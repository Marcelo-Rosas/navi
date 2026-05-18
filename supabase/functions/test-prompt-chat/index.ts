import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAISimple } from "../nina-orchestrator/_shared/ai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function replacePromptVariables(prompt: string): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = { timeZone: "America/Sao_Paulo" };
  
  const dataBR = now.toLocaleDateString("pt-BR", options);
  const horaBR = now.toLocaleTimeString("pt-BR", options);
  const dataHora = `${dataBR} ${horaBR}`;
  
  const diasSemana = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const diaSemana = diasSemana[now.getDay()];

  return prompt
    .replace(/\{\{\s*data_hora\s*\}\}/g, dataHora)
    .replace(/\{\{\s*data\s*\}\}/g, dataBR)
    .replace(/\{\{\s*hora\s*\}\}/g, horaBR)
    .replace(/\{\{\s*dia_semana\s*\}\}/g, diaSemana)
    .replace(/\{\{\s*cliente_nome\s*\}\}/g, "Usuário Teste")
    .replace(/\{\{\s*cliente_telefone\s*\}\}/g, "5511999999999");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, systemPrompt } = await req.json();
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    const processedPrompt = replacePromptVariables(systemPrompt || "");

    const conversation = (messages || [])
      .map((m: any) => `${m?.role || "user"}: ${m?.content || ""}`)
      .join("\n");
    const fullPrompt = `${processedPrompt}\n\nConversa:\n${conversation}`;
    const content = await callAISimple(GEMINI_API_KEY, fullPrompt, 1024);

    return new Response(JSON.stringify({ response: content }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("test-prompt-chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
