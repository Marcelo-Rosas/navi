import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callAI } from './_shared/ai.ts';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
const cfnUrl = Deno.env.get('CFN_SUPABASE_URL');
const cfnKey = Deno.env.get('CFN_SUPABASE_SERVICE_KEY');
const OPERACIONAL_PHONE = '5547927010075';
async function buscarOS(osNumber) {
  try {
    const cfn = createClient(cfnUrl, cfnKey);
    const normalized = osNumber.trim().toUpperCase();
    const { data, error } = await cfn.from('orders').select('os_number, stage, client_name, origin, destination, driver_name, has_nfe, has_cte, has_pod, value, occurrences(id)').ilike('os_number', normalized).maybeSingle();
    if (error) throw error;
    if (!data) return JSON.stringify({
      found: false,
      os_number: normalized
    });
    const stageLabels = {
      ordem_criada: 'Ordem Criada',
      busca_motorista: 'Buscando Motorista',
      documentacao: 'Em Documentação',
      coleta_realizada: 'Coleta Realizada',
      em_transito: 'Em Trânsito',
      entregue: 'Entregue ✅'
    };
    const pendingDocs = [];
    if (!data.has_nfe) pendingDocs.push('NF-e');
    if (!data.has_cte) pendingDocs.push('CT-e');
    if (!data.has_pod) pendingDocs.push('POD');
    return JSON.stringify({
      found: true,
      os_number: data.os_number,
      status: stageLabels[data.stage] ?? data.stage,
      client: data.client_name,
      route: `${data.origin} → ${data.destination}`,
      driver: data.driver_name ?? 'Não atribuído',
      docs_pending: pendingDocs,
      occurrences_count: data.occurrences?.length ?? 0,
      value: Number(data.value)
    });
  } catch (err) {
    return JSON.stringify({
      found: false,
      error: err.message
    });
  }
}
async function sugerirPerdido(supabase, minDaysStalled = 10, limit = 200, shipperIds = []) {
  try {
    const cfn = createClient(cfnUrl, cfnKey);
    const safeDays = Number.isFinite(minDaysStalled) ? Math.max(1, Math.floor(minDaysStalled)) : 10;
    const safeLimit = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 200;
    const shipperFilterProvided = (shipperIds || []).length > 0;
    const pageSize = 1000;
    const maxRows = 10000;
    const allStageEvents = [];
    for(let offset = 0; offset < maxRows; offset += pageSize){
      const { data: page, error: pageError } = await supabase.from('workflow_events').select('entity_id, created_at, payload').eq('entity_type', 'quote').eq('event_type', 'quote.stage_changed').order('created_at', {
        ascending: false
      }).range(offset, offset + pageSize - 1);
      if (pageError) throw pageError;
      const rows = page || [];
      allStageEvents.push(...rows);
      if (rows.length < pageSize) break;
    }

    const latestStageByQuoteId = new Map();
    const enteredNegociacaoByQuoteId = new Map();
    const eventMetaByQuoteId = new Map();
    for (const ev of allStageEvents){
      const key = String(ev.entity_id);
      const payload = ev.payload || {};
      const newStage = String(payload.new_stage || '');

      if (!latestStageByQuoteId.has(key)) {
        latestStageByQuoteId.set(key, newStage);
      }

      if (newStage === 'negociacao' && !enteredNegociacaoByQuoteId.has(key)) {
        enteredNegociacaoByQuoteId.set(key, ev.created_at);
        eventMetaByQuoteId.set(key, {
          quote_code: payload.quote_code ?? null,
          shipper_name: payload.shipper_name ?? null,
          client_name: payload.client_name ?? null,
        });
      }
    }
    const candidateQuoteIds = Array.from(latestStageByQuoteId.keys()).filter((qid)=>latestStageByQuoteId.get(qid) === 'negociacao');

    const now = Date.now();
    let campaignsInternal = candidateQuoteIds.map((qid)=>{
      const eventMeta = eventMetaByQuoteId.get(String(qid)) ?? {};
      const enteredNegociacaoAt = enteredNegociacaoByQuoteId.get(String(qid)) ?? null;
      const quoteRefIso = enteredNegociacaoAt ?? null;
      const quoteRefMs = quoteRefIso ? Date.parse(quoteRefIso) : NaN;
      const quoteDays = Number.isFinite(quoteRefMs) ? Math.max(0, Math.floor((now - quoteRefMs) / 86400000)) : 0;

      return {
        quote_code: eventMeta.quote_code ?? null,
        shipper_name: eventMeta.shipper_name ?? null,
        client_name: eventMeta.client_name ?? null,
        days_stalled: quoteDays,
        days_in_negociacao: quoteDays,
        days_stalled_from_quote: quoteDays,
        entered_negociacao_at: enteredNegociacaoAt,
        last_contact_at: enteredNegociacaoAt,
        next_action_at: null,
        updated_at: enteredNegociacaoAt,
        can_move_to_lost: true,
      };
    }).filter((c)=>c.days_stalled >= safeDays && c.quote_code);

    let source = 'workflow_events';

    // Fallback: if stage events are missing/incomplete, derive candidates from quotes table.
    if (campaignsInternal.length === 0) {
      const quotesFallback = [];
      for(let offset = 0; offset < maxRows; offset += pageSize){
        const { data: page, error: pageError } = await cfn.schema('public').from('quotes').select('quote_code, shipper_name, client_name, shipper_id, updated_at, created_at').eq('stage', 'negociacao').order('updated_at', {
          ascending: false
        }).range(offset, offset + pageSize - 1);
        if (pageError) throw pageError;
        const rows = page || [];
        for (const q of rows){
          if (!q.quote_code) continue;
          if (shipperFilterProvided && (!q.shipper_id || !shipperIds.includes(String(q.shipper_id)))) continue;
          const refIso = q.updated_at ?? q.created_at ?? null;
          const refMs = refIso ? Date.parse(refIso) : NaN;
          const days = Number.isFinite(refMs) ? Math.max(0, Math.floor((now - refMs) / 86400000)) : 0;
          if (days < safeDays) continue;
          quotesFallback.push({
            quote_code: q.quote_code,
            shipper_name: q.shipper_name ?? null,
            client_name: q.client_name ?? null,
            days_stalled: days,
            days_in_negociacao: days,
            days_stalled_from_quote: days,
            entered_negociacao_at: null,
            last_contact_at: refIso,
            next_action_at: null,
            updated_at: q.updated_at ?? q.created_at ?? null,
            can_move_to_lost: true,
          });
        }
        if (rows.length < pageSize) break;
      }
      campaignsInternal = quotesFallback;
      source = 'quotes_fallback';
    }

    const campaigns = campaignsInternal.sort((a, b)=>b.days_stalled - a.days_stalled).slice(0, safeLimit);

    const groups = new Map();
    for (const c of campaigns){
      const key = c.shipper_name ? String(c.shipper_name) : 'sem_shipper';
      if (!groups.has(key)) {
        groups.set(key, {
          shipper_name: c.shipper_name ?? 'Sem embarcador',
          total: 0,
          campaigns: [],
        });
      }
      const g = groups.get(key);
      g.total += 1;
      g.campaigns.push(c);
    }
    const quotesByShipper = Array.from(groups.values()).sort((a, b)=>b.total - a.total);

    return JSON.stringify({
      success: true,
      total: campaigns.length,
      min_days_stalled: safeDays,
      rule: 'dias desde entrada no stage negociacao (workflow_events.quote.stage_changed)',
      quote_stage: 'negociacao',
      source,
      shipper_filter_supported: false,
      shipper_filter_ignored: shipperFilterProvided,
      grouped_by_shipper: true,
      shipper_groups: quotesByShipper.length,
      quotes_by_shipper: quotesByShipper,
      quotes: campaigns
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: err.message
    });
  }
}
async function moverParaPerdido(supabase, quoteCodes = []) {
  try {
    const cfn = createClient(cfnUrl, cfnKey);
    const qCodes = [
      ...new Set((quoteCodes || []).filter((c)=>typeof c === 'string' && c.length > 0).map((c)=>c.trim().toUpperCase()))
    ];

    if (qCodes.length === 0) {
      return JSON.stringify({
        success: false,
        error: 'Informe quote_codes'
      });
    }

    const allQuoteIds = new Set();
    const { data: quotesByCode, error: quotesByCodeError } = await cfn.schema('public').from('quotes').select('id, quote_code').in('quote_code', qCodes);
    if (quotesByCodeError) throw quotesByCodeError;
    for (const q of quotesByCode || []){
      allQuoteIds.add(String(q.id));
    }

    if (allQuoteIds.size === 0) {
      return JSON.stringify({
        success: false,
        error: 'Nenhuma cotação encontrada para os identificadores informados'
      });
    }

    const { data: quotesToMove, error: quotesFetchError } = await cfn.schema('public').from('quotes').select('id, quote_code, stage').in('id', Array.from(allQuoteIds));
    if (quotesFetchError) throw quotesFetchError;
    if (!quotesToMove || quotesToMove.length === 0) {
      return JSON.stringify({
        success: false,
        error: 'Nenhuma cotação encontrada para mover'
      });
    }

    const alreadyLost = quotesToMove.filter((q)=>String(q.stage) === 'perdido');
    const targetQuotes = quotesToMove.filter((q)=>String(q.stage) !== 'perdido');
    if (targetQuotes.length === 0) {
      return JSON.stringify({
        success: true,
        moved: 0,
        message: 'Todas as cotações já estavam em perdido',
        already_lost_quote_codes: alreadyLost.map((q)=>q.quote_code).filter(Boolean),
      });
    }

    const quoteIdsToMove = targetQuotes.map((q)=>q.id);
    const { error: quoteUpdateError } = await cfn.schema('public').from('quotes').update({
      stage: 'perdido'
    }).in('id', quoteIdsToMove);
    if (quoteUpdateError) throw quoteUpdateError;

    return JSON.stringify({
      success: true,
      moved: quoteIdsToMove.length,
      quote_codes: targetQuotes.map((q)=>q.quote_code).filter(Boolean),
      already_lost_quote_codes: alreadyLost.map((q)=>q.quote_code).filter(Boolean),
    });
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: err.message
    });
  }
}
async function buscarNoticias(supabase) {
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('news_items')
      .select('title, summary, source_url, created_at')
      .gte('created_at', since)
      .order('relevance_score', { ascending: false })
      .limit(3);
    if (error) throw error;
    if (!data || data.length === 0) return JSON.stringify({ found: false, message: 'Nenhuma notícia nas últimas 48h.' });
    return JSON.stringify({ found: true, count: data.length, news: data });
  } catch (err) {
    return JSON.stringify({ found: false, error: err.message });
  }
}
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'buscar_status_os',
        description: 'Busca status e informações de uma Ordem de Serviço (OS) no sistema Vectra Cargo.',
        parameters: {
          type: 'OBJECT',
          properties: {
            os_number: {
              type: 'STRING',
              description: 'Número da OS, ex: OS-2026-03-0001'
            }
          },
          required: [
            'os_number'
          ]
        }
      },
      {
        name: 'sugerir_perdido',
        description: 'Sugere cards/COT para mover a perdido quando a cotação está no stage negociacao há 10+ dias (contados desde a entrada no stage), agrupando por embarcador (shipper).',
        parameters: {
          type: 'OBJECT',
          properties: {
            min_days_stalled: {
              type: 'NUMBER',
              description: 'Dias mínimos parado. Padrão: 10.'
            },
            limit: {
              type: 'NUMBER',
              description: 'Quantidade máxima de cotações retornadas. Padrão: 200, máximo 500.'
            },
            shipper_ids: {
              type: 'ARRAY',
              items: {
                type: 'STRING'
              },
              description: 'Opcional. Lista de shippers para filtrar (UUID). Se vazio, considera todos.'
            }
          },
          required: []
        }
      },
      {
        name: 'mover_para_perdido',
        description: 'Move cotações para stage perdido usando quote_codes.',
        parameters: {
          type: 'OBJECT',
          properties: {
            quote_codes: {
              type: 'ARRAY',
              items: {
                type: 'STRING'
              },
              description: 'Lista de códigos de cotação (ex: COT-2026-03-0012).'
            }
          },
          required: [
            'quote_codes'
          ]
        }
      },
      {
        name: 'buscar_noticias',
        description: 'Busca as últimas notícias de mercado (logística, transporte, ANTT) das últimas 48h. Use quando alguém perguntar sobre notícias, mercado ou novidades.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: []
        }
      }
    ]
  }
];
async function callGemini(messages, systemPrompt, tools) {
  const { text, toolCalls } = await callAI(geminiApiKey, messages, systemPrompt, tools, 1024);
  return {
    text,
    toolCalls
  };
}
function isAdminOnlyTool(toolName) {
  return toolName === 'sugerir_perdido' || toolName === 'mover_para_perdido';
}
serve(async ()=>{
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  try {
    const { data: batch, error } = await supabase.rpc('claim_nina_processing_batch', {
      p_limit: 5
    });
    if (error) throw error;
    if (!batch || batch.length === 0) {
      console.log('[Nina] Queue empty — claim returned 0 rows (cron/ping ok, no work)');
      return new Response(JSON.stringify({
        processed: 0
      }), {
        status: 200
      });
    }
    // Mesma conversa pode aparecer várias vezes no batch (webhooks duplicados, retries, fila antiga).
    // Sem isso, a Navi gera uma resposta por linha — rajada de mensagens iguais no WhatsApp.
    const bestByConv = new Map<string, (typeof batch)[number]>();
    for (const item of batch) {
      const conv = String(item.conversation_id);
      const cur = bestByConv.get(conv);
      if (!cur) {
        bestByConv.set(conv, item);
        continue;
      }
      const tItem = new Date(item.created_at ?? item.scheduled_for ?? 0).getTime();
      const tCur = new Date(cur.created_at ?? cur.scheduled_for ?? 0).getTime();
      if (tItem >= tCur) bestByConv.set(conv, item);
    }
    const nowDedupe = new Date().toISOString();
    const superseded = batch.filter((item) => bestByConv.get(String(item.conversation_id))?.id !== item.id);
    for (const item of superseded) {
      await supabase.from('nina_processing_queue').update({
        status: 'completed',
        processed_at: nowDedupe,
        error_message: 'superseded_duplicate_conversation_batch',
      }).eq('id', item.id);
    }
    const workBatch = Array.from(bestByConv.values());
    console.log(`[Nina] Claimed ${batch.length}, after conv dedupe: ${workBatch.length} (dropped ${superseded.length})`);
    const { data: settings } = await supabase.from('nina_settings').select('*').single();
    let processed = 0;
    for (const item of workBatch){
      try {
        // Só responde para a mensagem de usuário mais recente na conversa (evita rajada quando
        // cron/grouper reexecutam itens antigos da fila para a mesma conversa).
        const { data: latestUser } = await supabase
          .from('messages')
          .select('id')
          .eq('conversation_id', item.conversation_id)
          .eq('from_type', 'user')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestUser && latestUser.id !== item.message_id) {
          console.log(`[Nina] Skip ${item.id}: queue targets older user message (latest=${latestUser.id})`);
          await supabase.from('nina_processing_queue').update({
            status: 'completed',
            processed_at: new Date().toISOString(),
            error_message: 'superseded_not_latest_user_message',
          }).eq('id', item.id);
          continue;
        }

        if (item.created_at) {
          const { data: newerPending } = await supabase
            .from('nina_processing_queue')
            .select('id')
            .eq('conversation_id', item.conversation_id)
            .eq('status', 'pending')
            .gt('created_at', item.created_at)
            .limit(1)
            .maybeSingle();

          if (newerPending) {
            console.log(`[Nina] Skip ${item.id}: newer pending row for same conversation`);
            await supabase.from('nina_processing_queue').update({
              status: 'completed',
              processed_at: new Date().toISOString(),
              error_message: 'superseded_newer_pending_same_conversation',
            }).eq('id', item.id);
            continue;
          }
        }

        // Busca a mensagem pelo message_id
        const { data: message } = await supabase.from('messages').select('content, from_type, conversation_id').eq('id', item.message_id).single();
        if (!message?.content) throw new Error('Message content not found');
        const messageContent = message.content;
        console.log(`[Nina] Message: ${messageContent.substring(0, 80)}`);

        // === INTERCEPTOR: driver-search-reply-handler ===
        // Check if this contact is in an active driver search campaign
        const { data: dscActive } = await supabase
          .from('driver_search_contacts')
          .select('id, stage')
          .eq('contact_id', item.contact_id)
          .in('stage', ['greeting_sent', 'offer_sent'])
          .limit(1);
        if (dscActive && dscActive.length > 0) {
          console.log(`[Nina] Driver search active for contact ${item.contact_id}, delegating to reply-handler`);
          const { data: contact4dsr } = await supabase.from('contacts').select('phone_number').eq('id', item.contact_id).single();
          const { data: dscResult } = await supabase.functions.invoke('driver-search-reply-handler', {
            body: { phone: contact4dsr?.phone_number, message: messageContent, conversation_id: item.conversation_id }
          });
          if (dscResult?.handled) {
            await supabase.from('nina_processing_queue').update({ status: 'completed', processed_at: new Date().toISOString() }).eq('id', item.id);
            processed++;
            continue;
          }
        }

        // Busca contato com is_admin
        const { data: contact } = await supabase.from('contacts').select('phone_number, name, is_admin').eq('id', item.contact_id).single();
        const isAdmin = contact?.is_admin === true;
        console.log(`[Nina] Contact: ${contact?.name} | admin: ${isAdmin}`);
        // System prompt diferenciado
        const adminPrompt = `Você é Navi, assistente interno da Vectra Cargo.
Você está conversando com ${contact?.name}, membro da equipe interna.
NÃO trate esta pessoa como cliente. NÃO execute fluxo de vendas, cotações ou atendimento comercial.
Seja direto, operacional e objetivo. Pode usar linguagem mais informal.
Se perguntarem sobre notícias do setor (NTC, tabelas de frete, paralisações, regulamentações ANTT), informe que monitora as fontes diariamente e enviará atualizações relevantes assim que disponíveis.
Para análise de perdidos de COT, use sugerir_perdido para sugerir cards em negociacao há 10+ dias desde entrada no stage.
Para efetivar perda, use mover_para_perdido com quote_codes.
Ao apresentar sugestões de perdidos, sempre mostrar quote_code, shipper_name e client_name.
NUNCA use o termo "campanha" na resposta; use "cotação" ou "card".`;
        const basePrompt = isAdmin ? adminPrompt : settings?.system_prompt_override ?? `Você é Navi, assistente virtual da Vectra Cargo. Seja simpática, profissional e objetiva. Responda sempre em português.
Quando o cliente informar um número de OS, use a tool buscar_status_os para consultar o sistema em tempo real.
Se a OS não for encontrada, informe educadamente e diga que a equipe vai verificar.
Se houver ocorrências na OS, mencione e sugira falar com a equipe operacional.`;
        // Mantém regras de tool calling sempre ativas, mesmo com system_prompt_override no banco.
        const mandatoryToolsPrompt = `
Regras obrigatórias de ferramentas:
- Para consulta de OS, use buscar_status_os.
${isAdmin ? '- Para análise de perdidos de COT, use sugerir_perdido considerando dias desde entrada no stage negociacao.\n- Ao listar sugestões, sempre informe quote_code, shipper_name e client_name.\n- Formato obrigatório para WhatsApp (uma linha por cotação): COT-... | EMBARCADOR: ... | CLIENTE: ...\n- Para efetivar perdidos, use mover_para_perdido com quote_codes.\n- Alias explícitos de comando curto: "sugestao perdidas" => sugerir_perdido; "mover perdidas [COT-...]" => mover_para_perdido.\n- Nunca use o termo "campanha" na resposta ao usuário.\n' : '- Não use tools internas de gestão de cotações/perdidos para contatos não-admin.\n'}- Não responda que "não possui essa funcionalidade" se houver tool correspondente disponível.

REGRA CRÍTICA — Recuperação de contexto após instabilidade:
- Se o histórico da conversa contiver mensagens anteriores suas ou do cliente, NUNCA se reapresente com saudação inicial como se fosse o primeiro contato.
- Se o cliente já forneceu dados (endereços, dimensões, peso, valor da mercadoria) e você não os encontra no contexto: peça desculpas brevemente, informe que já encaminhou o pedido ao time comercial, e pergunte apenas o dado faltante (ex: telefone de contato).
- Fórmula de recuperação: "Peço desculpas pela instabilidade! Já encaminhei sua cotação ([resumo dos dados que o cliente mencionou]) ao time comercial. Qual o melhor telefone para retorno? 🚀"
- NUNCA reinicie o fluxo pedindo informações que o cliente já enviou nesta mesma conversa.`;
        const activePrompt = `${basePrompt}\n${mandatoryToolsPrompt}`;
        // Busca histórico da conversa (últimas 30 mensagens — janela ampliada para preservar contexto em conversas longas)
        const { data: history } = await supabase.from('messages').select('content, from_type, created_at').eq('conversation_id', item.conversation_id).order('created_at', {
          ascending: false
        }).limit(30);
        const geminiMessages = (history ?? []).filter((m)=>m.content).reverse().map((m)=>({
            role: m.from_type === 'nina' ? 'model' : 'user',
            parts: [
              {
                text: m.content
              }
            ]
          }));
        // Garante que a mensagem atual está no final
        const lastMsg = geminiMessages[geminiMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.parts[0].text !== messageContent) {
          geminiMessages.push({
            role: 'user',
            parts: [
              {
                text: messageContent
              }
            ]
          });
        }
        // Garante que não começa com mensagem do model
        while(geminiMessages.length > 0 && geminiMessages[0].role === 'model'){
          geminiMessages.shift();
        }

        // Sanitização de histórico: detecta e remove mensagens de reset acidental
        // (NAVI enviando saudação inicial mais de uma vez na mesma conversa)
        const RESET_MARKER = 'Sou o NAVI, assistente virtual da Vectra Cargo';
        const resetCount = geminiMessages.filter(m =>
          m.role === 'model' &&
          typeof (m.parts[0] as any)?.text === 'string' &&
          (m.parts[0] as any).text.includes(RESET_MARKER)
        ).length;
        if (resetCount > 1) {
          console.log(`[Nina] ${resetCount} saudações de reset detectadas no histórico (conv ${item.conversation_id}) — sanitizando contexto`);
          const cleaned = geminiMessages.filter(m =>
            !(m.role === 'model' &&
              typeof (m.parts[0] as any)?.text === 'string' &&
              (m.parts[0] as any).text.includes(RESET_MARKER))
          );
          // Injeta aviso de sistema para o modelo entender o que aconteceu
          cleaned.unshift({
            role: 'user' as const,
            parts: [{ text: '[AVISO DO SISTEMA]: Houve uma instabilidade técnica anterior que gerou saudações iniciais duplicadas e incorretas. Essas mensagens foram removidas do histórico. O cliente já forneceu dados de cotação nesta conversa. Peça desculpas brevemente pela instabilidade, confirme que já encaminhou ao time comercial e solicite apenas o telefone de contato para retorno.' }]
          });
          geminiMessages.splice(0, geminiMessages.length, ...cleaned);
          console.log(`[Nina] Histórico sanitizado: ${geminiMessages.length} msgs restantes`);
        }

        console.log(`[Nina] Calling AI, msgs: ${geminiMessages.length}`);
        const MAX_TOOL_ROUNDS = 3;
        let { text, toolCalls } = await callGemini(geminiMessages, activePrompt, TOOLS);
        const wantsLostSuggestion = /perdid|follow-?up|follow up|cot|cota[cç][aã]o/i.test(messageContent);
        if (toolCalls.length === 0 && isAdmin && wantsLostSuggestion) {
          toolCalls = [
            {
              name: 'sugerir_perdido',
              args: {
                min_days_stalled: 10,
                limit: 20
              }
            }
          ];
          console.log('[Nina] Fallback tool call injected: sugerir_perdido');
        }
        // Multi-round agentic loop — executa tools até max rounds ou resposta final
        for (let round = 0; round < MAX_TOOL_ROUNDS && toolCalls.length > 0; round++) {
          console.log(`[Nina] Tool round ${round + 1}/${MAX_TOOL_ROUNDS}: ${toolCalls.map((t)=>t.name).join(', ')}`);
          const toolResults = [];
          for (const tc of toolCalls){
            let result = '';
            if (isAdminOnlyTool(tc.name) && !isAdmin) {
              result = JSON.stringify({
                success: false,
                error: `A tool ${tc.name} exige contato admin.`,
                permission_required: 'admin',
              });
              toolResults.push({
                functionResponse: {
                  name: tc.name,
                  response: { result }
                }
              });
              continue;
            }
            const args = (()=>{
              if (tc?.args && typeof tc.args === 'object') return tc.args;
              if (typeof tc?.args === 'string') {
                try {
                  return JSON.parse(tc.args);
                } catch (_) {
                  return {};
                }
              }
              return {};
            })();
            if (tc.name === 'buscar_status_os' || tc.name === 'buscar_os') {
              result = await buscarOS(String(args?.os_number ?? ''));
              console.log(`[Nina] buscar_status_os(${String(args?.os_number ?? '')}): ${result}`);
            }
            if (tc.name === 'sugerir_perdido') {
              result = await sugerirPerdido(supabase, Number(args?.min_days_stalled ?? 10), Number(args?.limit ?? 200), Array.isArray(args?.shipper_ids) ? args.shipper_ids.map((id)=>String(id)) : []);
              console.log(`[Nina] sugerir_perdido: ${result.substring(0, 200)}`);
            }
            if (tc.name === 'mover_para_perdido') {
              const quoteCodes = Array.isArray(args?.quote_codes) ? args.quote_codes.map((c)=>String(c)) : [];
              result = await moverParaPerdido(supabase, quoteCodes);
              console.log(`[Nina] mover_para_perdido(${quoteCodes.length} quote_codes): ${result.substring(0, 200)}`);
            }
            if (tc.name === 'buscar_noticias') {
              result = await buscarNoticias(supabase);
              console.log(`[Nina] buscar_noticias: ${result.substring(0, 200)}`);
            }
            toolResults.push({
              functionResponse: {
                name: tc.name,
                response: { result }
              }
            });
          }
          geminiMessages.push({
            role: 'model',
            parts: toolCalls.map((tc)=>({
                functionCall: tc
              }))
          });
          geminiMessages.push({
            role: 'user',
            parts: toolResults
          });
          const next = await callGemini(geminiMessages, activePrompt, TOOLS);
          text = next.text;
          toolCalls = next.toolCalls ?? [];
        }
        if (toolCalls.length > 0) {
          console.warn(`[Nina] Tool loop hit max rounds (${MAX_TOOL_ROUNDS}), returning last text`);
        }
        if (!text) throw new Error('Empty response from Gemini');
        console.log(`[Nina] Response (${text.length} chars): ${text.substring(0, 100)}`);
        // Insere na send_queue com scheduled_at = agora
        await supabase.from('send_queue').insert({
          conversation_id: item.conversation_id,
          contact_id: item.contact_id,
          content: text,
          scheduled_at: new Date().toISOString(),
          status: 'pending'
        });
        // Dispara o sender imediatamente
        supabase.functions.invoke('whatsapp-sender', {
          body: {}
        }).catch((e)=>{
          console.warn('[Nina] Failed to invoke sender:', e.message);
        });
        // Notifica operacional se OS não encontrada
        const osNotFound = text.toLowerCase().includes('não encontr') || text.toLowerCase().includes('nao encontr');
        const askedAboutOS = messageContent.match(/OS[-\s]?\d/i);
        if (!isAdmin && osNotFound && askedAboutOS) {
          const alertMsg = `⚠️ *Operacional Vectra*\n\nCliente *${contact?.name ?? 'Desconhecido'}* (${contact?.phone_number}) perguntou sobre OS não encontrada:\n\n"${messageContent}"\n\nVerifique e retorne ao cliente.`;
          await supabase.from('send_queue').insert({
            conversation_id: item.conversation_id,
            contact_id: item.contact_id,
            content: `__NOTIFY__${OPERACIONAL_PHONE}__${alertMsg}`,
            scheduled_at: new Date(Date.now() + 3000).toISOString(),
            status: 'pending'
          });
        }
        // Marca como concluído
        await supabase.from('nina_processing_queue').update({
          status: 'completed',
          processed_at: new Date().toISOString()
        }).eq('id', item.id);
        processed++;
        console.log(`[Nina] Processed ${processed}/${batch.length}`);
      } catch (err) {
        console.error(`[Nina] Error ${item.id}: ${err.message}`);
        await supabase.from('nina_processing_queue').update({
          status: 'failed',
          error_message: err.message
        }).eq('id', item.id);
      }
    }
    return new Response(JSON.stringify({
      processed
    }), {
      status: 200
    });
  } catch (err) {
    console.error('[Nina] Fatal:', err.message);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500
    });
  }
});
