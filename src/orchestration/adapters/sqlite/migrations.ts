export interface OrchestrationMigration {
  version: number;
  name: string;
  sql: string;
}

export const orchestrationMigrations: readonly OrchestrationMigration[] = [
  {
    version: 1,
    name: "encrypted-orchestration-projects",
    sql: `
      CREATE TABLE orchestration_projects (
        project_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        idempotency_digest TEXT NOT NULL CHECK (length(idempotency_digest) = 64),
        status TEXT NOT NULL CHECK (
          status IN (
            'intake_received',
            'needs_clarification',
            'researching',
            'proposal_drafting',
            'awaiting_customer_revision',
            'awaiting_payment',
            'payment_verification_failed',
            'paid',
            'building',
            'verifying',
            'no_proven_candidate',
            'preview_ready',
            'revision_pending',
            'deploying',
            'deployment_verification_failed',
            'delivering',
            'completed',
            'cancelled',
            'failed',
            'needs_operator_attention'
          )
        ),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        encryption_nonce BLOB NOT NULL CHECK (length(encryption_nonce) = 12),
        encryption_tag BLOB NOT NULL CHECK (length(encryption_tag) = 16),
        encrypted_aggregate BLOB NOT NULL
      );

      CREATE INDEX orchestration_projects_status_updated_idx
      ON orchestration_projects(status, updated_at, project_id);

      CREATE TABLE orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES orchestration_projects(project_id),
        aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 0),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (
          actor IN ('system', 'customer', 'provider', 'operator')
        ),
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX orchestration_events_project_sequence_idx
      ON orchestration_events(project_id, sequence);

      CREATE TRIGGER orchestration_events_immutable_update
      BEFORE UPDATE ON orchestration_events
      BEGIN
        SELECT RAISE(ABORT, 'orchestration events are immutable');
      END;

      CREATE TRIGGER orchestration_events_immutable_delete
      BEFORE DELETE ON orchestration_events
      BEGIN
        SELECT RAISE(ABORT, 'orchestration events are immutable');
      END;

      CREATE TABLE orchestration_webhook_inbox (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
        received_at TEXT NOT NULL,
        PRIMARY KEY(provider, event_id)
      );

      CREATE TRIGGER orchestration_webhook_inbox_immutable_update
      BEFORE UPDATE ON orchestration_webhook_inbox
      BEGIN
        SELECT RAISE(ABORT, 'orchestration webhook inbox is immutable');
      END;

      CREATE TRIGGER orchestration_webhook_inbox_immutable_delete
      BEFORE DELETE ON orchestration_webhook_inbox
      BEGIN
        SELECT RAISE(ABORT, 'orchestration webhook inbox is immutable');
      END;
    `,
  },
  {
    version: 2,
    name: "durable-inbound-mail-envelopes",
    sql: `
      CREATE TABLE orchestration_inbound_mail_envelopes (
        provider TEXT NOT NULL CHECK (provider = 'resend'),
        event_id TEXT NOT NULL,
        event_digest TEXT NOT NULL CHECK (length(event_digest) = 64),
        project_id TEXT NOT NULL REFERENCES orchestration_projects(project_id),
        email_id TEXT NOT NULL,
        identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 64),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'processed', 'rejected', 'failed')
        ),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        next_attempt_at TEXT,
        last_error_code TEXT,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        processed_at TEXT,
        PRIMARY KEY(provider, event_id)
      );

      CREATE INDEX orchestration_inbound_mail_ready_idx
      ON orchestration_inbound_mail_envelopes(
        project_id,
        status,
        next_attempt_at,
        received_at,
        event_id
      );

      CREATE TRIGGER orchestration_inbound_mail_identity_immutable
      BEFORE UPDATE ON orchestration_inbound_mail_envelopes
      WHEN
        OLD.provider <> NEW.provider OR
        OLD.event_id <> NEW.event_id OR
        OLD.event_digest <> NEW.event_digest OR
        OLD.project_id <> NEW.project_id OR
        OLD.email_id <> NEW.email_id OR
        OLD.identity_digest <> NEW.identity_digest OR
        OLD.received_at <> NEW.received_at
      BEGIN
        SELECT RAISE(ABORT, 'inbound mail envelope identity is immutable');
      END;

      CREATE TRIGGER orchestration_inbound_mail_no_delete
      BEFORE DELETE ON orchestration_inbound_mail_envelopes
      BEGIN
        SELECT RAISE(ABORT, 'inbound mail envelopes are immutable records');
      END;
    `,
  },
  {
    version: 3,
    name: "bounded-webhook-security-audit",
    sql: `
      CREATE TABLE orchestration_webhook_security_audit (
        provider TEXT NOT NULL CHECK (provider IN ('stripe', 'resend')),
        body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
        header_digest TEXT NOT NULL CHECK (length(header_digest) = 64),
        failure_code TEXT NOT NULL CHECK (
          failure_code IN (
            'invalid_signature_headers',
            'webhook_verification_failed'
          )
        ),
        observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, body_digest, header_digest, failure_code)
      ) WITHOUT ROWID;

      CREATE INDEX orchestration_webhook_security_audit_group_idx
      ON orchestration_webhook_security_audit(
        provider,
        failure_code,
        observed_at
      );

      CREATE TRIGGER orchestration_webhook_security_audit_immutable_update
      BEFORE UPDATE ON orchestration_webhook_security_audit
      BEGIN
        SELECT RAISE(ABORT, 'webhook security audit receipts are immutable');
      END;

      CREATE TRIGGER orchestration_webhook_security_audit_immutable_delete
      BEFORE DELETE ON orchestration_webhook_security_audit
      BEGIN
        SELECT RAISE(ABORT, 'webhook security audit receipts are immutable');
      END;

      CREATE TABLE orchestration_webhook_security_audit_overflow (
        provider TEXT NOT NULL CHECK (provider IN ('stripe', 'resend')),
        failure_code TEXT NOT NULL CHECK (
          failure_code IN (
            'invalid_signature_headers',
            'webhook_verification_failed'
          )
        ),
        observation_count INTEGER NOT NULL CHECK (observation_count >= 1),
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, failure_code)
      ) WITHOUT ROWID;

      CREATE TRIGGER orchestration_webhook_security_overflow_identity_immutable
      BEFORE UPDATE ON orchestration_webhook_security_audit_overflow
      WHEN
        OLD.provider <> NEW.provider OR
        OLD.failure_code <> NEW.failure_code OR
        OLD.first_observed_at <> NEW.first_observed_at OR
        NEW.observation_count < OLD.observation_count OR
        NEW.last_observed_at < OLD.last_observed_at
      BEGIN
        SELECT RAISE(ABORT, 'webhook security overflow identity is immutable');
      END;

      CREATE TRIGGER orchestration_webhook_security_overflow_no_delete
      BEFORE DELETE ON orchestration_webhook_security_audit_overflow
      BEGIN
        SELECT RAISE(ABORT, 'webhook security overflow summaries are durable');
      END;
    `,
  },
  {
    version: 4,
    name: "immutable-encrypted-proof-summary-snapshots",
    sql: `
      CREATE TABLE orchestration_proof_summary_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES orchestration_projects(project_id),
        deployment_receipt_id TEXT NOT NULL,
        revision_hash TEXT NOT NULL CHECK (length(revision_hash) = 64),
        snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
        created_at TEXT NOT NULL,
        encryption_nonce BLOB NOT NULL CHECK (length(encryption_nonce) = 12),
        encryption_tag BLOB NOT NULL CHECK (length(encryption_tag) = 16),
        encrypted_snapshot BLOB NOT NULL,
        UNIQUE(project_id, deployment_receipt_id, revision_hash)
      );

      CREATE INDEX orchestration_proof_summary_project_idx
      ON orchestration_proof_summary_snapshots(
        project_id,
        created_at,
        snapshot_id
      );

      CREATE TRIGGER orchestration_proof_summary_snapshots_immutable_update
      BEFORE UPDATE ON orchestration_proof_summary_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'proof summary snapshots are immutable');
      END;

      CREATE TRIGGER orchestration_proof_summary_snapshots_immutable_delete
      BEFORE DELETE ON orchestration_proof_summary_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'proof summary snapshots are immutable');
      END;

      CREATE TABLE orchestration_proof_summary_revocations (
        snapshot_id TEXT PRIMARY KEY REFERENCES
          orchestration_proof_summary_snapshots(snapshot_id),
        reason TEXT NOT NULL CHECK (
          reason IN (
            'operator_requested',
            'capability_compromised',
            'privacy_request',
            'security_policy'
          )
        ),
        revoked_at TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TRIGGER orchestration_proof_summary_revocations_immutable_update
      BEFORE UPDATE ON orchestration_proof_summary_revocations
      BEGIN
        SELECT RAISE(ABORT, 'proof summary revocations are immutable');
      END;

      CREATE TRIGGER orchestration_proof_summary_revocations_immutable_delete
      BEFORE DELETE ON orchestration_proof_summary_revocations
      BEGIN
        SELECT RAISE(ABORT, 'proof summary revocations are immutable');
      END;
    `,
  },
  {
    version: 5,
    name: "one-time-customer-dashboard-logins",
    sql: `
      CREATE TABLE orchestration_customer_dashboard_logins (
        token_digest TEXT PRIMARY KEY CHECK (length(token_digest) = 64),
        project_id TEXT NOT NULL REFERENCES orchestration_projects(project_id),
        expires_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX orchestration_customer_dashboard_logins_project_idx
      ON orchestration_customer_dashboard_logins(
        project_id,
        consumed_at,
        token_digest
      );

      CREATE TRIGGER orchestration_customer_dashboard_logins_immutable_update
      BEFORE UPDATE ON orchestration_customer_dashboard_logins
      BEGIN
        SELECT RAISE(ABORT, 'customer dashboard login receipts are immutable');
      END;

      CREATE TRIGGER orchestration_customer_dashboard_logins_immutable_delete
      BEFORE DELETE ON orchestration_customer_dashboard_logins
      BEGIN
        SELECT RAISE(ABORT, 'customer dashboard login receipts are immutable');
      END;
    `,
  },
  {
    version: 6,
    name: "pending-dashboard-login-reconciliation-index",
    sql: `
      ALTER TABLE orchestration_projects
      ADD COLUMN has_pending_dashboard_login INTEGER NOT NULL DEFAULT 0
      CHECK (has_pending_dashboard_login IN (0, 1));

      CREATE INDEX orchestration_projects_dashboard_login_reconcile_idx
      ON orchestration_projects(has_pending_dashboard_login, project_id);
    `,
  },
] as const;
