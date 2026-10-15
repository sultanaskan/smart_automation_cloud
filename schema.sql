CREATE TABLE IF NOT EXISTS sa_user (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  display_name VARCHAR(120) NULL,
  password_hash VARCHAR(100) NOT NULL,
  role VARCHAR(12) NOT NULL DEFAULT 'MEMBER',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sa_google_identity (
  google_sub VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sa_google_identity_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_signup_request (
  id VARCHAR(36) PRIMARY KEY,
  google_sub VARCHAR(255) NULL,
  username VARCHAR(80) NULL,
  email VARCHAR(254) NOT NULL,
  display_name VARCHAR(120) NULL,
  password_hash VARCHAR(100) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  reviewed_by VARCHAR(36) NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_signup_status_created (status, created_at),
  KEY ix_sa_signup_identity (google_sub, status),
  CONSTRAINT fk_sa_signup_review_admin FOREIGN KEY (reviewed_by) REFERENCES sa_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sa_workflow (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE,
  description VARCHAR(4000),
  version BIGINT NOT NULL,
  package_bytes LONGBLOB NOT NULL,
  price_paisa BIGINT UNSIGNED NOT NULL DEFAULT 0,
  subscription_days INT NOT NULL DEFAULT 30,
  marketplace_can_edit BOOLEAN NOT NULL DEFAULT TRUE,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sa_grant (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  workflow_id VARCHAR(36) NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_run BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMP NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sa_grant_user_workflow (user_id, workflow_id),
  CONSTRAINT fk_sa_grant_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_grant_workflow FOREIGN KEY (workflow_id) REFERENCES sa_workflow(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_session (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  csrf_token CHAR(64) NULL,
  session_kind VARCHAR(12) NOT NULL DEFAULT 'API',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_session_user (user_id),
  CONSTRAINT fk_sa_session_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_wallet (
  user_id VARCHAR(36) PRIMARY KEY,
  balance_paisa BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sa_wallet_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_wallet_ledger (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  delta_paisa BIGINT NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  reference_type VARCHAR(24) NOT NULL,
  reference_id VARCHAR(36) NOT NULL,
  description VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_ledger_user_created (user_id, created_at),
  CONSTRAINT fk_sa_ledger_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_topup_request (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  amount_paisa BIGINT UNSIGNED NOT NULL,
  payment_reference VARCHAR(300) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  admin_note VARCHAR(500) NULL,
  reviewed_by VARCHAR(36) NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_topup_status_created (status, created_at),
  CONSTRAINT fk_sa_topup_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_topup_admin FOREIGN KEY (reviewed_by) REFERENCES sa_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sa_package (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(4000) NOT NULL DEFAULT '',
  price_paisa BIGINT UNSIGNED NOT NULL,
  subscription_days INT NOT NULL,
  marketplace_can_edit BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sa_package_workflow (
  package_id VARCHAR(36) NOT NULL,
  workflow_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (package_id, workflow_id),
  CONSTRAINT fk_sa_package_workflow_package FOREIGN KEY (package_id) REFERENCES sa_package(id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_package_workflow_workflow FOREIGN KEY (workflow_id) REFERENCES sa_workflow(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_purchase (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  product_type VARCHAR(12) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  amount_paisa BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sa_purchase_idempotency (user_id, idempotency_key),
  KEY ix_sa_purchase_user_created (user_id, created_at),
  CONSTRAINT fk_sa_purchase_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_subscription (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  workflow_id VARCHAR(36) NOT NULL,
  source_type VARCHAR(12) NOT NULL,
  source_id VARCHAR(36) NOT NULL,
  starts_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  can_edit BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_subscription_access (user_id, workflow_id, status, expires_at),
  CONSTRAINT fk_sa_subscription_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_subscription_workflow FOREIGN KEY (workflow_id) REFERENCES sa_workflow(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sa_package_request (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  requested_name VARCHAR(200) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  admin_response VARCHAR(1000) NULL,
  reviewed_by VARCHAR(36) NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_package_request_status (status, created_at),
  CONSTRAINT fk_sa_request_user FOREIGN KEY (user_id) REFERENCES sa_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_request_admin FOREIGN KEY (reviewed_by) REFERENCES sa_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sa_learning_content (
  id VARCHAR(36) PRIMARY KEY,
  content_type VARCHAR(12) NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(500) NOT NULL DEFAULT '',
  body MEDIUMTEXT NOT NULL,
  url VARCHAR(1000) NULL,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_sa_learning_published_type_created (published, content_type, created_at),
  CONSTRAINT fk_sa_learning_author FOREIGN KEY (created_by) REFERENCES sa_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sa_release (
  id VARCHAR(36) PRIMARY KEY,
  version VARCHAR(40) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_name VARCHAR(80) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  changelog VARCHAR(2000) NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sa_release_active_created (active, created_at),
  CONSTRAINT fk_sa_release_admin FOREIGN KEY (created_by) REFERENCES sa_user(id) ON DELETE SET NULL
);
