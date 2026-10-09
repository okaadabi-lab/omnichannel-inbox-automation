-- Tables written by the n8n workflows. Target: MySQL 8 / MariaDB 10.11, utf8mb4.
-- n8n keeps its own data (workflows, executions, credentials) in a separate database.

CREATE TABLE IF NOT EXISTS message_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel VARCHAR(32) NOT NULL,
  external_message_id VARCHAR(255) NOT NULL,
  customer_id VARCHAR(128) NOT NULL,
  customer_name VARCHAR(120) NULL,
  text_preview VARCHAR(500) NOT NULL,
  received_at DATETIME(3) NOT NULL,
  status ENUM('processing', 'replied', 'escalated', 'no_action', 'ignored', 'rate_limited')
    NOT NULL DEFAULT 'processing',
  action VARCHAR(32) NULL,
  intent VARCHAR(64) NULL,
  confidence DECIMAL(4, 3) NULL,
  reasons JSON NULL,
  conversation_id VARCHAR(64) NULL,
  reply_text TEXT NULL,
  processed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Webhook redeliveries hit this key and are dropped before the AI service is called.
  UNIQUE KEY uq_message_log_channel_message (channel, external_message_id),
  -- "Rows stuck in processing" and "escalations today" style queries.
  KEY idx_message_log_status_created (status, created_at),
  -- Conversation history per customer.
  KEY idx_message_log_customer (channel, customer_id, received_at),
  CONSTRAINT chk_message_log_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- One row per (Instagram account, hour). Incremented atomically before each public reply.
CREATE TABLE IF NOT EXISTS comment_reply_counter (
  scope_key VARCHAR(64) NOT NULL,
  window_start DATETIME NOT NULL,
  reply_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (scope_key, window_start)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Delivery state of hr-payroll-api outbox events, keyed by the outbox event id.
CREATE TABLE IF NOT EXISTS outbox_delivery_attempts (
  event_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  employee_id BIGINT UNSIGNED NULL,
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('pending', 'delivered', 'failed', 'undeliverable', 'gave_up', 'skipped')
    NOT NULL DEFAULT 'pending',
  last_error VARCHAR(500) NULL,
  provider_message_id VARCHAR(128) NULL,
  last_attempt_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id),
  KEY idx_outbox_attempts_status (status, updated_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
