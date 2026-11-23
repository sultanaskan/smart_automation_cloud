'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { packageStorageName, writeWorkflowPackage } = require('./workflow-storage');

const STORAGE_DIR = path.resolve(process.env.SA_STORAGE_DIR || path.join(__dirname, '..', 'storage'));

const pool = mysql.createPool({
  host: process.env.SA_DB_HOST || process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.SA_DB_PORT || process.env.DB_PORT || 3306),
  database: process.env.SA_DB_NAME || process.env.DB_NAME || 'smart_automation',
  user: process.env.SA_DB_USER || process.env.DB_USER || 'root',
  password: process.env.SA_DB_PASSWORD || process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: Number(process.env.SA_DB_POOL_SIZE || 8),
  queueLimit: 0,
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: 'utf8mb4'
});

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf8');
  for (const statement of schema.split(';').map(part => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  await addColumnIfMissing('sa_user', 'display_name', 'VARCHAR(120) NULL');
  await addColumnIfMissing('sa_workflow', 'price_paisa', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumnIfMissing('sa_workflow', 'subscription_days', 'INT NOT NULL DEFAULT 30');
  await addColumnIfMissing('sa_workflow', 'marketplace_can_edit', 'BOOLEAN NOT NULL DEFAULT TRUE');
  await addColumnIfMissing('sa_workflow', 'published', 'BOOLEAN NOT NULL DEFAULT TRUE');
  await addColumnIfMissing('sa_workflow', 'package_storage_name', 'VARCHAR(300) NULL');
  await addColumnIfMissing('sa_session', 'csrf_token', 'CHAR(64) NULL');
  await addColumnIfMissing('sa_session', 'session_kind', "VARCHAR(12) NOT NULL DEFAULT 'API'");
  await pool.query('ALTER TABLE sa_signup_request MODIFY google_sub VARCHAR(255) NULL');
  await addColumnIfMissing('sa_signup_request', 'username', 'VARCHAR(80) NULL');
  await addColumnIfMissing('sa_signup_request', 'password_hash', 'VARCHAR(100) NULL');
  await upgradeWorkflowPackageBlob();
  await migrateWorkflowPackages();
  await pool.query('INSERT IGNORE INTO sa_wallet(user_id,balance_paisa) SELECT id,0 FROM sa_user');
}

async function addColumnIfMissing(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error.code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

async function upgradeWorkflowPackageBlob() {
  const [rows] = await pool.query(`SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sa_workflow' AND COLUMN_NAME='package_bytes'`);
  if (rows.length && String(rows[0].DATA_TYPE).toLowerCase() !== 'longblob') {
    await pool.query('ALTER TABLE sa_workflow MODIFY package_bytes LONGBLOB NULL');
  } else if (rows.length) {
    const [nullability] = await pool.query(`SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sa_workflow' AND COLUMN_NAME='package_bytes'`);
    if (String(nullability[0]?.IS_NULLABLE).toUpperCase() !== 'YES') {
      await pool.query('ALTER TABLE sa_workflow MODIFY package_bytes LONGBLOB NULL');
    }
  }
}

async function migrateWorkflowPackages() {
  await fs.mkdir(path.join(STORAGE_DIR, 'workflows'), { recursive: true, mode: 0o700 });
  while (true) {
    const [rows] = await pool.query(`SELECT id,version,package_bytes FROM sa_workflow
      WHERE package_storage_name IS NULL AND package_bytes IS NOT NULL ORDER BY created_at,id LIMIT 1`);
    if (!rows.length) return;
    const row = rows[0];
    const storageName = packageStorageName(row.id, Number(row.version));
    await writeWorkflowPackage(STORAGE_DIR, storageName, Buffer.from(row.package_bytes));
    const [result] = await pool.query(`UPDATE sa_workflow SET package_storage_name=?,package_bytes=NULL
      WHERE id=? AND package_storage_name IS NULL`, [storageName, row.id]);
    if (result.affectedRows !== 1) {
      throw new Error(`Could not finalize filesystem migration for workflow ${row.id}.`);
    }
    console.info(`Migrated workflow package ${row.id} to persistent file storage.`);
  }
}

async function withTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* Keep the original failure. */ }
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { initializeDatabase, migrateWorkflowPackages, pool, withTransaction };
