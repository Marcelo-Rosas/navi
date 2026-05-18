import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { api_url, api_key, instance_name } = await req.json();

    const res = await fetch(`${api_url}/instance/fetchInstances`, {
      headers: { "apikey": api_key },
    });

    if (!res.ok) throw new Error(`Evolution API retornou ${res.status}`);

    const data = await res.json();
    const instance = data?.find((i: any) => i.name === instance_name || i.instance?.instanceName === instance_name);

    return new Response(JSON.stringify({ success: true, connected: !!instance, data }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});