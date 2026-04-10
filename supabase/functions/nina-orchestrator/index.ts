import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callAI } from './_shared/ai.ts';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
const cfnUrl = Deno.env.get('CFN_SUPABASE_URL');
const cfnKey = Deno.env.get('CFN_SUPABASE_SERVICE_KEY');
const OPERACIONAL_PHONE = '5547927010075';
const ADMIN_PHONE = '5521975602969';
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
// --- Distance estimation helpers ---
function extractUF(location: string): string {
  // Try explicit UF abbreviation first (e.g. "Eusébio, CE" or "SP")
  const m = location.match(/\b([A-Z]{2})\b/);
  if (m) return m[1];
  const lc = location.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cityMap: Record<string, string> = {
    'sao paulo': 'SP', 'campinas': 'SP', 'santos': 'SP', 'sorocaba': 'SP',
    'rio de janeiro': 'RJ', 'niteroi': 'RJ',
    'belo horizonte': 'MG', 'uberlandia': 'MG', 'contagem': 'MG',
    'salvador': 'BA', 'lauro de freitas': 'BA', 'camacari': 'BA', 'feira de santana': 'BA',
    'fortaleza': 'CE', 'eusebio': 'CE', 'caucaia': 'CE', 'juazeiro do norte': 'CE',
    'recife': 'PE', 'caruaru': 'PE', 'olinda': 'PE',
    'natal': 'RN', 'mossoro': 'RN',
    'joao pessoa': 'PB', 'campina grande': 'PB',
    'teresina': 'PI', 'parnaiba': 'PI',
    'sao luis': 'MA', 'imperatriz': 'MA',
    'curitiba': 'PR', 'londrina': 'PR', 'maringa': 'PR',
    'florianopolis': 'SC', 'joinville': 'SC', 'blumenau': 'SC',
    'porto alegre': 'RS', 'caxias do sul': 'RS', 'pelotas': 'RS',
    'goiania': 'GO', 'anapolis': 'GO',
    'brasilia': 'DF',
    'manaus': 'AM',
    'belem': 'PA', 'santarem': 'PA',
    'maceio': 'AL', 'arapiraca': 'AL',
    'aracaju': 'SE',
    'cuiaba': 'MT', 'rondonopolis': 'MT',
    'campo grande': 'MS', 'dourados': 'MS',
    'porto velho': 'RO',
    'macapa': 'AP',
    'boa vista': 'RR',
    'palmas': 'TO',
    'rio branco': 'AC',
    'vitoria': 'ES', 'vila velha': 'ES',
  };
  for (const [city, uf] of Object.entries(cityMap)) {
    if (lc.includes(city)) return uf;
  }
  return 'SP';
}

function estimateDistance(originUF: string, destUF: string): number {
  if (originUF === destUF) return 350;
  const key = (a: string, b: string) => [a, b].sort().join('-');
  const dist: Record<string, number> = {
    'CE-BA': 1150, 'CE-PE': 540, 'CE-RN': 290, 'CE-PB': 490, 'CE-PI': 350, 'CE-MA': 810,
    'CE-AL': 740, 'CE-SE': 990, 'CE-GO': 2200, 'CE-DF': 2300, 'CE-SP': 2800, 'CE-RJ': 3000,
    'CE-MG': 2600, 'CE-PR': 3100, 'CE-SC': 3400, 'CE-RS': 3800, 'CE-ES': 2700, 'CE-MS': 2500,
    'BA-SP': 1950, 'BA-RJ': 1650, 'BA-MG': 1350, 'BA-GO': 1400, 'BA-DF': 1420,
    'BA-SE': 350, 'BA-AL': 550, 'BA-PE': 800, 'BA-PR': 2300, 'BA-SC': 2700, 'BA-RS': 3100,
    'BA-PI': 1000, 'BA-MA': 1300, 'BA-ES': 900, 'BA-MS': 1800,
    'SP-RJ': 430, 'SP-MG': 580, 'SP-PR': 410, 'SP-SC': 690, 'SP-RS': 1100,
    'SP-GO': 900, 'SP-DF': 1000, 'SP-MS': 1000, 'SP-MT': 1500, 'SP-ES': 900,
    'RJ-MG': 440, 'RJ-PR': 850, 'RJ-SC': 1130, 'RJ-RS': 1540, 'RJ-ES': 520, 'RJ-GO': 1150,
    'MG-GO': 740, 'MG-DF': 750, 'MG-PR': 990, 'MG-ES': 510, 'MG-MS': 1200,
    'PR-SC': 280, 'PR-RS': 680, 'SC-RS': 380,
    'GO-DF': 210, 'GO-MT': 900, 'GO-MS': 850, 'GO-TO': 720,
    'PE-AL': 280, 'PE-PB': 120, 'PE-SE': 530, 'PE-RN': 290, 'PE-MA': 1200,
    'AL-SE': 280, 'PB-RN': 180, 'MA-PI': 450, 'MA-PA': 800, 'PI-BA': 1000,
    'PA-AM': 1300, 'PA-TO': 900, 'TO-GO': 720, 'TO-BA': 1200,
    'MT-GO': 900, 'MT-RO': 1200, 'MT-MS': 1000, 'MS-PR': 600,
    'ES-RJ': 520, 'ES-MG': 510, 'ES-BA': 900, 'DF-MG': 750,
  };
  return dist[key(originUF, destUF)] ?? 1500;
}

function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

async function buscarCotacao({ origin, destination, weight_kg, cargo_value, pallet_count, pallet_l, pallet_w, pallet_h }: {
  origin: string;
  destination: string;
  weight_kg: number;
  cargo_value: number;
  pallet_count?: number;
  pallet_l?: number;
  pallet_w?: number;
  pallet_h?: number;
}) {
  try {
    const cfn = createClient(cfnUrl, cfnKey);

    // 1. Calcular peso taxado (cubagem 300 kg/m³)
    let taxable_kg = weight_kg;
    if (pallet_count && pallet_l && pallet_w && pallet_h) {
      const cubic_kg = pallet_count * pallet_l * pallet_w * pallet_h * 300;
      taxable_kg = Math.max(weight_kg, cubic_kg);
    }

    // 2. Estimar distância
    const originUF = extractUF(origin);
    const destUF = extractUF(destination);
    const distancia_km = estimateDistance(originUF, destUF);

    // 3. Buscar tabela de preços ativa
    const { data: priceTable, error: ptError } = await cfn
      .from('price_tables')
      .select('id, name, modality')
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    if (ptError) throw new Error(`Tabela de preços: ${ptError.message}`);
    if (!priceTable) return JSON.stringify({ found: false, error: 'Nenhuma tabela de preços ativa. Entre em contato com o time comercial.' });

    // 4. Buscar faixa de km (km_from/km_to são os nomes reais das colunas)
    const { data: priceRow, error: prError } = await cfn
      .from('price_table_rows')
      .select('*')
      .eq('price_table_id', priceTable.id)
      .lte('km_from', distancia_km)
      .gte('km_to', distancia_km)
      .limit(1)
      .maybeSingle();

    let row = priceRow;
    if (prError || !row) {
      // Fallback: faixa mais próxima
      const { data: nearest } = await cfn
        .from('price_table_rows')
        .select('*')
        .eq('price_table_id', priceTable.id)
        .order('km_to', { ascending: false })
        .limit(1)
        .maybeSingle();
      row = nearest;
    }
    if (!row) return JSON.stringify({ found: false, error: 'Distância fora das faixas da tabela de preços. Entre em contato com o time comercial.' });

    // 5. Buscar regras de precificação (Lucro Presumido)
    const { data: rulesData } = await cfn
      .from('pricing_rules_config')
      .select('markup_percent, overhead_percent, pis_percent, cofins_percent, irpj_effective_percent, csll_effective_percent')
      .limit(1)
      .maybeSingle();
    const markup_pct = Number(rulesData?.markup_percent ?? 20);
    const overhead_pct = Number(rulesData?.overhead_percent ?? 4);
    const pis_pct = Number(rulesData?.pis_percent ?? 0.65);
    const cofins_pct = Number(rulesData?.cofins_percent ?? 3.0);
    const irpj_pct = Number(rulesData?.irpj_effective_percent ?? 1.20);
    const csll_pct = Number(rulesData?.csll_effective_percent ?? 1.08);

    // 6. Calcular componentes do frete
    const cost_per_kg = Number(row.cost_per_kg ?? 0);
    const ad_valorem_pct = Number(row.ad_valorem_percent ?? 0);
    const gris_pct = Number(row.gris_percent ?? 0);
    const toll_pct = Number(row.toll_percent ?? 0);

    const frete_base = taxable_kg * cost_per_kg;
    const ad_valorem = cargo_value * (ad_valorem_pct / 100);
    const gris = cargo_value * (gris_pct / 100);
    const pedagio = frete_base * (toll_pct / 100);

    const subtotal_custo = frete_base + ad_valorem + gris + pedagio;
    const com_overhead = subtotal_custo * (1 + overhead_pct / 100);
    const com_markup = com_overhead * (1 + markup_pct / 100);

    // 7. Gross-up Lucro Presumido (embute PIS+COFINS+IRPJ+CSLL no preço)
    const total_tax_rate = (pis_pct + cofins_pct + irpj_pct + csll_pct) / 100;
    const valor_final = com_markup / (1 - total_tax_rate);

    const impostos = valor_final - com_markup;

    // 8. Validade: 3 dias úteis
    const validadeDate = addBusinessDays(new Date(), 3);
    const validadeStr = validadeDate.toLocaleDateString('pt-BR');

    const r = (n: number) => Math.round(n * 100) / 100;

    return JSON.stringify({
      found: true,
      valor_frete: r(valor_final),
      peso_taxado_kg: Math.round(taxable_kg * 10) / 10,
      peso_original_kg: weight_kg,
      distancia_km_estimada: distancia_km,
      origem_uf: originUF,
      destino_uf: destUF,
      tabela_usada: priceTable.name,
      validade: validadeStr,
      breakdown: {
        frete_base: r(frete_base),
        ad_valorem: r(ad_valorem),
        gris: r(gris),
        pedagio: r(pedagio),
        overhead: r(com_overhead - subtotal_custo),
        impostos_lp: r(impostos),
      },
      aviso: `Estimativa sujeita a confirmação do time comercial. Válida até ${validadeStr}.`,
    });
  } catch (err: unknown) {
    return JSON.stringify({ found: false, error: (err as Error).message });
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
      },
      {
        name: 'buscar_cotacao',
        description: 'Calcula estimativa de frete com base nos dados da carga. Use quando o cliente fornecer origem, destino, peso e valor da mercadoria. Retorna valor total, peso taxado e validade.',
        parameters: {
          type: 'OBJECT',
          properties: {
            origin: { type: 'STRING', description: 'Cidade e UF de origem, ex: "Eusébio, CE" ou "CE"' },
            destination: { type: 'STRING', description: 'Cidade e UF de destino, ex: "Lauro de Freitas, BA" ou "BA"' },
            weight_kg: { type: 'NUMBER', description: 'Peso total da carga em kg' },
            cargo_value: { type: 'NUMBER', description: 'Valor declarado da mercadoria em R$' },
            pallet_count: { type: 'NUMBER', description: 'Número de paletes (opcional)' },
            pallet_l: { type: 'NUMBER', description: 'Comprimento do palete em metros (opcional)' },
            pallet_w: { type: 'NUMBER', description: 'Largura do palete em metros (opcional)' },
            pallet_h: { type: 'NUMBER', description: 'Altura do palete em metros (opcional)' },
          },
          required: ['origin', 'destination', 'weight_kg', 'cargo_value']
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
- Para calcular frete, use buscar_cotacao assim que o cliente fornecer: origem, destino, peso (kg) e valor da mercadoria (R$). Não peça confirmação antes de chamar a tool — execute imediatamente.
- Ao retornar resultado de buscar_cotacao: apresente o valor total em R$, peso taxado (se diferente do peso original), prazo de validade (3 dias úteis), e inclua a nota "Estimativa sujeita a confirmação do time comercial".
- Se buscar_cotacao retornar found=false ou erro: informe que o time comercial entrará em contato com o valor em breve.
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
            if (tc.name === 'buscar_cotacao') {
              result = await buscarCotacao({
                origin: String(args?.origin ?? ''),
                destination: String(args?.destination ?? ''),
                weight_kg: Number(args?.weight_kg ?? 0),
                cargo_value: Number(args?.cargo_value ?? 0),
                pallet_count: args?.pallet_count ? Number(args.pallet_count) : undefined,
                pallet_l: args?.pallet_l ? Number(args.pallet_l) : undefined,
                pallet_w: args?.pallet_w ? Number(args.pallet_w) : undefined,
                pallet_h: args?.pallet_h ? Number(args.pallet_h) : undefined,
              });
              console.log(`[Nina] buscar_cotacao(${args?.origin}→${args?.destination}): ${result.substring(0, 200)}`);

              // Se a cotação falhou, notifica admin automaticamente com todos os dados
              try {
                const parsed = JSON.parse(result);
                if (!parsed.found) {
                  const { data: contactInfo } = await supabase
                    .from('contacts')
                    .select('name, phone_number')
                    .eq('id', item.contact_id)
                    .maybeSingle();
                  const alertMsg =
                    `🚨 *Falha na Cotação Automática — NAVI*\n\n` +
                    `Cliente: *${contactInfo?.name ?? 'Desconhecido'}* (${contactInfo?.phone_number})\n\n` +
                    `Dados da carga:\n` +
                    `• Origem: ${args?.origin ?? '-'}\n` +
                    `• Destino: ${args?.destination ?? '-'}\n` +
                    `• Peso: ${args?.weight_kg ?? '-'} kg\n` +
                    `• Valor mercadoria: R$ ${args?.cargo_value ?? '-'}\n\n` +
                    `Erro retornado: _${parsed.error ?? 'desconhecido'}_\n\n` +
                    `⚡ Ação necessária: verificar tabela de preços no CFN (projeto epgedaiukjippepujuzc) e retornar a cotação ao cliente via WhatsApp.`;

                  await supabase.from('send_queue').insert({
                    conversation_id: item.conversation_id,
                    contact_id: item.contact_id,
                    content: `__NOTIFY__${ADMIN_PHONE}__${alertMsg}`,
                    scheduled_at: new Date(Date.now() + 2000).toISOString(),
                    status: 'pending',
                  });
                  console.log(`[Nina] buscar_cotacao falhou — admin ${ADMIN_PHONE} notificado`);
                }
              } catch (_) { /* ignore parse error */ }
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
