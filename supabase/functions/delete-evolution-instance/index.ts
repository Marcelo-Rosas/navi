import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { instance_id } = await req.json();

    if (!instance_id) {
      return new Response(JSON.stringify({ success: false, error: 'instance_id é obrigatório' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Buscar instância e seus secrets
    const { data: instance, error: instanceError } = await supabase
      .from('whatsapp_instances')
      .select('*')
      .eq('id', instance_id)
      .single();

    if (instanceError || !instance) {
      return new Response(JSON.stringify({ success: false, error: 'Instância não encontrada' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: secrets } = await supabase
      .from('whatsapp_instance_secrets')
      .select('api_url, api_key')
      .eq('instance_id', instance_id)
      .maybeSingle();

    let evolutionDeleted = false;
    let evolutionError: string | null = null;

    // 2. Deletar na Evolution API (apenas para instâncias Evolution)
    if (instance.provider_type !== 'official' && secrets?.api_url && secrets?.api_key) {
      try {
        const baseUrl = secrets.api_url.replace(/\/$/, '');
        const deleteRes = await fetch(`${baseUrl}/instance/delete/${instance.instance_name}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'apikey': secrets.api_key,
          },
        });

        const deleteText = await deleteRes.text();
        console.log(`[delete-evolution-instance] Evolution DELETE response (${deleteRes.status}): ${deleteText.substring(0, 300)}`);

        if (deleteRes.ok) {
          evolutionDeleted = true;
        } else {
          evolutionError = `Evolution API retornou ${deleteRes.status}: ${deleteText.substring(0, 200)}`;
          console.warn('[delete-evolution-instance] Evolution API error (non-fatal):', evolutionError);
        }
      } catch (err) {
        evolutionError = err instanceof Error ? err.message : 'Erro desconhecido';
        console.warn('[delete-evolution-instance] Failed to delete from Evolution API (non-fatal):', evolutionError);
      }
    }

    // 3. Soft delete no banco (is_active = false) independente do resultado da Evolution API
    const { error: dbError } = await supabase
      .from('whatsapp_instances')
      .update({ is_active: false })
      .eq('id', instance_id);

    if (dbError) {
      return new Response(JSON.stringify({ success: false, error: dbError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      evolution_deleted: evolutionDeleted,
      evolution_error: evolutionError,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[delete-evolution-instance] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
