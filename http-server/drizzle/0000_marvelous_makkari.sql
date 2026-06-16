CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."recurring_task_frequency" AS ENUM('weekly', 'daily', 'interval', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('waiting', 'starting', 'running', 'needs_attention', 'paused', 'error', 'stopped', 'detached');--> statement-breakpoint
CREATE TYPE "public"."shell_type" AS ENUM('powershell', 'bash', 'ssh');--> statement-breakpoint
CREATE TYPE "public"."slack_notification_priority_label" AS ENUM('mention', 'dm', 'thread_mention', 'thread_written', 'other');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"account_email" text,
	"account_name" text,
	"calendar_id" text NOT NULL,
	"look_ahead_days" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"connected_at" bigint NOT NULL,
	"last_synced_at" bigint,
	"auth_error" text,
	"auth" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"account_email" text,
	"account_name" text,
	"calendar_id" text NOT NULL,
	"summary" text NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"html_link" text,
	"location" text,
	"updated" text
);
--> statement-breakpoint
CREATE TABLE "manual_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"created_at" bigint NOT NULL,
	"priority" integer
);
--> statement-breakpoint
CREATE TABLE "recurring_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"time" text NOT NULL,
	"frequency" "recurring_task_frequency" DEFAULT 'weekly' NOT NULL,
	"days_of_week" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"interval_days" integer,
	"day_of_month" integer,
	"anchor_date" text,
	"created_at" bigint NOT NULL,
	"priority" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_generated_date" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cmd" text NOT NULL,
	"cwd" text NOT NULL,
	"shell_type" "shell_type" NOT NULL,
	"ssh_command" text,
	"ssh_options" jsonb,
	"terminal_ref" text,
	"terminal_pid" integer,
	"client_metadata" jsonb,
	"status" "session_status" DEFAULT 'needs_attention' NOT NULL,
	"last_activity" bigint NOT NULL,
	"git_changes" boolean DEFAULT false NOT NULL,
	"terminal_exit_code" integer,
	"terminal_exit_reason" text,
	"terminal_capture_state" text,
	"terminal_capture_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"team_name" text,
	"channel_id" text,
	"channel_name" text,
	"channel_type" text,
	"user_id" text,
	"user_name" text,
	"text" text NOT NULL,
	"ts" text,
	"thread_ts" text,
	"permalink" text,
	"received_at" bigint NOT NULL,
	"message_count" integer,
	"priority_rank" integer,
	"priority_label" "slack_notification_priority_label"
);
--> statement-breakpoint
CREATE INDEX "google_calendar_connections_enabled_idx" ON "google_calendar_connections" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "google_calendar_events_connection_idx" ON "google_calendar_events" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "google_calendar_events_start_ms_idx" ON "google_calendar_events" USING btree ("start_ms");--> statement-breakpoint
CREATE INDEX "manual_tasks_created_at_idx" ON "manual_tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recurring_tasks_enabled_idx" ON "recurring_tasks" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "recurring_tasks_created_at_idx" ON "recurring_tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_terminal_ref_idx" ON "sessions" USING btree ("terminal_ref");--> statement-breakpoint
CREATE INDEX "slack_notifications_received_at_idx" ON "slack_notifications" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "slack_notifications_channel_idx" ON "slack_notifications" USING btree ("team_id","channel_id");