-- Trusted API presence observations apply only to the observed battle. Generic
-- LIVE status and room reconnects are independent of this PK-only settlement.
BEGIN;

CREATE FUNCTION public.pk_settle_absent(p_battle_id uuid,p_stream_ids uuid[]) RETURNS public.pk_battles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE
  battle public.pk_battles%ROWTYPE;
  absent_stream_id uuid;
  current_time_at timestamptz; cutoff timestamptz;
BEGIN
  IF p_battle_id IS NULL OR p_stream_ids IS NULL OR coalesce(array_ndims(p_stream_ids),0)<>1
    OR cardinality(p_stream_ids) NOT IN (1,2) OR array_position(p_stream_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT id) FROM unnest(p_stream_ids) AS ids(id))<>cardinality(p_stream_ids) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.pk.state',0));
  SELECT * INTO battle FROM public.pk_battles WHERE id=p_battle_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_stream_ids) AS ids(id) WHERE id NOT IN(battle.host_stream_id,battle.guest_stream_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST';
  END IF;
  -- A stale observation must never settle a later battle on the same streams.
  IF battle.status NOT IN('INVITED','ACTIVE') THEN RETURN battle; END IF;

  -- Reuse the user -> ordered DU advisory -> stream locks before the battle
  -- row, so in-flight committed gifts enter the final score consistently.
  PERFORM public.pk_lock_participants(ARRAY[battle.host_stream_id,battle.guest_stream_id]);
  SELECT * INTO battle FROM public.pk_battles WHERE id=p_battle_id FOR UPDATE;
  SELECT id INTO absent_stream_id FROM unnest(p_stream_ids) AS ids(id) LIMIT 1;
  IF battle.status='INVITED' OR cardinality(p_stream_ids)=1 THEN
    RETURN public.pk_reconcile(p_battle_id,absent_stream_id);
  END IF;

  -- Both observations form one transition; sequential forfeits would invent a
  -- winner. The score window remains capped by the original round deadline.
  current_time_at := clock_timestamp();
  IF current_time_at>=battle.ends_at THEN RETURN public.pk_reconcile(p_battle_id); END IF;
  cutoff := least(current_time_at,battle.ends_at);
  SELECT coalesce(sum(-amount::numeric) FILTER(WHERE stream_id=battle.host_stream_id AND creator_id=battle.host_user_id),0),
    coalesce(sum(-amount::numeric) FILTER(WHERE stream_id=battle.guest_stream_id AND creator_id=battle.guest_user_id),0)
    INTO battle.final_host_score,battle.final_guest_score
    FROM public.du_transactions WHERE type='GIFT' AND amount<0 AND stream_id IN(battle.host_stream_id,battle.guest_stream_id)
      AND created_at>=battle.starts_at AND created_at<cutoff;
  battle.status := 'FINISHED'; battle.settled_at := current_time_at;
  battle.finish_reason := 'BOTH_UNAVAILABLE'; battle.winner_stream_id := NULL;
  RETURN public.pk_store(battle);
END $$;

REVOKE ALL ON FUNCTION public.pk_settle_absent(uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='livestar_app') THEN
    GRANT EXECUTE ON FUNCTION public.pk_settle_absent(uuid,uuid[]) TO livestar_app;
  END IF;
END $$;

COMMIT;
