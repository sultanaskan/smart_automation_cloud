'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let csrfToken = '';
let currentUser = null;
let appData = { marketplace: { workflows: [], packages: [] }, subscriptions: [], wallet: { balance: '0.00', ledger: [], topups: [] }, requests: [], release: null, learning: [], admin: null };
const learningExpanded = {};
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function money(value) { return `৳${Number(value || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function dateText(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3400);
}
function showPurchaseDialog({ name, price, durationDays, renewal = false, insufficient = false }) {
  const dialog = $('#purchaseDialog');
  const content = $('#purchaseDialogContent');
  const balance = Number(appData.wallet.balance || 0);
  const cost = Number(price || 0);
  const gap = Math.max(0, cost - balance);
  content.innerHTML = insufficient
    ? `<div class="purchase-dialog-icon warning">৳</div><p class="eyebrow">WALLET BALANCE TOO LOW</p><h2 id="purchaseDialogTitle">Add funds to continue</h2><p class="purchase-dialog-copy"><strong>${escapeHtml(name)}</strong> costs ${money(cost)}, but your wallet has ${money(balance)}${gap ? `; you need at least ${money(gap)} more` : ''}.</p><ol class="topup-guide"><li>Open your Wallet and enter the amount you need.</li><li>Add your payment transaction ID or reference.</li><li>Send the request and wait for the administrator to approve it.</li><li>After your balance is credited, return and buy this ${renewal ? 'renewal' : 'product'}.</li></ol><div class="purchase-dialog-actions"><button type="button" class="button subtle" data-dialog-action="cancel">Cancel</button><button type="button" class="button primary" data-dialog-action="wallet">Open Wallet <span>→</span></button></div>`
    : `<div class="purchase-dialog-icon">${renewal ? '↻' : '◇'}</div><p class="eyebrow">${renewal ? 'SUBSCRIPTION RENEWAL' : 'PURCHASE CONFIRMATION'}</p><h2 id="purchaseDialogTitle">${renewal ? 'Confirm renewal' : 'Confirm purchase'}</h2><p class="purchase-dialog-copy">You are ${renewal ? 'renewing' : 'buying'} <strong>${escapeHtml(name)}</strong> for <strong>${money(cost)}</strong>${durationDays ? ` with ${escapeHtml(durationDays)} days of access` : ''}.</p><div class="purchase-summary"><span>Available balance</span><strong>${money(balance)}</strong><span>After purchase</span><strong>${money(Math.max(0, balance - cost))}</strong></div><p class="purchase-dialog-note">Your wallet will be charged only after you confirm.</p><div class="purchase-dialog-actions"><button type="button" class="button subtle" data-dialog-action="cancel">Cancel</button><button type="button" class="button primary" data-dialog-action="confirm">Confirm and Pay ${money(cost)}</button></div>`;
  dialog.showModal();
  return new Promise(resolve => {
    const onClick = event => {
      const action = event.target.closest('[data-dialog-action]')?.dataset.dialogAction;
      if (!action) return;
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('close', onClose);
      dialog.close();
      resolve(action);
    };
    const onClose = () => {
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('close', onClose);
      resolve('cancel');
    };
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', onClose, { once: true });
  });
}
async function api(url, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  let body;
  if (options.form) body = options.form;
  else if (options.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(options.json); }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken && url !== '/api/auth/login') {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(url, { method, headers, body, credentials: 'same-origin' });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
  return result;
}
function showAuth(message = '') {
  currentUser = null;
  csrfToken = '';
  $('#appShell').hidden = true;
  $('#authScreen').hidden = false;
  $('#authMessage').textContent = message;
}
function showApp(user) {
  currentUser = user;
  csrfToken = user.csrfToken || csrfToken;
  $('#authScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#headerName').textContent = user.displayName || user.username;
  $('#headerRole').textContent = user.role === 'ADMIN' ? 'Administrator' : 'Member';
  $('#userAvatar').textContent = (user.displayName || user.username || 'U').trim().slice(0, 1).toUpperCase();
  $('#welcomeTitle').textContent = `Welcome, ${user.displayName || user.username}`;
  $('#adminNavWrap').hidden = user.role !== 'ADMIN';
  $('#profileForm [name="username"]').value = user.username || '';
  $('#profileForm [name="displayName"]').value = user.displayName || '';
  const currentPasswordLabel = $('#currentPasswordLabel');
  const currentPassword = currentPasswordLabel.querySelector('input');
  currentPassword.required = !user.googleLinked;
  currentPasswordLabel.hidden = Boolean(user.googleLinked);
  $('#passwordHeading').textContent = user.googleLinked ? 'Set a desktop password' : 'Change password';
  $('#passwordSubmit').textContent = user.googleLinked ? 'Set password' : 'Update password';
  $('#passwordHelp').textContent = user.googleLinked
    ? 'Optional: set a password here if you also want to sign in to the desktop app with your account.'
    : 'For your security, password change signs out all devices.';
}
function emptyState(title, detail, className = '') {
  return `<div class="empty-state ${className}"><strong>${escapeHtml(title)}</strong>${escapeHtml(detail || '')}</div>`;
}
function rowIcon(text) { return `<span class="row-icon" aria-hidden="true">${escapeHtml(text)}</span>`; }

function setView(name) {
  if (name === 'admin' && currentUser?.role !== 'ADMIN') name = 'overview';
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  const labels = { overview: ['YOUR WORKSPACE', 'Overview'], marketplace: ['WORKFLOW CATALOG', 'Marketplace'], subscriptions: ['YOUR ACCESS', 'Subscriptions'], wallet: ['WALLET', 'Wallet'], requests: ['CUSTOM REQUESTS', 'Package requests'], downloads: ['DESKTOP CLIENT', 'Desktop app'], account: ['PROFILE & SECURITY', 'Account settings'], admin: ['CONTROL CENTER', 'Admin console'] };
  $('#pageEyebrow').textContent = labels[name]?.[0] || 'SMART AUTOMATION';
  $('#pageTitle').textContent = labels[name]?.[1] || 'Workspace';
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function renderOverview() {
  const active = appData.subscriptions.filter(item => item.active);
  const pending = appData.requests.filter(item => item.status === 'PENDING').length;
  $('#statSubscriptions').textContent = String(active.length);
  $('#statBalance').textContent = money(appData.wallet.balance);
  $('#headerBalance').textContent = money(appData.wallet.balance);
  $('#statRequests').textContent = String(pending);
  $('#statRelease').textContent = appData.release?.version || '—';
  $('#overviewSubscriptions').innerHTML = active.length ? active.slice(0, 5).map(item => `
    <div class="compact-row">${rowIcon('▣')}<div class="row-copy"><strong>${escapeHtml(item.workflowName)}</strong><small>Active until ${escapeHtml(dateText(item.expiresAt))}</small></div><span class="state-pill">ACTIVE</span></div>`).join('') : emptyState('No active workflows', 'Browse the marketplace to get started.');
  const ledger = appData.wallet.ledger.slice(0, 5);
  $('#overviewLedger').innerHTML = ledger.length ? ledger.map(renderLedgerRow).join('') : emptyState('No wallet activity yet', 'Approved top-ups and purchases will show here.');
}

function renderLearningCard(item) {
  const details = item.contentType === 'VIDEO'
    ? `<a class="learning-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>${item.body ? `<details><summary>Video notes</summary><div class="learning-body">${escapeHtml(item.body)}</div></details>` : ''}`
    : `<details><summary>${item.contentType === 'TUTORIAL' ? 'Open tutorial' : 'Read post'}</summary><div class="learning-body">${escapeHtml(item.body)}</div>${item.url ? `<a class="learning-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open related link ↗</a>` : ''}</details>`;
  return `<article class="learning-card"><div class="learning-card-top"><span class="product-type">${item.contentType === 'VIDEO' ? 'YOUTUBE' : escapeHtml(item.contentType)}</span><small>${escapeHtml(dateText(item.updatedAt || item.createdAt))}</small></div><h4>${escapeHtml(item.title)}</h4>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}${details}</article>`;
}

function renderLearning() {
  const items = appData.learning || [];
  const groups = [
    ['TUTORIAL', '#dashboardTutorials', 'No tutorials yet'],
    ['VIDEO', '#dashboardVideos', 'No videos yet'],
    ['BLOG', '#dashboardBlogs', 'No blog posts yet']
  ];
  for (const [type, selector, emptyText] of groups) {
    const entries = items.filter(item => item.contentType === type);
    const panel = $(selector).closest('.learning-section');
    let toggle = $('.learning-toggle', panel);
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'text-button learning-toggle'; toggle.dataset.learningToggle = type;
      $('.panel-heading', panel).append(toggle);
    }
    toggle.hidden = entries.length <= 3;
    toggle.textContent = learningExpanded[type] ? 'Show fewer' : `View all (${entries.length})`;
    const visibleEntries = learningExpanded[type] ? entries : entries.slice(0, 3);
    $(selector).innerHTML = visibleEntries.length ? visibleEntries.map(renderLearningCard).join('')
      : emptyState(emptyText, 'New learning resources from your administrator will appear here.');
  }
}

function renderLedgerRow(item) {
  const positive = !String(item.deltaPaisa ?? '').startsWith('-');
  const signed = `${positive ? '+' : ''}${money(item.amount)}`;
  return `<div class="activity-row">${rowIcon(positive ? '↙' : '↗')}<div class="row-copy"><strong>${escapeHtml(item.description || item.event_type || 'Wallet transaction')}</strong><small>${escapeHtml(dateText(item.created_at))}</small></div><div class="row-end"><strong class="${positive ? 'activity-positive' : 'activity-negative'}">${escapeHtml(signed)}</strong><small>${escapeHtml(item.event_type || '')}</small></div></div>`;
}

function renderMarketplace() {
  const search = ($('#marketSearch').value || '').trim().toLowerCase();
  const products = [
    ...appData.marketplace.workflows.map(item => ({ ...item, productType: 'WORKFLOW', icon: '◇' })),
    ...appData.marketplace.packages.map(item => ({ ...item, productType: 'PACKAGE', icon: '▣' }))
  ].filter(item => !search || `${item.name} ${item.description} ${item.workflowNames || ''}`.toLowerCase().includes(search));
  const target = $('#marketplaceContent');
  if (!products.length) {
    target.innerHTML = emptyState(search ? 'No matching listings' : 'Marketplace is getting ready', search ? 'Try another name or keyword.' : 'Published workflows and packages will appear here.', 'catalog-empty');
    return;
  }
  target.innerHTML = products.map(item => `
    <article class="product-card">
      <div class="product-top"><span class="product-type">${item.productType === 'PACKAGE' ? 'CURATED PACKAGE' : 'WORKFLOW'}</span>${item.owned ? '<span class="state-pill">PURCHASED</span>' : ''}</div>
      <h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || (item.workflowNames ? `Includes: ${item.workflowNames}` : 'A Smart Automation workflow subscription.'))}</p>
      <div class="product-meta"><span>${item.productType === 'WORKFLOW' ? `Version ${escapeHtml(item.version)}` : `${escapeHtml(item.workflowCount)} workflows`}</span><span>${escapeHtml(item.durationDays)} days access</span><span>${item.canEdit ? 'View · Run · Edit' : 'View · Run'}</span></div>
      <div class="product-bottom"><div class="product-price"><strong>${money(item.price)}</strong><small>for ${escapeHtml(item.durationDays)} days</small></div><button type="button" class="purchase-button ${item.owned ? 'secondary' : 'primary'}" data-buy="${item.productType}" data-id="${escapeHtml(item.id)}" ${item.owned ? 'disabled aria-disabled="true"' : ''} aria-label="${item.owned ? 'Already purchased' : 'Buy'} ${escapeHtml(item.name)}">${item.owned ? 'Purchased' : 'Buy'} <span aria-hidden="true">${item.owned ? '✓' : '→'}</span></button></div>
    </article>`).join('');
}

function renderSubscriptions() {
  const target = $('#subscriptionsContent');
  const cards = [];
  const packageGroups = new Map();
  for (const item of appData.subscriptions) {
    if (item.source === 'PACKAGE') {
      const key = item.productId;
      if (!packageGroups.has(key)) packageGroups.set(key, []);
      packageGroups.get(key).push(item);
    } else cards.push({ ...item, productType: item.source, renewType: item.source, renewId: item.source === 'WORKFLOW' ? item.productId : null });
  }
  for (const [productId, items] of packageGroups) {
    const sorted = [...items].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
    cards.push({ ...sorted[0], source: 'PACKAGE', productType: 'PACKAGE', productId, renewType: 'PACKAGE', renewId: productId,
      workflowName: `${items.length} workflow${items.length === 1 ? '' : 's'}: ${items.map(item => item.workflowName).join(' · ')}`,
      active: items.every(item => item.active), expiresAt: sorted[0].expiresAt, canEdit: items.every(item => item.canEdit) });
  }
  if (!cards.length) {
    target.innerHTML = emptyState('No workflow access yet', 'Purchase a workflow or package from the marketplace.', 'catalog-empty');
    return;
  }
  target.innerHTML = cards.map(item => `
    <article class="subscription-card"><div class="product-top"><span class="product-type">${escapeHtml(item.source || 'WORKFLOW')}</span><span class="state-pill ${item.active ? '' : 'expired'}">${item.active ? 'ACTIVE' : 'EXPIRED'}</span></div>
      <h3>${escapeHtml(item.workflowName)}</h3><p>${escapeHtml(item.description || 'Cloud workflow definition')} · version ${escapeHtml(item.version)}</p>
      <div class="product-meta"><span>${item.canEdit ? 'View · Run · Edit' : 'View · Run'}</span><span>Subscription access</span></div>
      <div class="expires">${item.active ? 'Expires' : 'Expired'} ${escapeHtml(dateText(item.expiresAt))}</div>
      ${!item.active && item.renewId ? `<button type="button" class="button primary renew" data-buy="${escapeHtml(item.renewType)}" data-id="${escapeHtml(item.renewId)}" data-renewal="true">Renew subscription <span>→</span></button>` : ''}
    </article>`).join('');
}

function renderWallet() {
  $('#walletBalance').textContent = money(appData.wallet.balance);
  $('#headerBalance').textContent = money(appData.wallet.balance);
  $('#walletLedger').innerHTML = appData.wallet.ledger.length ? appData.wallet.ledger.map(renderLedgerRow).join('') : emptyState('No transactions', 'Your wallet ledger is currently empty.');
  $('#topupHistory').innerHTML = appData.wallet.topups.length ? appData.wallet.topups.map(item => `
    <div class="compact-row">${rowIcon('↙')}<div class="row-copy"><strong>${money(item.amount)} top-up request</strong><small>${escapeHtml(item.payment_reference)} · ${escapeHtml(dateText(item.created_at))}</small></div><span class="state-pill ${item.status === 'REJECTED' ? 'expired' : ''}">${escapeHtml(item.status)}</span></div>`).join('') : emptyState('No top-up requests', 'You can submit a request above.');
}

function renderRequests() {
  $('#statRequests').textContent = String(appData.requests.filter(item => item.status === 'PENDING').length);
  $('#packageRequestHistory').innerHTML = appData.requests.length ? appData.requests.map(item => `
    <div class="compact-row">${rowIcon('↗')}<div class="row-copy"><strong>${escapeHtml(item.requestedName)}</strong><small>${escapeHtml(item.message)} · ${escapeHtml(dateText(item.createdAt))}${item.adminResponse ? ` · Admin: ${escapeHtml(item.adminResponse)}` : ''}</small></div><span class="state-pill ${item.status === 'DECLINED' ? 'expired' : ''}">${escapeHtml(item.status)}</span></div>`).join('') : emptyState('No package requests', 'Submitted requests and admin replies appear here.');
}

function renderRelease() {
  const release = appData.release;
  $('#releaseCard').innerHTML = release ? `
    <div class="release-icon">↓</div><div><p class="eyebrow">LATEST DESKTOP VERSION</p><h3>Smart Automation ${escapeHtml(release.version)}</h3><p>${escapeHtml(release.changelog || 'The latest desktop installer is ready.')}</p><p>${escapeHtml(release.fileName)} · ${escapeHtml((Number(release.sizeBytes) / (1024 * 1024)).toFixed(1))} MB · ${escapeHtml(dateText(release.createdAt))}</p><a class="button primary" href="/api/releases/latest/download">Download installer <span>↓</span></a></div>`
    : `<div class="release-icon">↓</div><div><p class="eyebrow">LATEST DESKTOP VERSION</p><h3>No release published yet</h3><p>An administrator will publish the installer here when it is ready.</p></div>`;
}

function renderAdmin() {
  const admin = appData.admin;
  if (!admin) return;
  $('#pendingTopupCount').textContent = String(admin.topups.filter(item => item.status === 'PENDING').length);
  $('#pendingRequestCount').textContent = String(admin.packageRequests.filter(item => item.status === 'PENDING').length);
  $('#pendingSignupCount').textContent = String((admin.signupRequests || []).filter(item => item.status === 'PENDING').length);
  $('#adminUsers').innerHTML = `<table class="admin-table"><thead><tr><th>User</th><th>Role</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead><tbody>${admin.users.map(user => `
    <tr><td><strong>${escapeHtml(user.displayName || user.username)}</strong><small>${escapeHtml(user.username)}</small></td><td>${escapeHtml(user.role)}</td><td>${money(user.balance)}</td><td>${user.active ? 'Active' : 'Disabled'}</td><td><button class="mini-button" data-admin-action="user-transactions" data-id="${escapeHtml(user.id)}">Transactions</button> ${user.id === currentUser.id ? '' : `<button class="mini-button ${user.active ? 'danger' : ''}" data-admin-action="user-status" data-id="${escapeHtml(user.id)}" data-active="${!user.active}">${user.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}</tbody></table>`;
  const signupRequests = admin.signupRequests || [];
  $('#adminSignupRequests').innerHTML = signupRequests.length ? signupRequests.map(item => `
    <article class="admin-item"><div class="admin-item-main"><h4>${escapeHtml(item.displayName || item.email)} <span class="state-pill">${item.google ? 'GOOGLE' : 'PUBLIC SIGNUP'}</span></h4><p>${escapeHtml(item.email)}${item.username ? ` · username: ${escapeHtml(item.username)}` : ''}</p><div class="admin-item-meta"><span>${escapeHtml(item.status)}</span><span>Requested ${escapeHtml(dateText(item.createdAt))}</span></div></div><div class="admin-item-actions">${item.status === 'PENDING' ? `<button class="mini-button approve" data-admin-action="signup-review" data-id="${escapeHtml(item.id)}" data-decision="APPROVE">Approve & create account</button><button class="mini-button reject" data-admin-action="signup-review" data-id="${escapeHtml(item.id)}" data-decision="REJECT">Reject</button>` : ''}</div></article>`).join('') : emptyState('No signup requests', 'Google and public signup requests will appear here after users submit them.');
  const choices = admin.workflows.filter(item => item.published);
  $('#packageWorkflowChoices').innerHTML = choices.length ? choices.map(item => `<label><input type="checkbox" name="workflowIds" value="${escapeHtml(item.id)}">${escapeHtml(item.name)} <span class="muted">v${escapeHtml(item.version)}</span></label>`).join('') : emptyState('No workflows published', 'Publish a workflow first.');
  const userSelect = $('#grantForm select[name="userId"]');
  const workflowSelect = $('#grantForm select[name="workflowId"]');
  userSelect.innerHTML = `<option value="">Choose user</option>${admin.users.filter(user => user.active).map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`).join('')}`;
  workflowSelect.innerHTML = `<option value="">Choose workflow</option>${choices.map(workflow => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)}</option>`).join('')}`;
  renderAdminListings(admin);
  $('#adminTopups').innerHTML = admin.topups.length ? admin.topups.map(item => `
    <article class="admin-item"><div class="admin-item-main"><h4>${escapeHtml(item.username)} · ${money(item.amount)}</h4><p>${escapeHtml(item.paymentReference)}</p><div class="admin-item-meta"><span>${escapeHtml(item.status)}</span><span>Submitted ${escapeHtml(dateText(item.createdAt))}</span>${item.adminNote ? `<span>${escapeHtml(item.adminNote)}</span>` : ''}</div></div><div class="admin-item-actions">${item.status === 'PENDING' ? `<button class="mini-button approve" data-admin-action="topup-review" data-id="${escapeHtml(item.id)}" data-decision="APPROVE">Approve</button><button class="mini-button reject" data-admin-action="topup-review" data-id="${escapeHtml(item.id)}" data-decision="REJECT">Reject</button>` : ''}</div></article>`).join('') : emptyState('No top-up requests', 'New requests will appear here.');
  $('#adminRequests').innerHTML = admin.packageRequests.length ? admin.packageRequests.map(item => `
    <article class="admin-item"><div class="admin-item-main"><h4>${escapeHtml(item.requestedName)} <span class="muted">· ${escapeHtml(item.username)}</span></h4><p>${escapeHtml(item.message)}</p><div class="admin-item-meta"><span>${escapeHtml(item.status)}</span><span>${escapeHtml(dateText(item.createdAt))}</span>${item.adminResponse ? `<span>Reply: ${escapeHtml(item.adminResponse)}</span>` : ''}</div></div><div class="admin-item-actions">${item.status === 'PENDING' ? `<button class="mini-button approve" data-admin-action="request-review" data-id="${escapeHtml(item.id)}" data-status="REVIEWED">Review</button><button class="mini-button reject" data-admin-action="request-review" data-id="${escapeHtml(item.id)}" data-status="DECLINED">Decline</button><button class="mini-button" data-admin-action="request-review" data-id="${escapeHtml(item.id)}" data-status="FULFILLED">Fulfilled</button>` : ''}</div></article>`).join('') : emptyState('No package requests', 'Customer requests will appear here.');
  $('#adminGrants').innerHTML = admin.grants.length ? admin.grants.map(item => `
    <article class="admin-item"><div class="admin-item-main"><h4>${escapeHtml(item.workflowName)} · ${escapeHtml(item.username)}</h4><div class="admin-item-meta"><span>${[item.canView && 'View', item.canRun && 'Run', item.canEdit && 'Edit'].filter(Boolean).join(' · ')}</span><span>Until ${escapeHtml(dateText(item.expiresAt))}</span></div></div><div class="admin-item-actions"><button class="mini-button danger" data-admin-action="revoke-grant" data-user-id="${escapeHtml(item.userId)}" data-workflow-id="${escapeHtml(item.workflowId)}">Revoke</button></div></article>`).join('') : emptyState('No manual grants', 'Temporary complimentary access grants appear here.');
  $('#adminReleases').innerHTML = admin.releases.length ? admin.releases.map(item => `
    <article class="admin-item"><div class="admin-item-main"><h4>Version ${escapeHtml(item.version)} ${item.active ? '<span class="state-pill">CURRENT</span>' : ''}</h4><p>${escapeHtml(item.fileName)} · ${(Number(item.sizeBytes) / (1024 * 1024)).toFixed(1)} MB</p><div class="admin-item-meta"><span>${escapeHtml(dateText(item.createdAt))}</span><span>${escapeHtml(item.changelog)}</span></div></div><div class="admin-item-actions"><button class="mini-button danger" data-admin-action="delete-release" data-id="${escapeHtml(item.id)}">Delete</button></div></article>`).join('') : emptyState('No desktop release', 'Upload an installer to make it available to users.');
  renderAdminLearning(admin.learning || []);
}

function renderAdminLearning(items) {
  $('#adminLearningContent').innerHTML = items.length ? items.map(item => `
    <article class="admin-item learning-admin-item"><div class="admin-item-main"><h4>${escapeHtml(item.title)} <span class="state-pill ${item.published ? '' : 'expired'}">${item.published ? 'PUBLISHED' : 'DRAFT'}</span></h4><form class="learning-edit" data-id="${escapeHtml(item.id)}"><select name="contentType" aria-label="Content type"><option value="TUTORIAL" ${item.contentType === 'TUTORIAL' ? 'selected' : ''}>Tutorial</option><option value="VIDEO" ${item.contentType === 'VIDEO' ? 'selected' : ''}>YouTube video</option><option value="BLOG" ${item.contentType === 'BLOG' ? 'selected' : ''}>Blog post</option></select><input name="title" aria-label="Title" maxlength="200" value="${escapeHtml(item.title)}" required><textarea name="summary" aria-label="Short summary" maxlength="500" rows="2" placeholder="Short summary">${escapeHtml(item.summary)}</textarea><textarea name="body" aria-label="Content or video notes" maxlength="20000" rows="5" placeholder="Tutorial or blog text; optional notes for a video">${escapeHtml(item.body)}</textarea><input name="url" type="url" aria-label="HTTPS link or YouTube URL" maxlength="1000" value="${escapeHtml(item.url)}" placeholder="HTTPS related link or YouTube URL"><label class="check-label"><input name="published" type="checkbox" ${item.published ? 'checked' : ''}>Visible to users</label><button class="button secondary">Save changes</button></form></div><div class="admin-item-actions"><button class="mini-button danger" data-admin-action="delete-learning" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.title)}">Delete</button></div></article>`).join('') : emptyState('No learning content yet', 'Publish tutorials, YouTube videos, and blog posts for users.');
}

function renderAdminListings(admin) {
  const workflowCards = admin.workflows.map(workflow => `
    <article class="admin-item listing-edit"><div class="admin-item-main"><h4>${escapeHtml(workflow.name)} <span class="muted">v${escapeHtml(workflow.version)}</span></h4><p>${escapeHtml(workflow.description)}</p><form class="inline-edit workflow-edit" data-id="${escapeHtml(workflow.id)}"><input name="description" aria-label="Description" value="${escapeHtml(workflow.description)}" placeholder="Description"><input name="price" type="number" min="0" step="0.01" aria-label="Price in BDT" value="${escapeHtml(workflow.price)}"><input name="durationDays" type="number" min="1" max="3650" aria-label="Subscription days" value="${escapeHtml(workflow.durationDays)}"><label class="check-label"><input name="canEdit" type="checkbox" ${workflow.canEdit ? 'checked' : ''}>Edit</label><button class="button secondary">Save</button><label class="check-label"><input name="published" type="checkbox" ${workflow.published ? 'checked' : ''}>Listed</label></form></div><div class="admin-item-actions"><button class="mini-button danger" data-admin-action="delete-workflow" data-id="${escapeHtml(workflow.id)}" data-name="${escapeHtml(workflow.name)}">Delete</button></div></article>`).join('');
  const packageCards = admin.packages.map(item => `
    <article class="admin-item listing-edit"><div class="admin-item-main"><h4>${escapeHtml(item.name)} <span class="muted">PACKAGE</span></h4><p>${escapeHtml(item.description)}</p><form class="inline-edit package-edit" data-id="${escapeHtml(item.id)}"><input name="name" aria-label="Package name" value="${escapeHtml(item.name)}"><input name="description" aria-label="Package description" value="${escapeHtml(item.description)}"><input name="price" type="number" min="0" step="0.01" aria-label="Price" value="${escapeHtml(item.price)}"><input name="durationDays" type="number" min="1" max="3650" aria-label="Duration" value="${escapeHtml(item.durationDays)}"><button class="button secondary">Save</button><label class="check-label"><input name="canEdit" type="checkbox" ${item.canEdit ? 'checked' : ''}>Edit</label><label class="check-label"><input name="active" type="checkbox" ${item.active ? 'checked' : ''}>Listed</label>${admin.workflows.filter(workflow => workflow.published).map(workflow => `<label class="check-label"><input name="workflowIds" type="checkbox" value="${escapeHtml(workflow.id)}" ${item.workflowIds.includes(workflow.id) ? 'checked' : ''}>${escapeHtml(workflow.name)}</label>`).join('')}</form></div><div class="admin-item-actions"><button class="mini-button danger" data-admin-action="delete-package" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">Delete</button></div></article>`).join('');
  $('#adminListings').innerHTML = `${workflowCards || emptyState('No workflows published', 'Upload a workflow package above.')} ${packageCards}`;
}

function renderAll() {
  renderOverview(); renderLearning(); renderMarketplace(); renderSubscriptions(); renderWallet(); renderRequests(); renderRelease(); renderAdmin();
}

async function refreshData() {
  const requests = [
    api('/api/marketplace'), api('/api/subscriptions'), api('/api/wallet'), api('/api/package-requests'), api('/api/releases/latest'), api('/api/learning')
  ];
  if (currentUser.role === 'ADMIN') requests.push(api('/api/admin/overview'));
  const results = await Promise.allSettled(requests);
  const keys = ['marketplace', 'subscriptions', 'wallet', 'requests', 'release', 'learning', 'admin'];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') appData[keys[index]] = result.value;
    else if (keys[index] === 'release' && result.reason.message.includes('No desktop release')) appData.release = null;
    else if (keys[index] === 'admin') toast(result.reason.message, true);
  });
  renderAll();
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function setBusy(form, busy) { const button = $('button[type="submit"],button:not([type])', form); if (button) button.disabled = busy; }
async function withForm(form, action, successMessage) {
  setBusy(form, true);
  try { await action(); if (successMessage) toast(successMessage); }
  catch (error) { toast(error.message, true); }
  finally { setBusy(form, false); }
}

function setupAuth() {
  $('#loginForm').addEventListener('submit', event => {
    event.preventDefault(); const values = formObject(event.currentTarget); $('#authMessage').textContent = '';
    withForm(event.currentTarget, async () => {
      const result = await api('/api/auth/login', { method: 'POST', json: values });
      csrfToken = result.csrfToken;
      const user = await api('/api/auth/session'); showApp(user); setView(location.hash.slice(1) || 'overview'); await refreshData();
    });
  });
  $('#signupForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    $('#authMessage').textContent = '';
    setBusy(form, true);
    try {
      const result = await api('/api/auth/signup', { method: 'POST', json: formObject(form) });
      form.reset();
      $('#authMessage').textContent = result.message;
    } catch (error) {
      $('#authMessage').textContent = error.message;
    } finally {
      setBusy(form, false);
    }
  });
}

async function setupGoogleAuth() {
  const config = await api('/api/auth/config');
  const phoneDigits = String(config.adminWhatsApp || '').replace(/\D/g, '');
  const whatsappNumber = phoneDigits.startsWith('0') ? `88${phoneDigits}` : phoneDigits;
  $('#authWhatsApp').href = `https://wa.me/${encodeURIComponent(whatsappNumber)}`;
  $('#authWhatsApp').textContent = `WhatsApp: ${config.adminWhatsApp}`;
  $('#authEmail').href = `mailto:${encodeURIComponent(config.adminEmail)}`;
  $('#authEmail').textContent = `Email: ${config.adminEmail}`;
  if (!config.googleClientId) {
    $('#googleSignInNote').textContent = 'Google account signup and sign-in will be available after the administrator configures Google OAuth.';
    $('#googleSignIn').hidden = true;
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    if (!window.google?.accounts?.id) { $('#googleSignInNote').textContent = 'Google sign-in could not load. Check your internet connection and retry.'; return; }
    window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: async ({ credential }) => {
      $('#authMessage').textContent = 'Checking your Google account…';
      try {
        const result = await api('/api/auth/google', { method: 'POST', json: { credential } });
        if (result.status === 'PENDING') { $('#authMessage').textContent = result.message; return; }
        csrfToken = result.csrfToken;
        const user = await api('/api/auth/session');
        showApp(user); setView(location.hash.slice(1) || 'overview'); await refreshData();
      } catch (error) { $('#authMessage').textContent = error.message; }
    } });
    window.google.accounts.id.renderButton($('#googleSignIn'), { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 320 });
  };
  script.onerror = () => { $('#googleSignInNote').textContent = 'Google sign-in could not load. Check your internet connection and retry.'; };
  document.head.append(script);
}

function setupForms() {
  $('#learningContentForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget; const values = formObject(form);
    values.published = $('[name="published"]', form).checked;
    withForm(form, async () => {
      await api('/api/admin/learning', { method: 'POST', json: values });
      form.reset(); $('[name="published"]', form).checked = true; await refreshData();
    }, 'Learning content published.');
  });
  $('#adminLearningContent').addEventListener('submit', event => {
    const form = event.target.closest('.learning-edit');
    if (!form) return;
    event.preventDefault(); const values = formObject(form);
    values.published = $('[name="published"]', form).checked;
    withForm(form, async () => {
      await api(`/api/admin/learning/${form.dataset.id}`, { method: 'POST', json: values });
      await refreshData();
    }, 'Learning content updated.');
  });
  $('#topupForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { await api('/api/wallet/topups', { method: 'POST', json: formObject(form) }); form.reset(); await refreshData(); }, 'Top-up request sent for review.');
  });
  $('#packageRequestForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { await api('/api/package-requests', { method: 'POST', json: formObject(form) }); form.reset(); await refreshData(); }, 'Package request sent.');
  });
  $('#profileForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { await api('/api/account/profile', { method: 'POST', json: formObject(form) }); const user = await api('/api/auth/session'); showApp(user); await refreshData(); }, 'Profile saved.');
  });
  $('#passwordForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { const result = await api('/api/account/password', { method: 'POST', json: formObject(form) }); form.reset(); showAuth(result.message); }, 'Password changed. Please sign in again.');
  });
  $('#adminUserForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { await api('/api/admin/users', { method: 'POST', json: formObject(form) }); form.reset(); await refreshData(); }, 'User created.');
  });
  $('#publishWorkflowForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { const upload = new FormData(form); upload.set('canEdit', $('[name="canEdit"]', form).checked ? 'true' : 'false'); await api('/api/admin/workflows', { method: 'POST', form: upload }); form.reset(); $('#publishWorkflowForm [name="durationDays"]').value = '30'; $('#publishWorkflowForm [name="canEdit"]').checked = true; await refreshData(); }, 'Workflow listing published.');
  });
  $('#adminPackageForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget; const values = formObject(form);
    values.workflowIds = $$('[name="workflowIds"]:checked', form).map(input => input.value); values.canEdit = $('[name="canEdit"]', form).checked;
    withForm(form, async () => { await api('/api/admin/packages', { method: 'POST', json: values }); form.reset(); $('[name="durationDays"]', form).value = '30'; $('[name="canEdit"]', form).checked = true; await refreshData(); }, 'Package published.');
  });
  $('#grantForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget; const values = formObject(form);
    for (const field of ['canView', 'canRun', 'canEdit']) values[field] = $(`[name="${field}"]`, form).checked;
    withForm(form, async () => { await api('/api/admin/grants', { method: 'POST', json: values }); await refreshData(); }, 'Access granted.');
  });
  $('#releaseForm').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    withForm(form, async () => { await api('/api/admin/releases', { method: 'POST', form: new FormData(form) }); form.reset(); await refreshData(); }, 'Desktop release published.');
  });
  $('#adminListings').addEventListener('submit', event => {
    const workflowForm = event.target.closest('.workflow-edit');
    const packageForm = event.target.closest('.package-edit');
    if (!workflowForm && !packageForm) return;
    event.preventDefault();
    const form = event.target; const values = formObject(form);
    if (workflowForm) {
      values.canEdit = $('[name="canEdit"]', form).checked; values.published = $('[name="published"]', form).checked;
      withForm(form, async () => { await api(`/api/admin/workflows/${form.dataset.id}`, { method: 'POST', json: values }); await refreshData(); }, 'Workflow listing updated.');
    } else {
      values.canEdit = $('[name="canEdit"]', form).checked; values.active = $('[name="active"]', form).checked;
      values.workflowIds = $$('[name="workflowIds"]:checked', form).map(input => input.value);
      withForm(form, async () => { await api(`/api/admin/packages/${form.dataset.id}`, { method: 'POST', json: values }); await refreshData(); }, 'Package listing updated.');
    }
  });
}

async function handleAdminAction(button) {
  const action = button.dataset.adminAction;
  if (action === 'signup-review') {
    const decision = button.dataset.decision;
    if (decision === 'APPROVE' && !confirm(`Approve ${button.closest('.admin-item')?.querySelector('.admin-item-main p')?.textContent || 'this Google account'} and create a user account?`)) return;
    const result = await api(`/api/admin/signup-requests/${button.dataset.id}/review`, { method: 'POST', json: { decision } });
    toast(result.message);
  } else if (action === 'user-transactions') {
    const userRow = button.closest('tr');
    const currentDetail = userRow?.nextElementSibling;
    if (currentDetail?.classList.contains('user-ledger-detail')) {
      currentDetail.remove();
      button.textContent = 'Transactions';
      return;
    }
    document.querySelectorAll('.user-ledger-detail').forEach(row => row.remove());
    $$('[data-admin-action="user-transactions"]').forEach(item => { item.textContent = 'Transactions'; });
    button.disabled = true;
    try {
      const result = await api(`/api/admin/users/${button.dataset.id}/transactions`);
      const transactionRows = result.transactions.map(item => {
        const positive = !String(item.amountPaisa).startsWith('-');
        return `<div class="admin-transaction-row"><div><strong>${escapeHtml(item.description)}</strong><small>${escapeHtml(item.eventType)} · ${escapeHtml(dateText(item.createdAt))}</small></div><strong class="${positive ? 'activity-positive' : 'activity-negative'}">${positive ? '+' : ''}${money(item.amount)}</strong></div>`;
      }).join('');
      const topupRows = result.topups.map(item => `<div class="admin-transaction-row"><div><strong>Top-up request · ${escapeHtml(item.status)}</strong><small>${escapeHtml(item.paymentReference)} · ${escapeHtml(dateText(item.createdAt))}${item.adminNote ? ` · ${escapeHtml(item.adminNote)}` : ''}</small></div><strong>${money(item.amount)}</strong></div>`).join('');
      const detail = document.createElement('tr');
      detail.className = 'user-ledger-detail';
      detail.innerHTML = `<td colspan="5"><div class="user-ledger-panel"><h4>${escapeHtml(result.user.displayName || result.user.username)} · Wallet transactions</h4><div class="user-ledger-columns"><section><h5>Balance changes</h5>${transactionRows || emptyState('No wallet transactions', 'Approved deposits and purchases will appear here.')}</section><section><h5>Top-up requests</h5>${topupRows || emptyState('No top-up requests', 'Requests submitted by this user will appear here.')}</section></div></div></td>`;
      userRow.after(detail);
      button.textContent = 'Hide history';
    } finally {
      button.disabled = false;
    }
    return;
  } else if (action === 'user-status') {
    await api(`/api/admin/users/${button.dataset.id}/status`, { method: 'POST', json: { active: button.dataset.active === 'true' } });
    toast(button.dataset.active === 'true' ? 'User enabled.' : 'User disabled.');
  } else if (action === 'topup-review') {
    const note = prompt(`${button.dataset.decision === 'APPROVE' ? 'Approval' : 'Rejection'} note (optional):`) || '';
    await api(`/api/admin/topups/${button.dataset.id}/review`, { method: 'POST', json: { decision: button.dataset.decision, note } }); toast('Top-up request reviewed.');
  } else if (action === 'request-review') {
    const response = prompt('Reply to the customer (optional):') || '';
    await api(`/api/admin/package-requests/${button.dataset.id}/review`, { method: 'POST', json: { status: button.dataset.status, response } }); toast('Package request updated.');
  } else if (action === 'delete-workflow') {
    if (!confirm(`Delete “${button.dataset.name}” and revoke its subscriptions?`)) return;
    await api(`/api/admin/workflows/${button.dataset.id}`, { method: 'DELETE' }); toast('Workflow listing removed.');
  } else if (action === 'delete-package') {
    if (!confirm(`Delete package “${button.dataset.name}”?`)) return;
    await api(`/api/admin/packages/${button.dataset.id}`, { method: 'DELETE' }); toast('Package removed.');
  } else if (action === 'revoke-grant') {
    if (!confirm('Revoke this manual workflow grant?')) return;
    await api(`/api/admin/grants/${button.dataset.userId}/${button.dataset.workflowId}`, { method: 'DELETE' }); toast('Access revoked.');
  } else if (action === 'delete-release') {
    if (!confirm('Delete this installer release?')) return;
    await api(`/api/admin/releases/${button.dataset.id}`, { method: 'DELETE' }); toast('Release removed.');
  } else if (action === 'delete-learning') {
    if (!confirm(`Delete “${button.dataset.name}” from the Learning Center?`)) return;
    await api(`/api/admin/learning/${button.dataset.id}`, { method: 'DELETE' }); toast('Learning content deleted.');
  }
  await refreshData();
}

function setupNavigation() {
  document.addEventListener('click', async event => {
    const learningToggle = event.target.closest('[data-learning-toggle]');
    if (learningToggle) {
      const type = learningToggle.dataset.learningToggle;
      learningExpanded[type] = !learningExpanded[type];
      renderLearning();
    }
    const viewButton = event.target.closest('[data-view], [data-go]');
    if (viewButton) { const next = viewButton.dataset.view || viewButton.dataset.go; if (next) setView(next); }
    const buyButton = event.target.closest('[data-buy]');
    if (buyButton) {
      const productType = buyButton.dataset.buy;
      const productId = buyButton.dataset.id;
      const renewal = buyButton.dataset.renewal === 'true';
      const products = productType === 'PACKAGE' ? appData.marketplace.packages : appData.marketplace.workflows;
      const product = products.find(item => String(item.id) === String(productId));
      if (!product) { toast('This product is no longer available in the marketplace.', true); return; }
      const isInsufficient = Number(appData.wallet.balance || 0) < Number(product.price || 0);
      const action = await showPurchaseDialog({ name: product.name, price: product.price, durationDays: product.durationDays, renewal, insufficient: isInsufficient });
      if (action === 'wallet') { setView('wallet'); return; }
      if (action !== 'confirm') return;
      const idempotencyKey = buyButton.dataset.purchaseKey || crypto.randomUUID().replaceAll('-', '_');
      buyButton.dataset.purchaseKey = idempotencyKey;
      const label = buyButton.textContent; buyButton.disabled = true; buyButton.textContent = 'Processing…';
      api('/api/purchases', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, json: { type: buyButton.dataset.buy, id: buyButton.dataset.id, renewal: buyButton.dataset.renewal === 'true' } })
        .then(async result => { toast(result.message); await refreshData(); })
        .catch(async error => {
          if (error.message.toLowerCase().includes('wallet balance is too low')) {
            try { appData.wallet = await api('/api/wallet'); renderWallet(); } catch { /* Keep the current balance visible if refresh is unavailable. */ }
            const choice = await showPurchaseDialog({ name: product.name, price: product.price, durationDays: product.durationDays, renewal, insufficient: true });
            if (choice === 'wallet') setView('wallet');
          } else toast(error.message, true);
        })
        .finally(() => { if (document.body.contains(buyButton)) { buyButton.disabled = false; buyButton.textContent = label; } });
    }
    const adminButton = event.target.closest('[data-admin]');
    if (adminButton) {
      $$('.admin-tabs button').forEach(item => item.classList.toggle('active', item === adminButton));
      $$('.admin-section').forEach(section => section.classList.toggle('active', section.id === `admin-${adminButton.dataset.admin}`));
    }
    const adminAction = event.target.closest('[data-admin-action]');
    if (adminAction) handleAdminAction(adminAction).catch(error => toast(error.message, true));
    if (event.target.closest('.refresh-admin')) refreshData().then(() => toast('Admin data refreshed.')).catch(error => toast(error.message, true));
  });
  $('#marketSearch').addEventListener('input', renderMarketplace);
  $('#logoutButton').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* Clear local view even if the session expired. */ }
    showAuth('You have signed out.');
  });
}

async function initialize() {
  setupAuth(); setupForms(); setupNavigation();
  setupGoogleAuth().catch(error => { $('#googleSignIn').hidden = true; $('#googleSignInNote').textContent = error.message; });
  $('#profileForm [name="username"]').value = '';
  try {
    const session = await api('/api/auth/session');
    showApp(session);
    $('#profileForm [name="username"]').value = session.username;
    $('#profileForm [name="displayName"]').value = session.displayName || '';
    setView(location.hash.slice(1) || 'overview'); await refreshData();
  } catch { showAuth(); }
}

initialize();
