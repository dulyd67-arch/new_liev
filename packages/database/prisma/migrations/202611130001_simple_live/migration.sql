BEGIN;

-- A creator may have only one reserved or currently live room.
CREATE UNIQUE INDEX live_streams_one_open_per_creator
ON public.live_streams(creator_id) WHERE status IN ('SCHEDULED', 'LIVE');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'livestar_app') THEN
    GRANT INSERT ON public.live_streams TO livestar_app;
    GRANT UPDATE (status,started_at,ended_at,title,category) ON public.live_streams TO livestar_app;
    GRANT INSERT ON public.live_messages TO livestar_app;
  END IF;
END $$;

COMMIT;
