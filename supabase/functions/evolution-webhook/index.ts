import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: any;
  date_time?: string;
  sender?: string;
  server_url?: string;
  apikey?: string;
}

interface MessageData {
  key: {
    remoteJid: string;
    remoteJidAlt?: string; // Número real quando remoteJid é @lid
    fromMe: boolean;
    id: string;
    addressingMode?: string;
  };
  pushName?: string;
  senderPn?: string; // Fallback alternativo para número real
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
    imageMessage?: { caption?: string; mimetype?: string; url?: string };
    audioMessage?: { mimetype?: string; url?: string; seconds?: number };
    documentMessage?: { caption?: string; mimetype?: string; fileName?: string; url?: string };
    videoMessage?: { caption?: string; mimetype?: string; url?: string };
  };
  messageType?: string;
  messageTimestamp?: number;
  status?: string;
}

serve(async (req) => {
  console.log(`[evolution-webhook] Received ${req.method} request`);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const payload: EvolutionWebhookPayload = await req.json();
    console.log(`[evolution-webhook] Event: ${payload.event}, Instance: ${payload.instance}`);

    // Buscar instância por instance_name ou instance_id_external
    let { data: instanceData } = await supabase
      .from('whatsapp_instances')
      .select('id, instance_name, instance_id_external, provider_type, status, user_id')
      .eq('instance_name', payload.instance)
      .maybeSingle();

    if (!instanceData) {
      // Fallback para instance_id_external (Evolution Cloud envia UUID)
      const { data: cloudInstance } = await supabase
        .from('whatsapp_instances')
        .select('id, instance_name, instance_id_external, provider_type, status, user_id')
        .eq('instance_id_external', payload.instance)
        .maybeSingle();
      instanceData = cloudInstance;
    }

    if (!instanceData) {
      console.log(`[evolution-webhook] Instance not found: ${payload.instance}`);
      return new Response(JSON.stringify({ error: 'Instance not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[evolution-webhook] Found instance: ${instanceData.id}, provider: ${instanceData.provider_type}`);

    // Processar baseado no tipo de evento
    switch (payload.event) {
      case 'messages.upsert':
        await processMessageUpsert(payload, instanceData, supabase, supabaseUrl, supabaseServiceKey);
        break;
      case 'messages.update':
        await processMessageUpdate(payload, instanceData, supabase);
        break;
      case 'connection.update':
        await processConnectionUpdate(payload, instanceData, supabase);
        break;
      case 'qrcode.updated':
        await processQRCodeUpdate(payload, instanceData, supabase);
        break;
      default:
        console.log(`[evolution-webhook] Unhandled event: ${payload.event}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[evolution-webhook] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function processMessageUpsert(
  payload: EvolutionWebhookPayload,
  instance: any,
  supabase: any,
  supabaseUrl: string,
  supabaseServiceKey: string
) {
  const messageData = payload.data as MessageData;
  
  if (!messageData?.key) {
    console.log('[evolution-webhook] No message key found');
    return;
  }

  const remoteJid = messageData.key.remoteJid;
  const fromMe = messageData.key.fromMe;
  const messageId = messageData.key.id;
  
  // Mensagens enviadas por nós (fromMe=true): salvar no chat mas NÃO processar pela Nina
  if (fromMe) {
    console.log('[evolution-webhook] Outgoing message (fromMe=true) - saving to chat without Nina processing');
    await saveOutgoingMessage(messageData, instance, supabase);
    return;
  }

  // Ignorar mensagens de grupos e status
  if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
    console.log('[evolution-webhook] Ignoring group/status message');
    return;
  }

  // Fix 2: Ignorar vCards / contactMessage para evitar contatos corrompidos
  const firstMessageKey = Object.keys(messageData.message || {})[0];
  if (firstMessageKey === 'contactMessage' || firstMessageKey === 'contactsArrayMessage') {
    console.log('[evolution-webhook] Ignoring contact card message (vCard) - skipping to prevent corrupt contact data');
    return;
  }

  // Detectar formato @lid vs @s.whatsapp.net
  const isLid = remoteJid.includes('@lid');
  
  // Prioridade para resolver número real quando @lid:
  // 1. remoteJidAlt (presente no payload da Evolution API v2+)
  // 2. senderPn (campo legado de versões anteriores)
  // 3. remoteJid como fallback (vai salvar o @lid, mas é melhor que nada)
  let whatsappId: string;
  if (isLid && messageData.key.remoteJidAlt) {
    whatsappId = messageData.key.remoteJidAlt;
    console.log(`[evolution-webhook] @lid detected - using remoteJidAlt as real number: ${whatsappId}`);
  } else if (isLid && messageData.senderPn) {
    whatsappId = messageData.senderPn;
    console.log(`[evolution-webhook] @lid detected - using senderPn as real number: ${whatsappId}`);
  } else {
    whatsappId = remoteJid;
  }
  
  // Extrair número de telefone limpo (sem sufixo @s.whatsapp.net ou @lid)
  const phoneNumber = whatsappId.replace('@s.whatsapp.net', '').replace('@lid', '');
  const contactName = messageData.pushName || phoneNumber;

  console.log(`[evolution-webhook] Processing message - phoneNumber: ${phoneNumber}, whatsappId: ${whatsappId}, isLid: ${isLid}, remoteJid: ${remoteJid}, remoteJidAlt: ${messageData.key.remoteJidAlt || 'N/A'}, senderPn: ${messageData.senderPn || 'N/A'}`);

  // Verificar se contato já existe
  let { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (!contact) {
    // Se não existe, criar novo contato usando whatsappId (que vem do senderPn se @lid)
    const { data: newContact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        phone_number: phoneNumber,
        whatsapp_id: whatsappId, // Usar whatsappId (senderPn se disponível, senão remoteJid)
        name: contactName,
        call_name: contactName,
        instance_id: instance.id,
        user_id: instance.user_id,
        last_activity: new Date().toISOString(),
      })
      .select()
      .single();

    if (contactError) {
      console.error('[evolution-webhook] Error creating contact:', contactError);
      return;
    }
    contact = newContact;
    console.log('[evolution-webhook] Created NEW contact:', contact.id);
  } else {
    // Se já existe, apenas atualizar campos não-críticos (NÃO sobrescrever whatsapp_id)
    const updates: Record<string, any> = {
      last_activity: new Date().toISOString(),
      instance_id: instance.id,
    };
    
    // Só atualiza nome se não existir
    if (contactName && !contact.name) {
      updates.name = contactName;
      updates.call_name = contactName;
    }
    
    await supabase
      .from('contacts')
      .update(updates)
      .eq('id', contact.id);
      
    console.log('[evolution-webhook] Updated existing contact (preserved whatsapp_id):', contact.id);
  }

  // Fix 1: Buscar conversa ativa sem filtro de instance_id para evitar duplicatas
  let { data: conversation } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contact.id)
    .eq('is_active', true)
    .maybeSingle();

  if (!conversation) {
    const { data: newConversation, error: convError } = await supabase
      .from('conversations')
      .insert({
        contact_id: contact.id,
        instance_id: instance.id,
        user_id: instance.user_id,
        status: 'nina',
        is_active: true,
        last_message_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (convError) {
      console.error('[evolution-webhook] Error creating conversation:', convError);
      return;
    }
    conversation = newConversation;
  } else if (conversation.instance_id !== instance.id) {
    // Atualizar instance_id se a conversa veio por outra instância
    await supabase
      .from('conversations')
      .update({ instance_id: instance.id })
      .eq('id', conversation.id);
    conversation.instance_id = instance.id;
    console.log(`[evolution-webhook] Updated conversation instance from ${conversation.instance_id} to ${instance.id}`);
  }

  // Extrair conteúdo da mensagem
  const { content, messageType, mediaUrl } = extractMessageContent(messageData);

  // Criar mensagem no banco
  const { data: message, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      whatsapp_message_id: messageId,
      content: content,
      type: messageType,
      from_type: 'user',
      status: 'delivered',
      media_url: mediaUrl,
      sent_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (msgError) {
    console.error('[evolution-webhook] Error creating message:', msgError);
    return;
  }

  // Atualizar last_message_at da conversa
  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversation.id);

  // Calcular o novo process_after para agrupamento
  const GROUPING_DELAY_MS = 20000; // 20 segundos
  const processAfter = new Date(Date.now() + GROUPING_DELAY_MS).toISOString();

  // CORREÇÃO: Atualizar process_after de mensagens pendentes do mesmo telefone
  // Isso garante que todas as mensagens da mesma "rajada" sejam processadas juntas
  const { data: updatedPending, error: updateError } = await supabase
    .from('message_grouping_queue')
    .update({ process_after: processAfter })
    .eq('phone_number_id', instance.instance_name)
    .eq('processed', false)
    .select('id');

  if (updateError) {
    console.error('[evolution-webhook] Error updating pending messages:', updateError);
  } else {
    const pendingCount = updatedPending?.length || 0;
    if (pendingCount > 0) {
      console.log(`[evolution-webhook] Reset process_after for ${pendingCount} pending message(s) from ${phoneNumber}`);
    }
  }

  // Agora inserir a nova mensagem com o mesmo process_after
  await supabase
    .from('message_grouping_queue')
    .insert({
      phone_number_id: instance.instance_name,
      whatsapp_message_id: messageId,
      message_id: message.id,
      instance_id: instance.id,
      message_data: {
        content,
        type: messageType,
        messageType,
        mediaUrl,
        from: phoneNumber,
        contactName,
        // Pass original key and media info for download in message-grouper
        key: messageData.key,
        audio: messageType === 'audio' ? { id: messageId } : undefined,
        image: messageType === 'image' ? { id: messageId, caption: messageData.message?.imageMessage?.caption || '' } : undefined,
      },
      process_after: processAfter,
    });

  console.log(`[evolution-webhook] Message queued for processing: ${message.id}`);

  // Trigger message-grouper em background
  try {
    fetch(`${supabaseUrl}/functions/v1/message-grouper`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ trigger: 'evolution-webhook' }),
    }).catch(err => console.log('[evolution-webhook] message-grouper trigger error:', err));
  } catch (e) {
    console.log('[evolution-webhook] Could not trigger message-grouper:', e);
  }
}

async function saveOutgoingMessage(
  messageData: MessageData,
  instance: any,
  supabase: any
) {
  const remoteJid = messageData.key.remoteJid;
  const messageId = messageData.key.id;

  // Ignorar grupos e status
  if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
    console.log('[evolution-webhook] Ignoring outgoing group/status message');
    return;
  }

  // Ignorar vCards
  const firstMessageKey = Object.keys(messageData.message || {})[0];
  if (firstMessageKey === 'contactMessage' || firstMessageKey === 'contactsArrayMessage') {
    return;
  }

  // Resolver número do destinatário
  const isLid = remoteJid.includes('@lid');
  let whatsappId = remoteJid;
  if (isLid && messageData.key.remoteJidAlt) {
    whatsappId = messageData.key.remoteJidAlt;
  } else if (isLid && messageData.senderPn) {
    whatsappId = messageData.senderPn;
  }
  const phoneNumber = whatsappId.replace('@s.whatsapp.net', '').replace('@lid', '');

  // Buscar contato existente
  const { data: contact } = await supabase
    .from('contacts')
    .select('id')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (!contact) {
    console.log(`[evolution-webhook] No contact found for outgoing message to ${phoneNumber} - skipping`);
    return;
  }

  // Buscar conversa ativa
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('is_active', true)
    .maybeSingle();

  if (!conversation) {
    console.log(`[evolution-webhook] No active conversation for contact ${contact.id} - skipping outgoing message`);
    return;
  }

  // Verificar se a mensagem já existe (evitar duplicatas com mensagens enviadas pelo sistema)
  const { data: existingMsg } = await supabase
    .from('messages')
    .select('id')
    .eq('whatsapp_message_id', messageId)
    .maybeSingle();

  if (existingMsg) {
    console.log(`[evolution-webhook] Outgoing message ${messageId} already exists - skipping`);
    return;
  }

  // Extrair conteúdo
  const { content, messageType, mediaUrl } = extractMessageContent(messageData);

  // Salvar como mensagem do tipo 'human' (atendente via WhatsApp direto)
  const { error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      whatsapp_message_id: messageId,
      content,
      type: messageType,
      from_type: 'human',
      status: 'sent',
      media_url: mediaUrl,
      sent_at: new Date().toISOString(),
    });

  if (msgError) {
    console.error('[evolution-webhook] Error saving outgoing message:', msgError);
    return;
  }

  // Atualizar last_message_at
  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversation.id);

  console.log(`[evolution-webhook] Saved outgoing message to conversation ${conversation.id}`);
}

function extractMessageContent(messageData: MessageData): { content: string; messageType: string; mediaUrl: string | null } {
  const msg = messageData.message;
  
  if (!msg) {
    return { content: '', messageType: 'text', mediaUrl: null };
  }

  if (msg.conversation) {
    return { content: msg.conversation, messageType: 'text', mediaUrl: null };
  }

  if (msg.extendedTextMessage?.text) {
    return { content: msg.extendedTextMessage.text, messageType: 'text', mediaUrl: null };
  }

  if (msg.imageMessage) {
    return {
      content: msg.imageMessage.caption || '[Imagem]',
      messageType: 'image',
      mediaUrl: msg.imageMessage.url || null
    };
  }

  if (msg.audioMessage) {
    return {
      content: '[Áudio]',
      messageType: 'audio',
      mediaUrl: msg.audioMessage.url || null
    };
  }

  if (msg.documentMessage) {
    return {
      content: msg.documentMessage.caption || msg.documentMessage.fileName || '[Documento]',
      messageType: 'document',
      mediaUrl: msg.documentMessage.url || null
    };
  }

  if (msg.videoMessage) {
    return {
      content: msg.videoMessage.caption || '[Vídeo]',
      messageType: 'video',
      mediaUrl: msg.videoMessage.url || null
    };
  }

  return { content: messageData.messageType || '', messageType: 'text', mediaUrl: null };
}

async function processMessageUpdate(
  payload: EvolutionWebhookPayload,
  instance: any,
  supabase: any
) {
  const data = payload.data;
  
  if (!data?.key?.id) {
    console.log('[evolution-webhook] No message id in update');
    return;
  }

  const messageId = data.key.id;
  const status = data.status;

  // Mapear status do Evolution para nosso enum
  let dbStatus: string;
  switch (status) {
    case 'DELIVERY_ACK':
    case 'delivered':
      dbStatus = 'delivered';
      break;
    case 'READ':
    case 'read':
      dbStatus = 'read';
      break;
    case 'PLAYED':
      dbStatus = 'read';
      break;
    case 'ERROR':
    case 'FAILED':
      dbStatus = 'failed';
      break;
    default:
      dbStatus = 'sent';
  }

  const updateData: any = { status: dbStatus };
  if (dbStatus === 'delivered') {
    updateData.delivered_at = new Date().toISOString();
  }
  if (dbStatus === 'read') {
    updateData.read_at = new Date().toISOString();
  }

  await supabase
    .from('messages')
    .update(updateData)
    .eq('whatsapp_message_id', messageId);

  console.log(`[evolution-webhook] Updated message status: ${messageId} -> ${dbStatus}`);
}

async function processConnectionUpdate(
  payload: EvolutionWebhookPayload,
  instance: any,
  supabase: any
) {
  const data = payload.data;
  const state = data?.state || data?.connection;

  let status: string;
  switch (state) {
    case 'open':
    case 'connected':
      status = 'connected';
      break;
    case 'connecting':
      status = 'connecting';
      break;
    case 'close':
    case 'disconnected':
      status = 'disconnected';
      break;
    default:
      status = 'disconnected';
  }

  await supabase
    .from('whatsapp_instances')
    .update({ 
      status,
      qr_code: status === 'connected' ? null : instance.qr_code,
      updated_at: new Date().toISOString()
    })
    .eq('id', instance.id);

  console.log(`[evolution-webhook] Updated instance status: ${instance.id} -> ${status}`);
}

async function processQRCodeUpdate(
  payload: EvolutionWebhookPayload,
  instance: any,
  supabase: any
) {
  const qrCode = payload.data?.qrcode?.base64 || payload.data?.base64;

  if (qrCode) {
    await supabase
      .from('whatsapp_instances')
      .update({ 
        qr_code: qrCode,
        status: 'qr_required',
        updated_at: new Date().toISOString()
      })
      .eq('id', instance.id);

    console.log(`[evolution-webhook] Updated QR code for instance: ${instance.id}`);
  }
}
