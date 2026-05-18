DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = COALESCE(NULLIF(split_part('public.design_settings', '.', 1), 'public.design_settings'), 'public')
      AND table_name = split_part('public.design_settings', '.', 2)
      AND column_name = 'sidebar_identity_font'
  ) THEN
    ALTER TABLE public.design_settings ADD COLUMN sidebar_identity_font text DEFAULT 'Playfair Display',
  ADD COLUMN sidebar_identity_enabled boolean DEFAULT true;
  END IF;
END $$;