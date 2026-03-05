import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Retry com delay exponencial para contornar problemas temporários de DNS/rede
async function fetchWithRetry(
  url: string, 
  options: RequestInit, 
  retries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      console.log(`[send-evolution-message] Attempt ${attempt + 1}/${retries} to ${url}`);
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[send-evolution-message] Attempt ${attempt + 1} failed: ${errorMessage}`);
      
      if (attempt === retries - 1) {
        throw error;
      }
      
      // Delay exponencial: 1s, 2s, 4s
      const delay = 1000 * Math.pow(2, attempt);
      console.log(`[send-evolution-message] Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('All retries failed');
}

/** Normalizes Brazilian phone numbers to E.164 without '+' (e.g. "5511999998888") */
function normalizeBrazilianPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) {
    digits = digits.slice(2);
  }
  if (digits.length < 10 || digits.length > 11) return null;
  if (digits.length === 10) {
    const firstDigit = parseInt(digits[2], 10);
    if (firstDigit >= 6) digits = digits.slice(0, 2) + '9' + digits.slice(2);
  }
  return '55' + digits;
}

interface SendMessageRequest {
  instance_id: string;
  phone_number: string;
  content: string;
  message_type?: 'text' | 'audio' | 'image' | 'document';
  media_url?: string;
  file_name?: string;
}

serve(async (req) => {
  console.log(`[send-evolution-message] Received ${req.method} request`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body: SendMessageRequest = await req.json();
    const { instance_id, phone_number, content, message_type = 'text', media_url, file_name } = body;

    console.log(`[send-evolution-message] Sending ${message_type} to ${phone_number} via instance ${instance_id}`);

    // Buscar instância
    const { data: instance, error: instanceError } = await supabase
      .from('whatsapp_instances')
      .select('id, instance_name, instance_id_external, provider_type, status')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      throw new Error('Instance not found');
    }

    if (instance.status !== 'connected') {
      throw new Error(`Instance is not connected. Status: ${instance.status}`);
    }

    // Buscar secrets
    const { data: secrets, error: secretsError } = await supabase
      .from('whatsapp_instance_secrets')
      .select('api_url, api_key')
      .eq('instance_id', instance_id)
      .single();

    if (secretsError || !secrets) {
      throw new Error('Instance secrets not found');
    }

    // Determinar identificador correto
    const instanceIdentifier = instance.provider_type === 'evolution_cloud' && instance.instance_id_external
      ? instance.instance_id_external
      : instance.instance_name;

    // Formatar número com normalização completa brasileira
    const formattedNumber = normalizeBrazilianPhone(phone_number) ?? phone_number.replace(/\D/g, '');

    // Headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': secrets.api_key,
    };

    let endpoint: string;
    let payload: any;
    let presenceType = 'composing';

    switch (message_type) {
      case 'text':
        endpoint = `${secrets.api_url.replace(/\/$/, '')}/message/sendText/${instanceIdentifier}`;
        payload = {
          number: formattedNumber,
          text: content,
        };
        presenceType = 'composing';
        break;

      case 'audio':
        endpoint = `${secrets.api_url.replace(/\/$/, '')}/message/sendWhatsAppAudio/${instanceIdentifier}`;
        payload = {
          number: formattedNumber,
          audio: media_url,
        };
        presenceType = 'recording';
        break;

      case 'image':
        endpoint = `${secrets.api_url.replace(/\/$/, '')}/message/sendMedia/${instanceIdentifier}`;
        payload = {
          number: formattedNumber,
          mediatype: 'image',
          media: media_url,
          caption: content || '',
        };
        break;

      case 'document':
        endpoint = `${secrets.api_url.replace(/\/$/, '')}/message/sendMedia/${instanceIdentifier}`;
        payload = {
          number: formattedNumber,
          mediatype: 'document',
          media: media_url,
          caption: content || '',
          fileName: file_name || 'document',
        };
        break;

      default:
        throw new Error(`Unsupported message type: ${message_type}`);
    }

    // Enviar presence antes da mensagem
    try {
      const presenceUrl = `${secrets.api_url.replace(/\/$/, '')}/chat/sendPresence/${instanceIdentifier}`;
      console.log(`[send-evolution-message] Sending presence '${presenceType}' to ${formattedNumber}`);
      await fetch(presenceUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          number: `${formattedNumber}@s.whatsapp.net`,
          delay: 3000,
          presence: presenceType,
        }),
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (presenceErr) {
      console.log('[send-evolution-message] Presence error (non-fatal):', presenceErr);
    }

    console.log(`[send-evolution-message] Sending to: ${endpoint}`);

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    console.log(`[send-evolution-message] Response: ${response.status} - ${responseText.substring(0, 500)}`);

    if (!response.ok) {
      throw new Error(`Evolution API error: ${responseText}`);
    }

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    // Extrair messageId da resposta
    const messageId = responseData?.key?.id || responseData?.messageId || responseData?.id;

    return new Response(JSON.stringify({
      success: true,
      messageId,
      data: responseData,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[send-evolution-message] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      success: false,
      error: message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
