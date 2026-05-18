
-- Knowledge files table
CREATE TABLE IF NOT EXISTS public.knowledge_files (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'text',
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Knowledge chunks table with vector embeddings
DO $$
BEGIN
  IF to_regtype('extensions.vector') IS NOT NULL THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
        id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        file_id UUID NOT NULL REFERENCES public.knowledge_files(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        metadata JSONB DEFAULT ''{}'',
        embedding extensions.vector(384),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )';

    EXECUTE '
      CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON public.knowledge_chunks
      USING ivfflat (embedding extensions.vector_cosine_ops) WITH (lists = 100)';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN null;
END $$;

-- RLS
ALTER TABLE public.knowledge_files ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF to_regclass('public.knowledge_chunks') IS NOT NULL THEN
    ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN null;
END $$;

DO $$
BEGIN
  CREATE POLICY "Authenticated users can manage knowledge_files"
    ON public.knowledge_files FOR ALL TO authenticated
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN insufficient_privilege THEN null;
END $$;

DO $$
BEGIN
  IF to_regclass('public.knowledge_chunks') IS NOT NULL THEN
    CREATE POLICY "Authenticated users can manage knowledge_chunks"
      ON public.knowledge_chunks FOR ALL TO authenticated
      USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN insufficient_privilege THEN null;
END $$;

-- Updated_at trigger
DROP TRIGGER IF EXISTS update_knowledge_files_updated_at ON public.knowledge_files;
CREATE TRIGGER update_knowledge_files_updated_at
  BEFORE UPDATE ON public.knowledge_files
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
