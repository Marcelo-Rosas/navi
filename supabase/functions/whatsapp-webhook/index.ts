/**
 * whatsapp-webhook
 *
 * 1) Meta Cloud API (URL configurada no Developer Console): GET verify + POST com
 *    `object: whatsapp_business_account` → cria/atualiza contact/conversation/message,
 *    enfileira `message_grouping_queue` (phone_number_id = ID do número na Meta, alinhado a
 *    `nina_settings.whatsapp_phone_number_id`) e dispara `message-grouper`.
 *
 * 2) Outros POSTs (ex.: cron interno): mantém o worker “slim grouper” que só drena
 *    `message_grouping_queue` e chama `nina-orchestrator` (comportamento legado do repo).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const GROUPING_DELAY_MS = 20_000;

interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  messages?: Array<Record<string, unknown>>;
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
}

function extractInboundText(message: Record<string, unknown>): string | null {
  const type = message.type as string | undefined;
  if (type === "text") {
    const body = (message.text as { body?: string } | undefined)?.body;
    return body?.trim() ? body : null;
  }
  if (type === "interactive") {
    const ir = message.interactive as {
      type?: string;
      button_reply?: { title?: string };
      list_reply?: { title?: string };
      nfm_reply?: { name?: string; body?: string; response_json?: string };
    } | undefined;
    if (ir?.type === "button_reply") return ir.button_reply?.title?.trim() || null;
    if (ir?.type === "list_reply") return ir.list_reply?.title?.trim() || null;
    if (ir?.type === "nfm_reply") return formatNfmReply(ir.nfm_reply);
  }
  if (type === "button") {
    const t = (message.button as { text?: string } | undefined)?.text;
    return t?.trim() ? t : null;
  }
  return null;
}

/**
 * Meta Flow submission — converte response_json em texto estruturado que o
 * nina-orchestrator (LLM via Groq) reconhece e dispara buscar_cotacao
 * imediatamente sem precisar perguntar nada ao cliente.
 *
 * Schema do Flow QUOTATION_FORM (4 campos): origem, destino, peso_kg, cargo_value.
 */
function formatNfmReply(
  nfm?: { name?: string; body?: string; response_json?: string },
): string | null {
  if (!nfm?.response_json) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(nfm.response_json) as Record<string, unknown>;
  } catch {
    console.warn("[whatsapp-webhook] nfm_reply: response_json inválido");
    return null;
  }

  // Cotação flow — campos esperados
  const origem = String(data.origem ?? "").trim();
  const destino = String(data.destino ?? "").trim();
  const peso = String(data.peso_kg ?? "").trim();
  const valor = String(data.cargo_value ?? "").trim();

  if (origem && destino && peso && valor) {
    return [
      "[FORM_COTACAO]",
      `Origem: ${origem}`,
      `Destino: ${destino}`,
      `Peso: ${peso} kg`,
      `Valor da mercadoria: R$ ${valor}`,
    ].join("\n");
  }

  // Form desconhecido — devolve raw pra LLM tentar interpretar
  const pairs = Object.entries(data).map(([k, v]) => `${k}: ${String(v)}`);
  return `[FORM_RECEBIDO]\n${pairs.join("\n")}`;
}

function contactNameForWa(
  value: MetaChangeValue,
  waFrom: string,
): string {
  const list = value.contacts ?? [];
  for (const c of list) {
    if (c.wa_id && String(c.wa_id).replace(/\D/g, "") === waFrom) {
      return c.profile?.name?.trim() || waFrom;
    }
  }
  return waFrom;
}

async function handleMetaWebhook(
  payload: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  supabaseServiceKey: string,
): Promise<Response> {
  const entries = (payload.entry as Array<{ changes?: unknown[] }> | undefined) ?? [];
  let processed = 0;
  let triggeredGrouper = false;

  for (const ent of entries) {
    const changes = (ent.changes as Array<{ value?: MetaChangeValue; field?: string }> | undefined) ??
      [];
    for (const ch of changes) {
      const value = ch.value;
      if (!value?.messages?.length) continue;

      let phoneNumberId = value.metadata?.phone_number_id?.trim() || "";
      if (!phoneNumberId) {
        const { data: settings } = await supabase
          .from("nina_settings")
          .select("whatsapp_phone_number_id")
          .limit(1)
          .maybeSingle();
        phoneNumberId = settings?.whatsapp_phone_number_id?.trim() || "";
      }
      if (!phoneNumberId) {
        console.error("[whatsapp-webhook] Meta: sem phone_number_id no payload nem em nina_settings");
        continue;
      }

      const processAfter = new Date(Date.now() + GROUPING_DELAY_MS).toISOString();

      for (const raw of value.messages) {
        const msg = raw as Record<string, unknown>;
        const wamid = (msg.id as string) || "";
        const fromRaw = (msg.from as string) || "";
        const fromDigits = fromRaw.replace(/\D/g, "");
        if (!wamid || !fromDigits) continue;

        const text = extractInboundText(msg);
        if (!text) {
          console.log(`[whatsapp-webhook] Meta: tipo ignorado (sem texto) wamid=${wamid}`);
          continue;
        }

        const { data: existingMsg } = await supabase
          .from("messages")
          .select("id")
          .eq("whatsapp_message_id", wamid)
          .maybeSingle();
        if (existingMsg) {
          console.log(`[whatsapp-webhook] Meta: duplicata wamid=${wamid}, skip`);
          continue;
        }

        const contactName = contactNameForWa(value, fromDigits);

        let { data: contact } = await supabase
          .from("contacts")
          .select("*")
          .eq("phone_number", fromDigits)
          .maybeSingle();

        if (!contact) {
          const { data: newContact, error: contactError } = await supabase
            .from("contacts")
            .insert({
              phone_number: fromDigits,
              whatsapp_id: fromDigits,
              name: contactName,
              call_name: contactName,
              user_id: null,
              last_activity: new Date().toISOString(),
            })
            .select()
            .single();
          if (contactError) {
            console.error("[whatsapp-webhook] Meta: erro ao criar contact", contactError);
            continue;
          }
          contact = newContact;
        } else {
          const updates: Record<string, unknown> = {
            last_activity: new Date().toISOString(),
          };
          if (contactName && !contact.name) {
            updates.name = contactName;
            updates.call_name = contactName;
          }
          await supabase.from("contacts").update(updates).eq("id", contact.id);
        }

        let { data: conversation } = await supabase
          .from("conversations")
          .select("*")
          .eq("contact_id", contact.id)
          .eq("is_active", true)
          .maybeSingle();

        if (!conversation) {
          const { data: newConv, error: convError } = await supabase
            .from("conversations")
            .insert({
              contact_id: contact.id,
              status: "nina",
              is_active: true,
              user_id: null,
              last_message_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (convError) {
            console.error("[whatsapp-webhook] Meta: erro ao criar conversation", convError);
            continue;
          }
          conversation = newConv;
        }

        const { data: message, error: msgError } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversation.id,
            whatsapp_message_id: wamid,
            content: text,
            type: "text",
            from_type: "user",
            status: "delivered",
            sent_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (msgError) {
          console.error("[whatsapp-webhook] Meta: erro ao criar message", msgError);
          continue;
        }

        await supabase
          .from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", conversation.id);

        // Fix: filtrar por telefone do CLIENTE (fromDigits) além do phone_number_id do negócio
        // Sem esse filtro, mensagens de TODOS os clientes teriam o process_after atualizado juntos
        const { error: updatePendingErr } = await supabase
          .from("message_grouping_queue")
          .update({ process_after: processAfter })
          .eq("phone_number_id", phoneNumberId)
          .eq("processed", false)
          .filter("message_data->>from", "eq", fromDigits);
        if (updatePendingErr) {
          console.error("[whatsapp-webhook] Meta: update process_after", updatePendingErr);
        }

        const { error: queueErr } = await supabase.from("message_grouping_queue").insert({
          phone_number_id: phoneNumberId,
          whatsapp_message_id: wamid,
          message_id: message.id,
          instance_id: null,
          message_data: {
            content: text,
            type: "text",
            messageType: "text",
            mediaUrl: null,
            from: fromDigits,
            contactName,
            key: { id: wamid, remoteJid: `${fromDigits}@s.whatsapp.net` },
          },
          process_after: processAfter,
        });

        if (queueErr) {
          console.error("[whatsapp-webhook] Meta: erro na fila de agrupamento", queueErr);
          continue;
        }

        processed++;
      }
    }
  }

  if (processed > 0) {
    triggeredGrouper = true;
    try {
      (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
        .EdgeRuntime?.waitUntil?.(
          fetch(`${supabaseUrl}/functions/v1/message-grouper`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({ trigger: "whatsapp-webhook-meta" }),
          }).catch((err) => console.error("[whatsapp-webhook] message-grouper trigger:", err)),
        );
    } catch (e) {
      console.error("[whatsapp-webhook] waitUntil message-grouper:", e);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, meta_ingested: processed, message_grouper_triggered: triggeredGrouper }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function runSlimGrouper(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  supabaseServiceKey: string,
): Promise<Response> {
  try {
    console.log("[whatsapp-webhook] Slim grouper starting...");
    const now = new Date().toISOString();

    const { data: readyItems, error } = await supabase
      .from("message_grouping_queue")
      .select("*")
      .eq("processed", false)
      .lte("process_after", now)
      .order("process_after", { ascending: true })
      .limit(10);

    if (error) throw error;

    if (!readyItems || readyItems.length === 0) {
      console.log("[whatsapp-webhook] Slim grouper: nothing to process");
      return new Response(JSON.stringify({ status: "nothing_to_process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[whatsapp-webhook] Slim grouper: ${readyItems.length} item(s)`);

    const conversationMap = new Map<string, typeof readyItems>();

    for (const item of readyItems) {
      const { data: message } = await supabase
        .from("messages")
        .select("conversation_id")
        .eq("id", item.message_id)
        .maybeSingle();

      if (!message?.conversation_id) continue;

      const convId = message.conversation_id;
      if (!conversationMap.has(convId)) conversationMap.set(convId, []);
      conversationMap.get(convId)!.push(item);
    }

    for (const [conversationId, items] of conversationMap) {
      const lastItem = items[items.length - 1];

      const { data: convRow } = await supabase
        .from("conversations")
        .select("contact_id")
        .eq("id", conversationId)
        .maybeSingle();

      if (!convRow?.contact_id) {
        console.warn(`[whatsapp-webhook] Slim grouper: no contact_id for conversation ${conversationId}`);
        continue;
      }

      const { data: existing } = await supabase
        .from("nina_processing_queue")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("status", "pending")
        .maybeSingle();

      if (!existing) {
        await supabase.from("nina_processing_queue").insert({
          conversation_id: conversationId,
          message_id: lastItem.message_id,
          contact_id: convRow.contact_id,
          status: "pending",
          retry_count: 0,
          scheduled_for: new Date().toISOString(),
        });
        console.log(`[whatsapp-webhook] Slim grouper: queued conversation ${conversationId}`);
      }

      const ids = items.map((i) => i.id);
      await supabase
        .from("message_grouping_queue")
        .update({ processed: true, processed_at: now })
        .in("id", ids);
    }

    (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
      .EdgeRuntime?.waitUntil?.(
        fetch(`${supabaseUrl}/functions/v1/nina-orchestrator`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({ triggered_by: "message-grouper" }),
        }).catch((err) => console.error("[whatsapp-webhook] nina-orchestrator:", err)),
      );

    return new Response(
      JSON.stringify({ status: "ok", conversations: conversationMap.size, mode: "slim_grouper" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[whatsapp-webhook] Slim grouper error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && challenge) {
      if (!WHATSAPP_VERIFY_TOKEN) {
        console.error("[whatsapp-webhook] WHATSAPP_VERIFY_TOKEN não configurada");
        return new Response("Forbidden", { status: 403 });
      }
      if (token !== WHATSAPP_VERIFY_TOKEN) {
        console.warn("[whatsapp-webhook] verify_token mismatch");
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(challenge, { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  let payload: Record<string, unknown> | null = null;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      payload = await req.json() as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }

  if (payload?.object === "whatsapp_business_account") {
    return handleMetaWebhook(payload, supabase, supabaseUrl, supabaseServiceKey);
  }

  // Segurança/estabilidade: não execute o "slim grouper" em qualquer POST genérico.
  // Isso evita loops quando algum monitor/cron pinga a Function sem payload.
  const runSlim =
    payload?.run_slim_grouper === true ||
    url.searchParams.get("run_slim_grouper") === "1";

  if (runSlim) {
    return runSlimGrouper(supabase, supabaseUrl, supabaseServiceKey);
  }

  return new Response(JSON.stringify({ ok: true, ignored: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
