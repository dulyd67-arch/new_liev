BEGIN;

-- CreateEnum
CREATE TYPE "SessionClientType" AS ENUM ('WEB', 'MOBILE');

-- CreateEnum
CREATE TYPE "AuthChallengeKind" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFY');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "age_attested_at" TIMESTAMPTZ(6),
ADD COLUMN     "birth_date" DATE,
ADD COLUMN     "privacy_accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "privacy_version" VARCHAR(80),
ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "terms_version" VARCHAR(80);

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "client_type" "SessionClientType" NOT NULL DEFAULT 'WEB';

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AuthChallengeKind" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_token_hash_key" ON "auth_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "auth_challenges_user_id_kind_expires_at_idx" ON "auth_challenges"("user_id", "kind", "expires_at");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Security boundaries are explicit additions beyond Prisma's relational DDL.
ALTER TABLE public.users ADD CONSTRAINT user_consent_pairs CHECK (
  (terms_version IS NULL) = (terms_accepted_at IS NULL)
  AND (privacy_version IS NULL) = (privacy_accepted_at IS NULL)
  AND (birth_date IS NULL) = (age_attested_at IS NULL));
ALTER TABLE public.sessions ADD CONSTRAINT session_refresh_hash CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE public.sessions ADD CONSTRAINT session_no_self_rotation CHECK (id <> replaced_by_id);
ALTER TABLE public.auth_challenges ADD CONSTRAINT challenge_token_hash CHECK (token_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE public.auth_challenges ADD CONSTRAINT challenge_consumed_after_creation CHECK (
  consumed_at IS NULL OR consumed_at >= created_at);

CREATE FUNCTION public.validate_session_rotation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Revoked sessions cannot be restored or rewritten';
  END IF;
  IF OLD.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Session rotation history is immutable';
  END IF;
  IF NEW.replaced_by_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.sessions s WHERE s.id = NEW.replaced_by_id
        AND s.user_id = NEW.user_id AND s.family_id = NEW.family_id AND s.client_type = NEW.client_type) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rotation successor must belong to the same user, family and client';
  END IF;
  IF NEW.replaced_by_id IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rotated sessions must be revoked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_rotation_integrity BEFORE UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.validate_session_rotation();

CREATE FUNCTION public.validate_challenge_consumption() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Consumed challenges cannot be reused or rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_single_consumption BEFORE UPDATE ON public.auth_challenges
FOR EACH ROW EXECUTE FUNCTION public.validate_challenge_consumption();

-- Future financial workers must not be able to reassign a wallet's identity.
CREATE TRIGGER coin_wallet_identity_immutable BEFORE UPDATE OR DELETE ON public.coin_wallets
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();

CREATE FUNCTION public.register_user(
  p_id uuid, p_email text, p_password_hash text, p_username text,
  p_display_name text, p_birth_date date, p_terms_version text,
  p_privacy_version text, p_locale text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  normalized_email text := lower(btrim(p_email));
  normalized_username text := lower(btrim(p_username));
  normalized_display_name text := btrim(p_display_name);
  user_role uuid;
  accepted_at timestamptz := transaction_timestamp();
BEGIN
  IF p_id IS NULL OR normalized_email IS NULL OR length(normalized_email) NOT BETWEEN 3 AND 320
      OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      OR normalized_email LIKE '%@deleted.invalid'
      OR normalized_username IS NULL OR normalized_username !~ '^[a-z][a-z0-9_]{2,31}$'
      OR left(normalized_username, 8) = 'deleted_'
      OR normalized_display_name IS NULL OR length(normalized_display_name) NOT BETWEEN 1 AND 80
      OR p_password_hash IS NULL OR p_password_hash !~ '^scrypt[$]131072[$]8[$]1[$][A-Za-z0-9_-]{22}[$][A-Za-z0-9_-]{86}$'
      OR p_birth_date IS NULL OR p_birth_date > (current_date - INTERVAL '18 years')::date
      OR p_birth_date < (current_date - INTERVAL '120 years')::date
      OR p_terms_version IS NULL OR length(btrim(p_terms_version)) NOT BETWEEN 1 AND 80
      OR p_privacy_version IS NULL OR length(btrim(p_privacy_version)) NOT BETWEEN 1 AND 80
      OR p_locale IS NULL OR p_locale NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid registration, adult attestation or required consent';
  END IF;
  SELECT id INTO user_role FROM public.roles WHERE name = 'USER';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The default user role has not been configured';
  END IF;
  INSERT INTO public.users (
    id,email,password_hash,status,birth_date,age_attested_at,terms_accepted_at,terms_version,
    privacy_accepted_at,privacy_version,created_at,updated_at
  ) VALUES (
    p_id,normalized_email,p_password_hash,'ACTIVE',p_birth_date,accepted_at,accepted_at,btrim(p_terms_version),
    accepted_at,btrim(p_privacy_version),accepted_at,accepted_at
  );
  INSERT INTO public.user_profiles(user_id,username,display_name,locale)
  VALUES (p_id,normalized_username,normalized_display_name,p_locale);
  INSERT INTO public.user_roles(user_id,role_id) VALUES (p_id,user_role);
  RETURN p_id;
END $$;

CREATE FUNCTION public.request_account_deletion(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE account_status public."UserStatus"; requested_at timestamptz := transaction_timestamp();
BEGIN
  SELECT status INTO account_status FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF account_status IN ('DELETION_PENDING', 'DELETED') THEN RETURN true; END IF;

  -- Finance and compliance records retain their stable user FK. Consent versions
  -- are retained for the documented legal retention policy, not erased blindly.
  UPDATE public.users SET
    status = 'DELETION_PENDING', deleted_at = requested_at,
    email = 'deleted.' || p_user_id::text || '@deleted.invalid',
    password_hash = NULL, birth_date = NULL, age_attested_at = NULL,
    email_verified_at = NULL, updated_at = requested_at
  WHERE id = p_user_id;
  UPDATE public.user_profiles SET
    username = 'deleted_' || left(replace(p_user_id::text, '-', ''),24),
    display_name = 'Deleted user', bio = NULL, avatar_key = NULL,
    country_code = NULL, timezone = 'UTC', locale = 'en'
  WHERE user_id = p_user_id;
  UPDATE public.sessions SET revoked_at = coalesce(revoked_at, requested_at) WHERE user_id = p_user_id;
  UPDATE public.auth_challenges SET consumed_at = coalesce(consumed_at, requested_at) WHERE user_id = p_user_id;
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION public.register_user(uuid,text,text,text,text,date,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_account_deletion(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'livestar_app') THEN
    GRANT SELECT ON public.auth_challenges TO livestar_app;
    -- SELECT grants from Phase 1 remain. These are trusted service privileges,
    -- not per-row end-user authorization; the API always binds the subject ID.
    GRANT UPDATE (password_hash,email_verified_at,updated_at) ON public.users TO livestar_app;
    GRANT UPDATE (display_name,bio,locale,timezone) ON public.user_profiles TO livestar_app;
    GRANT INSERT ON public.sessions TO livestar_app;
    GRANT UPDATE (revoked_at,replaced_by_id) ON public.sessions TO livestar_app;
    GRANT INSERT ON public.auth_challenges TO livestar_app;
    GRANT UPDATE (consumed_at) ON public.auth_challenges TO livestar_app;
    GRANT INSERT ON public.admin_audit_logs TO livestar_app;
    GRANT EXECUTE ON FUNCTION public.register_user(uuid,text,text,text,text,date,text,text,text) TO livestar_app;
    GRANT EXECUTE ON FUNCTION public.request_account_deletion(uuid) TO livestar_app;
  END IF;
END $$;

COMMIT;

