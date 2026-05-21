import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const META_GRAPH = 'https://graph.facebook.com/v21.0';

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const instanceName =
      typeof body.instance_name === 'string'
        ? body.instance_name.trim()
        : name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    const isDefault = Boolean(body.is_default);

    if (!name || !instanceName) {
      return json({ success: false, error: 'Nome da conexão é obrigatório' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('authorization');
    const bearer = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? '';
    if (!bearer) {
      return json({ success: false, error: 'Authorization obrigatório' }, 401);
    }

    if (bearer !== supabaseServiceKey) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(bearer);
      if (authError || !user) {
        return json({ success: false, error: 'Token inválido ou expirado' }, 401);
      }
    }

    const { data: ninaSettings } = await supabase
      .from('nina_settings')
      .select(
        'whatsapp_access_token, whatsapp_phone_number_id, whatsapp_business_account_id, whatsapp_verify_token',
      )
      .limit(1)
      .maybeSingle();

    const accessToken = (
      body.whatsapp_access_token || ninaSettings?.whatsapp_access_token || ''
    ).trim();
    const phoneNumberId = (
      body.whatsapp_phone_number_id || ninaSettings?.whatsapp_phone_number_id || ''
    ).trim();

    if (!accessToken || !phoneNumberId) {
      return json({
        success: false,
        error:
          'Configure Access Token e Phone Number ID (Meta Cloud API) em Configurações ou no onboarding antes de registrar a instância.',
      }, 400);
    }

    if (!/^\d{10,20}$/.test(phoneNumberId)) {
      return json({
        success: false,
        error: 'Phone Number ID inválido (apenas dígitos, ID do número na Meta — não WABA nem App ID).',
      }, 400);
    }

    const verifyRes = await fetch(
      `${META_GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) {
      const msg = (verifyData as { error?: { message?: string } })?.error?.message ||
        'Token ou Phone Number ID inválidos';
      return json({ success: false, error: `Meta API: ${msg}` }, 400);
    }

    const displayPhone = (verifyData as { display_phone_number?: string }).display_phone_number ||
      null;
    const verifiedName = (verifyData as { verified_name?: string }).verified_name || name;

    const { data: existing } = await supabase
      .from('whatsapp_instances')
      .select('id')
      .eq('provider_type', 'official')
      .eq('instance_id_external', phoneNumberId)
      .eq('is_active', true)
      .maybeSingle();

    let instanceId: string;

    if (existing?.id) {
      const { data: updated, error: updateError } = await supabase
        .from('whatsapp_instances')
        .update({
          name,
          instance_name: instanceName,
          status: 'connected',
          phone_number: displayPhone,
          is_default: isDefault,
          metadata: {
            verified_name: verifiedName,
            phone_number_id: phoneNumberId,
            provider: 'meta_cloud_api',
          },
        })
        .eq('id', existing.id)
        .select('id')
        .single();

      if (updateError) {
        return json({ success: false, error: updateError.message }, 500);
      }
      instanceId = updated.id;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('whatsapp_instances')
        .insert({
          name,
          instance_name: instanceName,
          provider_type: 'official',
          instance_id_external: phoneNumberId,
          phone_number: displayPhone,
          status: 'connected',
          is_default: isDefault,
          is_active: true,
          metadata: {
            verified_name: verifiedName,
            phone_number_id: phoneNumberId,
            provider: 'meta_cloud_api',
          },
        })
        .select('id')
        .single();

      if (insertError) {
        return json({ success: false, error: insertError.message }, 500);
      }
      instanceId = inserted.id;
    }

    if (isDefault) {
      await supabase
        .from('whatsapp_instances')
        .update({ is_default: false })
        .eq('is_active', true)
        .neq('id', instanceId);
      await supabase
        .from('whatsapp_instances')
        .update({ is_default: true })
        .eq('id', instanceId);
    }

    return json({
      success: true,
      instance_id: instanceId,
      provider: 'meta',
      status: 'connected',
      display_phone_number: displayPhone,
      verified_name: verifiedName,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error('[create-meta-instance]', message);
    return json({ success: false, error: message }, 500);
  }
});
