/**
 * send-quotation-flow
 *
 * Dispara o Meta WhatsApp Flow "QUOTATION_FORM" (4 campos: origem, destino,
 * peso_kg, cargo_value) pro cliente. Quando o cliente submete, a resposta
 * volta via webhook como interactive.nfm_reply contendo response_json com
 * os dados estruturados — tratado em whatsapp-webhook/index.ts.
 *
 * Pré-requisito: Marcelo publica o Flow JSON (./quotation-flow.json) no Meta
 * App Manager (Flow Builder UI) ou via Flow Management API. O flow_id
 * retornado vai pra `nina_settings.quotation_flow_id` (coluna a criar) ou
 * variável de env META_QUOTATION_FLOW_ID.
 *
 * POST body esperado:
 *   {
 *     "phone": "5521975602969",     // E.164 sem +, com DDI 55
 *     "contact_name"?: "Marcelo",   // opcional, vai no body do convite
 *     "flow_id"?: "1234567890"      // opcional override; default da env
 *   }
 *
 * Resposta:
 *   { ok: true, message_id: "wamid...", flow_token: "..." }
 *   { ok: false, error: "..." }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v21.0";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function newFlowToken(phone: string): string {
  // Token opaco devolvido pela Meta junto da nfm_reply — usamos pra correlacionar.
  // Formato: quote_<phone>_<unix_ms>_<random4> (≤256 chars per Meta spec).
  const ts = Date.now().toString();
  const rnd = Math.random().toString(36).slice(2, 6);
  return `quote_${phone}_${ts}_${rnd}`;
}

async function sendFlow(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  flowId: string,
  flowToken: string,
  contactName: string | null,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const greeting = contactName ? `Olá ${contactName}!` : "Olá!";

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Vectra Cargo" },
      body: {
        text:
          `${greeting} Pra te passar uma estimativa de frete rapidinho, toca no botão e preenche os 4 campos:`,
      },
      footer: { text: "Estimativa em segundos" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: "Solicitar cotação",
          mode: "published",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "QUOTATION_FORM",
            data: {},
          },
        },
      },
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    console.error("[send-quotation-flow] Meta error:", JSON.stringify(data));
    return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  }

  const messageId = data?.messages?.[0]?.id;
  return { ok: true, messageId };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json() as {
      phone?: string;
      contact_name?: string;
      flow_id?: string;
    };
    const rawPhone = body.phone?.trim();
    if (!rawPhone) return json({ ok: false, error: "phone_required" }, 400);

    const to = normalizePhone(rawPhone);
    if (to.length < 12 || to.length > 13) {
      return json({ ok: false, error: "invalid_phone_format" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: ninaSettings } = await supabase
      .from("nina_settings")
      .select("whatsapp_access_token, whatsapp_phone_number_id, quotation_flow_id")
      .limit(1)
      .maybeSingle();

    const accessToken = (ninaSettings?.whatsapp_access_token || "").trim();
    const phoneNumberId = (ninaSettings?.whatsapp_phone_number_id || "").trim();
    if (!accessToken || !phoneNumberId) {
      return json({ ok: false, error: "meta_credentials_missing_in_nina_settings" }, 503);
    }

    const flowId = (
      body.flow_id ||
      (ninaSettings as { quotation_flow_id?: string } | null)?.quotation_flow_id ||
      Deno.env.get("META_QUOTATION_FLOW_ID") ||
      ""
    ).trim();
    if (!flowId) {
      return json({
        ok: false,
        error:
          "quotation_flow_id_not_configured. Publique o Flow no Meta App Manager " +
          "e salve o ID em nina_settings.quotation_flow_id OU env META_QUOTATION_FLOW_ID.",
      }, 503);
    }

    const flowToken = newFlowToken(to);
    const contactName = body.contact_name?.trim() || null;

    const result = await sendFlow(phoneNumberId, accessToken, to, flowId, flowToken, contactName);
    if (!result.ok) {
      return json({ ok: false, error: result.error }, 502);
    }

    // Persistir token para correlação posterior com nfm_reply
    await supabase.from("quotation_flow_tokens").insert({
      flow_token: flowToken,
      phone: to,
      contact_name: contactName,
      flow_id: flowId,
      message_id: result.messageId,
    }).then(({ error }) => {
      if (error) {
        // Tabela pode não existir ainda — best-effort, não bloqueia o envio
        console.warn("[send-quotation-flow] persist flow_token failed:", error.message);
      }
    });

    return json({ ok: true, message_id: result.messageId, flow_token: flowToken }, 200);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-quotation-flow] error:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
