'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const multer = require('multer');
const { initializeDatabase, pool, withTransaction } = require('./db');
const { MAX_PAISE, addDays, formatPaisa, parseMoneyToPaise } = require('./money');
const { sanitizeWorkflowPackage, MAX_PACKAGE_BYTES } = require('./workflow-package');
const {
  asBoolean, asyncRoute, cleanText, hashToken, newCsrfToken, newId, newToken,
  normalizeUsername, passwordHash, passwordMatches, safeEqual, validatePassword
} = require('./security');

const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'sa_session';
const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
const STORAGE_DIR = path.resolve(process.env.SA_STORAGE_DIR || path.join(__dirname, '..', 'storage'));
const RELEASE_DIR = path.join(STORAGE_DIR, 'releases');
const TEMP_DIR = path.join(STORAGE_DIR, 'tmp');
const COOKIE_SECURE = process.env.SA_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const ADMIN_WHATSAPP = '01746144544';
const ADMIN_EMAIL = 'sultanahmedaskan@gmail.com';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const app = express();
app.disable('x-powered-by');
if (process.env.SA_TRUST_PROXY) app.set('trust proxy', Number(process.env.SA_TRUST_PROXY) || 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], connectSrc: ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com'],
      fontSrc: ["'self'", 'data:'], formAction: ["'self'"], frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'], objectSrc: ["'none'"], scriptSrc: ["'self'", 'https://accounts.google.com'],
      frameSrc: ['https://accounts.google.com'], styleSrc: ["'self'", "'unsafe-inline'"], ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {})
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, TEMP_DIR),
    filename: (_req, _file, callback) => callback(null, `${newId()}.upload`)
  }),
  limits: { fileSize: 150 * 1024 * 1024, files: 1, fields: 12 }
});

function cleanupUploadedFile(req, res, next) {
  res.once('finish', () => { if (req.file?.path) fs.rm(req.file.path, { force: true }).catch(() => {}); });
  res.once('close', () => { if (req.file?.path) fs.rm(req.file.path, { force: true }).catch(() => {}); });
  next();
}

const authAttempts = new Map();
function limitAuthAttempts(req, res, next) {
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const prior = authAttempts.get(key);
  if (!prior || prior.resetAt <= now) authAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  else prior.count += 1;
  if (authAttempts.get(key).count > 20) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  if (authAttempts.size > 2000) {
    for (const [entry, value] of authAttempts) if (value.resetAt <= now) authAttempts.delete(entry);
  }
  next();
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' });
}

async function requireUser(req, res, next) {
  try {
    const authorization = req.get('authorization') || '';
    const headerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
    const cookieToken = req.cookies?.[COOKIE_NAME] || null;
    const token = headerToken || cookieToken;
    if (!token || token.length < 32 || token.length > 128) throw new HttpError(401, 'Please sign in.');
    const [rows] = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.role, u.active, s.csrf_token, s.session_kind, s.expires_at
      FROM sa_session s JOIN sa_user u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=TRUE
      LIMIT 1`, [hashToken(token)]);
    if (!rows.length) throw new HttpError(401, 'Please sign in again.');
    const session = rows[0];
    const browserSession = !headerToken && Boolean(cookieToken);
    if (browserSession && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = req.get('x-csrf-token') || '';
      if (!session.csrf_token || !safeEqual(csrf, session.csrf_token)) throw new HttpError(403, 'Refresh your session and try again.');
    }
    req.auth = {
      id: session.id,
      username: session.username,
      displayName: session.display_name,
      role: session.role,
      csrfToken: session.csrf_token,
      tokenHash: hashToken(token),
      browserSession
    };
    next();
  } catch (error) { next(error); }
}

function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'ADMIN') return next(new HttpError(403, 'Administrator access is required.'));
  next();
}

function validId(value) {
  const id = String(value ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid ID.');
  return id;
}

function numericDuration(value) {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 3650) throw new HttpError(400, 'Subscription duration must be 1–3650 days.');
  return duration;
}

function sendFailure(res, error) {
  const status = Number.isInteger(error.status) ? error.status : (Number.isInteger(error.statusCode) ? error.statusCode : 500);
  const message = status >= 500 ? 'The server could not complete this request.' : error.message;
  if (status >= 500) console.error('Request failed:', error.message);
  return res.status(status).json({ error: message });
}

function requireJsonString(value, limit, label, required = true) {
  try { return cleanText(value, limit, label, { required }); }
  catch (error) { throw new HttpError(400, error.message); }
}
function validateInput(operation) {
  try { return operation(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error.message); }
}

async function createUserSession(req, res, user) {
  const token = newToken();
  const csrfToken = newCsrfToken();
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  await pool.query('INSERT INTO sa_session(token_hash,user_id,expires_at,csrf_token,session_kind) VALUES(?,?,?,?,?)',
    [hashToken(token), user.id, expiresAt, csrfToken, req.get('x-smart-automation-client') === 'desktop' ? 'API' : 'WEB']);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: TOKEN_LIFETIME_MS });
  return { token, username: user.username, expiresAt: expiresAt.toISOString(), csrfToken };
}

async function verifyGoogleCredential(credential) {
  const clientId = String(process.env.SA_GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) throw new HttpError(503, 'Google sign-in is not configured yet. Contact the administrator.');
  if (typeof credential !== 'string' || credential.length < 100 || credential.length > 16384) throw new HttpError(400, 'Google sign-in credential is invalid.');
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new HttpError(401, 'Google could not verify this sign-in. Please try again.');
  const claims = await response.json();
  const expiresAt = Number(claims.exp);
  if (claims.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)
    || !(claims.email_verified === 'true' || claims.email_verified === true)
    || typeof claims.sub !== 'string' || claims.sub.length > 255
    || typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    throw new HttpError(401, 'Use a verified Google account and try again.');
  }
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: String(claims.name || '').trim().slice(0, 120) };
}

// This route is declared separately to keep account and financial operations close to their API contract.
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'smart-automation-cloud', runtime: 'node' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'smart-automation-cloud', runtime: 'node' }));
app.get('/api/auth/config', (_req, res) => res.json({
  googleClientId: process.env.SA_GOOGLE_CLIENT_ID || '',
  adminWhatsApp: ADMIN_WHATSAPP,
  adminEmail: ADMIN_EMAIL
}));

app.post('/api/auth/signup', limitAuthAttempts, asyncRoute(async (req, res) => {
  const username = validateInput(() => normalizeUsername(req.body?.username));
  const password = validateInput(() => validatePassword(req.body?.password));
  const email = requireJsonString(req.body?.email, 254, 'Email', true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const displayName = requireJsonString(req.body?.displayName, 120, 'Name', true);
  const [[existingUser]] = await pool.query('SELECT id FROM sa_user WHERE username=? LIMIT 1', [username]);
  if (existingUser) throw new HttpError(409, 'That username is already registered. Contact the administrator if you need help.');
  const [[linkedEmail]] = await pool.query('SELECT user_id FROM sa_google_identity WHERE email=? LIMIT 1', [email]);
  if (linkedEmail) throw new HttpError(409, 'This email already belongs to an account. Sign in with Google or contact the administrator.');
  const [[registeredEmail]] = await pool.query(`SELECT id FROM sa_signup_request WHERE email=? AND status='APPROVED' LIMIT 1`, [email]);
  if (registeredEmail) throw new HttpError(409, 'This email already has an account request that was approved. Please sign in or contact the administrator.');
  const [[pending]] = await pool.query(`SELECT id FROM sa_signup_request WHERE status='PENDING' AND (username=? OR email=?)
    ORDER BY created_at DESC LIMIT 1`, [username, email]);
  if (pending) return res.status(202).json({ status: 'PENDING', message: 'An account request for this username or email is already waiting for review.' });
  const id = newId();
  await pool.query(`INSERT INTO sa_signup_request(id,username,email,display_name,password_hash,status)
    VALUES(?,?,?,?,?,'PENDING')`, [id, username, email, displayName, await passwordHash(password)]);
  res.status(202).json({ status: 'PENDING', message: 'Your account request has been sent. You can sign in after the administrator approves it.' });
}));

app.post('/api/auth/google', limitAuthAttempts, asyncRoute(async (req, res) => {
  const identity = await verifyGoogleCredential(req.body?.credential);
  const [[linked]] = await pool.query(`SELECT u.id,u.username,u.active FROM sa_google_identity g
    JOIN sa_user u ON u.id=g.user_id WHERE g.google_sub=? LIMIT 1`, [identity.sub]);
  if (linked) {
    if (!linked.active) throw new HttpError(403, 'This account is disabled. Please contact the administrator.');
    return res.json(await createUserSession(req, res, linked));
  }
  const [[emailInUse]] = await pool.query('SELECT user_id FROM sa_google_identity WHERE email=? LIMIT 1', [identity.email]);
  if (emailInUse) throw new HttpError(409, 'This email is linked to another Google sign-in. Contact the administrator.');
  const [[pending]] = await pool.query(`SELECT id FROM sa_signup_request WHERE google_sub=? AND status='PENDING'
    ORDER BY created_at DESC LIMIT 1`, [identity.sub]);
  if (pending) return res.status(202).json({ status: 'PENDING', message: 'Your account request is waiting for administrator approval.' });
  const requestId = newId();
  await pool.query(`INSERT INTO sa_signup_request(id,google_sub,email,display_name,status)
    VALUES(?,?,?,?,'PENDING')`, [requestId, identity.sub, identity.email, identity.name || null]);
  res.status(202).json({ status: 'PENDING', message: 'Your account request has been sent. You can sign in with Google after the administrator approves it.' });
}));

app.post('/api/auth/login', limitAuthAttempts, asyncRoute(async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) throw new HttpError(400, 'Username and password are required.');
  const [rows] = await pool.query('SELECT id,username,display_name,password_hash,role FROM sa_user WHERE username=? AND active=TRUE LIMIT 1', [username]);
  if (!rows.length || !(await passwordMatches(password, rows[0].password_hash))) {
    throw new HttpError(401, 'Username or password is incorrect.');
  }
  res.json(await createUserSession(req, res, rows[0]));
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : req.cookies?.[COOKIE_NAME];
  if (token && token.length >= 32 && token.length <= 128) {
    if (!authorization.startsWith('Bearer ')) {
      const [sessions] = await pool.query('SELECT csrf_token FROM sa_session WHERE token_hash=? AND expires_at>UTC_TIMESTAMP()', [hashToken(token)]);
      if (sessions.length && !safeEqual(req.get('x-csrf-token') || '', sessions[0].csrf_token || '')) {
        throw new HttpError(403, 'Refresh your session and try again.');
      }
    }
    await pool.query('DELETE FROM sa_session WHERE token_hash=?', [hashToken(token)]);
  }
  clearSessionCookie(res);
  res.status(204).end();
}));

app.get('/api/auth/session', requireUser, asyncRoute(async (req, res) => {
  const [[identity]] = await pool.query('SELECT email FROM sa_google_identity WHERE user_id=? LIMIT 1', [req.auth.id]);
  res.json({ id: req.auth.id, username: req.auth.username, displayName: req.auth.displayName,
    role: req.auth.role, csrfToken: req.auth.csrfToken, googleLinked: Boolean(identity), email: identity?.email || null });
}));
app.get('/api/me', requireUser, asyncRoute(async (req, res) => {
  const [[user]] = await pool.query('SELECT id,username,display_name,role,created_at FROM sa_user WHERE id=?', [req.auth.id]);
  res.json({ ...user, displayName: user.display_name, csrfToken: req.auth.csrfToken });
}));

app.post('/api/account/profile', requireUser, asyncRoute(async (req, res) => {
  const displayName = requireJsonString(req.body?.displayName, 120, 'Display name', false);
  await pool.query('UPDATE sa_user SET display_name=? WHERE id=?', [displayName || null, req.auth.id]);
  res.json({ message: 'Account details updated.' });
}));

app.post('/api/account/password', requireUser, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '');
  const nextPassword = validateInput(() => validatePassword(req.body?.newPassword));
  const [[user]] = await pool.query('SELECT password_hash FROM sa_user WHERE id=?', [req.auth.id]);
  const [[identity]] = await pool.query('SELECT google_sub FROM sa_google_identity WHERE user_id=? LIMIT 1', [req.auth.id]);
  if (!user || (!identity && !(await passwordMatches(currentPassword, user.password_hash)))) throw new HttpError(401, 'Current password is incorrect.');
  await withTransaction(async connection => {
    await connection.query('UPDATE sa_user SET password_hash=? WHERE id=?', [await passwordHash(nextPassword), req.auth.id]);
    await connection.query('DELETE FROM sa_session WHERE user_id=?', [req.auth.id]);
  });
  clearSessionCookie(res);
  res.json({ message: 'Password changed. Sign in again on your devices.' });
}));

async function getWalletBalance(connectionOrPool, userId, lock = false) {
  const [rows] = await connectionOrPool.query(`SELECT balance_paisa FROM sa_wallet WHERE user_id=?${lock ? ' FOR UPDATE' : ''}`, [userId]);
  if (!rows.length) throw new HttpError(500, 'Wallet account was not initialized.');
  return BigInt(rows[0].balance_paisa);
}

app.get('/api/wallet', requireUser, asyncRoute(async (req, res) => {
  const [wallet, ledger, topups] = await Promise.all([
    getWalletBalance(pool, req.auth.id),
    pool.query('SELECT id,delta_paisa,event_type,reference_type,reference_id,description,created_at FROM sa_wallet_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.auth.id]),
    pool.query('SELECT id,amount_paisa,payment_reference,status,admin_note,created_at,reviewed_at FROM sa_topup_request WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.auth.id])
  ]).then(values => [values[0], values[1][0], values[2][0]]);
  res.json({
    balancePaisa: wallet.toString(), balance: formatPaisa(wallet),
    ledger: ledger.map(row => ({ ...row, amount: formatPaisa(row.delta_paisa), deltaPaisa: row.delta_paisa })),
    topups: topups.map(row => ({ ...row, amount: formatPaisa(row.amount_paisa), amountPaisa: row.amount_paisa }))
  });
}));

app.post('/api/wallet/topups', requireUser, asyncRoute(async (req, res) => {
  let amountPaisa;
  try { amountPaisa = parseMoneyToPaise(req.body?.amount); }
  catch (error) { throw new HttpError(400, error.message); }
  const reference = requireJsonString(req.body?.paymentReference, 300, 'Payment reference');
  const id = newId();
  await pool.query("INSERT INTO sa_topup_request(id,user_id,amount_paisa,payment_reference,status) VALUES(?,?,?,?,'PENDING')",
    [id, req.auth.id, amountPaisa, reference]);
  res.status(201).json({ id, status: 'PENDING', amount: formatPaisa(amountPaisa), message: 'Top-up request sent for administrator review.' });
}));

app.get('/api/marketplace', requireUser, asyncRoute(async (req, res) => {
  const [workflowRows] = await pool.query(`
    SELECT w.id,w.name,w.description,w.version,w.price_paisa,w.subscription_days,w.marketplace_can_edit,
      (EXISTS(SELECT 1 FROM sa_purchase p WHERE p.user_id=? AND p.product_type='WORKFLOW' AND p.product_id=w.id)
        OR EXISTS(SELECT 1 FROM sa_subscription s WHERE s.user_id=? AND s.workflow_id=w.id AND s.status='ACTIVE' AND s.expires_at>UTC_TIMESTAMP())
        OR EXISTS(SELECT 1 FROM sa_grant g WHERE g.user_id=? AND g.workflow_id=w.id AND g.active=TRUE AND g.expires_at>UTC_TIMESTAMP())) AS owned
    FROM sa_workflow w WHERE w.published=TRUE ORDER BY w.name`, [req.auth.id, req.auth.id, req.auth.id]);
  const [packageRows] = await pool.query(`
    SELECT p.id,p.name,p.description,p.price_paisa,p.subscription_days,p.marketplace_can_edit,
      COUNT(DISTINCT package_workflow.workflow_id) AS workflow_count,
      GROUP_CONCAT(DISTINCT package_workflow.name ORDER BY package_workflow.name SEPARATOR ' · ') AS workflow_names,
      (EXISTS(SELECT 1 FROM sa_purchase purchase WHERE purchase.user_id=? AND purchase.product_type='PACKAGE' AND purchase.product_id=p.id)
        OR COUNT(DISTINCT CASE WHEN subscription.workflow_id IS NOT NULL OR grant_access.workflow_id IS NOT NULL THEN package_workflow.workflow_id END)=COUNT(DISTINCT package_workflow.workflow_id)) AS owned
    FROM sa_package p
    LEFT JOIN (
      SELECT pw.package_id,pw.workflow_id,w.name FROM sa_package_workflow pw
      JOIN sa_workflow w ON w.id=pw.workflow_id AND w.published=TRUE
    ) package_workflow ON package_workflow.package_id=p.id
    LEFT JOIN sa_subscription subscription ON subscription.user_id=? AND subscription.workflow_id=package_workflow.workflow_id
      AND subscription.status='ACTIVE' AND subscription.expires_at>UTC_TIMESTAMP()
    LEFT JOIN sa_grant grant_access ON grant_access.user_id=? AND grant_access.workflow_id=package_workflow.workflow_id
      AND grant_access.active=TRUE AND grant_access.expires_at>UTC_TIMESTAMP()
    WHERE p.active=TRUE GROUP BY p.id HAVING COUNT(DISTINCT package_workflow.workflow_id)>0 ORDER BY p.name`, [req.auth.id, req.auth.id, req.auth.id]);
  res.json({
    workflows: workflowRows.map(row => ({
      id: row.id, name: row.name, description: row.description || '', version: row.version,
      pricePaisa: String(row.price_paisa), price: formatPaisa(row.price_paisa),
      durationDays: row.subscription_days, canEdit: Boolean(row.marketplace_can_edit),
      owned: Boolean(row.owned), type: 'WORKFLOW'
    })),
    packages: packageRows.map(row => ({
      id: row.id, name: row.name, description: row.description, workflowCount: Number(row.workflow_count),
      workflowNames: row.workflow_names || '', pricePaisa: String(row.price_paisa), price: formatPaisa(row.price_paisa),
      durationDays: row.subscription_days, canEdit: Boolean(row.marketplace_can_edit),
      owned: Boolean(row.owned), type: 'PACKAGE'
    }))
  });
}));

app.post('/api/purchases', requireUser, asyncRoute(async (req, res) => {
  const type = String(req.body?.type ?? '').toUpperCase();
  const id = validId(req.body?.id);
  if (!['WORKFLOW', 'PACKAGE'].includes(type)) throw new HttpError(400, 'Choose a workflow or package.');
  const idempotencyKey = String(req.get('idempotency-key') || req.body?.idempotencyKey || '').trim();
  const renewal = req.body?.renewal === true;
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(idempotencyKey)) throw new HttpError(400, 'Purchase request is missing its retry key. Please retry from the marketplace.');
  const purchase = await withTransaction(async connection => {
    const [walletRows] = await connection.query('SELECT balance_paisa FROM sa_wallet WHERE user_id=? FOR UPDATE', [req.auth.id]);
    if (!walletRows.length) throw new HttpError(500, 'Wallet account was not initialized.');
    const [priorRows] = await connection.query('SELECT id,product_type,product_id,amount_paisa FROM sa_purchase WHERE user_id=? AND idempotency_key=? LIMIT 1', [req.auth.id, idempotencyKey]);
    if (priorRows.length) {
      if (priorRows[0].product_type !== type || priorRows[0].product_id !== id) throw new HttpError(409, 'This retry key already belongs to a different purchase.');
      return { duplicate: true, purchaseId: priorRows[0].id, amountPaisa: priorRows[0].amount_paisa, balance: walletRows[0].balance_paisa };
    }

    let product;
    let workflowIds;
    let canEdit;
    if (type === 'WORKFLOW') {
      const [rows] = await connection.query('SELECT id,name,price_paisa,subscription_days,marketplace_can_edit FROM sa_workflow WHERE id=? AND published=TRUE FOR UPDATE', [id]);
      if (!rows.length) throw new HttpError(404, 'Workflow is not available in the marketplace.');
      product = rows[0]; workflowIds = [rows[0].id]; canEdit = Boolean(rows[0].marketplace_can_edit);
    } else {
      const [rows] = await connection.query('SELECT id,name,price_paisa,subscription_days,marketplace_can_edit FROM sa_package WHERE id=? AND active=TRUE FOR UPDATE', [id]);
      if (!rows.length) throw new HttpError(404, 'Package is not available in the marketplace.');
      product = rows[0]; canEdit = Boolean(rows[0].marketplace_can_edit);
      const [items] = await connection.query('SELECT pw.workflow_id FROM sa_package_workflow pw JOIN sa_workflow w ON w.id=pw.workflow_id WHERE pw.package_id=? AND w.published=TRUE ORDER BY pw.workflow_id', [id]);
      workflowIds = items.map(item => item.workflow_id);
      if (!workflowIds.length) throw new HttpError(409, 'This package currently has no published workflows.');
    }

    const [priorProductPurchases] = await connection.query(`SELECT id FROM sa_purchase
      WHERE user_id=? AND product_type=? AND product_id=? LIMIT 1`, [req.auth.id, type, id]);
    if (renewal && !priorProductPurchases.length) throw new HttpError(409, 'This product has not been purchased by your account, so it cannot be renewed.');
    if (!renewal && priorProductPurchases.length) throw new HttpError(409, 'This product was already purchased. Renew it from the Subscriptions tab after it expires.');

    const [activeRows] = await connection.query(`SELECT id FROM sa_subscription
      WHERE user_id=? AND source_type=? AND source_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP()
      LIMIT 1 FOR UPDATE`, [req.auth.id, type, id]);
    if (activeRows.length) throw new HttpError(409, 'This subscription is still active. It can be renewed after it expires.');
    if (type === 'WORKFLOW') {
      const [otherAccess] = await connection.query(`SELECT id FROM sa_subscription
        WHERE user_id=? AND workflow_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE`, [req.auth.id, id]);
      const [activeGrants] = await connection.query(`SELECT id FROM sa_grant
        WHERE user_id=? AND workflow_id=? AND active=TRUE AND expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE`, [req.auth.id, id]);
      if (otherAccess.length || activeGrants.length) throw new HttpError(409, 'Your account already has active access to this workflow.');
    }
    if (renewal) {
      const [expiredRows] = await connection.query(`SELECT id FROM sa_subscription
        WHERE user_id=? AND source_type=? AND source_id=? AND status='ACTIVE' AND expires_at<=UTC_TIMESTAMP()
        LIMIT 1 FOR UPDATE`, [req.auth.id, type, id]);
      if (!expiredRows.length) throw new HttpError(409, 'This subscription is not expired yet or cannot be renewed.');
    }

    const price = BigInt(product.price_paisa);
    const balance = BigInt(walletRows[0].balance_paisa);
    if (balance < price) throw new HttpError(402, 'Your wallet balance is too low. Submit a top-up request and wait for admin approval.');
    const purchaseId = newId();
    if (price > 0n) {
      await connection.query('UPDATE sa_wallet SET balance_paisa=balance_paisa-? WHERE user_id=?', [price.toString(), req.auth.id]);
      await connection.query(`INSERT INTO sa_wallet_ledger(id,user_id,delta_paisa,event_type,reference_type,reference_id,description)
        VALUES(?,?,?,'PURCHASE',?,?,?)`, [newId(), req.auth.id, `-${price}`, type, purchaseId, `${type === 'WORKFLOW' ? 'Workflow' : 'Package'} purchase: ${product.name}`]);
    }
    await connection.query('INSERT INTO sa_purchase(id,user_id,product_type,product_id,amount_paisa,idempotency_key) VALUES(?,?,?,?,?,?)',
      [purchaseId, req.auth.id, type, id, price.toString(), idempotencyKey]);
    const started = new Date();
    const durationDays = numericDuration(product.subscription_days);
    const expiries = [];
    for (const workflowId of workflowIds) {
      const [old] = await connection.query(`SELECT expires_at FROM sa_subscription
        WHERE user_id=? AND workflow_id=? AND status='ACTIVE' AND expires_at>UTC_TIMESTAMP()
        ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`, [req.auth.id, workflowId]);
      const startsAt = old.length && new Date(old[0].expires_at) > started ? new Date(old[0].expires_at) : started;
      const expiresAt = addDays(startsAt, durationDays);
      await connection.query(`INSERT INTO sa_subscription(id,user_id,workflow_id,source_type,source_id,starts_at,expires_at,can_edit,status)
        VALUES(?,?,?,?,?,?,?,?, 'ACTIVE')`, [newId(), req.auth.id, workflowId, type, id, startsAt, expiresAt, canEdit]);
      expiries.push(expiresAt.toISOString());
    }
    return { duplicate: false, purchaseId, amountPaisa: price.toString(), balance: (balance - price).toString(), expiresAt: expiries.sort().at(-1) };
  });
  res.status(purchase.duplicate ? 200 : 201).json({
    purchaseId: purchase.purchaseId, amountPaisa: String(purchase.amountPaisa), amount: formatPaisa(purchase.amountPaisa),
    balancePaisa: String(purchase.balance), balance: formatPaisa(purchase.balance), expiresAt: purchase.expiresAt || null,
    message: purchase.duplicate ? 'This purchase was already completed.' : 'Purchase complete. Workflow access is now active.'
  });
}));

app.get('/api/subscriptions', requireUser, asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT MAX(s.id) AS id,s.workflow_id,w.name AS workflow_name,w.description,w.version,s.source_type,s.source_id,
      MIN(s.starts_at) AS starts_at,MAX(s.expires_at) AS expires_at,MAX(s.can_edit) AS can_edit,
      CASE WHEN MAX(s.expires_at)>UTC_TIMESTAMP() THEN TRUE ELSE FALSE END AS currently_active
    FROM sa_subscription s JOIN sa_workflow w ON w.id=s.workflow_id
    WHERE s.user_id=? AND s.status='ACTIVE'
    GROUP BY s.workflow_id,w.name,w.description,w.version,s.source_type,s.source_id
    ORDER BY MAX(s.expires_at) DESC LIMIT 500`, [req.auth.id]);
  const [grants] = await pool.query(`
    SELECT g.id,w.id AS workflow_id,w.name AS workflow_name,w.description,w.version,'ADMIN' AS source_type,
      g.created_at AS starts_at,g.expires_at,g.can_edit,g.active AS status,
      CASE WHEN g.expires_at>UTC_TIMESTAMP() AND g.active=TRUE THEN TRUE ELSE FALSE END AS currently_active
    FROM sa_grant g JOIN sa_workflow w ON w.id=g.workflow_id WHERE g.user_id=? AND g.active=TRUE`, [req.auth.id]);
  res.json(rows.concat(grants).map(row => ({
    id: row.id, workflowId: row.workflow_id, workflowName: row.workflow_name, productId: row.source_id,
    description: row.description || '', version: Number(row.version), source: row.source_type,
    startsAt: row.starts_at, expiresAt: row.expires_at, canEdit: Boolean(row.can_edit),
    active: Boolean(row.currently_active)
  })));
}));

app.get('/api/purchases', requireUser, asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`SELECT id,product_type,product_id,amount_paisa,created_at FROM sa_purchase
    WHERE user_id=? ORDER BY created_at DESC LIMIT 200`, [req.auth.id]);
  res.json(rows.map(row => ({ ...row, productType: row.product_type, productId: row.product_id,
    amountPaisa: String(row.amount_paisa), amount: formatPaisa(row.amount_paisa), createdAt: row.created_at })));
}));

app.get('/api/package-requests', requireUser, asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`SELECT id,requested_name,message,status,admin_response,created_at,reviewed_at
    FROM sa_package_request WHERE user_id=? ORDER BY created_at DESC LIMIT 100`, [req.auth.id]);
  res.json(rows.map(row => ({ id: row.id, requestedName: row.requested_name, message: row.message,
    status: row.status, adminResponse: row.admin_response, createdAt: row.created_at, reviewedAt: row.reviewed_at })));
}));

function validateLearningContent(input, authorId) {
  const type = String(input.contentType || '').toUpperCase();
  if (!['TUTORIAL', 'VIDEO', 'BLOG'].includes(type)) throw new HttpError(400, 'Choose Tutorial, YouTube video, or Blog post.');
  const title = requireJsonString(input.title, 200, 'Title');
  const summary = requireJsonString(input.summary, 500, 'Summary', false);
  const body = requireJsonString(input.body, 20000, 'Content', type !== 'VIDEO');
  const rawUrl = requireJsonString(input.url, 1000, type === 'VIDEO' ? 'YouTube URL' : 'Link', false);
  let url = null;
  if (rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { throw new HttpError(400, 'Enter a valid HTTPS link.'); }
    if (parsed.protocol !== 'https:') throw new HttpError(400, 'Learning content links must use HTTPS.');
    const host = parsed.hostname.toLowerCase();
    if (type === 'VIDEO' && !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      throw new HttpError(400, 'YouTube video links must use youtube.com or youtu.be.');
    }
    url = parsed.toString();
  }
  if (type === 'VIDEO' && !url) throw new HttpError(400, 'Add a YouTube video link.');
  return { type, title, summary, body, url, published: asBoolean(input.published), authorId };
}

function learningContentFromRow(row) {
  return { id: row.id, contentType: row.content_type, title: row.title, summary: row.summary || '',
    body: row.body || '', url: row.url || '', published: Boolean(row.published),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

app.get('/api/learning', requireUser, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query(`SELECT id,content_type,title,summary,body,url,published,created_at,updated_at
    FROM sa_learning_content WHERE published=TRUE ORDER BY created_at DESC LIMIT 300`);
  res.json(rows.map(learningContentFromRow));
}));

app.post('/api/admin/learning', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const content = validateLearningContent(req.body || {}, req.auth.id);
  const id = newId();
  await pool.query(`INSERT INTO sa_learning_content(id,content_type,title,summary,body,url,published,created_by)
    VALUES(?,?,?,?,?,?,?,?)`, [id, content.type, content.title, content.summary, content.body, content.url,
    content.published, content.authorId]);
  res.status(201).json({ id, message: 'Learning content published.' });
}));

app.post('/api/admin/learning/:contentId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.contentId);
  const content = validateLearningContent(req.body || {}, req.auth.id);
  const [result] = await pool.query(`UPDATE sa_learning_content SET content_type=?,title=?,summary=?,body=?,url=?,published=? WHERE id=?`,
    [content.type, content.title, content.summary, content.body, content.url, content.published, id]);
  if (!result.affectedRows) throw new HttpError(404, 'Learning content was not found.');
  res.json({ message: 'Learning content updated.' });
}));

app.delete('/api/admin/learning/:contentId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const [result] = await pool.query('DELETE FROM sa_learning_content WHERE id=?', [validId(req.params.contentId)]);
  if (!result.affectedRows) throw new HttpError(404, 'Learning content was not found.');
  res.json({ message: 'Learning content deleted.' });
}));

app.post('/api/package-requests', requireUser, asyncRoute(async (req, res) => {
  const name = requireJsonString(req.body?.requestedName, 200, 'Requested package name');
  const message = requireJsonString(req.body?.message, 2000, 'Request details');
  const id = newId();
  await pool.query("INSERT INTO sa_package_request(id,user_id,requested_name,message,status) VALUES(?,?,?,?,'PENDING')",
    [id, req.auth.id, name, message]);
  res.status(201).json({ id, status: 'PENDING', message: 'Package request sent to the administrator.' });
}));

app.get('/api/workflows', requireUser, asyncRoute(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT access.id,access.name,access.description,access.version,
      MAX(access.can_view) AS can_view,MAX(access.can_run) AS can_run,MAX(access.can_edit) AS can_edit,
      MAX(access.expires_at) AS expires_at
    FROM (
      SELECT w.id,w.name,w.description,w.version,g.can_view,g.can_run,g.can_edit,g.expires_at
      FROM sa_grant g JOIN sa_workflow w ON w.id=g.workflow_id
      WHERE g.user_id=? AND g.active=TRUE AND g.expires_at>UTC_TIMESTAMP() AND w.published=TRUE
      UNION ALL
      SELECT w.id,w.name,w.description,w.version,TRUE,TRUE,s.can_edit,s.expires_at
      FROM sa_subscription s JOIN sa_workflow w ON w.id=s.workflow_id
      WHERE s.user_id=? AND s.status='ACTIVE' AND s.expires_at>UTC_TIMESTAMP() AND w.published=TRUE
    ) access GROUP BY access.id,access.name,access.description,access.version ORDER BY access.name`, [req.auth.id, req.auth.id]);
  res.json(rows.map(row => ({ id: row.id, name: row.name, description: row.description || '', version: Number(row.version),
    canView: Boolean(row.can_view), canRun: Boolean(row.can_run), canEdit: Boolean(row.can_edit),
    expiresAt: new Date(row.expires_at).toISOString() })));
}));

app.get('/api/workflows/:workflowId/package', requireUser, asyncRoute(async (req, res) => {
  const workflowId = validId(req.params.workflowId);
  const [accessRows] = await pool.query(`
    SELECT MAX(can_view) AS can_view,MAX(can_run) AS can_run,MAX(can_edit) AS can_edit FROM (
      SELECT g.can_view,g.can_run,g.can_edit FROM sa_grant g
      WHERE g.user_id=? AND g.workflow_id=? AND g.active=TRUE AND g.expires_at>UTC_TIMESTAMP()
      UNION ALL
      SELECT TRUE,TRUE,s.can_edit FROM sa_subscription s
      WHERE s.user_id=? AND s.workflow_id=? AND s.status='ACTIVE' AND s.expires_at>UTC_TIMESTAMP()
    ) entitlement`, [req.auth.id, workflowId, req.auth.id, workflowId]);
  if (!accessRows.length || (!accessRows[0].can_view && !accessRows[0].can_run && !accessRows[0].can_edit)) {
    throw new HttpError(404, 'Workflow access is not active.');
  }
  const [rows] = await pool.query('SELECT name,version,package_bytes FROM sa_workflow WHERE id=? AND published=TRUE LIMIT 1', [workflowId]);
  if (!rows.length) throw new HttpError(404, 'Workflow was removed.');
  const safeName = String(rows[0].name).replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'workflow';
  res.set({
    'Content-Type': 'application/vnd.smartautomation.workflow',
    'Content-Disposition': `attachment; filename="${safeName}.saworkflow"`,
    'X-Workflow-Id': workflowId,
    'X-Workflow-Version': String(rows[0].version),
    'Cache-Control': 'private, no-store'
  }).send(rows[0].package_bytes);
}));

app.post('/api/admin/users', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const username = validateInput(() => normalizeUsername(req.body?.username));
  const password = validateInput(() => validatePassword(req.body?.password));
  const role = String(req.body?.role || 'MEMBER').toUpperCase();
  if (!['MEMBER', 'ADMIN'].includes(role)) throw new HttpError(400, 'Invalid account role.');
  const displayName = requireJsonString(req.body?.displayName, 120, 'Display name', false);
  const id = newId();
  try {
    await withTransaction(async connection => {
      await connection.query('INSERT INTO sa_user(id,username,display_name,password_hash,role,active) VALUES(?,?,?,?,?,TRUE)',
        [id, username, displayName || null, await passwordHash(password), role]);
      await connection.query('INSERT INTO sa_wallet(user_id,balance_paisa) VALUES(?,0)', [id]);
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'That username is already in use.');
    throw error;
  }
  res.status(201).json({ id, username, role, message: 'User account created.' });
}));

app.post('/api/admin/signup-requests/:requestId/review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const requestId = validId(req.params.requestId);
  const decision = String(req.body?.decision || '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) throw new HttpError(400, 'Choose approve or reject.');
  const result = await withTransaction(async connection => {
    const [[request]] = await connection.query(`SELECT id,google_sub,username,email,display_name,password_hash,status FROM sa_signup_request
      WHERE id=? FOR UPDATE`, [requestId]);
    if (!request) throw new HttpError(404, 'Signup request was not found.');
    if (request.status !== 'PENDING') throw new HttpError(409, 'This signup request has already been reviewed.');
    if (decision === 'REJECT') {
      await connection.query(`UPDATE sa_signup_request SET status='REJECTED',password_hash=NULL,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?`, [req.auth.id, requestId]);
      return { status: 'REJECTED', username: null };
    }
    const id = newId();
    const displayName = String(request.display_name || request.email.split('@')[0]).slice(0, 120);
    let username = request.username;
    let accountPasswordHash = request.password_hash;
    if (request.google_sub) {
      const [[existingIdentity]] = await connection.query('SELECT google_sub FROM sa_google_identity WHERE google_sub=? OR email=? LIMIT 1 FOR UPDATE', [request.google_sub, request.email]);
      if (existingIdentity) throw new HttpError(409, 'This Google account or email is already linked to a user.');
      const localPart = request.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 55);
      username = `${localPart || 'member'}_${id.slice(0, 8)}`;
      accountPasswordHash = await passwordHash(newToken());
    }
    if (!username || !accountPasswordHash) throw new HttpError(409, 'This signup request is missing account details. Ask the user to submit it again.');
    const [[existingUser]] = await connection.query('SELECT id FROM sa_user WHERE username=? LIMIT 1 FOR UPDATE', [username]);
    if (existingUser) throw new HttpError(409, 'That username was claimed while the request was waiting. Ask the user to submit another request with a different username.');
    await connection.query(`INSERT INTO sa_user(id,username,display_name,password_hash,role,active)
      VALUES(?,?,?,?,'MEMBER',TRUE)`, [id, username, displayName, accountPasswordHash]);
    if (request.google_sub) await connection.query('INSERT INTO sa_google_identity(google_sub,user_id,email) VALUES(?,?,?)', [request.google_sub, id, request.email]);
    await connection.query('INSERT INTO sa_wallet(user_id,balance_paisa) VALUES(?,0)', [id]);
    await connection.query(`UPDATE sa_signup_request SET status='APPROVED',password_hash=NULL,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?`, [req.auth.id, requestId]);
    return { status: 'APPROVED', username, googleLinked: Boolean(request.google_sub) };
  });
  res.json({ ...result, message: decision === 'APPROVE' ? `Signup approved. The user can now sign in${result.googleLinked ? ' with the same Google account' : ' with the requested username and password'}.` : 'Signup request rejected.' });
}));

app.get('/api/admin/overview', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const [users] = await pool.query(`SELECT u.id,u.username,u.display_name,u.role,u.active,u.created_at,
    COALESCE(w.balance_paisa,0) AS balance_paisa FROM sa_user u LEFT JOIN sa_wallet w ON w.user_id=u.id ORDER BY u.created_at DESC`);
  const [workflows] = await pool.query(`SELECT id,name,description,version,price_paisa,subscription_days,marketplace_can_edit,published,updated_at
    FROM sa_workflow ORDER BY name`);
  const [packages] = await pool.query(`SELECT p.id,p.name,p.description,p.price_paisa,p.subscription_days,p.marketplace_can_edit,p.active,
    GROUP_CONCAT(pw.workflow_id) AS workflow_ids FROM sa_package p LEFT JOIN sa_package_workflow pw ON pw.package_id=p.id
    GROUP BY p.id ORDER BY p.name`);
  const [topups] = await pool.query(`SELECT t.id,t.user_id,u.username,t.amount_paisa,t.payment_reference,t.status,t.admin_note,t.created_at,t.reviewed_at
    FROM sa_topup_request t JOIN sa_user u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 500`);
  const [requests] = await pool.query(`SELECT r.id,r.user_id,u.username,r.requested_name,r.message,r.status,r.admin_response,r.created_at,r.reviewed_at
    FROM sa_package_request r JOIN sa_user u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 500`);
  const [grants] = await pool.query(`SELECT g.id,g.user_id,u.username,g.workflow_id,w.name AS workflow_name,g.can_view,g.can_run,g.can_edit,g.expires_at
    FROM sa_grant g JOIN sa_user u ON u.id=g.user_id JOIN sa_workflow w ON w.id=g.workflow_id WHERE g.active=TRUE ORDER BY g.expires_at DESC`);
  const [releases] = await pool.query('SELECT id,version,file_name,size_bytes,changelog,active,created_at FROM sa_release ORDER BY created_at DESC LIMIT 50');
  const [learning] = await pool.query(`SELECT id,content_type,title,summary,body,url,published,created_at,updated_at
    FROM sa_learning_content ORDER BY created_at DESC LIMIT 300`);
  const [signupRequests] = await pool.query(`SELECT id,username,email,display_name,google_sub,status,created_at FROM sa_signup_request
    ORDER BY CASE WHEN status='PENDING' THEN 0 ELSE 1 END,created_at DESC LIMIT 500`);
  res.json({
    users: users.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role,
      active: Boolean(row.active), balance: formatPaisa(row.balance_paisa), createdAt: row.created_at })),
    workflows: workflows.map(row => ({ id: row.id, name: row.name, description: row.description || '', version: Number(row.version),
      price: formatPaisa(row.price_paisa), durationDays: row.subscription_days, canEdit: Boolean(row.marketplace_can_edit),
      published: Boolean(row.published), updatedAt: row.updated_at })),
    packages: packages.map(row => ({ id: row.id, name: row.name, description: row.description, price: formatPaisa(row.price_paisa),
      durationDays: row.subscription_days, canEdit: Boolean(row.marketplace_can_edit), active: Boolean(row.active),
      workflowIds: row.workflow_ids ? row.workflow_ids.split(',') : [] })),
    topups: topups.map(row => ({ id: row.id, userId: row.user_id, username: row.username, amount: formatPaisa(row.amount_paisa),
      paymentReference: row.payment_reference, status: row.status, adminNote: row.admin_note, createdAt: row.created_at, reviewedAt: row.reviewed_at })),
    packageRequests: requests.map(row => ({ id: row.id, userId: row.user_id, username: row.username, requestedName: row.requested_name,
      message: row.message, status: row.status, adminResponse: row.admin_response, createdAt: row.created_at, reviewedAt: row.reviewed_at })),
    grants: grants.map(row => ({ id: row.id, userId: row.user_id, username: row.username, workflowId: row.workflow_id,
      workflowName: row.workflow_name, canView: Boolean(row.can_view), canRun: Boolean(row.can_run), canEdit: Boolean(row.can_edit), expiresAt: row.expires_at })),
    releases: releases.map(row => ({ id: row.id, version: row.version, fileName: row.file_name, sizeBytes: String(row.size_bytes),
      changelog: row.changelog, active: Boolean(row.active), createdAt: row.created_at })),
    learning: learning.map(learningContentFromRow),
    signupRequests: signupRequests.map(row => ({ id: row.id, username: row.username, email: row.email,
      displayName: row.display_name, google: Boolean(row.google_sub), status: row.status, createdAt: row.created_at }))
  });
}));

app.get('/api/admin/users/:userId/transactions', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const userId = validId(req.params.userId);
  const [[user]] = await pool.query('SELECT id,username,display_name FROM sa_user WHERE id=? LIMIT 1', [userId]);
  if (!user) throw new HttpError(404, 'User account was not found.');
  const [ledger] = await pool.query(`SELECT id,delta_paisa,event_type,reference_type,reference_id,description,created_at
    FROM sa_wallet_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 500`, [userId]);
  const [topups] = await pool.query(`SELECT id,amount_paisa,payment_reference,status,admin_note,created_at,reviewed_at
    FROM sa_topup_request WHERE user_id=? ORDER BY created_at DESC LIMIT 500`, [userId]);
  res.json({
    user: { id: user.id, username: user.username, displayName: user.display_name },
    transactions: ledger.map(row => ({ id: row.id, amountPaisa: String(row.delta_paisa), amount: formatPaisa(row.delta_paisa),
      eventType: row.event_type, description: row.description, createdAt: row.created_at })),
    topups: topups.map(row => ({ id: row.id, amountPaisa: String(row.amount_paisa), amount: formatPaisa(row.amount_paisa),
      paymentReference: row.payment_reference, status: row.status, adminNote: row.admin_note,
      createdAt: row.created_at, reviewedAt: row.reviewed_at }))
  });
}));

app.post('/api/admin/users/:userId/status', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const userId = validId(req.params.userId);
  const active = asBoolean(req.body?.active);
  if (userId === req.auth.id && !active) throw new HttpError(400, 'You cannot disable your own administrator account.');
  const [result] = await pool.query('UPDATE sa_user SET active=? WHERE id=?', [active, userId]);
  if (!result.affectedRows) throw new HttpError(404, 'User account was not found.');
  if (!active) await pool.query('DELETE FROM sa_session WHERE user_id=?', [userId]);
  res.json({ message: active ? 'User enabled.' : 'User disabled and sessions revoked.' });
}));

app.post('/api/admin/workflows', requireUser, requireAdmin, upload.single('packageFile'), cleanupUploadedFile, asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a .saworkflow package.');
  const requestedName = requireJsonString(req.body?.name, 200, 'Workflow name', false);
  const requestedDescription = requireJsonString(req.body?.description, 4000, 'Workflow description', false);
  let price;
  try { price = parseMoneyToPaise(req.body?.price ?? '0', { allowZero: true }); }
  catch (error) { throw new HttpError(400, error.message); }
  const duration = numericDuration(req.body?.durationDays || 30);
  let content;
  try {
    if (req.file.size > MAX_PACKAGE_BYTES) throw new HttpError(400, 'Choose a workflow package under 25 MB.');
    const bytes = await fs.readFile(req.file.path);
    const parsed = sanitizeWorkflowPackage(bytes, { name: requestedName || undefined, description: requestedDescription || undefined });
    content = parsed;
  } finally { await fs.rm(req.file.path, { force: true }); }
  const canEdit = req.body?.canEdit === undefined ? true : asBoolean(req.body.canEdit);
  const workflow = await withTransaction(async connection => {
    const [existing] = await connection.query('SELECT id,version FROM sa_workflow WHERE name=? LIMIT 1 FOR UPDATE', [content.name]);
    if (existing.length) {
      const version = Number(existing[0].version) + 1;
      await connection.query(`UPDATE sa_workflow SET description=?,version=?,package_bytes=?,price_paisa=?,subscription_days=?,
        marketplace_can_edit=?,published=TRUE,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [content.description, version, content.bytes, price, duration, canEdit, existing[0].id]);
      return { id: existing[0].id, name: content.name, version };
    }
    const id = newId();
    await connection.query(`INSERT INTO sa_workflow(id,name,description,version,package_bytes,price_paisa,subscription_days,marketplace_can_edit,published)
      VALUES(?,?,?,1,?,?,?,?,TRUE)`, [id, content.name, content.description, content.bytes, price, duration, canEdit]);
    return { id, name: content.name, version: 1 };
  });
  res.status(201).json({ ...workflow, price: formatPaisa(price), durationDays: duration, message: `Workflow published as version ${workflow.version}.` });
}));

app.post('/api/admin/workflows/:workflowId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.workflowId);
  let price;
  try { price = parseMoneyToPaise(req.body?.price, { allowZero: true }); }
  catch (error) { throw new HttpError(400, error.message); }
  const duration = numericDuration(req.body?.durationDays);
  const published = req.body?.published === undefined ? true : asBoolean(req.body.published);
  const canEdit = asBoolean(req.body?.canEdit);
  const description = requireJsonString(req.body?.description, 4000, 'Workflow description', false);
  const [result] = await pool.query(`UPDATE sa_workflow SET price_paisa=?,subscription_days=?,marketplace_can_edit=?,published=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [price, duration, canEdit, published, description, id]);
  if (!result.affectedRows) throw new HttpError(404, 'Workflow was not found.');
  res.json({ message: 'Workflow listing updated.' });
}));

app.delete('/api/admin/workflows/:workflowId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.workflowId);
  const [result] = await pool.query('DELETE FROM sa_workflow WHERE id=?', [id]);
  if (!result.affectedRows) throw new HttpError(404, 'Workflow was not found.');
  res.json({ message: 'Workflow and its grants, package listings, and subscriptions were removed.' });
}));

async function savePackage(connection, packageId, input) {
  const name = cleanText(input.name, 200, 'Package name', { required: true });
  const description = cleanText(input.description, 4000, 'Package description');
  const price = parseMoneyToPaise(input.price, { allowZero: true });
  const duration = Number(input.durationDays);
  if (!Number.isInteger(duration) || duration < 1 || duration > 3650) throw new Error('Subscription duration must be 1–3650 days.');
  const workflowIds = Array.isArray(input.workflowIds) ? [...new Set(input.workflowIds.map(validId))] : [];
  if (!workflowIds.length) throw new Error('Choose at least one published workflow for this package.');
  const [items] = await connection.query(`SELECT id FROM sa_workflow WHERE published=TRUE AND id IN (${workflowIds.map(() => '?').join(',')})`, workflowIds);
  if (items.length !== workflowIds.length) throw new Error('All package workflows must be published.');
  const canEdit = input.canEdit === undefined ? true : asBoolean(input.canEdit);
  const active = input.active === undefined ? true : asBoolean(input.active);
  if (packageId) {
    const [exists] = await connection.query('SELECT id FROM sa_package WHERE id=? FOR UPDATE', [packageId]);
    if (!exists.length) throw new HttpError(404, 'Package was not found.');
    await connection.query(`UPDATE sa_package SET name=?,description=?,price_paisa=?,subscription_days=?,marketplace_can_edit=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [name, description, price, duration, canEdit, active, packageId]);
    await connection.query('DELETE FROM sa_package_workflow WHERE package_id=?', [packageId]);
  } else {
    packageId = newId();
    await connection.query(`INSERT INTO sa_package(id,name,description,price_paisa,subscription_days,marketplace_can_edit,active)
      VALUES(?,?,?,?,?,?,?)`, [packageId, name, description, price, duration, canEdit, active]);
  }
  for (const workflowId of workflowIds) await connection.query('INSERT INTO sa_package_workflow(package_id,workflow_id) VALUES(?,?)', [packageId, workflowId]);
  return { id: packageId, name, price: formatPaisa(price), durationDays: duration, workflowIds };
}

app.post('/api/admin/packages', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const saved = await withTransaction(connection => savePackage(connection, null, req.body || {}));
    res.status(201).json({ ...saved, message: 'Package published.' });
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error.message); }
}));

app.post('/api/admin/packages/:packageId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const saved = await withTransaction(connection => savePackage(connection, validId(req.params.packageId), req.body || {}));
    res.json({ ...saved, message: 'Package updated.' });
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error.message); }
}));

app.delete('/api/admin/packages/:packageId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const [result] = await pool.query('DELETE FROM sa_package WHERE id=?', [validId(req.params.packageId)]);
  if (!result.affectedRows) throw new HttpError(404, 'Package was not found.');
  res.json({ message: 'Package removed from the marketplace.' });
}));

app.post('/api/admin/topups/:topupId/review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.topupId);
  const decision = String(req.body?.decision || '').toUpperCase();
  const note = requireJsonString(req.body?.note, 500, 'Admin note', false);
  if (!['APPROVE', 'REJECT'].includes(decision)) throw new HttpError(400, 'Choose approve or reject.');
  const result = await withTransaction(async connection => {
    const [rows] = await connection.query('SELECT id,user_id,amount_paisa,status FROM sa_topup_request WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) throw new HttpError(404, 'Top-up request was not found.');
    const request = rows[0];
    if (request.status !== 'PENDING') throw new HttpError(409, 'This top-up request has already been reviewed.');
    if (decision === 'APPROVE') {
      const [walletRows] = await connection.query('SELECT balance_paisa FROM sa_wallet WHERE user_id=? FOR UPDATE', [request.user_id]);
      if (!walletRows.length) throw new HttpError(409, 'The user wallet no longer exists.');
      if (BigInt(walletRows[0].balance_paisa) + BigInt(request.amount_paisa) > BigInt(MAX_PAISE)) {
        throw new HttpError(409, 'Approving this request would exceed the maximum wallet balance.');
      }
      await connection.query('UPDATE sa_wallet SET balance_paisa=balance_paisa+? WHERE user_id=?', [String(request.amount_paisa), request.user_id]);
      await connection.query(`INSERT INTO sa_wallet_ledger(id,user_id,delta_paisa,event_type,reference_type,reference_id,description)
        VALUES(?,?,?,'TOPUP','TOPUP_REQUEST',?,?)`, [newId(), request.user_id, String(request.amount_paisa), id, note || 'Wallet top-up approved by administrator']);
    }
    await connection.query('UPDATE sa_topup_request SET status=?,admin_note=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?',
      [decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', note || null, req.auth.id, id]);
    return decision === 'APPROVE' ? 'Top-up approved and wallet credited.' : 'Top-up request rejected.';
  });
  res.json({ message: result });
}));

app.post('/api/admin/package-requests/:requestId/review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.requestId);
  const status = String(req.body?.status || '').toUpperCase();
  const response = requireJsonString(req.body?.response, 1000, 'Response', false);
  if (!['REVIEWED', 'DECLINED', 'FULFILLED'].includes(status)) throw new HttpError(400, 'Choose a valid request status.');
  const [result] = await pool.query(`UPDATE sa_package_request SET status=?,admin_response=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP()
    WHERE id=? AND status='PENDING'`, [status, response || null, req.auth.id, id]);
  if (!result.affectedRows) throw new HttpError(409, 'Request was already reviewed or no longer exists.');
  res.json({ message: 'Package request updated.' });
}));

app.post('/api/admin/grants', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const userId = validId(req.body?.userId);
  const workflowId = validId(req.body?.workflowId);
  const days = numericDuration(req.body?.durationDays);
  const canView = asBoolean(req.body?.canView);
  const canRun = asBoolean(req.body?.canRun);
  const canEdit = asBoolean(req.body?.canEdit);
  if (!canView && !canRun && !canEdit) throw new HttpError(400, 'Select at least one permission.');
  const expiresAt = addDays(new Date(), days);
  const [userRows] = await pool.query('SELECT id FROM sa_user WHERE id=? AND active=TRUE', [userId]);
  const [workflowRows] = await pool.query('SELECT id FROM sa_workflow WHERE id=? AND published=TRUE', [workflowId]);
  if (!userRows.length || !workflowRows.length) throw new HttpError(400, 'Choose an active user and a published workflow.');
  await pool.query(`INSERT INTO sa_grant(id,user_id,workflow_id,can_view,can_run,can_edit,expires_at,active)
    VALUES(?,?,?,?,?,?,?,TRUE) ON DUPLICATE KEY UPDATE can_view=VALUES(can_view),can_run=VALUES(can_run),can_edit=VALUES(can_edit),expires_at=VALUES(expires_at),active=TRUE`,
  [newId(), userId, workflowId, canView || canRun || canEdit, canRun, canEdit, expiresAt]);
  res.status(201).json({ expiresAt: expiresAt.toISOString(), message: 'Temporary workflow access granted.' });
}));

app.delete('/api/admin/grants/:userId/:workflowId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const [result] = await pool.query('DELETE FROM sa_grant WHERE user_id=? AND workflow_id=?', [validId(req.params.userId), validId(req.params.workflowId)]);
  if (!result.affectedRows) throw new HttpError(404, 'Manual grant was not found.');
  res.json({ message: 'Manual access grant revoked.' });
}));

app.get('/api/releases/latest', requireUser, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT id,version,file_name,size_bytes,changelog,created_at FROM sa_release WHERE active=TRUE ORDER BY created_at DESC LIMIT 1');
  if (!rows.length) throw new HttpError(404, 'No desktop release has been published yet.');
  const release = rows[0];
  res.json({ id: release.id, version: release.version, fileName: release.file_name, sizeBytes: String(release.size_bytes),
    changelog: release.changelog, createdAt: release.created_at, downloadUrl: '/api/releases/latest/download' });
}));

app.get('/api/releases/latest/download', requireUser, asyncRoute(async (_req, res) => {
  const [rows] = await pool.query('SELECT file_name,storage_name,size_bytes FROM sa_release WHERE active=TRUE ORDER BY created_at DESC LIMIT 1');
  if (!rows.length) throw new HttpError(404, 'No desktop release has been published yet.');
  const releasePath = path.join(RELEASE_DIR, path.basename(rows[0].storage_name));
  await fs.access(releasePath).catch(() => { throw new HttpError(404, 'The published installer file is missing.'); });
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Length': String(rows[0].size_bytes) });
  res.download(releasePath, path.basename(rows[0].file_name));
}));

app.post('/api/admin/releases', requireUser, requireAdmin, upload.single('installer'), cleanupUploadedFile, asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose an installer file.');
  const version = requireJsonString(req.body?.version, 40, 'Version');
  const changelog = requireJsonString(req.body?.changelog, 2000, 'Release notes', false);
  const originalName = path.basename(req.file.originalname).replace(/[\r\n"\\/]/g, '_').slice(0, 255);
  const allowedExtensions = new Set(['.exe', '.msi', '.dmg', '.pkg', '.appimage', '.zip']);
  if (!allowedExtensions.has(path.extname(originalName).toLowerCase())) {
    await fs.rm(req.file.path, { force: true });
    throw new HttpError(400, 'Upload an EXE, MSI, DMG, PKG, AppImage, or ZIP installer.');
  }
  const id = newId();
  const storageName = `${id}${path.extname(originalName).toLowerCase()}`;
  const finalPath = path.join(RELEASE_DIR, storageName);
  try {
    await fs.mkdir(RELEASE_DIR, { recursive: true });
    await fs.rename(req.file.path, finalPath);
    await withTransaction(async connection => {
      await connection.query('UPDATE sa_release SET active=FALSE WHERE active=TRUE');
      await connection.query(`INSERT INTO sa_release(id,version,file_name,storage_name,size_bytes,changelog,active,created_by)
        VALUES(?,?,?,?,?,?,TRUE,?)`, [id, version, originalName, storageName, req.file.size, changelog, req.auth.id]);
    });
  } catch (error) {
    await fs.rm(req.file.path, { force: true });
    await fs.rm(finalPath, { force: true });
    throw error;
  }
  res.status(201).json({ id, version, fileName: originalName, message: 'Desktop release published.' });
}));

app.delete('/api/admin/releases/:releaseId', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = validId(req.params.releaseId);
  const [rows] = await pool.query('SELECT storage_name FROM sa_release WHERE id=?', [id]);
  if (!rows.length) throw new HttpError(404, 'Release was not found.');
  await pool.query('DELETE FROM sa_release WHERE id=?', [id]);
  await fs.rm(path.join(RELEASE_DIR, path.basename(rows[0].storage_name)), { force: true });
  res.json({ message: 'Release removed.' });
}));

app.get(['/admin', '/login'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route was not found.' }));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return sendFailure(res, new HttpError(400, error.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is larger than the allowed limit.' : 'Upload request is invalid.'));
  return sendFailure(res, error);
});

async function bootstrapAdmin() {
  const username = process.env.SA_BOOTSTRAP_ADMIN;
  const password = process.env.SA_BOOTSTRAP_PASSWORD;
  if (!username && !password) {
    const [admins] = await pool.query("SELECT id FROM sa_user WHERE role='ADMIN' AND active=TRUE LIMIT 1");
    if (!admins.length && process.env.NODE_ENV === 'production') {
      throw new Error('No active administrator exists. Set SA_BOOTSTRAP_ADMIN and SA_BOOTSTRAP_PASSWORD to initialize one.');
    }
    if (!admins.length) console.warn('No bootstrap administrator configured. Set SA_BOOTSTRAP_ADMIN and SA_BOOTSTRAP_PASSWORD before deployment.');
    return;
  }
  if (!username || !password || password.length < 14) throw new Error('Set SA_BOOTSTRAP_ADMIN and a SA_BOOTSTRAP_PASSWORD of at least 14 characters.');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('SA_BOOTSTRAP_PASSWORD must not exceed 72 UTF-8 bytes.');
  const safeUsername = normalizeUsername(username);
  const [admins] = await pool.query("SELECT id FROM sa_user WHERE role='ADMIN' AND active=TRUE LIMIT 1");
  if (admins.length) return;
  const [existing] = await pool.query('SELECT id,role FROM sa_user WHERE username=? LIMIT 1', [safeUsername]);
  if (existing.length) throw new Error('Bootstrap username already belongs to a non-admin account; choose a dedicated administrator username.');
  const id = newId();
  await withTransaction(async connection => {
    await connection.query('INSERT INTO sa_user(id,username,password_hash,role,active) VALUES(?,?,?,\'ADMIN\',TRUE)',
      [id, safeUsername, await passwordHash(password)]);
    await connection.query('INSERT INTO sa_wallet(user_id,balance_paisa) VALUES(?,0)', [id]);
  });
  console.info(`Bootstrap administrator "${safeUsername}" created.`);
}

async function start() {
  if (process.env.NODE_ENV === 'production') {
    const configured = ['SA_DB_HOST', 'SA_DB_NAME', 'SA_DB_USER', 'SA_DB_PASSWORD', 'SA_STORAGE_DIR'];
    const missing = configured.filter(name => !process.env[name]);
    if (missing.length) throw new Error(`Production configuration is missing: ${missing.join(', ')}.`);
  }
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(RELEASE_DIR, { recursive: true });
  await initializeDatabase();
  await bootstrapAdmin();
  const server = app.listen(PORT, () => console.info(`Smart Automation cloud service listening on port ${PORT}.`));
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch(error => {
    console.error('Could not start Smart Automation cloud service:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
