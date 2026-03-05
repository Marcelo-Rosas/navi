import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { instance_id } = await req.json();

    if (!instance_id) {
      return new Response(JSON.stringify({ success: false, error: 'instance_id obrigatório' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Buscar dados da instância
    const { data: instance, error: instErr } = await supabase
      .from('whatsapp_instances')
      .select('*, whatsapp_instance_secrets(*)')
      .eq('id', instance_id)
      .single();

    if (instErr || !instance) {
      return new Response(JSON.stringify({ success: false, error: 'Instância não encontrada' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const secrets = (instance as any).whatsapp_instance_secrets;
    if (!secrets || !secrets.api_url || !secrets.api_key) {
      return new Response(JSON.stringify({ success: false, error: 'Credenciais da instância não encontradas' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const baseUrl = secrets.api_url.replace(/\/$/, '');
    const instanceName = instance.instance_name;

    // Verificar status de conexão primeiro
    const stateRes = await fetch(`${baseUrl}/instance/connectionState/${instanceName}`, {
      headers: { 'apikey': secrets.api_key },
    });

    let currentState = 'disconnected';
    if (stateRes.ok) {
      try {
        const stateData = await stateRes.json();
        currentState = stateData?.state || stateData?.instance?.state || 'disconnected';
      } catch {}
    }

    console.log(`[get-evolution-qrcode] Instance ${instanceName} state: ${currentState}`);

    // Se já conectado, atualizar no banco e retornar
    if (currentState === 'open') {
      await supabase
        .from('whatsapp_instances')
        .update({ status: 'connected', qr_code: null, updated_at: new Date().toISOString() })
        .eq('id', instance_id);

      return new Response(JSON.stringify({
        success: true,
        connected: true,
        status: 'connected',
        qr_code: null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Buscar QR Code
    const qrRes = await fetch(`${baseUrl}/instance/connect/${instanceName}`, {
      headers: { 'apikey': secrets.api_key },
    });

    const qrText = await qrRes.text();
    console.log(`[get-evolution-qrcode] QR response (${qrRes.status}): ${qrText.substring(0, 300)}`);

    let qrCode: string | null = null;
    let connected = false;

    try {
      const qrData = JSON.parse(qrText);
      qrCode = qrData?.base64 || qrData?.qrcode?.base64 || null;
      connected = qrData?.state === 'open' || qrData?.instance?.state === 'open';
    } catch {}

    // Atualizar no banco
    if (qrCode || connected) {
      await supabase
        .from('whatsapp_instances')
        .update({
          status: connected ? 'connected' : 'qr_required',
          qr_code: connected ? null : qrCode,
          updated_at: new Date().toISOString(),
        })
        .eq('id', instance_id);
    }

    return new Response(JSON.stringify({
      success: true,
      connected,
      status: connected ? 'connected' : (qrCode ? 'qr_required' : 'disconnected'),
      qr_code: qrCode,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[get-evolution-qrcode] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
