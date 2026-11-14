-- LiveStar Phase 1 initial schema.
-- Rendered offline from schema.prisma by scripts/render-initial-migration.py.
-- Prisma CLI / PostgreSQL verification must be run when tooling is available.
-- Migration 0002 is required for accounting checks, immutability and grants.

CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED');

CREATE TYPE "StreamStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'TERMINATED');

CREATE TYPE "LedgerUnit" AS ENUM ('LIVECOIN', 'USD_MICRO');

CREATE TYPE "LedgerAccountKind" AS ENUM ('COIN_WALLET', 'COIN_ISSUANCE', 'COIN_REDEMPTION', 'PROVIDER_CLEARING', 'DEFERRED_GIFT_REVENUE', 'CREATOR_PENDING', 'CREATOR_AVAILABLE', 'CREATOR_HELD', 'PLATFORM_REVENUE', 'PROCESSING_FEES', 'TAX_PAYABLE', 'REFUND_RESERVE', 'PAYOUT_CLEARING', 'ROUNDING');

CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'APPLE', 'GOOGLE');

CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'PAID', 'SETTLED', 'FAILED', 'REFUNDED', 'DISPUTED');

CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'HELD', 'REVERSED');

CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELED');

CREATE TYPE "VerificationStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED');

CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'WON', 'LOST');

CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');

CREATE TYPE "ModerationActionType" AS ENUM ('WARN', 'MUTE', 'BLOCK', 'SUSPEND', 'TERMINATE_STREAM', 'REMOVE_MESSAGE');

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "password_hash" TEXT,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "email_verified_at" TIMESTAMPTZ(6),
  "age_verified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_profiles" (
  "user_id" UUID NOT NULL,
  "username" VARCHAR(32) NOT NULL,
  "display_name" VARCHAR(80) NOT NULL,
  "bio" VARCHAR(500),
  "avatar_key" TEXT,
  "locale" VARCHAR(10) NOT NULL DEFAULT 'ar',
  "country_code" CHAR(2),
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
  CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "roles" (
  "id" UUID NOT NULL,
  "name" VARCHAR(32) NOT NULL,
  "permissions" TEXT[],
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_roles" (
  "user_id" UUID NOT NULL,
  "role_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_id")
);

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "refresh_token_hash" TEXT NOT NULL,
  "family_id" UUID NOT NULL,
  "replaced_by_id" UUID,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_streams" (
  "id" UUID NOT NULL,
  "creator_id" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "description" VARCHAR(2000),
  "language" VARCHAR(10) NOT NULL DEFAULT 'ar',
  "category" VARCHAR(80),
  "status" "StreamStatus" NOT NULL DEFAULT 'SCHEDULED',
  "livekit_room" TEXT NOT NULL,
  "thumbnail_key" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_streams_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stream_viewers" (
  "id" UUID NOT NULL,
  "stream_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at" TIMESTAMPTZ(6),
  CONSTRAINT "stream_viewers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "follows" (
  "follower_id" UUID NOT NULL,
  "followed_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "followed_id")
);

CREATE TABLE "user_blocks" (
  "blocker_id" UUID NOT NULL,
  "blocked_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id")
);

CREATE TABLE "stream_mutes" (
  "id" UUID NOT NULL,
  "stream_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "moderator_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stream_mutes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "live_messages" (
  "id" UUID NOT NULL,
  "stream_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "body" VARCHAR(1000) NOT NULL,
  "removed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gifts" (
  "id" UUID NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "name_ar" VARCHAR(80) NOT NULL,
  "name_en" VARCHAR(80) NOT NULL,
  "price_coins" BIGINT NOT NULL,
  "image_key" TEXT,
  "animation_key" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coin_packages" (
  "id" UUID NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "coins" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" SMALLINT NOT NULL,
  "price_minor" BIGINT NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_product_id" TEXT,
  "country_code" CHAR(2),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "coin_packages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_accounts" (
  "id" UUID NOT NULL,
  "owner_id" UUID,
  "code" VARCHAR(120) NOT NULL,
  "unit" "LedgerUnit" NOT NULL,
  "kind" "LedgerAccountKind" NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "enforce_non_negative" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_journals" (
  "id" UUID NOT NULL,
  "unit" "LedgerUnit" NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "source_type" VARCHAR(50) NOT NULL,
  "source_id" VARCHAR(200) NOT NULL,
  "description" VARCHAR(500),
  "reverses_journal_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_journals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_ledger" (
  "id" UUID NOT NULL,
  "journal_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "unit" "LedgerUnit" NOT NULL,
  "amount" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coin_wallets" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "ledger_account_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coin_wallets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_orders" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "package_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_order_id" VARCHAR(200),
  "idempotency_key" VARCHAR(200) NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
  "coins" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" SMALLINT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "fx_rate_to_usd" DECIMAL(30, 12),
  "fx_observed_at" TIMESTAMPTZ(6),
  "fx_source" VARCHAR(100),
  "gross_usd_micros" BIGINT,
  "processing_fee_usd_micros" BIGINT,
  "tax_usd_micros" BIGINT,
  "settled_net_usd_micros" BIGINT,
  "settlement_reference" VARCHAR(200),
  "paid_at" TIMESTAMPTZ(6),
  "settled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_webhooks" (
  "id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_event_id" VARCHAR(200) NOT NULL,
  "payment_order_id" UUID,
  "payload_sha256" CHAR(64) NOT NULL,
  "payload_object_key" TEXT,
  "signature_verified_at" TIMESTAMPTZ(6) NOT NULL,
  "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(100),
  CONSTRAINT "payment_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coin_lots" (
  "id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "payment_order_id" UUID NOT NULL,
  "coins_issued" BIGINT NOT NULL,
  "coins_remaining" BIGINT NOT NULL,
  "settled_net_usd_micros" BIGINT NOT NULL,
  "allocated_net_usd_micros" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coin_lots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "revenue_splits" (
  "id" UUID NOT NULL,
  "creator_bps" SMALLINT NOT NULL,
  "platform_bps" SMALLINT NOT NULL,
  "effective_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "revenue_splits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gift_transactions" (
  "id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "sender_id" UUID NOT NULL,
  "creator_id" UUID NOT NULL,
  "stream_id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "gift_id" UUID NOT NULL,
  "revenue_split_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price_coins" BIGINT NOT NULL,
  "total_coins" BIGINT NOT NULL,
  "eligible_net_usd_micros" BIGINT NOT NULL,
  "creator_bps" SMALLINT NOT NULL,
  "platform_bps" SMALLINT NOT NULL,
  "creator_usd_micros" BIGINT NOT NULL,
  "platform_usd_micros" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gift_allocations" (
  "id" UUID NOT NULL,
  "gift_transaction_id" UUID NOT NULL,
  "coin_lot_id" UUID NOT NULL,
  "coins" BIGINT NOT NULL,
  "eligible_net_usd_micros" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creator_earnings" (
  "id" UUID NOT NULL,
  "creator_id" UUID NOT NULL,
  "gift_transaction_id" UUID NOT NULL,
  "amount_usd_micros" BIGINT NOT NULL,
  "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
  "available_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creator_earnings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payout_accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(50) NOT NULL,
  "provider_account_ref" VARCHAR(200) NOT NULL,
  "country_code" CHAR(2) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "verified_at" TIMESTAMPTZ(6),
  "disabled_at" TIMESTAMPTZ(6),
  "compliance_checked_at" TIMESTAMPTZ(6),
  "compliance_reference" VARCHAR(200),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payout_requests" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "payout_account_id" UUID NOT NULL,
  "provider" VARCHAR(50) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "amount_usd_micros" BIGINT NOT NULL,
  "fee_usd_micros" BIGINT NOT NULL DEFAULT 0,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" SMALLINT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "fx_rate_from_usd" DECIMAL(30, 12) NOT NULL,
  "fx_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "fx_source" VARCHAR(100) NOT NULL,
  "provider_transfer_id" VARCHAR(200),
  "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "rejection_reason_code" VARCHAR(100),
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "identity_verifications" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(50) NOT NULL,
  "provider_reference" VARCHAR(200) NOT NULL,
  "status" "VerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "country_code" CHAR(2) NOT NULL,
  "age_over_minimum" BOOLEAN NOT NULL DEFAULT false,
  "sanctions_cleared_at" TIMESTAMPTZ(6),
  "verified_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
  "id" UUID NOT NULL,
  "payment_order_id" UUID NOT NULL,
  "provider_refund_id" VARCHAR(200) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" SMALLINT NOT NULL,
  "amount_usd_micros" BIGINT NOT NULL,
  "fx_rate_to_usd" DECIMAL(30, 12) NOT NULL,
  "fx_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "fx_source" VARCHAR(100) NOT NULL,
  "processing_fee_usd_micros" BIGINT NOT NULL DEFAULT 0,
  "reason_code" VARCHAR(100) NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "disputes" (
  "id" UUID NOT NULL,
  "payment_order_id" UUID NOT NULL,
  "provider_dispute_id" VARCHAR(200) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "currency_exponent" SMALLINT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "amount_usd_micros" BIGINT NOT NULL,
  "fx_rate_to_usd" DECIMAL(30, 12) NOT NULL,
  "fx_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "fx_source" VARCHAR(100) NOT NULL,
  "fee_usd_micros" BIGINT NOT NULL DEFAULT 0,
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "type" VARCHAR(50) NOT NULL,
  "data" JSONB NOT NULL,
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reports" (
  "id" UUID NOT NULL,
  "reporter_id" UUID NOT NULL,
  "target_user_id" UUID,
  "stream_id" UUID,
  "message_id" UUID,
  "reason_code" VARCHAR(100) NOT NULL,
  "details" VARCHAR(2000),
  "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "moderation_actions" (
  "id" UUID NOT NULL,
  "moderator_id" UUID NOT NULL,
  "target_user_id" UUID,
  "stream_id" UUID,
  "report_id" UUID,
  "type" "ModerationActionType" NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_audit_logs" (
  "id" UUID NOT NULL,
  "actor_id" UUID,
  "action" VARCHAR(100) NOT NULL,
  "entity_type" VARCHAR(100) NOT NULL,
  "entity_id" VARCHAR(200),
  "before" JSONB,
  "after" JSONB,
  "request_id" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_settings" (
  "key" VARCHAR(120) NOT NULL,
  "value" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "topic" VARCHAR(100) NOT NULL,
  "aggregate_id" VARCHAR(200) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMPTZ(6),
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);


-- Unique constraints and query indexes.

CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
CREATE INDEX "users_status_created_at_idx" ON "users" ("status", "created_at");
CREATE UNIQUE INDEX "user_profiles_username_key" ON "user_profiles" ("username");
CREATE UNIQUE INDEX "roles_name_key" ON "roles" ("name");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" ("role_id");
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" ("refresh_token_hash");
CREATE UNIQUE INDEX "sessions_replaced_by_id_key" ON "sessions" ("replaced_by_id");
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions" ("user_id", "revoked_at");
CREATE INDEX "sessions_family_id_idx" ON "sessions" ("family_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");
CREATE UNIQUE INDEX "live_streams_livekit_room_key" ON "live_streams" ("livekit_room");
CREATE INDEX "live_streams_status_created_at_idx" ON "live_streams" ("status", "created_at");
CREATE INDEX "live_streams_creator_id_created_at_idx" ON "live_streams" ("creator_id", "created_at");
CREATE INDEX "live_streams_category_status_idx" ON "live_streams" ("category", "status");
CREATE INDEX "stream_viewers_stream_id_left_at_idx" ON "stream_viewers" ("stream_id", "left_at");
CREATE INDEX "stream_viewers_user_id_joined_at_idx" ON "stream_viewers" ("user_id", "joined_at");
CREATE INDEX "follows_followed_id_created_at_idx" ON "follows" ("followed_id", "created_at");
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks" ("blocked_id");
CREATE UNIQUE INDEX "stream_mutes_stream_id_user_id_key" ON "stream_mutes" ("stream_id", "user_id");
CREATE INDEX "stream_mutes_moderator_id_idx" ON "stream_mutes" ("moderator_id");
CREATE INDEX "live_messages_stream_id_created_at_id_idx" ON "live_messages" ("stream_id", "created_at", "id");
CREATE INDEX "live_messages_sender_id_created_at_idx" ON "live_messages" ("sender_id", "created_at");
CREATE UNIQUE INDEX "gifts_code_key" ON "gifts" ("code");
CREATE INDEX "gifts_active_price_coins_idx" ON "gifts" ("active", "price_coins");
CREATE UNIQUE INDEX "coin_packages_code_key" ON "coin_packages" ("code");
CREATE UNIQUE INDEX "coin_packages_provider_provider_product_id_country_code_key" ON "coin_packages" ("provider", "provider_product_id", "country_code");
CREATE INDEX "coin_packages_provider_country_code_active_idx" ON "coin_packages" ("provider", "country_code", "active");
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts" ("code");
CREATE UNIQUE INDEX "ledger_accounts_id_unit_key" ON "ledger_accounts" ("id", "unit");
CREATE INDEX "ledger_accounts_owner_id_kind_unit_idx" ON "ledger_accounts" ("owner_id", "kind", "unit");
CREATE UNIQUE INDEX "ledger_journals_idempotency_key_key" ON "ledger_journals" ("idempotency_key");
CREATE UNIQUE INDEX "ledger_journals_reverses_journal_id_key" ON "ledger_journals" ("reverses_journal_id");
CREATE UNIQUE INDEX "ledger_journals_id_unit_key" ON "ledger_journals" ("id", "unit");
CREATE INDEX "ledger_journals_source_type_source_id_idx" ON "ledger_journals" ("source_type", "source_id");
CREATE INDEX "ledger_journals_created_at_idx" ON "ledger_journals" ("created_at");
CREATE UNIQUE INDEX "wallet_ledger_journal_id_account_id_key" ON "wallet_ledger" ("journal_id", "account_id");
CREATE INDEX "wallet_ledger_account_id_created_at_id_idx" ON "wallet_ledger" ("account_id", "created_at", "id");
CREATE UNIQUE INDEX "coin_wallets_user_id_key" ON "coin_wallets" ("user_id");
CREATE UNIQUE INDEX "coin_wallets_ledger_account_id_key" ON "coin_wallets" ("ledger_account_id");
CREATE UNIQUE INDEX "payment_orders_idempotency_key_key" ON "payment_orders" ("idempotency_key");
CREATE UNIQUE INDEX "payment_orders_provider_provider_order_id_key" ON "payment_orders" ("provider", "provider_order_id");
CREATE INDEX "payment_orders_user_id_created_at_idx" ON "payment_orders" ("user_id", "created_at");
CREATE INDEX "payment_orders_status_created_at_idx" ON "payment_orders" ("status", "created_at");
CREATE UNIQUE INDEX "payment_webhooks_provider_provider_event_id_key" ON "payment_webhooks" ("provider", "provider_event_id");
CREATE INDEX "payment_webhooks_status_received_at_idx" ON "payment_webhooks" ("status", "received_at");
CREATE INDEX "payment_webhooks_payment_order_id_idx" ON "payment_webhooks" ("payment_order_id");
CREATE UNIQUE INDEX "coin_lots_payment_order_id_key" ON "coin_lots" ("payment_order_id");
CREATE INDEX "coin_lots_wallet_id_created_at_id_idx" ON "coin_lots" ("wallet_id", "created_at", "id");
CREATE UNIQUE INDEX "revenue_splits_effective_at_key" ON "revenue_splits" ("effective_at");
CREATE UNIQUE INDEX "gift_transactions_idempotency_key_key" ON "gift_transactions" ("idempotency_key");
CREATE INDEX "gift_transactions_creator_id_created_at_idx" ON "gift_transactions" ("creator_id", "created_at");
CREATE INDEX "gift_transactions_sender_id_created_at_idx" ON "gift_transactions" ("sender_id", "created_at");
CREATE INDEX "gift_transactions_stream_id_created_at_idx" ON "gift_transactions" ("stream_id", "created_at");
CREATE INDEX "gift_transactions_gift_id_idx" ON "gift_transactions" ("gift_id");
CREATE INDEX "gift_transactions_wallet_id_idx" ON "gift_transactions" ("wallet_id");
CREATE INDEX "gift_transactions_revenue_split_id_idx" ON "gift_transactions" ("revenue_split_id");
CREATE UNIQUE INDEX "gift_allocations_gift_transaction_id_coin_lot_id_key" ON "gift_allocations" ("gift_transaction_id", "coin_lot_id");
CREATE INDEX "gift_allocations_coin_lot_id_idx" ON "gift_allocations" ("coin_lot_id");
CREATE UNIQUE INDEX "creator_earnings_gift_transaction_id_key" ON "creator_earnings" ("gift_transaction_id");
CREATE INDEX "creator_earnings_creator_id_status_available_at_idx" ON "creator_earnings" ("creator_id", "status", "available_at");
CREATE UNIQUE INDEX "payout_accounts_provider_provider_account_ref_key" ON "payout_accounts" ("provider", "provider_account_ref");
CREATE INDEX "payout_accounts_user_id_disabled_at_idx" ON "payout_accounts" ("user_id", "disabled_at");
CREATE UNIQUE INDEX "payout_requests_idempotency_key_key" ON "payout_requests" ("idempotency_key");
CREATE UNIQUE INDEX "payout_requests_provider_provider_transfer_id_key" ON "payout_requests" ("provider", "provider_transfer_id");
CREATE INDEX "payout_requests_payout_account_id_idx" ON "payout_requests" ("payout_account_id");
CREATE INDEX "payout_requests_user_id_requested_at_idx" ON "payout_requests" ("user_id", "requested_at");
CREATE INDEX "payout_requests_status_requested_at_idx" ON "payout_requests" ("status", "requested_at");
CREATE UNIQUE INDEX "identity_verifications_provider_provider_reference_key" ON "identity_verifications" ("provider", "provider_reference");
CREATE INDEX "identity_verifications_user_id_status_idx" ON "identity_verifications" ("user_id", "status");
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds" ("idempotency_key");
CREATE UNIQUE INDEX "refunds_payment_order_id_provider_refund_id_key" ON "refunds" ("payment_order_id", "provider_refund_id");
CREATE INDEX "refunds_status_created_at_idx" ON "refunds" ("status", "created_at");
CREATE UNIQUE INDEX "disputes_payment_order_id_provider_dispute_id_key" ON "disputes" ("payment_order_id", "provider_dispute_id");
CREATE INDEX "disputes_status_opened_at_idx" ON "disputes" ("status", "opened_at");
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications" ("user_id", "read_at", "created_at");
CREATE INDEX "reports_status_created_at_idx" ON "reports" ("status", "created_at");
CREATE INDEX "reports_reporter_id_idx" ON "reports" ("reporter_id");
CREATE INDEX "reports_target_user_id_idx" ON "reports" ("target_user_id");
CREATE INDEX "reports_stream_id_idx" ON "reports" ("stream_id");
CREATE INDEX "reports_message_id_idx" ON "reports" ("message_id");
CREATE INDEX "moderation_actions_target_user_id_created_at_idx" ON "moderation_actions" ("target_user_id", "created_at");
CREATE INDEX "moderation_actions_moderator_id_idx" ON "moderation_actions" ("moderator_id");
CREATE INDEX "moderation_actions_stream_id_idx" ON "moderation_actions" ("stream_id");
CREATE INDEX "moderation_actions_report_id_idx" ON "moderation_actions" ("report_id");
CREATE INDEX "admin_audit_logs_actor_id_created_at_idx" ON "admin_audit_logs" ("actor_id", "created_at");
CREATE INDEX "admin_audit_logs_entity_type_entity_id_idx" ON "admin_audit_logs" ("entity_type", "entity_id");
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" ("created_at");
CREATE INDEX "outbox_events_published_at_available_at_idx" ON "outbox_events" ("published_at", "available_at");
CREATE INDEX "outbox_events_aggregate_id_idx" ON "outbox_events" ("aggregate_id");

-- Foreign keys (created after all tables to allow cyclic relations).

ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "sessions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_streams" ADD CONSTRAINT "live_streams_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stream_viewers" ADD CONSTRAINT "stream_viewers_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stream_viewers" ADD CONSTRAINT "stream_viewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follows" ADD CONSTRAINT "follows_followed_id_fkey" FOREIGN KEY ("followed_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stream_mutes" ADD CONSTRAINT "stream_mutes_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stream_mutes" ADD CONSTRAINT "stream_mutes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stream_mutes" ADD CONSTRAINT "stream_mutes_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_messages" ADD CONSTRAINT "live_messages_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_messages" ADD CONSTRAINT "live_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_reverses_journal_id_fkey" FOREIGN KEY ("reverses_journal_id") REFERENCES "ledger_journals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_journal_id_unit_fkey" FOREIGN KEY ("journal_id", "unit") REFERENCES "ledger_journals" ("id", "unit") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_account_id_unit_fkey" FOREIGN KEY ("account_id", "unit") REFERENCES "ledger_accounts" ("id", "unit") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_wallets" ADD CONSTRAINT "coin_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_wallets" ADD CONSTRAINT "coin_wallets_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "coin_packages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_webhooks" ADD CONSTRAINT "payment_webhooks_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lots" ADD CONSTRAINT "coin_lots_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "coin_wallets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lots" ADD CONSTRAINT "coin_lots_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_splits" ADD CONSTRAINT "revenue_splits_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "coin_wallets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_gift_id_fkey" FOREIGN KEY ("gift_id") REFERENCES "gifts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_revenue_split_id_fkey" FOREIGN KEY ("revenue_split_id") REFERENCES "revenue_splits" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_allocations" ADD CONSTRAINT "gift_allocations_gift_transaction_id_fkey" FOREIGN KEY ("gift_transaction_id") REFERENCES "gift_transactions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gift_allocations" ADD CONSTRAINT "gift_allocations_coin_lot_id_fkey" FOREIGN KEY ("coin_lot_id") REFERENCES "coin_lots" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_gift_transaction_id_fkey" FOREIGN KEY ("gift_transaction_id") REFERENCES "gift_transactions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_payout_account_id_fkey" FOREIGN KEY ("payout_account_id") REFERENCES "payout_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "live_messages" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "live_streams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
