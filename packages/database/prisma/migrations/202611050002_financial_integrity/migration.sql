-- Reviewed SQL controls complement the Prisma model. Amounts are integer units.
-- Application credentials are deliberately read-only in Phase 1.
BEGIN;

CREATE UNIQUE INDEX users_email_casefold_key ON public.users (lower(email));
CREATE UNIQUE INDEX user_profiles_username_casefold_key ON public.user_profiles (lower(username));
ALTER TABLE public.follows ADD CONSTRAINT follows_no_self CHECK (follower_id <> followed_id);
ALTER TABLE public.user_blocks ADD CONSTRAINT user_blocks_no_self CHECK (blocker_id <> blocked_id);
ALTER TABLE public.gifts ADD CONSTRAINT gift_positive_price CHECK (price_coins > 0);
ALTER TABLE public.coin_packages ADD CONSTRAINT coin_package_positive CHECK (
  coins > 0 AND price_minor > 0 AND currency_exponent BETWEEN 0 AND 4 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE public.revenue_splits ADD CONSTRAINT revenue_split_complete CHECK (
  creator_bps BETWEEN 0 AND 10000 AND platform_bps BETWEEN 0 AND 10000
  AND creator_bps + platform_bps = 10000);
ALTER TABLE public.wallet_ledger ADD CONSTRAINT ledger_line_nonzero CHECK (amount <> 0 AND amount >= -9223372036854775807);
ALTER TABLE public.ledger_journals ADD CONSTRAINT ledger_hash_format CHECK (request_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE public.ledger_journals ADD CONSTRAINT ledger_no_self_reversal CHECK (id <> reverses_journal_id);
ALTER TABLE public.ledger_accounts ADD CONSTRAINT protected_balance CHECK (NOT enforce_non_negative OR balance >= 0);
ALTER TABLE public.ledger_accounts ADD CONSTRAINT ledger_account_unit CHECK (
  ((kind IN ('COIN_WALLET','COIN_ISSUANCE','COIN_REDEMPTION')) = (unit = 'LIVECOIN'))
  AND (kind NOT IN ('COIN_WALLET','CREATOR_PENDING','CREATOR_AVAILABLE','CREATOR_HELD')
       OR (enforce_non_negative AND owner_id IS NOT NULL)));
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_positive CHECK (
  coins > 0 AND amount_minor > 0 AND currency_exponent BETWEEN 0 AND 4 AND currency ~ '^[A-Z]{3}$'
  AND (fx_rate_to_usd IS NULL OR fx_rate_to_usd > 0)
  AND (gross_usd_micros IS NULL OR gross_usd_micros >= 0)
  AND (processing_fee_usd_micros IS NULL OR processing_fee_usd_micros >= 0)
  AND (tax_usd_micros IS NULL OR tax_usd_micros >= 0)
  AND (settled_net_usd_micros IS NULL OR settled_net_usd_micros >= 0));
ALTER TABLE public.payment_orders ADD CONSTRAINT settled_payment_evidence CHECK (
  status <> 'SETTLED' OR (
    settled_at IS NOT NULL AND settlement_reference IS NOT NULL AND provider_order_id IS NOT NULL
    AND fx_rate_to_usd IS NOT NULL AND fx_observed_at IS NOT NULL AND fx_source IS NOT NULL
    AND gross_usd_micros IS NOT NULL AND processing_fee_usd_micros IS NOT NULL
    AND tax_usd_micros IS NOT NULL AND settled_net_usd_micros IS NOT NULL
    AND settled_net_usd_micros::numeric = gross_usd_micros::numeric - processing_fee_usd_micros - tax_usd_micros));
ALTER TABLE public.coin_lots ADD CONSTRAINT coin_lot_conservation CHECK (
  coins_issued > 0 AND coins_remaining BETWEEN 0 AND coins_issued
  AND settled_net_usd_micros >= 0 AND allocated_net_usd_micros BETWEEN 0 AND settled_net_usd_micros
  AND allocated_net_usd_micros = floor(settled_net_usd_micros::numeric * (coins_issued - coins_remaining) / coins_issued)
  AND (coins_remaining <> 0 OR allocated_net_usd_micros = settled_net_usd_micros));
ALTER TABLE public.gift_transactions ADD CONSTRAINT gift_transaction_snapshot CHECK (
  sender_id <> creator_id AND quantity > 0 AND unit_price_coins > 0 AND total_coins > 0
  AND total_coins::numeric = unit_price_coins::numeric * quantity
  AND eligible_net_usd_micros >= 0 AND creator_usd_micros >= 0 AND platform_usd_micros >= 0
  AND creator_bps BETWEEN 0 AND 10000 AND platform_bps BETWEEN 0 AND 10000
  AND creator_bps + platform_bps = 10000
  AND creator_usd_micros::numeric + platform_usd_micros = eligible_net_usd_micros
  AND creator_usd_micros = floor(eligible_net_usd_micros::numeric * creator_bps / 10000));
ALTER TABLE public.gift_allocations ADD CONSTRAINT allocation_positive CHECK (coins > 0 AND eligible_net_usd_micros >= 0);
ALTER TABLE public.creator_earnings ADD CONSTRAINT earning_positive CHECK (amount_usd_micros >= 0);
ALTER TABLE public.payout_requests ADD CONSTRAINT payout_positive CHECK (
  amount_usd_micros > 0 AND fee_usd_micros >= 0 AND amount_minor > 0 AND fx_rate_from_usd > 0
  AND currency_exponent BETWEEN 0 AND 4 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE public.refunds ADD CONSTRAINT refund_positive CHECK (
  amount_minor > 0 AND amount_usd_micros >= 0 AND processing_fee_usd_micros >= 0 AND fx_rate_to_usd > 0
  AND currency_exponent BETWEEN 0 AND 4 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE public.disputes ADD CONSTRAINT dispute_positive CHECK (
  amount_minor > 0 AND amount_usd_micros >= 0 AND fee_usd_micros >= 0 AND fx_rate_to_usd > 0
  AND currency_exponent BETWEEN 0 AND 4 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE public.reports ADD CONSTRAINT report_has_target CHECK (
  target_user_id IS NOT NULL OR stream_id IS NOT NULL OR message_id IS NOT NULL);

CREATE FUNCTION public.reject_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Append-only record: create a compensating event instead';
END $$;

CREATE TRIGGER ledger_journal_immutable BEFORE UPDATE OR DELETE ON public.ledger_journals
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER ledger_line_immutable BEFORE UPDATE OR DELETE ON public.wallet_ledger
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON public.admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER revenue_split_immutable BEFORE UPDATE OR DELETE ON public.revenue_splits
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER gift_snapshot_immutable BEFORE UPDATE OR DELETE ON public.gift_transactions
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON public.gift_allocations
FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();

-- TRUNCATE does not fire row DELETE triggers; protect it explicitly.
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON public.ledger_journals
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER lines_no_truncate BEFORE TRUNCATE ON public.wallet_ledger
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON public.admin_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER splits_no_truncate BEFORE TRUNCATE ON public.revenue_splits
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER gifts_no_truncate BEFORE TRUNCATE ON public.gift_transactions
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER allocations_no_truncate BEFORE TRUNCATE ON public.gift_allocations
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();

CREATE FUNCTION public.validate_new_revenue_split() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.revenue-policy', 0));
  IF EXISTS (SELECT 1 FROM public.revenue_splits) AND NEW.effective_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'New revenue policies must take effect in the future';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revenue_split_future BEFORE INSERT ON public.revenue_splits
FOR EACH ROW EXECUTE FUNCTION public.validate_new_revenue_split();

CREATE FUNCTION public.guard_ledger_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Opening balances require a journal';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Ledger accounts are permanent';
  END IF;
  IF pg_trigger_depth() <> 2 OR
    (to_jsonb(NEW) - 'balance') IS DISTINCT FROM (to_jsonb(OLD) - 'balance') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Account metadata is immutable and balances are ledger projections';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_account_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_ledger_account();

CREATE FUNCTION public.apply_ledger_line() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- The posting function supplies this guard only while building one journal.
  -- SQL grants, not this setting, form the trust boundary against the runtime role.
  IF current_setting('livestar.posting_journal', true) IS DISTINCT FROM NEW.journal_id::text THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Use the atomic posting function; journals are sealed';
  END IF;
  UPDATE public.ledger_accounts SET balance = balance + NEW.amount
  WHERE id = NEW.account_id AND unit = NEW.unit
    AND (NOT enforce_non_negative OR balance::numeric + NEW.amount >= 0);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unknown account, unit mismatch, or insufficient balance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_line_projection AFTER INSERT ON public.wallet_ledger
FOR EACH ROW EXECUTE FUNCTION public.apply_ledger_line();

CREATE FUNCTION public.check_journal_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target_id uuid; n bigint; total numeric;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN target_id := NEW.id;
  ELSE target_id := NEW.journal_id; END IF;
  SELECT count(*), coalesce(sum(amount), 0) INTO n, total
  FROM public.wallet_ledger WHERE journal_id = target_id;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every journal must contain two or more balanced lines';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON public.ledger_journals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_journal_balance();
CREATE CONSTRAINT TRIGGER lines_balanced AFTER INSERT ON public.wallet_ledger
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_journal_balance();

CREATE FUNCTION public.validate_coin_wallet() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_accounts WHERE id = NEW.ledger_account_id
      AND owner_id = NEW.user_id AND unit = 'LIVECOIN' AND kind = 'COIN_WALLET' AND enforce_non_negative) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Wallet must reference its own protected LiveCoin account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coin_wallet_owner BEFORE INSERT OR UPDATE ON public.coin_wallets
FOR EACH ROW EXECUTE FUNCTION public.validate_coin_wallet();

CREATE FUNCTION public.validate_coin_lot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.coins_remaining <> NEW.coins_issued OR NEW.allocated_net_usd_micros <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'New settled lots must begin unspent';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.payment_orders p JOIN public.coin_wallets w ON w.user_id = p.user_id
        WHERE p.id = NEW.payment_order_id AND w.id = NEW.wallet_id AND p.status = 'SETTLED'
        AND p.coins = NEW.coins_issued AND p.settled_net_usd_micros = NEW.settled_net_usd_micros) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lot must match a settled payment owned by the wallet holder';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'coins_remaining' - 'allocated_net_usd_micros') IS DISTINCT FROM
        (to_jsonb(OLD) - 'coins_remaining' - 'allocated_net_usd_micros')
        OR NEW.coins_remaining > OLD.coins_remaining OR NEW.allocated_net_usd_micros < OLD.allocated_net_usd_micros THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lot provenance is immutable; consumption is monotonic';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coin_lot_provenance BEFORE INSERT OR UPDATE ON public.coin_lots
FOR EACH ROW EXECUTE FUNCTION public.validate_coin_lot();

CREATE FUNCTION public.validate_gift_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE policy public.revenue_splits%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM public.revenue_splits WHERE effective_at <= transaction_timestamp()
  ORDER BY effective_at DESC LIMIT 1;
  IF NOT FOUND OR NEW.revenue_split_id <> policy.id OR NEW.creator_bps <> policy.creator_bps
      OR NEW.platform_bps <> policy.platform_bps THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Gift must snapshot the currently effective revenue policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.coin_wallets WHERE id = NEW.wallet_id AND user_id = NEW.sender_id)
      OR NOT EXISTS (SELECT 1 FROM public.live_streams WHERE id = NEW.stream_id AND creator_id = NEW.creator_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Gift wallet and stream must belong to sender and creator';
  END IF;
  NEW.created_at := transaction_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER gift_revenue_policy BEFORE INSERT ON public.gift_transactions
FOR EACH ROW EXECUTE FUNCTION public.validate_gift_snapshot();

CREATE FUNCTION public.post_ledger_journal(
  p_key text, p_unit public."LedgerUnit", p_source_type text, p_source_id text,
  p_entries jsonb, p_reverses uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  canonical jsonb; digest text; previous public.ledger_journals%ROWTYPE;
  new_id uuid := gen_random_uuid(); line record; n integer; total numeric;
  original_entries jsonb; previous_guard text;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_unit IS NULL
    OR p_source_type IS NULL OR length(p_source_type) NOT BETWEEN 1 AND 50
    OR p_source_id IS NULL OR length(p_source_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Missing or invalid posting identity';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Entries must be an array';
  END IF;
  n := jsonb_array_length(p_entries);
  IF n NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Journal requires 2 to 100 distinct accounts';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_entries) e WHERE
      jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'amount') IS DISTINCT FROM 'string'
      OR jsonb_typeof(e->'account_id') IS DISTINCT FROM 'string'
      OR (e->>'amount') !~ '^-?(0|[1-9][0-9]*)$'
      OR (e->>'account_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (e - 'account_id' - 'amount') <> '{}'::jsonb) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Entry amounts must be exact integer strings with account UUIDs';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'amount', amount::text) ORDER BY account_id), sum(amount)
  INTO canonical, total FROM (
    SELECT (e->>'account_id')::uuid AS account_id, (e->>'amount')::bigint AS amount
    FROM jsonb_array_elements(p_entries) e
  ) parsed;
  IF total <> 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(canonical) e WHERE (e->>'amount')::bigint = 0)
    OR (SELECT count(DISTINCT e->>'account_id') FROM jsonb_array_elements(canonical) e) <> n THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Posting must balance, use nonzero amounts and distinct accounts';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_object(
    'unit', p_unit, 'source_type', p_source_type, 'source_id', p_source_id,
    'reverses', p_reverses, 'entries', canonical)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.post:' || p_key, 0));
  SELECT * INTO previous FROM public.ledger_journals WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF previous.request_hash <> digest THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Idempotency key reused with different content';
    END IF;
    RETURN previous.id;
  END IF;

  -- Stable global account ordering prevents deadlocks between overlapping postings.
  PERFORM a.id FROM public.ledger_accounts a
  JOIN jsonb_array_elements(canonical) e ON a.id = (e->>'account_id')::uuid
  ORDER BY a.id FOR UPDATE OF a;
  IF (SELECT count(*) FROM public.ledger_accounts a JOIN jsonb_array_elements(canonical) e
      ON a.id = (e->>'account_id')::uuid WHERE a.unit = p_unit) <> n THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'All accounts must exist in the journal unit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_accounts a JOIN jsonb_array_elements(canonical) e
      ON a.id = (e->>'account_id')::uuid
      WHERE a.enforce_non_negative AND a.balance::numeric + (e->>'amount')::bigint < 0) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Insufficient available balance';
  END IF;
  IF p_reverses IS NOT NULL THEN
    PERFORM 1 FROM public.ledger_journals WHERE id = p_reverses AND unit = p_unit FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unknown original journal or unit mismatch';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'amount', (-amount::numeric)::text) ORDER BY account_id)
    INTO original_entries FROM public.wallet_ledger WHERE journal_id = p_reverses;
    IF original_entries IS DISTINCT FROM canonical THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Reversal must exactly negate the original journal';
    END IF;
  END IF;

  INSERT INTO public.ledger_journals(id,unit,idempotency_key,request_hash,source_type,source_id,reverses_journal_id)
  VALUES (new_id,p_unit,p_key,digest,p_source_type,p_source_id,p_reverses);
  previous_guard := current_setting('livestar.posting_journal', true);
  PERFORM set_config('livestar.posting_journal', new_id::text, true);
  FOR line IN SELECT (e->>'account_id')::uuid AS account_id, (e->>'amount')::bigint AS amount
      FROM jsonb_array_elements(canonical) e ORDER BY (e->>'account_id')::uuid LOOP
    INSERT INTO public.wallet_ledger(id,journal_id,account_id,unit,amount)
    VALUES (gen_random_uuid(),new_id,line.account_id,p_unit,line.amount);
  END LOOP;
  PERFORM set_config('livestar.posting_journal', coalesce(previous_guard, ''), true);
  RETURN new_id;
END $$;

-- Close default function execution. No external route or runtime role can mint
-- coins/post revenue. A dedicated worker grant needs its own reviewed phase.
REVOKE EXECUTE ON FUNCTION public.post_ledger_journal(text,public."LedgerUnit",text,text,jsonb,uuid) FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'livestar_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM livestar_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM livestar_app;
    GRANT USAGE ON SCHEMA public TO livestar_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO livestar_app;
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
      REVOKE ALL ON public._prisma_migrations FROM livestar_app;
    END IF;
    REVOKE EXECUTE ON FUNCTION public.post_ledger_journal(text,public."LedgerUnit",text,text,jsonb,uuid) FROM livestar_app;
  END IF;
END $$;
COMMIT;
