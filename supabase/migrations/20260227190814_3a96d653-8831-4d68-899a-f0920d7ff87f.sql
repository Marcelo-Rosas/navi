
-- Enable pgvector in extensions schema (it may already be there)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN insufficient_privilege THEN null;
  WHEN undefined_file THEN null;
END $$;
