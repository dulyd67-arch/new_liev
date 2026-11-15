-- Prisma masks custom SQL23505 messages as unique-constraint metadata.
-- Use the existing tagged domain-error SQLSTATE so clients retain the DU tag.
-- CREATE OR REPLACE retains the existing restricted execution privileges.
BEGIN;

CREATE OR REPLACE FUNCTION public.du_claim_coins(p_user_id uuid,p_idempotency_key text)
RETURNS public.du_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  previous public.du_transactions%ROWTYPE;
  wallet public.du_wallets%ROWTYPE;
  posted public.du_transactions%ROWTYPE;
  new_id uuid := gen_random_uuid();
  previous_guard text;
BEGIN
  IF p_user_id IS NULL OR p_idempotency_key IS NULL
      OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.du.idem:' || p_user_id::text || ':' || p_idempotency_key,0));
  SELECT * INTO previous FROM public.du_transactions
  WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF previous.type <> 'CLAIM' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN previous;
  END IF;
  PERFORM 1 FROM public.users WHERE id = p_user_id AND status = 'ACTIVE' AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_ACCOUNT_UNAVAILABLE';
  END IF;
  INSERT INTO public.du_wallets(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO wallet FROM public.du_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF wallet.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_ALREADY_CLAIMED';
  END IF;
  IF wallet.balance::numeric + 100 > 9223372036854775807 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_AMOUNT_OVERFLOW';
  END IF;
  previous_guard := current_setting('livestar.du_transaction',true);
  PERFORM set_config('livestar.du_transaction',new_id::text,true);
  INSERT INTO public.du_transactions(id,type,user_id,amount,balance_after,idempotency_key)
  VALUES(new_id,'CLAIM',p_user_id,100,wallet.balance + 100,p_idempotency_key) RETURNING * INTO posted;
  PERFORM set_config('livestar.du_transaction',coalesce(previous_guard,''),true);
  RETURN posted;
END $$;

CREATE OR REPLACE FUNCTION public.du_send_gift(
  p_user_id uuid,p_stream_id uuid,p_gift_id uuid,p_quantity bigint,p_idempotency_key text
) RETURNS public.du_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  previous public.du_transactions%ROWTYPE;
  room public.live_streams%ROWTYPE;
  gift public.du_gifts%ROWTYPE;
  wallet public.du_wallets%ROWTYPE;
  posted public.du_transactions%ROWTYPE;
  total numeric;
  new_id uuid := gen_random_uuid();
  previous_guard text;
  expected_creator uuid;
BEGIN
  IF p_user_id IS NULL OR p_stream_id IS NULL OR p_gift_id IS NULL
      OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 99 OR p_idempotency_key IS NULL
      OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.du.idem:' || p_user_id::text || ':' || p_idempotency_key,0));
  SELECT * INTO previous FROM public.du_transactions
  WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF previous.type <> 'GIFT' OR previous.stream_id IS DISTINCT FROM p_stream_id
        OR previous.gift_id IS DISTINCT FROM p_gift_id OR previous.quantity IS DISTINCT FROM p_quantity THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN previous;
  END IF;

  -- Every sender on a stream shares this transaction lock. Its sequence values
  -- commit in order, so a polling client never skips a late-committing event.
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.du.stream:' || p_stream_id::text,0));
  SELECT * INTO room FROM public.live_streams WHERE id = p_stream_id;
  IF NOT FOUND OR room.status <> 'LIVE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_STREAM_UNAVAILABLE';
  END IF;
  IF room.creator_id = p_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_SELF_GIFT';
  END IF;
  expected_creator := room.creator_id;
  -- Stream activation locks its creator before updating the stream. Follow the
  -- same row-lock order, then re-read the stream after obtaining the user locks.
  PERFORM id FROM public.users WHERE id IN (p_user_id,room.creator_id) ORDER BY id FOR SHARE;
  SELECT * INTO room FROM public.live_streams WHERE id = p_stream_id FOR SHARE;
  IF NOT FOUND OR room.status <> 'LIVE' OR room.creator_id <> expected_creator THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_STREAM_UNAVAILABLE';
  END IF;
  IF (SELECT count(*) FROM public.users WHERE id IN (p_user_id,room.creator_id)
      AND status = 'ACTIVE' AND deleted_at IS NULL) <> 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_ACCOUNT_UNAVAILABLE';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_blocks
      WHERE (blocker_id = p_user_id AND blocked_id = room.creator_id)
         OR (blocker_id = room.creator_id AND blocked_id = p_user_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_BLOCKED';
  END IF;
  SELECT * INTO gift FROM public.du_gifts WHERE id = p_gift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_GIFT_UNAVAILABLE';
  END IF;
  total := gift.price::numeric * p_quantity::numeric;
  IF total > 9223372036854775807 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_AMOUNT_OVERFLOW';
  END IF;
  SELECT * INTO wallet FROM public.du_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR wallet.balance::numeric < total THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DU_INSUFFICIENT_BALANCE';
  END IF;
  previous_guard := current_setting('livestar.du_transaction',true);
  PERFORM set_config('livestar.du_transaction',new_id::text,true);
  INSERT INTO public.du_transactions(
    id,type,user_id,stream_id,creator_id,gift_id,quantity,unit_price,amount,balance_after,idempotency_key
  ) VALUES(
    new_id,'GIFT',p_user_id,p_stream_id,room.creator_id,p_gift_id,p_quantity,gift.price,
    -total::bigint,wallet.balance - total::bigint,p_idempotency_key
  ) RETURNING * INTO posted;
  PERFORM set_config('livestar.du_transaction',coalesce(previous_guard,''),true);
  RETURN posted;
END $$;

COMMIT;
