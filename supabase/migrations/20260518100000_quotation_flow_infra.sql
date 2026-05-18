-- Migration: quotation_flow_infra
-- P0-6 do board Miro — infra pra Meta WhatsApp Flow de cotação.
--
-- 1) nina_settings.quotation_flow_id — armazena o flow_id retornado pelo Meta
--    App Manager após publicar quotation-flow.json. Permite trocar/atualizar
--    sem redeploy de Edge function.
-- 2) quotation_flow_tokens — rastreia cada Flow enviado pra correlacionar com
--    a nfm_reply quando o cliente submete o form (response_json não inclui
--    flow_token, então precisa lookup por message_id ou phone+timestamp).
--
-- Idempotente.

-- ============================================================================
-- 1) nina_settings.quotation_flow_id
-- ============================================================================

ALTER TABLE public.nina_settings
  ADD COLUMN IF NOT EXISTS quotation_flow_id TEXT;

COMMENT ON COLUMN public.nina_settings.quotation_flow_id IS
  'Meta WhatsApp Flow ID publicado para QUOTATION_FORM. Obtido após upload do '
  'JSON em supabase/functions/send-quotation-flow/quotation-flow.json pelo '
  'Meta App Manager (Flow Builder UI) ou Flow Management API.';

-- ============================================================================
-- 2) quotation_flow_tokens (rastreamento)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quotation_flow_tokens (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_token     TEXT        NOT NULL UNIQUE,
  phone          TEXT        NOT NULL,
  contact_name   TEXT,
  flow_id        TEXT        NOT NULL,
  message_id     TEXT,
  conversation_id UUID,
  status         TEXT        NOT NULL DEFAULT 'sent',
  response_json  JSONB,
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotation_flow_tokens_phone
  ON public.quotation_flow_tokens (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotation_flow_tokens_status
  ON public.quotation_flow_tokens (status)
  WHERE status = 'sent';

COMMENT ON TABLE public.quotation_flow_tokens IS
  'Rastreamento de Flows de cotação enviados via send-quotation-flow Edge function. '
  'Atualizado pelo whatsapp-webhook quando interactive.nfm_reply é recebido (status=responded).';

COMMENT ON COLUMN public.quotation_flow_tokens.status IS
  'sent (Flow enviado, aguardando submissão) | responded (cliente submeteu) | expired (24h sem resposta)';

COMMENT ON COLUMN public.quotation_flow_tokens.response_json IS
  'JSON parsed do nfm_reply.response_json — origem, destino, peso_kg, cargo_value.';

-- ============================================================================
-- 3) RLS — service_role acessa tudo, authenticated não vê (interna)
-- ============================================================================

ALTER TABLE public.quotation_flow_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quotation_flow_tokens_service_all" ON public.quotation_flow_tokens;
CREATE POLICY "quotation_flow_tokens_service_all"
  ON public.quotation_flow_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
