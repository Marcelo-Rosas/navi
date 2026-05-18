import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date().toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Processing há >1h: abandonar (zumbis bloqueavam a fila ao voltarem pending com scheduled_at antigo).
    const { data: abandoned } = await supabase
      .from('send_queue')
      .update({
        status: 'failed',
        error_message: 'processing_timeout_abandoned',
      })
      .eq('status', 'processing')
      .lt('updated_at', oneHourAgo)
      .select('id');
    if (abandoned && abandoned.length > 0) {
      console.log(`[Sender] Abandoned ${abandoned.length} stale processing row(s)`);
    }

    // Processing entre 5min e 1h: re-tentar como pending
    const { data: stuck } = await supabase
      .from('send_queue')
      .update({ status: 'pending' })
      .eq('status', 'processing')
      .lt('updated_at', fiveMinAgo)
      .gte('updated_at', oneHourAgo)
      .select('id');
    if (stuck && stuck.length > 0) {
      console.log(`[Sender] Recovered ${stuck.length} stuck message(s) to pending`);
    }

    // Não filtrar por created_at recente: pendentes antigas também precisam ser enviadas
    // (filtro de 30min deixava milhares de rows em pending para sempre).
    const { data: queueItems, error } = await supabase
      .from('send_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(5);

    if (error) {
      console.error('[Sender] Error:', error);
      return new Response(JSON.stringify({ error }), { status: 500 });
    }

    if (!queueItems || queueItems.length === 0) {
      console.log('[Sender] No messages to send');
      return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
    }

    console.log(`[Sender] Processing ${queueItems.length} message(s)`);

    const { data: settings } = await supabase
      .from('nina_settings')
      .select('whatsapp_phone_number_id, whatsapp_access_token')
      .single();

    const phoneNumberId = settings?.whatsapp_phone_number_id;
    const accessToken = settings?.whatsapp_access_token;

    if (!phoneNumberId || !accessToken) {
      console.error('[Sender] Missing Meta API credentials');
      return new Response(JSON.stringify({ error: 'Missing Meta credentials' }), { status: 500 });
    }

    let sent = 0;

    for (const item of queueItems) {
      try {
        // Só processa se ainda estiver pending (evita corrida entre várias invocações do sender).
        const { data: claimed } = await supabase
          .from('send_queue')
          .update({ status: 'processing' })
          .eq('id', item.id)
          .eq('status', 'pending')
          .select('id, sent_at')
          .maybeSingle();

        if (!claimed) {
          console.log(`[Sender] Skip ${item.id} — já enviado ou outro worker processando`);
          continue;
        }

        if (claimed.sent_at) {
          await supabase
            .from('send_queue')
            .update({ status: 'completed', error_message: null, updated_at: new Date().toISOString() })
            .eq('id', item.id)
            .eq('status', 'processing');
          console.log(`[Sender] Skip ${item.id} — item já possuía sent_at`);
          continue;
        }

        let phone: string;
        if (item.override_phone) {
          // Internal notification — route to explicit phone, not conversation contact
          phone = item.override_phone.replace(/\D/g, '');
          if (!phone.startsWith('55')) phone = `55${phone}`;
        } else {
          const { data: contact } = await supabase
            .from('contacts')
            .select('phone_number')
            .eq('id', item.contact_id)
            .single();

          if (!contact?.phone_number) {
            await supabase.from('send_queue').update({ status: 'failed', error_message: 'No phone number found' }).eq('id', item.id).eq('status', 'processing');
            continue;
          }

          phone = contact.phone_number.replace(/\D/g, '');
          if (!phone.startsWith('55')) phone = `55${phone}`;
        }

        // Build request body based on message_type
        let td = item.template_data;
        if (typeof td === 'string') {
          try { td = JSON.parse(td); } catch { td = null; }
        }
        const isTemplate = item.message_type === 'template' && td != null;
        let metaBody: Record<string, unknown>;

        if (isTemplate) {
          metaBody = {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: td.name,
              language: { code: td.language || 'pt_BR' },
              components: td.components || [],
            },
          };
          console.log(`[Sender] Sending template "${td.name}" to ${phone}`);
        } else {
          metaBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { body: item.content },
          };
          console.log(`[Sender] Sending text to ${phone}`);
        }

        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 45_000);
        let response: Response;
        try {
          response = await fetch(
            `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
              },
              body: JSON.stringify(metaBody),
              signal: controller.signal,
            }
          );
        } finally {
          clearTimeout(fetchTimeout);
        }

        let data: any;
        try {
          data = await response.json();
        } catch {
          data = null;
        }

        if (!response.ok) {
          throw new Error(`Meta API error ${response.status}: ${data ? JSON.stringify(data) : '(non-JSON response)'}`);
        }

        const wamid = data?.messages?.[0]?.id || null;
        console.log(`[Sender] Sent to ${phone}`, wamid);

        // P1: insert no histórico ANTES de marcar sent — se o update falhar,
        // o row fica em processing (recuperável), não sent sem histórico (irrecuperável).
        // Notificações internas (override_phone) não entram no histórico de conversa do cliente.
        if (!item.override_phone) {
          const historyContent =
            isTemplate && typeof item.content === 'string' && item.content.trim()
              ? item.content.trim()
              : isTemplate
                ? `[Template: ${td.name}]`
                : item.content;
          const { error: insertErr } = await supabase.from('messages').insert({
            conversation_id: item.conversation_id,
            content: historyContent,
            type: 'text',
            from_type: 'nina',
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: wamid,
          });
          if (insertErr) {
            console.error(`[Sender] Failed to insert message history id=${item.id}:`, insertErr.message);
          }
        }

        // P0: capturar erro do update — NÃO fazer throw para evitar que o catch
        // marque como 'failed' e acione reenvio de mensagem já entregue.
        const { error: sentErr } = await supabase
          .from('send_queue')
          .update({ status: 'completed', sent_at: new Date().toISOString(), error_message: null })
          .eq('id', item.id)
          .eq('status', 'processing');
        if (sentErr) {
          console.error(`[Sender] CRITICAL: message sent but queue not updated id=${item.id}:`, sentErr.message);
        }

        sent++;
      } catch (err: any) {
        console.error('[Sender] Error:', item.id, err.message);
        const { error: failErr } = await supabase
          .from('send_queue')
          .update({ status: 'failed', error_message: err.message })
          .eq('id', item.id)
          .eq('status', 'processing');
        if (failErr) {
          console.error(`[Sender] Failed to mark as failed id=${item.id}:`, failErr.message);
        }
      }
    }

    console.log(`[Sender] Done: ${sent}/${queueItems.length} sent`);
    return new Response(JSON.stringify({ sent, total: queueItems.length }), { status: 200 });

  } catch (err: any) {
    console.error('[Sender] Fatal error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});