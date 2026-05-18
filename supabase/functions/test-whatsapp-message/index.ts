import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (!digits.startsWith('55')) {
    digits = `55${digits}`;
  }
  return digits;
}

async function sendViaMeta(
  phoneNumberId: string,
  accessToken: string,
  phone: string,
  message: string,
): Promise<{ messageId: string }> {
  const response = await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: message },
      }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const metaMsg = data?.error?.message || JSON.stringify(data);
    const hint = metaMsg.includes('not in allowed list') || metaMsg.includes('131030')
      ? ' Adicione o número na lista de testes do app no Meta for Developers.'
      : '';
    throw new Error(`Meta API: ${metaMsg}${hint}`);
  }

  const messageId = data?.messages?.[0]?.id;
  if (!messageId) throw new Error('Meta API não retornou ID da mensagem');
  return { messageId };
}

async function sendViaEvolution(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  supabaseServiceKey: string,
  cleanPhone: string,
  message: string,
  userId: string,
): Promise<{ messageId: string; contactId: string; conversationId: string }> {
  const { data: instance } = await supabase
    .from('whatsapp_instances')
    .select('id, instance_name, status, is_default')
    .eq('is_active', true)
    .eq('status', 'connected')
    .order('is_default', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!instance) {
    throw new Error(
      'Nenhuma instância Evolution conectada. Configure Access Token e Phone Number ID (Meta) ou conecte uma instância Evolution.',
    );
  }

  const { data: existingContact } = await supabase
    .from('contacts')
    .select('id')
    .eq('phone_number', cleanPhone)
    .maybeSingle();

  let contactId: string;
  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const { data: newContact, error: contactError } = await supabase
      .from('contacts')
      .insert({ phone_number: cleanPhone, whatsapp_id: cleanPhone, user_id: userId })
      .select('id')
      .single();
    if (contactError) throw new Error('Erro ao criar contato: ' + contactError.message);
    contactId = newContact.id;
  }

  const { data: existingConv } = await supabase
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
    .eq('is_active', true)
    .maybeSingle();

  let conversationId: string;
  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    const { data: newConv, error: convError } = await supabase
      .from('conversations')
      .insert({ contact_id: contactId, status: 'nina', is_active: true, user_id: userId })
      .select('id')
      .single();
    if (convError) throw new Error('Erro ao criar conversa: ' + convError.message);
    conversationId = newConv.id;
  }

  const { data: newMessage, error: messageError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      from_type: 'nina',
      type: 'text',
      content: message,
      status: 'processing',
    })
    .select('id')
    .single();

  if (messageError) throw new Error('Erro ao criar mensagem: ' + messageError.message);

  const sendResponse = await fetch(`${supabaseUrl}/functions/v1/send-evolution-message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({
      instance_id: instance.id,
      phone_number: cleanPhone,
      content: message,
      message_type: 'text',
    }),
  });

  const sendData = await sendResponse.json();

  if (!sendResponse.ok || !sendData.success) {
    await supabase.from('messages').update({ status: 'failed' }).eq('id', newMessage.id);
    throw new Error(sendData.error || 'Erro ao enviar mensagem via Evolution API');
  }

  const whatsappMessageId = sendData.messageId;
  await supabase
    .from('messages')
    .update({ whatsapp_message_id: whatsappMessageId, status: 'sent' })
    .eq('id', newMessage.id);

  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return { messageId: whatsappMessageId, contactId, conversationId };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { phone, phone_number, message } = body;
    const rawPhone = phone || phone_number;
    const text = typeof message === 'string' ? message.trim() : '';

    if (!rawPhone || !text) {
      return jsonResponse(
        { success: false, error: 'Número de telefone e mensagem são obrigatórios' },
        400,
      );
    }

    const cleanPhone = normalizePhone(rawPhone);
    if (cleanPhone.length < 12 || cleanPhone.length > 13) {
      return jsonResponse(
        {
          success: false,
          error: 'Número inválido. Use DDD + número com 9 dígitos (ex: 5511999999999 ou +5511999999999)',
        },
        400,
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let userId: string | null = null;
    const authHeader = req.headers.get('authorization');
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id || null;
    }

    if (!userId) {
      return jsonResponse({ success: false, error: 'Usuário não autenticado' }, 401);
    }

    const { data: ninaSettings } = await supabase
      .from('nina_settings')
      .select('whatsapp_access_token, whatsapp_phone_number_id')
      .limit(1)
      .maybeSingle();

    const accessToken = (
      body.whatsapp_access_token ||
      ninaSettings?.whatsapp_access_token ||
      ''
    ).trim();
    const phoneNumberId = (
      body.whatsapp_phone_number_id ||
      ninaSettings?.whatsapp_phone_number_id ||
      ''
    ).trim();

    if (accessToken && phoneNumberId) {
      console.log('[test-whatsapp-message] Meta Cloud API →', cleanPhone);
      const { messageId } = await sendViaMeta(phoneNumberId, accessToken, cleanPhone, text);
      return jsonResponse({ success: true, message_id: messageId, provider: 'meta' }, 200);
    }

    console.log('[test-whatsapp-message] Evolution fallback');
    const result = await sendViaEvolution(
      supabase,
      supabaseUrl,
      supabaseServiceKey,
      cleanPhone,
      text,
      userId,
    );
    return jsonResponse({
      success: true,
      message_id: result.messageId,
      contact_id: result.contactId,
      conversation_id: result.conversationId,
      provider: 'evolution',
    }, 200);
  } catch (error) {
    console.error('[test-whatsapp-message] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erro inesperado';
    const isClientError =
      errorMessage.includes('Meta API') ||
      errorMessage.includes('Nenhuma instância') ||
      errorMessage.includes('obrigatório');
    return jsonResponse(
      { success: false, error: errorMessage },
      isClientError ? 400 : 500,
    );
  }
});
