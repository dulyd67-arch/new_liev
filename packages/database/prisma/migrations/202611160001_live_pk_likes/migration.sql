-- LIVE PK uses two existing live rooms and free DU gift history only.
-- The trusted API supplies the authenticated actor; no financial path is enabled.
BEGIN;

CREATE TYPE public."PkBattleStatus" AS ENUM ('INVITED','ACTIVE','FINISHED','DECLINED','CANCELED');
CREATE TABLE public.pk_battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  guest_stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  host_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  guest_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  inviter_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  idempotency_key uuid NOT NULL,
  status public."PkBattleStatus" NOT NULL DEFAULT 'INVITED',
  duration_seconds integer NOT NULL DEFAULT 300 CHECK (duration_seconds IN (180,300)),
  invitation_expires_at timestamptz(6) NOT NULL,
  starts_at timestamptz(6),
  ends_at timestamptz(6),
  final_host_score numeric(78,0),
  final_guest_score numeric(78,0),
  winner_stream_id uuid REFERENCES public.live_streams(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  finish_reason varchar(40),
  settled_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (inviter_id,idempotency_key),
  CHECK (host_stream_id <> guest_stream_id AND host_user_id <> guest_user_id AND inviter_id = host_user_id),
  CHECK (winner_stream_id IS NULL OR winner_stream_id IN (host_stream_id,guest_stream_id)),
  CHECK (invitation_expires_at > created_at),
  CONSTRAINT pk_battle_shape CHECK (
    (status = 'INVITED' AND starts_at IS NULL AND ends_at IS NULL AND settled_at IS NULL
      AND final_host_score IS NULL AND final_guest_score IS NULL AND winner_stream_id IS NULL AND finish_reason IS NULL)
    OR (status = 'ACTIVE' AND starts_at IS NOT NULL AND ends_at > starts_at AND settled_at IS NULL
      AND final_host_score IS NULL AND final_guest_score IS NULL AND winner_stream_id IS NULL AND finish_reason IS NULL)
    OR (status = 'FINISHED' AND starts_at IS NOT NULL AND ends_at > starts_at AND settled_at IS NOT NULL
      AND final_host_score IS NOT NULL AND final_guest_score IS NOT NULL
      AND final_host_score >= 0 AND final_guest_score >= 0 AND finish_reason IS NOT NULL)
    OR (status IN ('DECLINED','CANCELED') AND starts_at IS NULL AND ends_at IS NULL AND settled_at IS NOT NULL
      AND final_host_score IS NULL AND final_guest_score IS NULL AND winner_stream_id IS NULL AND finish_reason IS NOT NULL)
  )
);
CREATE INDEX pk_battles_host_stream_id_created_at_idx ON public.pk_battles(host_stream_id,created_at DESC);
CREATE INDEX pk_battles_guest_stream_id_created_at_idx ON public.pk_battles(guest_stream_id,created_at DESC);
CREATE INDEX pk_battles_guest_user_id_status_created_at_idx ON public.pk_battles(guest_user_id,status,created_at DESC);
CREATE INDEX pk_battles_status_ends_at_idx ON public.pk_battles(status,ends_at);
CREATE INDEX du_transactions_pk_score_idx ON public.du_transactions(stream_id,creator_id,created_at) WHERE type='GIFT' AND amount < 0;

CREATE FUNCTION public.guard_pk_battle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_HISTORY_IMMUTABLE';
  END IF;
  IF current_setting('livestar.pk_battle',true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_ATOMIC_FUNCTION_ONLY';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('FINISHED','DECLINED','CANCELED') THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_HISTORY_IMMUTABLE';
    END IF;
    IF (to_jsonb(NEW)-'status'-'starts_at'-'ends_at'-'final_host_score'-'final_guest_score'-'winner_stream_id'-'finish_reason'-'settled_at')
        IS DISTINCT FROM (to_jsonb(OLD)-'status'-'starts_at'-'ends_at'-'final_host_score'-'final_guest_score'-'winner_stream_id'-'finish_reason'-'settled_at')
      OR (OLD.status='INVITED' AND NEW.status NOT IN ('ACTIVE','DECLINED','CANCELED'))
      OR (OLD.status='ACTIVE' AND (NEW.status <> 'FINISHED' OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at)) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_HISTORY_IMMUTABLE';
    END IF;
  ELSIF NEW.status <> 'INVITED' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pk_battles_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pk_battles FOR EACH ROW EXECUTE FUNCTION public.guard_pk_battle();
CREATE TRIGGER pk_battles_no_truncate BEFORE TRUNCATE ON public.pk_battles FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();

-- All PK changes take one transaction advisory lock before reading participants.
-- This serializes cross-role reservations (A→B racing C→A), including stale
-- invitations whose opponent lies outside the two requested rooms. Then lock
-- users before streams, matching live-room activation; DU locks serialize gift
-- commits before a final score. Never invoke these RPCs while holding row locks.
CREATE FUNCTION public.pk_lock_participants(p_stream_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE room_id uuid;
BEGIN
  PERFORM id FROM public.users WHERE id IN
    (SELECT creator_id FROM public.live_streams WHERE id=ANY(p_stream_ids)) ORDER BY id FOR SHARE;
  FOR room_id IN SELECT DISTINCT unnest(p_stream_ids) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('livestar.du.stream:'||room_id::text,0));
  END LOOP;
  PERFORM id FROM public.live_streams WHERE id=ANY(p_stream_ids) ORDER BY id FOR SHARE;
END $$;

CREATE FUNCTION public.pk_store(p_battle public.pk_battles) RETURNS public.pk_battles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE previous_guard text; result public.pk_battles%ROWTYPE;
BEGIN
  previous_guard := current_setting('livestar.pk_battle',true);
  PERFORM set_config('livestar.pk_battle',p_battle.id::text,true);
  UPDATE public.pk_battles SET status=p_battle.status,starts_at=p_battle.starts_at,ends_at=p_battle.ends_at,
    final_host_score=p_battle.final_host_score,final_guest_score=p_battle.final_guest_score,
    winner_stream_id=p_battle.winner_stream_id,finish_reason=p_battle.finish_reason,settled_at=p_battle.settled_at
    WHERE id=p_battle.id RETURNING * INTO result;
  PERFORM set_config('livestar.pk_battle',coalesce(previous_guard,''),true);
  RETURN result;
END $$;

CREATE FUNCTION public.pk_reconcile(p_battle_id uuid,p_forfeit_stream_id uuid DEFAULT NULL) RETURNS public.pk_battles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE
  battle public.pk_battles%ROWTYPE;
  host_available boolean; guest_available boolean; blocked boolean;
  current_time_at timestamptz; cutoff timestamptz;
BEGIN
  SELECT * INTO battle FROM public.pk_battles WHERE id=p_battle_id FOR UPDATE;
  IF NOT FOUND OR battle.status NOT IN ('INVITED','ACTIVE') THEN RETURN battle; END IF;
  current_time_at := clock_timestamp();
  SELECT EXISTS(SELECT 1 FROM public.live_streams s JOIN public.users u ON u.id=s.creator_id
      WHERE s.id=battle.host_stream_id AND s.creator_id=battle.host_user_id AND s.status='LIVE' AND u.status='ACTIVE' AND u.deleted_at IS NULL),
    EXISTS(SELECT 1 FROM public.live_streams s JOIN public.users u ON u.id=s.creator_id
      WHERE s.id=battle.guest_stream_id AND s.creator_id=battle.guest_user_id AND s.status='LIVE' AND u.status='ACTIVE' AND u.deleted_at IS NULL),
    EXISTS(SELECT 1 FROM public.user_blocks WHERE (blocker_id=battle.host_user_id AND blocked_id=battle.guest_user_id)
      OR (blocker_id=battle.guest_user_id AND blocked_id=battle.host_user_id))
    INTO host_available,guest_available,blocked;
  IF battle.status='INVITED' THEN
    IF current_time_at>=battle.invitation_expires_at OR NOT host_available OR NOT guest_available OR blocked OR p_forfeit_stream_id IS NOT NULL THEN
      battle.status := 'CANCELED'; battle.settled_at := current_time_at;
      battle.finish_reason := CASE WHEN current_time_at>=battle.invitation_expires_at THEN 'INVITATION_EXPIRED'
        WHEN blocked THEN 'BLOCKED' ELSE 'STREAM_UNAVAILABLE' END;
      RETURN public.pk_store(battle);
    END IF;
    RETURN battle;
  END IF;
  IF current_time_at < battle.ends_at AND host_available AND guest_available AND NOT blocked AND p_forfeit_stream_id IS NULL THEN
    RETURN battle;
  END IF;
  cutoff := least(current_time_at,battle.ends_at);
  SELECT coalesce(sum(-amount::numeric) FILTER(WHERE stream_id=battle.host_stream_id AND creator_id=battle.host_user_id),0),
    coalesce(sum(-amount::numeric) FILTER(WHERE stream_id=battle.guest_stream_id AND creator_id=battle.guest_user_id),0)
    INTO battle.final_host_score,battle.final_guest_score
    FROM public.du_transactions WHERE type='GIFT' AND amount<0 AND stream_id IN(battle.host_stream_id,battle.guest_stream_id)
      AND created_at>=battle.starts_at AND created_at<cutoff;
  battle.status := 'FINISHED'; battle.settled_at := current_time_at;
  IF current_time_at>=battle.ends_at THEN
    battle.finish_reason := 'COMPLETED';
    battle.winner_stream_id := CASE WHEN battle.final_host_score>battle.final_guest_score THEN battle.host_stream_id
      WHEN battle.final_guest_score>battle.final_host_score THEN battle.guest_stream_id ELSE NULL END;
  ELSIF blocked THEN
    battle.finish_reason := 'BLOCKED'; battle.winner_stream_id := NULL;
  ELSE
    host_available := host_available AND p_forfeit_stream_id IS DISTINCT FROM battle.host_stream_id;
    guest_available := guest_available AND p_forfeit_stream_id IS DISTINCT FROM battle.guest_stream_id;
    battle.finish_reason := CASE WHEN NOT host_available AND NOT guest_available THEN 'BOTH_UNAVAILABLE' ELSE 'FORFEIT' END;
    battle.winner_stream_id := CASE WHEN host_available AND NOT guest_available THEN battle.host_stream_id
      WHEN guest_available AND NOT host_available THEN battle.guest_stream_id ELSE NULL END;
  END IF;
  RETURN public.pk_store(battle);
END $$;

CREATE FUNCTION public.pk_invite(p_actor_id uuid,p_host_stream_id uuid,p_guest_stream_id uuid,p_idempotency_key uuid,p_duration_seconds integer DEFAULT 300)
RETURNS public.pk_battles LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE battle public.pk_battles%ROWTYPE; host public.live_streams%ROWTYPE; guest public.live_streams%ROWTYPE;
  related_streams uuid[]; related_id uuid; previous_guard text; created_time timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_host_stream_id IS NULL OR p_guest_stream_id IS NULL OR p_idempotency_key IS NULL
      OR p_duration_seconds IS NULL OR p_duration_seconds NOT IN (180,300) OR p_host_stream_id=p_guest_stream_id THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.pk.state',0));
  SELECT * INTO battle FROM public.pk_battles WHERE inviter_id=p_actor_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF battle.host_stream_id<>p_host_stream_id OR battle.guest_stream_id<>p_guest_stream_id OR battle.duration_seconds<>p_duration_seconds THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN battle;
  END IF;
  SELECT * INTO host FROM public.live_streams WHERE id=p_host_stream_id;
  SELECT * INTO guest FROM public.live_streams WHERE id=p_guest_stream_id;
  IF host.id IS NULL OR guest.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_STREAM_UNAVAILABLE'; END IF;
  IF host.creator_id<>p_actor_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_FORBIDDEN'; END IF;
  IF host.creator_id=guest.creator_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST'; END IF;
  SELECT array_agg(DISTINCT stream_id) INTO related_streams FROM (
    SELECT unnest(ARRAY[p_host_stream_id,p_guest_stream_id]) AS stream_id
    UNION SELECT unnest(ARRAY[host_stream_id,guest_stream_id]) FROM public.pk_battles WHERE status IN ('INVITED','ACTIVE')
      AND (host_stream_id IN(p_host_stream_id,p_guest_stream_id) OR guest_stream_id IN(p_host_stream_id,p_guest_stream_id))
  ) rooms;
  PERFORM public.pk_lock_participants(related_streams);
  FOR related_id IN SELECT id FROM public.pk_battles WHERE status IN ('INVITED','ACTIVE')
    AND (host_stream_id IN(p_host_stream_id,p_guest_stream_id) OR guest_stream_id IN(p_host_stream_id,p_guest_stream_id)) ORDER BY id LOOP
    PERFORM public.pk_reconcile(related_id);
  END LOOP;
  SELECT * INTO host FROM public.live_streams WHERE id=p_host_stream_id;
  SELECT * INTO guest FROM public.live_streams WHERE id=p_guest_stream_id;
  IF host.status<>'LIVE' OR guest.status<>'LIVE' OR host.creator_id<>p_actor_id THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_STREAM_UNAVAILABLE';
  END IF;
  IF (SELECT count(*) FROM public.users WHERE id IN(host.creator_id,guest.creator_id) AND status='ACTIVE' AND deleted_at IS NULL)<>2 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_ACCOUNT_UNAVAILABLE';
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_blocks WHERE (blocker_id=host.creator_id AND blocked_id=guest.creator_id) OR (blocker_id=guest.creator_id AND blocked_id=host.creator_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_BLOCKED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.pk_battles WHERE status IN('INVITED','ACTIVE')
    AND (host_stream_id IN(p_host_stream_id,p_guest_stream_id) OR guest_stream_id IN(p_host_stream_id,p_guest_stream_id))) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_BUSY';
  END IF;
  created_time := clock_timestamp();
  battle.id := gen_random_uuid(); previous_guard := current_setting('livestar.pk_battle',true);
  PERFORM set_config('livestar.pk_battle',battle.id::text,true);
  INSERT INTO public.pk_battles(id,host_stream_id,guest_stream_id,host_user_id,guest_user_id,inviter_id,idempotency_key,duration_seconds,invitation_expires_at,created_at)
    VALUES(battle.id,host.id,guest.id,host.creator_id,guest.creator_id,p_actor_id,p_idempotency_key,p_duration_seconds,created_time+interval '60 seconds',created_time)
    RETURNING * INTO battle;
  PERFORM set_config('livestar.pk_battle',coalesce(previous_guard,''),true);
  RETURN battle;
END $$;

CREATE FUNCTION public.pk_respond(p_actor_id uuid,p_battle_id uuid,p_action text) RETURNS public.pk_battles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE battle public.pk_battles%ROWTYPE; start_time timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_battle_id IS NULL OR p_action IS NULL OR p_action NOT IN('ACCEPT','DECLINE','CANCEL','LEAVE') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.pk.state',0));
  SELECT * INTO battle FROM public.pk_battles WHERE id=p_battle_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_NOT_FOUND'; END IF;
  IF p_actor_id NOT IN(battle.host_user_id,battle.guest_user_id)
    OR (p_action IN('ACCEPT','DECLINE') AND p_actor_id<>battle.guest_user_id)
    OR (p_action='CANCEL' AND p_actor_id<>battle.inviter_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_FORBIDDEN';
  END IF;
  PERFORM public.pk_lock_participants(ARRAY[battle.host_stream_id,battle.guest_stream_id]);
  battle := public.pk_reconcile(p_battle_id);
  IF battle.status IN('FINISHED','DECLINED','CANCELED') THEN RETURN battle; END IF;
  IF p_action='LEAVE' THEN
    IF battle.status<>'ACTIVE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_STATE_CONFLICT'; END IF;
    RETURN public.pk_reconcile(p_battle_id,CASE WHEN p_actor_id=battle.host_user_id THEN battle.host_stream_id ELSE battle.guest_stream_id END);
  END IF;
  IF p_action='ACCEPT' AND battle.status='ACTIVE' THEN RETURN battle; END IF;
  IF battle.status<>'INVITED' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_STATE_CONFLICT'; END IF;
  IF p_action='ACCEPT' THEN
    start_time := clock_timestamp(); battle.status := 'ACTIVE'; battle.starts_at := start_time;
    battle.ends_at := start_time+make_interval(secs=>battle.duration_seconds);
  ELSE
    battle.status := CASE WHEN p_action='DECLINE' THEN 'DECLINED'::public."PkBattleStatus" ELSE 'CANCELED'::public."PkBattleStatus" END;
    battle.settled_at := clock_timestamp(); battle.finish_reason := p_action;
  END IF;
  RETURN public.pk_store(battle);
END $$;

CREATE FUNCTION public.pk_snapshot(p_stream_id uuid) RETURNS TABLE(
  id uuid,host_stream_id uuid,guest_stream_id uuid,host_user_id uuid,guest_user_id uuid,inviter_id uuid,idempotency_key uuid,
  status public."PkBattleStatus",duration_seconds integer,invitation_expires_at timestamptz,starts_at timestamptz,ends_at timestamptz,
  final_host_score numeric,final_guest_score numeric,winner_stream_id uuid,finish_reason varchar,settled_at timestamptz,created_at timestamptz,
  host_score text,guest_score text,server_now timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE battle public.pk_battles%ROWTYPE; host_points numeric:=0; guest_points numeric:=0; snapshot_time timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.pk.state',0));
  SELECT b.* INTO battle FROM public.pk_battles b WHERE p_stream_id IN(b.host_stream_id,b.guest_stream_id) ORDER BY b.created_at DESC,b.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM public.pk_lock_participants(ARRAY[battle.host_stream_id,battle.guest_stream_id]);
  battle := public.pk_reconcile(battle.id); snapshot_time := clock_timestamp();
  IF battle.status='FINISHED' THEN host_points:=battle.final_host_score; guest_points:=battle.final_guest_score;
  ELSIF battle.status='ACTIVE' THEN
    SELECT coalesce(sum(-d.amount::numeric) FILTER(WHERE d.stream_id=battle.host_stream_id AND d.creator_id=battle.host_user_id),0),
      coalesce(sum(-d.amount::numeric) FILTER(WHERE d.stream_id=battle.guest_stream_id AND d.creator_id=battle.guest_user_id),0)
      INTO host_points,guest_points FROM public.du_transactions d WHERE d.type='GIFT' AND d.amount<0
        AND d.stream_id IN(battle.host_stream_id,battle.guest_stream_id) AND d.created_at>=battle.starts_at AND d.created_at<least(snapshot_time,battle.ends_at);
  END IF;
  RETURN QUERY SELECT battle.*,host_points::text,guest_points::text,snapshot_time;
END $$;

CREATE FUNCTION public.pk_settle_stream(p_stream_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE battle public.pk_battles%ROWTYPE;
BEGIN
  IF p_stream_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PK_INVALID_REQUEST'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.pk.state',0));
  FOR battle IN SELECT * FROM public.pk_battles WHERE status IN('INVITED','ACTIVE') AND p_stream_id IN(host_stream_id,guest_stream_id) ORDER BY id LOOP
    PERFORM public.pk_lock_participants(ARRAY[battle.host_stream_id,battle.guest_stream_id]);
    PERFORM public.pk_reconcile(battle.id,p_stream_id);
  END LOOP;
END $$;

CREATE TABLE public.stream_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  count integer NOT NULL CHECK(count BETWEEN 1 AND 20),
  idempotency_key uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX stream_likes_stream_id_idx ON public.stream_likes(stream_id);
CREATE INDEX stream_likes_user_id_created_at_idx ON public.stream_likes(user_id,created_at);
CREATE TRIGGER stream_likes_immutable BEFORE UPDATE OR DELETE ON public.stream_likes FOR EACH ROW EXECUTE FUNCTION public.reject_record_mutation();
CREATE TRIGGER stream_likes_no_truncate BEFORE TRUNCATE ON public.stream_likes FOR EACH STATEMENT EXECUTE FUNCTION public.reject_record_mutation();
CREATE FUNCTION public.guard_stream_like() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('livestar.stream_like',true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_ATOMIC_FUNCTION_ONLY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stream_likes_guard BEFORE INSERT ON public.stream_likes FOR EACH ROW EXECUTE FUNCTION public.guard_stream_like();

CREATE FUNCTION public.stream_send_likes(p_actor_id uuid,p_stream_id uuid,p_count integer,p_idempotency_key uuid)
RETURNS TABLE(id uuid,stream_id uuid,user_id uuid,count integer,created_at timestamptz,total text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event public.stream_likes%ROWTYPE; room public.live_streams%ROWTYPE; current_time_at timestamptz; recent_total bigint; previous_guard text;
BEGIN
  IF p_actor_id IS NULL OR p_stream_id IS NULL OR p_count IS NULL OR p_count NOT BETWEEN 1 AND 20 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_INVALID_REQUEST';
  END IF;
  -- One actor lock covers both idempotent replay and the rolling global quota.
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.likes.user:'||p_actor_id::text,0));
  SELECT l.* INTO event FROM public.stream_likes l WHERE l.user_id=p_actor_id AND l.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF event.stream_id<>p_stream_id OR event.count<>p_count THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_IDEMPOTENCY_CONFLICT'; END IF;
  ELSE
    SELECT * INTO room FROM public.live_streams WHERE live_streams.id=p_stream_id;
    IF NOT FOUND OR room.status<>'LIVE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_STREAM_UNAVAILABLE'; END IF;
    PERFORM u.id FROM public.users u WHERE u.id IN(p_actor_id,room.creator_id) ORDER BY u.id FOR SHARE;
    SELECT * INTO room FROM public.live_streams WHERE live_streams.id=p_stream_id FOR SHARE;
    IF NOT FOUND OR room.status<>'LIVE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_STREAM_UNAVAILABLE'; END IF;
    IF (SELECT count(*) FROM public.users u WHERE u.id IN(p_actor_id,room.creator_id) AND u.status='ACTIVE' AND u.deleted_at IS NULL)
      <> (CASE WHEN p_actor_id=room.creator_id THEN 1 ELSE 2 END) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_ACCOUNT_UNAVAILABLE'; END IF;
    IF EXISTS(SELECT 1 FROM public.user_blocks WHERE (blocker_id=p_actor_id AND blocked_id=room.creator_id) OR (blocker_id=room.creator_id AND blocked_id=p_actor_id)) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_BLOCKED';
    END IF;
    current_time_at := clock_timestamp();
    SELECT coalesce(sum(l.count),0) INTO recent_total FROM public.stream_likes l WHERE l.user_id=p_actor_id AND l.created_at>current_time_at-interval '1 minute';
    IF recent_total+p_count>120 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LIKES_RATE_LIMITED'; END IF;
    event.id:=gen_random_uuid(); previous_guard:=current_setting('livestar.stream_like',true);
    PERFORM set_config('livestar.stream_like',event.id::text,true);
    INSERT INTO public.stream_likes(id,stream_id,user_id,count,idempotency_key,created_at) VALUES(event.id,p_stream_id,p_actor_id,p_count,p_idempotency_key,current_time_at) RETURNING * INTO event;
    PERFORM set_config('livestar.stream_like',coalesce(previous_guard,''),true);
  END IF;
  RETURN QUERY SELECT event.id,event.stream_id,event.user_id,event.count,event.created_at,
    coalesce(sum(l.count::numeric),0)::text FROM public.stream_likes l WHERE l.stream_id=event.stream_id;
END $$;

REVOKE ALL ON public.pk_battles,public.stream_likes FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_pk_battle(),public.guard_stream_like(),public.pk_lock_participants(uuid[]),public.pk_store(public.pk_battles),public.pk_reconcile(uuid,uuid),public.pk_invite(uuid,uuid,uuid,uuid,integer),public.pk_respond(uuid,uuid,text),public.pk_snapshot(uuid),public.pk_settle_stream(uuid),public.stream_send_likes(uuid,uuid,integer,uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='livestar_app') THEN
    REVOKE ALL ON public.pk_battles,public.stream_likes FROM livestar_app;
    GRANT SELECT ON public.pk_battles,public.stream_likes TO livestar_app;
    GRANT EXECUTE ON FUNCTION public.pk_invite(uuid,uuid,uuid,uuid,integer),public.pk_respond(uuid,uuid,text),public.pk_snapshot(uuid),public.pk_settle_stream(uuid),public.stream_send_likes(uuid,uuid,integer,uuid) TO livestar_app;
  END IF;
END $$;

-- Gift timestamps must be allocated after the stream advisory lock is obtained,
-- not from transaction start: a waiting sender cannot backdate a post-deadline
-- gift into an already settled battle. Keep the deployed DU contract unchanged.
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
    id,type,user_id,stream_id,creator_id,gift_id,quantity,unit_price,amount,balance_after,idempotency_key,created_at
  ) VALUES(
    new_id,'GIFT',p_user_id,p_stream_id,room.creator_id,p_gift_id,p_quantity,gift.price,
    -total::bigint,wallet.balance - total::bigint,p_idempotency_key,clock_timestamp()
  ) RETURNING * INTO posted;
  PERFORM set_config('livestar.du_transaction',coalesce(previous_guard,''),true);
  RETURN posted;
END $$;

COMMIT;
