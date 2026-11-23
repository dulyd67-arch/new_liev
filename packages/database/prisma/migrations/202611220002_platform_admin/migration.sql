-- Trusted-service administration uses narrowly granted, actor-bound functions.
-- Media I/O and PK settlement always happen outside these row transactions.
BEGIN;

CREATE INDEX admin_audit_request_lookup_idx ON public.admin_audit_logs(actor_id,request_id)
  WHERE left(action,6)='ADMIN_';

CREATE FUNCTION public.admin_request_lock(p_actor uuid,p_entity uuid,p_reason text,p_key uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE reason text;
BEGIN
  reason := btrim(p_reason,E' \t\n\r\f'||chr(11));
  IF p_actor IS NULL OR p_entity IS NULL OR p_key IS NULL OR reason IS NULL OR char_length(reason) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_INVALID_REQUEST';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livestar.admin.request:'||p_actor::text||':'||p_key::text,0));
  RETURN reason;
END $$;

CREATE FUNCTION public.admin_lock_actor(p_actor uuid,p_related uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- This order matches authentication, follow operations and stream activation.
  PERFORM id FROM public.users WHERE id IN(p_actor,p_related) ORDER BY id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor AND status='ACTIVE' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_ACCOUNT_UNAVAILABLE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id
      WHERE ur.user_id=p_actor AND r.name IN('ADMIN','SUPER_ADMIN')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_FORBIDDEN';
  END IF;
END $$;

CREATE FUNCTION public.admin_set_user_status(p_actor uuid,p_target uuid,p_status text,p_reason text,p_key uuid)
RETURNS public.users LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target public.users%ROWTYPE; previous public.admin_audit_logs%ROWTYPE; reason text; prior_status text; action_name text;
BEGIN
  reason := public.admin_request_lock(p_actor,p_target,p_reason,p_key);
  IF p_status IS NULL OR p_status NOT IN('ACTIVE','SUSPENDED') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_INVALID_REQUEST';
  END IF;
  PERFORM public.admin_lock_actor(p_actor,p_target);
  -- The actor is checked before replay; old request IDs do not preserve access.
  SELECT * INTO previous FROM public.admin_audit_logs
    WHERE actor_id=p_actor AND request_id=p_key::text AND left(action,6)='ADMIN_' ORDER BY created_at,id LIMIT 1;
  IF FOUND THEN
    IF previous.entity_type IS DISTINCT FROM 'USER' OR previous.entity_id IS DISTINCT FROM p_target::text
      OR previous.after->>'operation' IS DISTINCT FROM 'SET_USER_STATUS'
      OR previous.after->>'status' IS DISTINCT FROM p_status OR previous.after->>'reason' IS DISTINCT FROM reason THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT * INTO target FROM public.users WHERE id=p_target;
    RETURN target;
  END IF;
  IF p_target=p_actor OR EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id
      WHERE ur.user_id=p_target AND r.name IN('ADMIN','SUPER_ADMIN','MODERATOR')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_TARGET_PROTECTED';
  END IF;
  SELECT * INTO target FROM public.users WHERE id=p_target;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_NOT_FOUND'; END IF;
  IF target.deleted_at IS NOT NULL OR target.status NOT IN('ACTIVE','SUSPENDED') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_TARGET_UNAVAILABLE';
  END IF;
  IF p_status='ACTIVE' AND EXISTS(SELECT 1 FROM public.live_streams WHERE creator_id=p_target AND status IN('LIVE','SCHEDULED')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_STATE_CONFLICT';
  END IF;
  prior_status := target.status::text;
  UPDATE public.users SET status=p_status::public."UserStatus",updated_at=clock_timestamp() WHERE id=p_target RETURNING * INTO target;
  IF p_status='SUSPENDED' THEN
    UPDATE public.sessions SET revoked_at=clock_timestamp() WHERE user_id=p_target AND revoked_at IS NULL;
    IF prior_status<>'SUSPENDED' THEN
      INSERT INTO public.moderation_actions(id,moderator_id,target_user_id,type,reason)
        VALUES(gen_random_uuid(),p_actor,p_target,'SUSPEND',reason);
    END IF;
  END IF;
  action_name := CASE WHEN p_status='SUSPENDED' THEN 'ADMIN_USER_SUSPENDED' ELSE 'ADMIN_USER_RESTORED' END;
  INSERT INTO public.admin_audit_logs(id,actor_id,action,entity_type,entity_id,before,after,request_id)
    VALUES(gen_random_uuid(),p_actor,action_name,'USER',p_target::text,jsonb_build_object('status',prior_status),
      jsonb_build_object('operation','SET_USER_STATUS','status',p_status,'reason',reason),p_key::text);
  RETURN target;
END $$;

CREATE FUNCTION public.admin_terminate_stream(p_actor uuid,p_stream uuid,p_reason text,p_key uuid,p_media_stopped boolean DEFAULT false)
RETURNS public.live_streams LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE stream public.live_streams%ROWTYPE; previous public.admin_audit_logs%ROWTYPE; reason text; creator uuid; prior_status text; has_request boolean; complete boolean;
BEGIN
  reason := public.admin_request_lock(p_actor,p_stream,p_reason,p_key);
  IF p_media_stopped IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_INVALID_REQUEST'; END IF;
  SELECT creator_id INTO creator FROM public.live_streams WHERE id=p_stream;
  PERFORM public.admin_lock_actor(p_actor,creator);
  SELECT * INTO previous FROM public.admin_audit_logs
    WHERE actor_id=p_actor AND request_id=p_key::text AND left(action,6)='ADMIN_' ORDER BY created_at,id LIMIT 1;
  has_request := FOUND;
  IF has_request AND (previous.entity_type IS DISTINCT FROM 'LIVE_STREAM' OR previous.entity_id IS DISTINCT FROM p_stream::text
      OR previous.after->>'operation' IS DISTINCT FROM 'TERMINATE_STREAM' OR previous.after->>'reason' IS DISTINCT FROM reason) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_IDEMPOTENCY_CONFLICT';
  END IF;
  SELECT * INTO stream FROM public.live_streams WHERE id=p_stream FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_NOT_FOUND'; END IF;
  IF has_request THEN
    SELECT EXISTS(SELECT 1 FROM public.admin_audit_logs WHERE actor_id=p_actor AND request_id=p_key::text
      AND action='ADMIN_STREAM_TERMINATED' AND entity_id=p_stream::text) INTO complete;
    IF complete OR NOT p_media_stopped THEN RETURN stream; END IF;
  ELSE
    -- Reserve before any provider I/O. Concurrent conflicting requests cannot
    -- delete two different rooms before the database sees their shared key.
    IF p_media_stopped THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_STATE_CONFLICT'; END IF;
    IF stream.status NOT IN('LIVE','SCHEDULED','TERMINATED') THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_STATE_CONFLICT';
    END IF;
    IF stream.status<>'TERMINATED' THEN
      INSERT INTO public.admin_audit_logs(id,actor_id,action,entity_type,entity_id,before,after,request_id)
        VALUES(gen_random_uuid(),p_actor,'ADMIN_STREAM_STOP_REQUESTED','LIVE_STREAM',p_stream::text,
          jsonb_build_object('status',stream.status::text),
          jsonb_build_object('operation','TERMINATE_STREAM','phase','REQUESTED','status',stream.status::text,'reason',reason),p_key::text);
      RETURN stream;
    END IF;
  END IF;

  -- A live request reserved before an owner-end race remains a moderation
  -- decision: after media deletion it becomes TERMINATED, hiding its history.
  prior_status := stream.status::text;
  IF stream.status<>'TERMINATED' THEN
    UPDATE public.live_streams SET status='TERMINATED',ended_at=clock_timestamp() WHERE id=p_stream RETURNING * INTO stream;
    INSERT INTO public.moderation_actions(id,moderator_id,target_user_id,stream_id,type,reason)
      VALUES(gen_random_uuid(),p_actor,stream.creator_id,p_stream,'TERMINATE_STREAM',reason);
  END IF;
  INSERT INTO public.admin_audit_logs(id,actor_id,action,entity_type,entity_id,before,after,request_id)
    VALUES(gen_random_uuid(),p_actor,'ADMIN_STREAM_TERMINATED','LIVE_STREAM',p_stream::text,
      jsonb_build_object('status',prior_status),
      jsonb_build_object('operation','TERMINATE_STREAM','phase','COMPLETED','status',stream.status::text,'reason',reason),p_key::text);
  RETURN stream;
END $$;

CREATE FUNCTION public.admin_review_report(p_actor uuid,p_report uuid,p_status text,p_reason text,p_key uuid)
RETURNS public.reports LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE report public.reports%ROWTYPE; previous public.admin_audit_logs%ROWTYPE; reason text; prior_status text;
BEGIN
  reason := public.admin_request_lock(p_actor,p_report,p_reason,p_key);
  IF p_status IS NULL OR p_status NOT IN('REVIEWING','RESOLVED','DISMISSED') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_INVALID_REQUEST';
  END IF;
  PERFORM public.admin_lock_actor(p_actor);
  SELECT * INTO previous FROM public.admin_audit_logs
    WHERE actor_id=p_actor AND request_id=p_key::text AND left(action,6)='ADMIN_' ORDER BY created_at,id LIMIT 1;
  IF FOUND THEN
    IF previous.entity_type IS DISTINCT FROM 'REPORT' OR previous.entity_id IS DISTINCT FROM p_report::text
      OR previous.after->>'operation' IS DISTINCT FROM 'REVIEW_REPORT'
      OR previous.after->>'status' IS DISTINCT FROM p_status OR previous.after->>'reason' IS DISTINCT FROM reason THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_IDEMPOTENCY_CONFLICT';
    END IF;
    SELECT * INTO report FROM public.reports WHERE id=p_report;
    RETURN report;
  END IF;
  SELECT * INTO report FROM public.reports WHERE id=p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_NOT_FOUND'; END IF;
  IF report.status NOT IN('OPEN','REVIEWING') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_STATE_CONFLICT';
  END IF;
  prior_status := report.status::text;
  UPDATE public.reports SET status=p_status::public."ReportStatus",
    resolved_at=CASE WHEN p_status IN('RESOLVED','DISMISSED') THEN clock_timestamp() ELSE NULL END
    WHERE id=p_report RETURNING * INTO report;
  INSERT INTO public.admin_audit_logs(id,actor_id,action,entity_type,entity_id,before,after,request_id)
    VALUES(gen_random_uuid(),p_actor,'ADMIN_REPORT_REVIEWED','REPORT',p_report::text,
      jsonb_build_object('status',prior_status),
      jsonb_build_object('operation','REVIEW_REPORT','status',p_status,'reason',reason),p_key::text);
  RETURN report;
END $$;

CREATE FUNCTION public.guard_terminated_stream() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status='TERMINATED' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ADMIN_TERMINATED_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER live_streams_terminated_guard BEFORE UPDATE ON public.live_streams
  FOR EACH ROW EXECUTE FUNCTION public.guard_terminated_stream();

REVOKE ALL ON FUNCTION public.admin_request_lock(uuid,uuid,text,uuid),public.admin_lock_actor(uuid,uuid),
  public.admin_set_user_status(uuid,uuid,text,text,uuid),public.admin_terminate_stream(uuid,uuid,text,uuid,boolean),
  public.admin_review_report(uuid,uuid,text,text,uuid),public.guard_terminated_stream() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='livestar_app') THEN
    GRANT EXECUTE ON FUNCTION public.admin_set_user_status(uuid,uuid,text,text,uuid),
      public.admin_terminate_stream(uuid,uuid,text,uuid,boolean),public.admin_review_report(uuid,uuid,text,text,uuid) TO livestar_app;
  END IF;
END $$;

COMMIT;
