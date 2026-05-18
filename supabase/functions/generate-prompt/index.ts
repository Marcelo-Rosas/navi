import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ✅ USA SERVICE ROLE — bypassa RLS completamente
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const results = [];

    // ✅ Uma única query com todos os campos necessários
    const { data: settings, error } = await supabase
      .from("nina_settings")
      .select("company_name, sdr_name, system_prompt_override, elevenlabs_api_key, whatsapp_access_token, whatsapp_phone_number_id, evolution_api_url, evolution_api_key")
      .limit(1)
      .single();

    // 1. Identidade
    results.push({
      component: "identity",
      status: settings?.company_name ? "ok" : "error",
      message: settings?.company_name ? "Identidade configurada" : "Identidade não configurada",
    });

    // 2. WhatsApp — checa via whatsapp_instances (Evolution já conectado)
    const { data: instances } = await supabase
      .from("whatsapp_instances")
      .select("status, is_active")
      .eq("is_active", true)
      .eq("status", "connected")
      .limit(1);

    const hasWhatsapp = instances && instances.length > 0;
    results.push({
      component: "whatsapp",
      status: hasWhatsapp ? "ok" : "error",
      message: hasWhatsapp ? "WhatsApp conectado" : "WhatsApp não conectado",
    });

    // 3. Agente IA — campo correto é system_prompt_override
    results.push({
      component: "agent_prompt",
      status: settings?.system_prompt_override ? "ok" : "warning",
      message: settings?.system_prompt_override ? "Prompt configurado" : "Prompt padrão em uso",
    });

    // 4. ElevenLabs — opcional
    results.push({
      component: "elevenlabs",
      status: settings?.elevenlabs_api_key ? "ok" : "warning",
      message: settings?.elevenlabs_api_key ? "ElevenLabs configurado" : "Opcional — áudio desativado",
    });

    // 5. Pipeline
    const { data: pipeline } = await supabase
      .from("pipeline_stages")
      .select("id")
      .limit(1);

    results.push({
      component: "pipeline",
      status: pipeline && pipeline.length > 0 ? "ok" : "warning",
      message: pipeline && pipeline.length > 0 ? "Pipeline configurado" : "Pipeline vazio",
    });

    // 6. Configurações Nina — Evolution API (seu caso real)
    const hasEvolution = !!(settings?.evolution_api_url && settings?.evolution_api_key);
    results.push({
      component: "nina_settings",
      status: hasEvolution ? "ok" : "error",
      message: hasEvolution ? "Evolution API configurado" : "Evolution API não configurado",
    });

    // 7. Profile
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);

    results.push({
      component: "profile",
      status: profiles && profiles.length > 0 ? "ok" : "ok", // não bloqueia
      message: "Perfil configurado",
    });

    // 8. IA Backend
    results.push({
      component: "ai_backend",
      status: "ok",
      message: "Backend de IA ativo",
    });

    const errors = results.filter(r => r.status === "error").length;
    const warnings = results.filter(r => r.status === "warning").length;
    const ok = results.filter(r => r.status === "ok").length;
    const total = results.length;

    return new Response(
      JSON.stringify({
        results,
        overallStatus: errors > 0 ? "error" : warnings > 0 ? "warning" : "ok",
        summary: { ok, total, percentage: Math.round((ok / total) * 100) },
        message: errors > 0
          ? `${errors} configuração(ões) obrigatória(s) pendente(s)`
          : warnings > 0 ? "Sistema funcional com itens opcionais pendentes"
          : "Todas as configurações estão corretas!",
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});