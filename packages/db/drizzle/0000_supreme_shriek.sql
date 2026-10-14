CREATE TABLE IF NOT EXISTS "job_source_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"merged" integer DEFAULT 0 NOT NULL,
	"enriched" integer DEFAULT 0 NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"keywords" text[] NOT NULL,
	"locations" text[] NOT NULL,
	"sources" text[] NOT NULL,
	"max_items" integer DEFAULT 25 NOT NULL,
	"import_rows" jsonb,
	"import_label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text,
	"phase_total" integer,
	"phase_done" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error_msg" text,
	"leads_found" integer DEFAULT 0 NOT NULL,
	"leads_skipped" integer DEFAULT 0 NOT NULL,
	"leads_merged" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "known_businesses" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text,
	"source" text NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_url" text,
	"phone" text,
	"phone_e164" text,
	"postal_code" text,
	"city_key" text,
	"website_host" text,
	"ledger_eligible" boolean DEFAULT true NOT NULL,
	"lead_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_contacts" (
	"lead_id" integer PRIMARY KEY NOT NULL,
	"emails" text[],
	"email_source" text,
	"instagram" text,
	"facebook" text,
	"linkedin" text,
	"twitter" text,
	"youtube" text,
	"tiktok" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_sources" (
	"lead_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"profile_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"profile_url" text,
	"dedup_key" text NOT NULL,
	"dedup_kind" text NOT NULL,
	"phone" text,
	"phone_e164" text,
	"address" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"website" text,
	"category" text,
	"rating" real,
	"review_count" integer,
	"emails_from_profile" text[],
	"extra" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"notes" text,
	"enriched" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_observations" (
	"host" text PRIMARY KEY NOT NULL,
	"emails" text[],
	"socials" jsonb,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_status" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_job_id" integer,
	"version" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_source_stats" ADD CONSTRAINT "job_source_stats_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_source_stats_uniq" ON "job_source_stats" USING btree ("job_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_phone_idx" ON "known_businesses" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_name_zip_idx" ON "known_businesses" USING btree ("name_key","postal_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_host_idx" ON "known_businesses" USING btree ("website_host");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_city_idx" ON "known_businesses" USING btree ("city_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_sources_uniq" ON "lead_sources" USING btree ("lead_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_job_source_external_uniq" ON "leads" USING btree ("job_id","source","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_job_idx" ON "leads" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_source_idx" ON "leads" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_dedup_key_idx" ON "leads" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_phone_e164_idx" ON "leads" USING btree ("phone_e164");