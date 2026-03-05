import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  console.log(`[check-instances-status] Received ${req.method} request`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Buscar todas as instâncias Evolution ativas
    const { data: instances, error: instancesError } = await supabase
      .from('whatsapp_instances')
      .select('id, instance_name, instance_id_external, provider_type, status')
      .in('provider_type', ['evolution_self_hosted', 'evolution_cloud'])
      .eq('is_active', true);

    if (instancesError) {
      throw instancesError;
    }

    console.log(`[check-instances-status] Found ${instances?.length || 0} instances to check`);

    const results = [];

    for (const instance of instances || []) {
      try {
        // Buscar secrets da instância
        const { data: secrets } = await supabase
          .from('whatsapp_instance_secrets')
          .select('api_url, api_key')
          .eq('instance_id', instance.id)
          .single();

        if (!secrets) {
          console.log(`[check-instances-status] No secrets for instance ${instance.id}`);
          results.push({ id: instance.id, status: 'error', error: 'No secrets' });
          continue;
        }

        // Determinar identificador correto
        const instanceIdentifier = instance.provider_type === 'evolution_cloud' && instance.instance_id_external
          ? instance.instance_id_external
          : instance.instance_name;

        // Verificar status via API
        const response = await fetch(
          `${secrets.api_url.replace(/\/$/, '')}/instance/connectionState/${instanceIdentifier}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'apikey': secrets.api_key,
            },
          }
        );

        let newStatus = 'disconnected';
        
        if (response.ok) {
          const data = await response.json();
          const state = data?.state || data?.instance?.state || data?.connection;
          
          switch (state) {
            case 'open':
            case 'connected':
              newStatus = 'connected';
              break;
            case 'connecting':
              newStatus = 'connecting';
              break;
            case 'close':
            case 'disconnected':
            default:
              newStatus = 'disconnected';
          }
        }

        // Atualizar status se mudou
        if (newStatus !== instance.status) {
          await supabase
            .from('whatsapp_instances')
            .update({ 
              status: newStatus,
              updated_at: new Date().toISOString()
            })
            .eq('id', instance.id);

          console.log(`[check-instances-status] Updated ${instance.id}: ${instance.status} -> ${newStatus}`);
        }

        results.push({ id: instance.id, status: newStatus });

      } catch (instanceError: unknown) {
        console.error(`[check-instances-status] Error checking instance ${instance.id}:`, instanceError);
        const errMsg = instanceError instanceof Error ? instanceError.message : 'Unknown error';
        results.push({ id: instance.id, status: 'error', error: errMsg });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      checked: results.length,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[check-instances-status] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      success: false,
      error: message,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
