// @ts-expect-error Supabase Edge runtime resolves Deno URL imports.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-expect-error Supabase Edge runtime resolves Deno URL imports.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVOLUTION_URL = "https://icysealion-evolution.cloudfy.live";
// @ts-expect-error Deno global is provided in Supabase Edge runtime.
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY")!;
const supabase = createClient(
  // @ts-expect-error Deno global is provided in Supabase Edge runtime.
  Deno.env.get("SUPABASE_URL")!,
  // @ts-expect-error Deno global is provided in Supabase Edge runtime.
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { instance_id } = await req.json();

    const { data: instance } = await supabase
      .from("whatsapp_instances")
      .select("instance_name")
      .eq("id", instance_id)
      .single();

    let evolution_error: string | null = null;
    if (instance?.instance_name) {
      const evoRes = await fetch(
        `${EVOLUTION_URL}/instance/delete/${instance.instance_name}`,
        {
          method: "DELETE",
          headers: { apikey: EVOLUTION_API_KEY },
        },
      );
      if (!evoRes.ok) evolution_error = await evoRes.text();
    }

    await supabase
      .from("whatsapp_instances")
      .update({ is_active: false })
      .eq("id", instance_id);

    return new Response(JSON.stringify({ success: true, evolution_error }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }
});
