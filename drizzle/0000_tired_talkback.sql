CREATE TABLE `call_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`to_number` text NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`website_goal` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`sip_call_id` text DEFAULT '' NOT NULL,
	`transcript_json` text DEFAULT '[]' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`duration_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
