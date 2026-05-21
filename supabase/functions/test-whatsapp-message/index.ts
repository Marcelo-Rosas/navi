import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const META_GRAPH = 'https://graph.facebook.com/v21.0';

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** E.164 sem + (ex: 55479933851351) */
function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('55')) {
    digits = digits.slice(2);
  }

  // BR móvel: DDD(2) + 8 dígitos → inserir 9 após DDD
  if (digits.length === 10) {
    const ddd = digits.slice(0, 2);
    const rest = digits.slice(2);
    if (parseInt(rest[0], 10) >= 6) {
      digits = `${ddd}9${rest}`;
    }
  }

  return `55${digits}`;
}

function formatMetaError(data: Record<string, unknown>): string {
  const err = data?.error as Record<string, unknown> | undefined;
  if (!err) return JSON.stringify(data);

  const parts: string[] = [];
  if (err.message) parts.push(String(err.message));
  if (err.error_user_msg) parts.push(String(err.error_user_msg));
  if (err.error_subcode) parts.push(`subcode ${err.error_subcode}`);

  const code = err.code;
  if (code === 131030 || String(err.message || '').includes('allowed list')) {
    parts.push('Adicione o número em Meta for Developers → WhatsApp → API Setup → To.');
  }
  if (code === 131047 || String(err.message || '').toLowerCase().includes('template')) {
    parts.push('Fora da janela de 24h: use template aprovado ou peça para o contato enviar uma mensagem primeiro.');
  }
  if (code === 100) {
    parts.push('Verifique se Phone Number ID está correto (não use WABA ID nem App ID).');
  }

  return parts.join(' — ') || 'Erro desconhecido da Meta';
}

async function metaPost(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown>; status: number }> {
  const response = await fetch(`${META_GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let data: Record<string, unknown> = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return { ok: response.ok, data, status: response.status };
}

async function sendViaMetaText(
  phoneNumberId: string,
  accessToken: string,
  phone: string,
  message: string,
): Promise<{ messageId: string }> {
  const { ok, data } = await metaPost(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: message },
  });

  if (!ok) {
    throw new Error(`Meta API: ${formatMetaError(data)}`);
  }

  const messages = data.messages as { id?: string }[] | undefined;
  const messageId = messages?.[0]?.id;
  if (!messageId) throw new Error('Meta API não retornou ID da mensagem');
  return { messageId };
}

async function verifyMetaPhoneNumberId(
  phoneNumberId: string,
  accessToken: string,
): Promise<string | null> {
  const res = await fetch(
    `${META_GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  if (!res.ok) {
    return `Phone Number ID inválido ou token sem permissão: ${formatMetaError(data)}`;
  }
  const row = data as { display_phone_number?: string; verified_name?: string };
  console.log(
    '[test-whatsapp-message] Número Meta:',
    row.verified_name,
    row.display_phone_number,
  );
  return null;
}

async function listApprovedTemplates(
  wabaId: string,
  accessToken: string,
): Promise<string[]> {
  try {
    const res = await fetch(
      `${META_GRAPH}/${wabaId}/message_templates?fields=name,status,language&limit=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = await res.json();
    if (!res.ok) return [];
    const list = data.data as { name?: string; status?: string }[] | undefined;
    return (list || [])
      .filter((t) => t.status === 'APPROVED' && t.name)
      .map((t) => t.name as string);
  } catch {
    return [];
  }
}

async function sendViaMetaHelloWorld(
  phoneNumberId: string,
  accessToken: string,
  phone: string,
  wabaId?: string | null,
): Promise<{ messageId: string; language: string; template: string }> {
  const attemptErrors: string[] = [];
  const languages = ['pt_BR', 'en_US', 'en'];
  const templateCandidates = ['hello_world'];

  if (wabaId) {
    const approved = await listApprovedTemplates(wabaId, accessToken);
    for (const name of approved) {
      if (!templateCandidates.includes(name)) templateCandidates.push(name);
    }
  }

  for (const templateName of templateCandidates) {
    for (const language of languages) {
      const { ok, data } = await metaPost(phoneNumberId, accessToken, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
        },
      });

      if (ok) {
        const messages = data.messages as { id?: string }[] | undefined;
        const messageId = messages?.[0]?.id;
        if (messageId) return { messageId, language, template: templateName };
      }
      const err = `${templateName}/${language}: ${formatMetaError(data)}`;
      attemptErrors.push(err);
      console.warn(`[test-whatsapp-message] template failed:`, err);
    }
  }

  const templatesHint = wabaId
    ? ` Templates aprovados na conta: ${templateCandidates.slice(0, 8).join(', ') || 'nenhum listado'}.`
    : '';

  throw new Error(
    `Meta API: falha no envio (texto e templates). Detalhes: ${attemptErrors.slice(0, 3).join(' | ')}.${templatesHint} ` +
      'Adicione o número em Meta for Developers → WhatsApp → API Setup → To (modo dev) ou peça o contato enviar uma mensagem primeiro (janela 24h).',
  );
}

async function sendViaMeta(
  phoneNumberId: string,
  accessToken: string,
  phone: string,
  message: string,
  wabaId?: string | null,
): Promise<{ messageId: string; mode: 'text' | 'template' }> {
  if (!/^\d{10,20}$/.test(phoneNumberId)) {
    throw new Error(
      'Phone Number ID inválido (use o ID do número em Meta → WhatsApp → API Setup, só dígitos).',
    );
  }

  const phoneIdError = await verifyMetaPhoneNumberId(phoneNumberId, accessToken);
  if (phoneIdError) throw new Error(`Meta API: ${phoneIdError}`);

  try {
    const { messageId } = await sendViaMetaText(phoneNumberId, accessToken, phone, message);
    return { messageId, mode: 'text' };
  } catch (textErr) {
    const textMsg = textErr instanceof Error ? textErr.message : '';
    console.warn('[test-whatsapp-message] Texto livre falhou, tentando hello_world:', textMsg);

    const shouldTryTemplate =
      textMsg.includes('(#100)') ||
      textMsg.includes('131047') ||
      textMsg.includes('131026') ||
      textMsg.includes('template') ||
      textMsg.includes('24') ||
      textMsg.includes('session') ||
      textMsg.includes('re-engagement');

    if (!shouldTryTemplate) throw textErr;

    const { messageId, language, template } = await sendViaMetaHelloWorld(
      phoneNumberId,
      accessToken,
      phone,
      wabaId,
    );
    console.log(`[test-whatsapp-message] template ${template} enviado (${language})`);
    return { messageId, mode: 'template' };
  }
}

async function sendViaEvolution(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  supabaseServiceKey: string,
  cleanPhone: string,
  message: string,
  userId: string | null,
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
          error: `Número inválido (${cleanPhone}). Use DDD + celular com 9 dígitos (ex: 55479933851351).`,
        },
        400,
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('authorization');
    const bearer = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? '';

    let userId: string | null = null;

    if (bearer && bearer === supabaseServiceKey) {
      // Scripts / Node com service_role (sem sessão de usuário)
      console.log('[test-whatsapp-message] Auth: service_role');
      userId = null;
    } else if (bearer) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(bearer);
      if (authError || !user) {
        return jsonResponse({
          success: false,
          error:
            'Token inválido ou expirado. Na UI use sessão logada; em scripts use Authorization: Bearer <SERVICE_ROLE_KEY>.',
        }, 401);
      }
      userId = user.id;
      console.log('[test-whatsapp-message] Auth: user', userId);
    } else {
      return jsonResponse({
        success: false,
        error: 'Header Authorization obrigatório (JWT do usuário ou service_role)',
      }, 401);
    }

    const { data: ninaSettings } = await supabase
      .from('nina_settings')
      .select('whatsapp_access_token, whatsapp_phone_number_id, whatsapp_business_account_id')
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

    const wabaId = (body.whatsapp_business_account_id || ninaSettings?.whatsapp_business_account_id || '')
      .trim() || null;

    if (accessToken && phoneNumberId) {
      console.log('[test-whatsapp-message] Meta →', cleanPhone);
      const { messageId, mode } = await sendViaMeta(
        phoneNumberId,
        accessToken,
        cleanPhone,
        text,
        wabaId,
      );
      return jsonResponse({
        success: true,
        message_id: messageId,
        provider: 'meta',
        mode,
        hint: mode === 'template'
          ? 'Enviado via template hello_world (texto livre só funciona se o contato falou com você nas últimas 24h).'
          : undefined,
      }, 200);
    }

    return jsonResponse({
      success: false,
      error:
        'WhatsApp Meta não configurado. Preencha Access Token e Phone Number ID em Configurações. Evolution API está deprecada (ver REQUIREMENTS.md).',
    }, 400);
  } catch (error) {
    console.error('[test-whatsapp-message] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Erro inesperado';
    const isClientError =
      errorMessage.includes('Meta API') ||
      errorMessage.includes('Nenhuma instância') ||
      errorMessage.includes('Phone Number ID') ||
      errorMessage.includes('obrigatório') ||
      errorMessage.includes('inválido');
    return jsonResponse(
      { success: false, error: errorMessage },
      isClientError ? 400 : 500,
    );
  }
});
