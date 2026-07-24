import { env } from "cloudflare:workers";

export type TranscriptTurn = {
  role: "agent" | "user";
  message: string;
  timeInCallSecs?: number;
};

export type CallRecord = {
  id: string;
  toNumber: string;
  contactName: string;
  businessName: string;
  websiteGoal: string;
  status:
    | "queued"
    | "dialing"
    | "in_progress"
    | "completed"
    | "successful"
    | "failed";
  provider: string;
  conversationId: string;
  sipCallId: string;
  transcript: TranscriptTurn[];
  summary: string;
  error: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
};

type CallRow = {
  id: string;
  to_number: string;
  contact_name: string;
  business_name: string;
  website_goal: string;
  status: CallRecord["status"];
  provider: string;
  conversation_id: string;
  sip_call_id: string;
  transcript_json: string;
  summary: string;
  error: string;
  duration_seconds: number;
  created_at: string;
  updated_at: string;
};

function database() {
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) throw new Error("The call archive database is not configured.");
  return bindings.DB;
}

export async function ensureCallSchema() {
  const db = database();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS call_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        to_number TEXT NOT NULL,
        contact_name TEXT NOT NULL DEFAULT '',
        business_name TEXT NOT NULL DEFAULT '',
        website_goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        sip_call_id TEXT NOT NULL DEFAULT '',
        transcript_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS call_sessions_created_at_idx ON call_sessions (created_at DESC)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_conversation_id_idx ON call_sessions (conversation_id) WHERE conversation_id <> ''",
    ),
  ]);
}

function parseTranscript(value: string): TranscriptTurn[] {
  try {
    const parsed = JSON.parse(value) as TranscriptTurn[];
    return Array.isArray(parsed) ? parsed.slice(0, 1000) : [];
  } catch {
    return [];
  }
}

function mapRow(row: CallRow): CallRecord {
  return {
    id: row.id,
    toNumber: row.to_number,
    contactName: row.contact_name,
    businessName: row.business_name,
    websiteGoal: row.website_goal,
    status: row.status,
    provider: row.provider,
    conversationId: row.conversation_id,
    sipCallId: row.sip_call_id,
    transcript: parseTranscript(row.transcript_json),
    summary: row.summary,
    error: row.error,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCalls(limit = 40) {
  await ensureCallSchema();
  const result = await database()
    .prepare("SELECT * FROM call_sessions ORDER BY created_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 100)))
    .all<CallRow>();
  return (result.results ?? []).map(mapRow);
}

export async function getCall(id: string) {
  await ensureCallSchema();
  const row = await database()
    .prepare("SELECT * FROM call_sessions WHERE id = ?")
    .bind(id)
    .first<CallRow>();
  return row ? mapRow(row) : null;
}

export async function upsertInboundCall(input: {
  conversationId: string;
  callerNumber: string;
  contactName: string;
  businessName: string;
  websiteGoal: string;
  status: "successful" | "failed";
  transcript: TranscriptTurn[];
  summary: string;
  error: string;
  durationSeconds: number;
  sipCallId: string;
  createdAt?: string;
}) {
  await ensureCallSchema();
  const db = database();
  const now = new Date().toISOString();
  const createdAt = input.createdAt || now;
  const id = `call_${crypto.randomUUID()}`;

  await db
    .prepare(`
      INSERT OR IGNORE INTO call_sessions (
        id, to_number, contact_name, business_name, website_goal, status, provider,
        conversation_id, sip_call_id, transcript_json, summary, error,
        duration_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id,
      input.callerNumber.slice(0, 40),
      input.contactName.slice(0, 120),
      input.businessName.slice(0, 160),
      input.websiteGoal.slice(0, 1200),
      input.status,
      "ElevenLabs + Plivo SIP",
      input.conversationId,
      input.sipCallId.slice(0, 160),
      JSON.stringify(input.transcript ?? []),
      input.summary.slice(0, 4000),
      input.error.slice(0, 1000),
      Math.max(0, Math.min(86400, Math.round(input.durationSeconds))),
      createdAt,
      now,
    )
    .run();

  await db
    .prepare(`
      UPDATE call_sessions SET
        to_number = ?,
        contact_name = ?,
        business_name = ?,
        website_goal = ?,
        status = ?,
        provider = 'ElevenLabs + Plivo SIP',
        sip_call_id = ?,
        transcript_json = ?,
        summary = ?,
        error = ?,
        duration_seconds = ?,
        updated_at = ?
      WHERE conversation_id = ?
    `)
    .bind(
      input.callerNumber.slice(0, 40),
      input.contactName.slice(0, 120),
      input.businessName.slice(0, 160),
      input.websiteGoal.slice(0, 1200),
      input.status,
      input.sipCallId.slice(0, 160),
      JSON.stringify(input.transcript ?? []),
      input.summary.slice(0, 4000),
      input.error.slice(0, 1000),
      Math.max(0, Math.min(86400, Math.round(input.durationSeconds))),
      now,
      input.conversationId,
    )
    .run();

  const row = await db
    .prepare("SELECT * FROM call_sessions WHERE conversation_id = ?")
    .bind(input.conversationId)
    .first<CallRow>();
  return row ? mapRow(row) : null;
}
