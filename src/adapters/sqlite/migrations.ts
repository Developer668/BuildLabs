export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-build-agent-state",
    sql: `
      CREATE TABLE acceptance_contracts (
        contract_hash TEXT PRIMARY KEY CHECK (length(contract_hash) = 64),
        contract_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        transcript_sha256 TEXT NOT NULL CHECK (length(transcript_sha256) = 64),
        contract_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TRIGGER acceptance_contracts_immutable_update
      BEFORE UPDATE ON acceptance_contracts
      BEGIN
        SELECT RAISE(ABORT, 'acceptance contracts are immutable');
      END;

      CREATE TRIGGER acceptance_contracts_immutable_delete
      BEFORE DELETE ON acceptance_contracts
      BEGIN
        SELECT RAISE(ABORT, 'acceptance contracts are immutable');
      END;

      CREATE TABLE build_runs (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL UNIQUE,
        assignment_hash TEXT NOT NULL CHECK (length(assignment_hash) = 64),
        assignment_json TEXT NOT NULL,
        project_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        contract_hash TEXT NOT NULL REFERENCES acceptance_contracts(contract_hash),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'passed', 'rejected', 'failed', 'cancelled')
        ),
        stage TEXT NOT NULL CHECK (
          stage IN (
            'queued',
            'provisioning',
            'generating',
            'verifying',
            'reviewing',
            'evaluating',
            'finalizing',
            'complete'
          )
        ),
        slot_id INTEGER,
        fencing_token INTEGER,
        sandbox_id TEXT,
        revision_hash TEXT CHECK (
          revision_hash IS NULL OR length(revision_hash) = 64
        ),
        preview_port INTEGER CHECK (
          preview_port IS NULL OR preview_port BETWEEN 1 AND 65535
        ),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (
          cancel_requested IN (0, 1)
        ),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX build_runs_queue_idx
      ON build_runs(status, cancel_requested, created_at);

      CREATE TABLE run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES build_runs(id),
        event_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX run_events_run_sequence_idx
      ON run_events(run_id, sequence);

      CREATE TRIGGER run_events_immutable_update
      BEFORE UPDATE ON run_events
      BEGIN
        SELECT RAISE(ABORT, 'run events are immutable');
      END;

      CREATE TRIGGER run_events_immutable_delete
      BEFORE DELETE ON run_events
      BEGIN
        SELECT RAISE(ABORT, 'run events are immutable');
      END;

      CREATE TABLE evidence_receipts (
        receipt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES build_runs(id),
        revision_hash TEXT NOT NULL CHECK (length(revision_hash) = 64),
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'ERROR')),
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX evidence_receipts_run_revision_idx
      ON evidence_receipts(run_id, revision_hash, kind);

      CREATE TRIGGER evidence_receipts_immutable_update
      BEFORE UPDATE ON evidence_receipts
      BEGIN
        SELECT RAISE(ABORT, 'evidence receipts are immutable');
      END;

      CREATE TRIGGER evidence_receipts_immutable_delete
      BEFORE DELETE ON evidence_receipts
      BEGIN
        SELECT RAISE(ABORT, 'evidence receipts are immutable');
      END;

      CREATE TABLE slot_leases (
        slot_id INTEGER PRIMARY KEY CHECK (slot_id BETWEEN 1 AND 4),
        run_id TEXT REFERENCES build_runs(id),
        fencing_token INTEGER NOT NULL DEFAULT 0,
        heartbeat_at TEXT,
        lease_expires_at TEXT
      );

      INSERT INTO slot_leases(slot_id) VALUES (1), (2), (3), (4);

      CREATE TABLE outbox (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES build_runs(id),
        revision_hash TEXT NOT NULL CHECK (length(revision_hash) = 64),
        trace_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        UNIQUE(event_type, run_id, revision_hash)
      );
    `,
  },
  {
    version: 2,
    name: "proven-artifacts",
    sql: `
      CREATE TABLE proven_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES build_runs(id),
        revision_hash TEXT NOT NULL CHECK (length(revision_hash) = 64),
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, revision_hash)
      );

      CREATE TRIGGER proven_artifacts_immutable_update
      BEFORE UPDATE ON proven_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'proven artifacts are immutable');
      END;

      CREATE TRIGGER proven_artifacts_immutable_delete
      BEFORE DELETE ON proven_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'proven artifacts are immutable');
      END;
    `,
  },
  {
    version: 3,
    name: "verification-sandbox-provenance",
    sql: `
      ALTER TABLE build_runs ADD COLUMN builder_sandbox_id TEXT;
      ALTER TABLE build_runs ADD COLUMN verification_sandbox_id TEXT;

      UPDATE build_runs
      SET builder_sandbox_id = sandbox_id
      WHERE sandbox_id IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: "verification-sandbox-purpose",
    sql: `
      ALTER TABLE build_runs ADD COLUMN verification_sandbox_purpose TEXT
      CHECK (
        verification_sandbox_purpose IS NULL OR
        verification_sandbox_purpose IN ('commands', 'delivery')
      );
    `,
  },
  {
    version: 5,
    name: "three-sandbox-proof-protocol",
    sql: `
      ALTER TABLE build_runs ADD COLUMN proof_protocol_version INTEGER NOT NULL DEFAULT 0
      CHECK (proof_protocol_version IN (0, 1));

      INSERT INTO run_events(
        run_id,
        event_type,
        stage,
        payload_json,
        created_at
      )
      SELECT
        id,
        'run.proof_quarantined',
        'complete',
        '{"code":"legacy_proof_quarantined","requiredProofProtocolVersion":1}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM build_runs
      WHERE status = 'passed';

      UPDATE build_runs
      SET status = 'rejected',
          error_code = 'legacy_proof_quarantined',
          error_message = 'Legacy pass predates the three-sandbox proof protocol; rebuild required',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'passed';
    `,
  },
  {
    version: 6,
    name: "interrupted-sandbox-cleanup-state",
    sql: `
      ALTER TABLE build_runs ADD COLUMN recovery_cleanup_completed_at TEXT;

      CREATE INDEX build_runs_recovery_cleanup_idx
      ON build_runs(status, error_code, recovery_cleanup_completed_at);
    `,
  },
] as const;
