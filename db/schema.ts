import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const callSessions = sqliteTable("call_sessions", {
  id: text("id").primaryKey(),
  toNumber: text("to_number").notNull(),
  contactName: text("contact_name").notNull().default(""),
  businessName: text("business_name").notNull().default(""),
  websiteGoal: text("website_goal").notNull().default(""),
  status: text("status").notNull(),
  provider: text("provider").notNull(),
  conversationId: text("conversation_id").notNull().default(""),
  sipCallId: text("sip_call_id").notNull().default(""),
  transcriptJson: text("transcript_json").notNull().default("[]"),
  summary: text("summary").notNull().default(""),
  error: text("error").notNull().default(""),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
