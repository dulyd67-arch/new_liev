-- Bounded profile images use the existing avatar field. The application validates
-- image format and dimensions; this constraint independently caps stored bytes.
BEGIN;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_avatar_key_size
  CHECK (avatar_key IS NULL OR octet_length(avatar_key) <= 65560);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'livestar_app') THEN
    GRANT UPDATE (avatar_key) ON public.user_profiles TO livestar_app;
  END IF;
END $$;

COMMIT;
