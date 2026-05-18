-- =============================================
-- FASE 1: Tabelas para Instâncias WhatsApp
-- =============================================

-- Criar enum para provider_type
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'whatsapp_provider_type') THEN
    CREATE TYPE whatsapp_provider_type AS ENUM ('official', 'evolution_self_hosted', 'evolution_cloud');
  END IF;
END $$;

-- Criar enum para status da instância
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'whatsapp_instance_status') THEN
    CREATE TYPE whatsapp_instance_status AS ENUM ('connected', 'connecting', 'disconnected', 'qr_required');
  END IF;
END $$;

-- Tabela principal de instâncias WhatsApp
CREATE TABLE IF NOT EXISTS public.whatsapp_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  instance_name TEXT NOT NULL,
  provider_type whatsapp_provider_type NOT NULL DEFAULT 'official',
  instance_id_external TEXT,
  phone_number TEXT,
  status whatsapp_instance_status DEFAULT 'disconnected',
  qr_code TEXT,
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(instance_name)
);

-- Tabela de secrets das instâncias (separada por segurança)
CREATE TABLE IF NOT EXISTS public.whatsapp_instance_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  api_key TEXT NOT NULL,
  api_url TEXT NOT NULL,
  verify_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(instance_id)
);

-- Trigger para updated_at em whatsapp_instances
CREATE TRIGGER update_whatsapp_instances_updated_at
  BEFORE UPDATE ON public.whatsapp_instances
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger para updated_at em whatsapp_instance_secrets
CREATE TRIGGER update_whatsapp_instance_secrets_updated_at
  BEFORE UPDATE ON public.whatsapp_instance_secrets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Função para garantir apenas uma instância padrão por usuário
CREATE OR REPLACE FUNCTION ensure_single_default_instance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    UPDATE public.whatsapp_instances 
    SET is_default = false 
    WHERE user_id = NEW.user_id 
      AND id != NEW.id 
      AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER ensure_single_default_instance_trigger
  BEFORE INSERT OR UPDATE ON public.whatsapp_instances
  FOR EACH ROW
  EXECUTE FUNCTION ensure_single_default_instance();

-- Enable RLS
ALTER TABLE public.whatsapp_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_instance_secrets ENABLE ROW LEVEL SECURITY;

-- RLS Policies para whatsapp_instances
CREATE POLICY "Admins can manage all whatsapp_instances"
  ON public.whatsapp_instances
  FOR ALL
  USING (has_role(auth.uid(), 'admin'))
  WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated users can read whatsapp_instances"
  ON public.whatsapp_instances
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- RLS Policies para whatsapp_instance_secrets (apenas admins)
CREATE POLICY "Admins can manage whatsapp_instance_secrets"
  ON public.whatsapp_instance_secrets
  FOR ALL
  USING (has_role(auth.uid(), 'admin'))
  WITH CHECK (has_role(auth.uid(), 'admin'));

-- =============================================
-- FASE 2: Adicionar instance_id nas tabelas existentes
-- =============================================

-- Adicionar coluna instance_id em contacts
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = COALESCE(NULLIF(split_part('public.contacts', '.', 1), 'public.contacts'), 'public')
      AND table_name = split_part('public.contacts', '.', 2)
      AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE public.contacts ADD COLUMN instance_id UUID REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Adicionar coluna instance_id em conversations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = COALESCE(NULLIF(split_part('public.conversations', '.', 1), 'public.conversations'), 'public')
      AND table_name = split_part('public.conversations', '.', 2)
      AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE public.conversations ADD COLUMN instance_id UUID REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Adicionar coluna instance_id em send_queue
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = COALESCE(NULLIF(split_part('public.send_queue', '.', 1), 'public.send_queue'), 'public')
      AND table_name = split_part('public.send_queue', '.', 2)
      AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE public.send_queue ADD COLUMN instance_id UUID REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Adicionar coluna instance_id em message_grouping_queue
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = COALESCE(NULLIF(split_part('public.message_grouping_queue', '.', 1), 'public.message_grouping_queue'), 'public')
      AND table_name = split_part('public.message_grouping_queue', '.', 2)
      AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE public.message_grouping_queue ADD COLUMN instance_id UUID REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_contacts_instance_id ON public.contacts(instance_id);
CREATE INDEX IF NOT EXISTS idx_conversations_instance_id ON public.conversations(instance_id);
CREATE INDEX IF NOT EXISTS idx_send_queue_instance_id ON public.send_queue(instance_id);
CREATE INDEX IF NOT EXISTS idx_message_grouping_queue_instance_id ON public.message_grouping_queue(instance_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_status ON public.whatsapp_instances(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_provider_type ON public.whatsapp_instances(provider_type);
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_is_default ON public.whatsapp_instances(is_default) WHERE is_default = true;