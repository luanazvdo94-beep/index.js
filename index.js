console.log('🔥 BACKEND NUMON ESTÁVEL + KANBAN AUTOMÁTICO + BUSCA INTELIGENTE POR TELEFONE');

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ========================
// CORS
// ========================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// ========================
// ENV
// ========================
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const BACKEND_API_KEY = process.env.BACKEND_API_KEY || '';

const conversationState = {};

// ========================
// CONSTANTES DO FUNIL
// ========================
const STAGE_NEW_LEAD = 'Novo lead';
const STAGE_IN_ATTENDANCE = 'Em atendimento';
const STAGE_IN_PROPOSAL = 'Em proposta';

const STATUS_NEW_LEAD = 'Novo lead';
const STATUS_IN_ATTENDANCE = 'Em atendimento';
const STATUS_IN_PROPOSAL = 'Em proposta';

// ========================
// UTILS
// ========================
function getSupabaseHeaders(prefer = null) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  return headers;
}

function assertEnv() {
  const missing = [];

  if (!ZAPI_INSTANCE) missing.push('ZAPI_INSTANCE');
  if (!ZAPI_TOKEN) missing.push('ZAPI_TOKEN');
  if (!ZAPI_CLIENT_TOKEN) missing.push('ZAPI_CLIENT_TOKEN');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    console.warn('⚠️ Variáveis de ambiente ausentes:', missing.join(', '));
  }
}

assertEnv();

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeCpf(value) {
  const digits = onlyDigits(value);
  return digits.length === 11 ? digits : '';
}

function normalizeCnpj(value) {
  const digits = onlyDigits(value);
  return digits.length === 14 ? digits : '';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function safeString(value) {
  return String(value || '').trim();
}

function compactText(value) {
  return safeString(value).replace(/\s+/g, ' ');
}

function buildPhoneVariants(phone) {
  const normalized = normalizePhone(phone);
  const variants = new Set();

  if (!normalized) return [];

  variants.add(normalized);

  if (normalized.startsWith('55') && normalized.length > 11) {
    variants.add(normalized.slice(2));
  }

  if (!normalized.startsWith('55')) {
    variants.add(`55${normalized}`);
  }

  if (normalized.length >= 11) {
    variants.add(normalized.slice(-11));
  }

  if (normalized.length >= 10) {
    variants.add(normalized.slice(-10));
  }

  const without55 = normalized.startsWith('55') ? normalized.slice(2) : normalized;

  if (without55.length >= 11) {
    variants.add(without55.slice(-11));
  }

  if (without55.length >= 10) {
    variants.add(without55.slice(-10));
  }

  return Array.from(variants).filter(Boolean);
}

function extractNameAndCpf(textMessage) {
  const text = compactText(textMessage);
  const cpf = normalizeCpf(text);
  let nome = text;

  if (cpf) {
    nome = text.replace(/(\d{3}\D?\d{3}\D?\d{3}\D?\d{2})/g, '').trim();
  }

  nome = nome
    .replace(/cpf/gi, '')
    .replace(/nome/gi, '')
    .replace(/[:\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    nome: nome || null,
    cpf: cpf || null,
  };
}

function isHotLead(lead) {
  if (!lead) return false;

  const etapa = String(lead.etapa || '').trim().toLowerCase();
  const allowedStages = ['em atendimento', 'em proposta'];

  return allowedStages.includes(etapa);
}

function renderTemplate(templateText, variables = {}) {
  let output = templateText || '';

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    output = output.replace(regex, value ?? '');
  });

  return output;
}

function mapButtonsForZApi(buttons = []) {
  if (!Array.isArray(buttons)) return [];

  return buttons.map((button) => ({
    id: String(button.id),
    label: String(button.text || button.label || ''),
  }));
}

function getWebhookText(data) {
  return (
    data?.text?.message ||
    data?.textMessage?.message ||
    data?.message ||
    data?.body ||
    data?.buttonsResponseMessage?.message ||
    data?.buttonsResponseMessage?.buttonText ||
    ''
  );
}

function getWebhookButtonId(data) {
  return (
    data?.buttonsResponseMessage?.buttonId ||
    data?.buttonReply?.id ||
    data?.listResponseMessage?.selectedRowId ||
    data?.selectedButtonId ||
    null
  );
}

function toSupabaseInList(values) {
  return `(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(',')})`;
}

// ========================
// SUPABASE - BASE
// ========================
async function supabaseGet(path) {
  const response = await axios.get(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: getSupabaseHeaders(),
  });

  return response.data;
}

async function supabasePost(path, payload, prefer = 'return=representation') {
  const response = await axios.post(`${SUPABASE_URL}/rest/v1/${path}`, payload, {
    headers: getSupabaseHeaders(prefer),
  });

  return response.data;
}

async function supabasePatch(path, payload, prefer = 'return=representation') {
  const response = await axios.patch(`${SUPABASE_URL}/rest/v1/${path}`, payload, {
    headers: getSupabaseHeaders(prefer),
  });

  return response.data;
}

async function safeSupabasePost(path, payload, label) {
  try {
    return await supabasePost(path, payload, 'return=minimal');
  } catch (error) {
    console.warn(`⚠️ Falha ignorada em ${label}:`, error.response?.data || error.message);
    return null;
  }
}

// ========================
// SUPABASE - TEMPLATES
// ========================
async function getTemplateByKey(key) {
  try {
    console.log('🔍 Buscando template:', key);

    const url = `whatsapp_templates?key=eq.${encodeURIComponent(
      key
    )}&is_active=eq.true&select=*`;

    const rows = await supabaseGet(url);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('⚠️ Template não encontrado:', key);
      return null;
    }

    return rows[0];
  } catch (error) {
    console.error('❌ Erro ao buscar template:', error.response?.data || error.message);
    return null;
  }
}

// ========================
// SUPABASE - LEADS / HISTÓRICO
// ========================
async function getLeadById(leadId) {
  if (!leadId || !isUuid(leadId)) return null;

  const rows = await supabaseGet(
    `leads?id=eq.${encodeURIComponent(leadId)}&select=*&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getLeadByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) return null;

  const variants = buildPhoneVariants(normalizedPhone);

  console.log('🔎 Buscando lead por telefone. Variantes:', variants);

  try {
    const exactRows = await supabaseGet(
      `leads?telefone=in.${toSupabaseInList(variants)}&select=*&order=created_at.desc&limit=10`
    );

    if (Array.isArray(exactRows) && exactRows.length > 0) {
      console.log('✅ Lead encontrado por telefone exato:', exactRows[0].id);
      return exactRows[0];
    }
  } catch (error) {
    console.warn('⚠️ Busca exata por telefone falhou:', error.response?.data || error.message);
  }

  for (const variant of variants.sort((a, b) => b.length - a.length)) {
    if (variant.length < 10) continue;

    try {
      const rows = await supabaseGet(
        `leads?telefone=ilike.*${encodeURIComponent(
          variant
        )}&select=*&order=created_at.desc&limit=10`
      );

      if (Array.isArray(rows) && rows.length > 0) {
        console.log('✅ Lead encontrado por final de telefone:', rows[0].id, variant);
        return rows[0];
      }
    } catch (error) {
      console.warn(
        '⚠️ Busca por final de telefone falhou:',
        variant,
        error.response?.data || error.message
      );
    }
  }

  console.log('ℹ️ Nenhum lead encontrado para telefone:', normalizedPhone);
  return null;
}

async function getLeadMessages(leadId, limit = 12) {
  if (!leadId) return [];

  const rows = await supabaseGet(
    `lead_messages?lead_id=eq.${encodeURIComponent(
      leadId
    )}&select=direction,message_text,created_at&order=created_at.desc&limit=${limit}`
  );

  return Array.isArray(rows) ? rows.reverse() : [];
}

async function saveLeadMessage({ leadId, direction, messageText }) {
  if (!leadId || !messageText) return;

  await safeSupabasePost(
    'lead_messages',
    {
      lead_id: leadId,
      direction,
      message_text: messageText,
    },
    'lead_messages'
  );
}

async function updateLeadById(leadId, payload) {
  if (!leadId || !isUuid(leadId)) return null;

  const cleanPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );

  if (Object.keys(cleanPayload).length === 0) return null;

  const rows = await supabasePatch(
    `leads?id=eq.${encodeURIComponent(leadId)}`,
    cleanPayload,
    'return=representation'
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateLeadMessageInfo(leadId, messageText) {
  if (!isUuid(leadId)) {
    console.log('ℹ️ leadId não é UUID válido. Pulando update em leads:', leadId);
    return null;
  }

  const now = new Date().toISOString();

  await updateLeadById(leadId, {
    last_message_sent_at: now,
    last_message_sent_text: messageText,
  });

  return now;
}

async function recordTriageAnswer({ leadId, phone, questionKey, answerValue, rawPayload = null }) {
  if (!leadId) return null;

  return safeSupabasePost(
    'lead_triage_answers',
    {
      lead_id: leadId,
      phone: normalizePhone(phone),
      question_key: questionKey,
      answer_value: String(answerValue ?? ''),
      raw_payload: rawPayload,
      created_at: new Date().toISOString(),
    },
    'lead_triage_answers'
  );
}

async function markClientInteractionByPhone(phone, messageText = '') {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) return null;

  const lead = await getLeadByPhone(normalizedPhone);

  if (!lead) {
    console.log('ℹ️ Nenhum lead encontrado para interação:', normalizedPhone);
    return null;
  }

  await updateLeadById(lead.id, {
    last_client_interaction_at: new Date().toISOString(),
  });

  if (messageText) {
    await saveLeadMessage({
      leadId: lead.id,
      direction: 'in',
      messageText,
    });
  }

  console.log('📩 Cliente respondeu → histórico salvo e follow-up bloqueado:', normalizedPhone);

  return lead;
}

async function updateLeadKanbanFromWhatsapp({
  phone,
  updates,
  messageText,
  questionKey,
  answerValue,
  rawPayload,
}) {
  const normalizedPhone = normalizePhone(phone);
  const lead = await getLeadByPhone(normalizedPhone);

  if (!lead) {
    console.log('ℹ️ Kanban não atualizado. Lead não encontrado:', normalizedPhone);
    return null;
  }

  const updatedLead = await updateLeadById(lead.id, {
    ...updates,
    is_archived: false,
    last_client_interaction_at: new Date().toISOString(),
  });

  if (messageText) {
    await saveLeadMessage({
      leadId: lead.id,
      direction: 'in',
      messageText,
    });
  }

  if (questionKey) {
    await recordTriageAnswer({
      leadId: lead.id,
      phone: normalizedPhone,
      questionKey,
      answerValue,
      rawPayload,
    });
  }

  console.log('✅ Kanban atualizado via WhatsApp:', {
    leadId: lead.id,
    from: lead.etapa,
    to: updates.etapa,
    status: updates.status,
  });

  return updatedLead || lead;
}

// ========================
// SUPABASE - LOGS
// ========================
async function createAutomationLog({
  userId,
  leadId,
  fromStage,
  toStage,
  phone,
  leadName,
  messageText,
  status,
  errorMessage,
}) {
  await safeSupabasePost(
    'funnel_automation_logs',
    {
      user_id: userId,
      lead_id: leadId,
      from_stage: fromStage,
      to_stage: toStage,
      phone: normalizePhone(phone),
      lead_name: leadName,
      message_text: messageText || null,
      status,
      error_message: errorMessage || null,
    },
    'funnel_automation_logs'
  );
}

// ========================
// Z-API
// ========================
async function sendText(phone, message, leadId = null) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw new Error('Telefone inválido');
  }

  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    {
      phone: normalizedPhone,
      message,
    },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );

  if (leadId) {
    await saveLeadMessage({
      leadId,
      direction: 'out',
      messageText: message,
    });
  }
}

async function sendButtonList(phone, message, buttons, leadId = null) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw new Error('Telefone inválido');
  }

  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-button-list`,
    {
      phone: normalizedPhone,
      message,
      buttonList: { buttons },
    },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );

  if (leadId) {
    await saveLeadMessage({
      leadId,
      direction: 'out',
      messageText: message,
    });
  }
}

async function sendTemplateMessage({ leadId, phone, templateKey, nome, empresa }) {
  if (!leadId || !phone || !templateKey) {
    throw new Error('Campos obrigatórios faltando');
  }

  const normalizedPhone = normalizePhone(phone);
  const template = await getTemplateByKey(templateKey);

  if (!template) {
    throw new Error('Template não encontrado');
  }

  const message = renderTemplate(template.message_text, {
    nome,
    empresa,
  });

  const buttons = mapButtonsForZApi(template.buttons || []);

  if (buttons.length > 0) {
    await sendButtonList(normalizedPhone, message, buttons, leadId);
  } else {
    await sendText(normalizedPhone, message, leadId);
  }

  await updateLeadMessageInfo(leadId, message);

  return {
    success: true,
    message,
    templateSource: 'supabase',
  };
}

async function sendTemplateFlow(phone, templateKey) {
  const normalizedPhone = normalizePhone(phone);
  const template = await getTemplateByKey(templateKey);

  if (!template) {
    return false;
  }

  const message = renderTemplate(template.message_text, {});
  const buttons = mapButtonsForZApi(template.buttons || []);
  const lead = await getLeadByPhone(normalizedPhone);
  const leadId = lead?.id || null;

  if (buttons.length > 0) {
    await sendButtonList(normalizedPhone, message, buttons, leadId);
  } else {
    await sendText(normalizedPhone, message, leadId);
  }

  console.log('✅ Fluxo via template:', templateKey);
  return true;
}

// ========================
// EMPRESAS / BRASILAPI / PRÉ-SIMULAÇÃO
// ========================
async function getCompanyProfileByCnpj(cnpj) {
  const cleanCnpj = normalizeCnpj(cnpj);

  if (!cleanCnpj) return null;

  try {
    const rows = await supabaseGet(
      `company_profiles?cnpj=eq.${encodeURIComponent(cleanCnpj)}&select=*&limit=1`
    );

    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.warn('⚠️ Erro ao buscar company_profiles:', error.response?.data || error.message);
    return null;
  }
}

async function getCompanyFromBrasilApi(cnpj) {
  const cleanCnpj = normalizeCnpj(cnpj);

  if (!cleanCnpj) return null;

  try {
    const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`, {
      timeout: 12000,
    });

    return response.data || null;
  } catch (error) {
    console.warn('⚠️ BrasilAPI não retornou CNPJ:', cleanCnpj, error.response?.data || error.message);
    return null;
  }
}

async function upsertCompanyCacheFromBrasilApi(company) {
  if (!company?.cnpj) return null;

  const cnpj = normalizeCnpj(company.cnpj);
  const razaoSocial = company.razao_social || company.nome_fantasia || null;
  const nomeFantasia = company.nome_fantasia || null;

  await safeSupabasePost(
    'company_profiles',
    {
      cnpj,
      razao_social: razaoSocial,
      nome_fantasia: nomeFantasia,
      situacao_cadastral: company.descricao_situacao_cadastral || company.situacao_cadastral || null,
      cnae_fiscal: company.cnae_fiscal || null,
      cnae_fiscal_descricao: company.cnae_fiscal_descricao || null,
      municipio: company.municipio || null,
      uf: company.uf || null,
      raw_data: company,
    },
    'company_profiles upsert'
  );

  await safeSupabasePost(
    'company_search_index',
    {
      cnpj,
      razao_social: razaoSocial,
      nome_fantasia: nomeFantasia,
      search_text: `${razaoSocial || ''} ${nomeFantasia || ''} ${cnpj}`.trim(),
    },
    'company_search_index upsert'
  );

  return true;
}

app.get('/company-search', async (req, res) => {
  try {
    const query = compactText(req.query.q || req.query.query || '');

    if (query.length < 2) {
      return res.json({
        success: true,
        rows: [],
      });
    }

    const rows = await supabaseGet(
      `company_search_index?or=(razao_social.ilike.*${encodeURIComponent(
        query
      )}*,nome_fantasia.ilike.*${encodeURIComponent(query)}*,cnpj.ilike.*${encodeURIComponent(
        onlyDigits(query)
      )}*)&select=*&limit=20`
    );

    return res.json({
      success: true,
      rows: Array.isArray(rows) ? rows : [],
    });
  } catch (error) {
    console.error('❌ ERRO EM /company-search:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno na busca de empresa',
    });
  }
});

app.get('/company/:cnpj', async (req, res) => {
  try {
    const cnpj = normalizeCnpj(req.params.cnpj);

    if (!cnpj) {
      return res.status(400).json({
        success: false,
        error: 'CNPJ inválido',
      });
    }

    let company = await getCompanyProfileByCnpj(cnpj);
    let source = 'supabase';

    if (!company) {
      company = await getCompanyFromBrasilApi(cnpj);
      source = 'brasilapi';

      if (company) {
        await upsertCompanyCacheFromBrasilApi(company);
      }
    }

    if (!company) {
      return res.status(404).json({
        success: false,
        error: 'Empresa não encontrada',
      });
    }

    return res.json({
      success: true,
      source,
      company,
    });
  } catch (error) {
    console.error('❌ ERRO EM /company/:cnpj:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao consultar empresa',
    });
  }
});

app.get('/lead-presimulation/:leadId', async (req, res) => {
  try {
    const leadId = req.params.leadId;

    if (!isUuid(leadId)) {
      return res.status(400).json({
        success: false,
        error: 'leadId inválido',
      });
    }

    const lead = await getLeadById(leadId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado',
      });
    }

    const cnpj = normalizeCnpj(lead.clt_company_cnpj || lead.cnpj || '');
    let company = null;
    let companySource = null;

    if (cnpj) {
      company = await getCompanyProfileByCnpj(cnpj);
      companySource = company ? 'supabase' : null;

      if (!company) {
        company = await getCompanyFromBrasilApi(cnpj);
        companySource = company ? 'brasilapi' : null;

        if (company) {
          await upsertCompanyCacheFromBrasilApi(company);
        }
      }
    }

    const presimulation = {
      lead_id: lead.id,
      nome: lead.nome || '',
      cpf: lead.cpf || '',
      telefone: lead.telefone || '',
      idade: lead.clt_age ?? lead.idade ?? null,
      isWorking: lead.clt_is_working ?? null,
      employmentMonths: lead.clt_employment_months ?? null,
      hasActiveLoan: lead.clt_has_active_loan ?? null,
      companyName:
        lead.clt_company_name ||
        lead.empresa ||
        company?.razao_social ||
        company?.nome_fantasia ||
        company?.nome ||
        '',
      companyCnpj: cnpj || '',
      readyForPresimulation: Boolean(lead.clt_ready_for_presimulation),
      triageCompletedAt: lead.clt_triage_completed_at || null,
    };

    return res.json({
      success: true,
      lead,
      company,
      companySource,
      presimulation,
      data: presimulation,
    });
  } catch (error) {
    console.error('❌ ERRO EM /lead-presimulation/:leadId:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno na pré-simulação do lead',
    });
  }
});

// ========================
// IA - GERAÇÃO DE RESPOSTA
// ========================
function buildAiInstructions() {
  return `
Você é um assistente interno da NumON Promotora para sugerir respostas de WhatsApp.

Função:
- Gerar SOMENTE uma sugestão de resposta para o atendente humano copiar/enviar.
- Não envie mensagem automaticamente.
- Não finja que consultou sistemas que não foram informados.
- Não invente valor aprovado, taxa, banco, prazo, parcela ou status de proposta.
- Nunca prometa aprovação.
- Nunca use linguagem robótica.
- Seja natural, curto, comercial e confiável.
- Responda como um consultor de crédito experiente no Brasil.
- Sempre conduza para a próxima ação objetiva.

Regras de qualidade:
- Máximo de 3 parágrafos curtos.
- Evite "Prezado", "agradecemos o contato", "estamos à disposição" de forma genérica.
- Use o nome do cliente se estiver disponível.
- Se faltar informação, peça apenas uma confirmação objetiva.
- Se o cliente estiver inseguro, reforce segurança e clareza.
- Se o cliente perguntar taxa/valor/parcela e não houver dados no contexto, diga que vai conferir/simular antes de passar condição.
- Se o cliente pedir cancelamento ou não tiver interesse, responda com respeito e deixe porta aberta.
- Se houver risco jurídico/financeiro, seja conservador.

A resposta deve conter apenas o texto sugerido para WhatsApp.
`.trim();
}

function formatMessagesForPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Sem histórico salvo.';
  }

  return messages
    .map((message) => {
      const who = message.direction === 'in' ? 'Cliente' : 'NumON';
      return `${who}: ${message.message_text || ''}`;
    })
    .join('\n');
}

async function generateAiReply({ lead, latestMessage }) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Railway');
  }

  const messages = await getLeadMessages(lead.id, 12);
  const historyText = formatMessagesForPrompt(messages);

  const input = `
DADOS DO LEAD:
Nome: ${lead.nome || 'Não informado'}
Telefone: ${lead.telefone || 'Não informado'}
Empresa: ${lead.empresa || lead.clt_company_name || 'Não informada'}
Produto: ${lead.produto || 'Não informado'}
Etapa do funil: ${lead.etapa || 'Não informada'}
Status: ${lead.status || 'Não informado'}
Origem: ${lead.origem || 'Não informada'}
Observações internas: ${lead.observacoes || 'Sem observações'}

HISTÓRICO RECENTE:
${historyText}

ÚLTIMA MENSAGEM DO CLIENTE:
${latestMessage || 'Não informada'}

TAREFA:
Gere uma resposta de WhatsApp com contexto, sem inventar informação, conduzindo para a próxima ação.
`.trim();

  const response = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: OPENAI_MODEL,
      instructions: buildAiInstructions(),
      input,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const suggestion =
    response.data?.output_text ||
    response.data?.output?.[0]?.content?.[0]?.text ||
    '';

  if (!suggestion) {
    throw new Error('IA não retornou sugestão válida');
  }

  return suggestion.trim();
}

// ========================
// HEALTH
// ========================
app.get('/', (req, res) => {
  res.send('Webhook online');
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'NumON Backend',
    status: 'online',
    timestamp: new Date().toISOString(),
  });
});

// ========================
// DISPARO USADO PELO CRM / ABA DE DISPARO / FUNIL
// ========================
app.post('/send-indication-message', async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const apiKey = req.headers['x-api-key'];

      if (apiKey !== BACKEND_API_KEY) {
        return res.status(401).json({
          success: false,
          error: 'Não autorizado',
        });
      }
    }

    const { leadId, phone, templateKey, nome, empresa } = req.body;

    const result = await sendTemplateMessage({
      leadId,
      phone,
      templateKey,
      nome,
      empresa,
    });

    return res.json(result);
  } catch (error) {
    console.error('❌ ERRO EM /send-indication-message:', error.response?.data || error.message);

    const statusCode = error.message === 'Template não encontrado' ? 400 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Erro interno no envio',
    });
  }
});

// ========================
// IA - ENDPOINT DE SUGESTÃO
// ========================
app.post('/generate-reply', async (req, res) => {
  try {
    const { leadId, phone, latestMessage } = req.body;

    let lead = null;

    if (leadId) {
      lead = await getLeadById(leadId);
    }

    if (!lead && phone) {
      lead = await getLeadByPhone(phone);
    }

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado',
      });
    }

    if (!isHotLead(lead)) {
      return res.status(200).json({
        success: false,
        blocked: true,
        reason: 'Lead não está em etapa qualificada para IA',
        currentStage: lead.etapa || null,
        allowedStages: ['Em atendimento', 'Em proposta'],
      });
    }

    const suggestion = await generateAiReply({
      lead,
      latestMessage,
    });

    return res.json({
      success: true,
      leadId: lead.id,
      stage: lead.etapa || null,
      suggestion,
    });
  } catch (error) {
    console.error('❌ ERRO EM /generate-reply:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao gerar resposta IA',
    });
  }
});

// ========================
// SEQUÊNCIA INTELIGENTE / FOLLOW-UP
// ========================
async function runFollowups() {
  console.log('🚀 Sequência inteligente rodando...');

  const result = {
    success: true,
    checkedSteps: 0,
    checkedLeads: 0,
    sent: 0,
    skipped: 0,
    skippedByResponse: 0,
    skippedByDelay: 0,
    skippedAlreadySent: 0,
    errors: [],
  };

  const steps = await supabaseGet(
    'funnel_followup_sequence_steps?is_active=eq.true&select=*&order=step_number.asc'
  );

  const sequenceSteps = Array.isArray(steps) ? steps : [];
  result.checkedSteps = sequenceSteps.length;

  for (const step of sequenceSteps) {
    const leads = await supabaseGet(
      `leads?etapa=eq.${encodeURIComponent(step.stage)}&user_id=eq.${encodeURIComponent(
        step.user_id
      )}&select=*`
    );

    const stageLeads = Array.isArray(leads) ? leads : [];
    result.checkedLeads += stageLeads.length;

    for (const lead of stageLeads) {
      const phone = normalizePhone(lead.telefone);

      try {
        if (!phone) {
          result.skipped += 1;

          await createAutomationLog({
            userId: step.user_id,
            leadId: lead.id,
            fromStage: step.stage,
            toStage: step.stage,
            phone,
            leadName: lead.nome,
            messageText: null,
            status: 'followup_skipped_no_phone',
            errorMessage: 'Lead sem telefone válido.',
          });

          continue;
        }

        if (lead.last_client_interaction_at) {
          result.skipped += 1;
          result.skippedByResponse += 1;

          await createAutomationLog({
            userId: step.user_id,
            leadId: lead.id,
            fromStage: step.stage,
            toStage: step.stage,
            phone,
            leadName: lead.nome,
            messageText: null,
            status: 'blocked_by_response',
            errorMessage: 'Cliente respondeu. Follow-up bloqueado.',
          });

          continue;
        }

        const sentLogs = await supabaseGet(
          `funnel_automation_logs?lead_id=eq.${encodeURIComponent(
            lead.id
          )}&status=eq.followup_sent&select=id,created_at,message_text&order=created_at.desc`
        );

        const previousLogs = Array.isArray(sentLogs) ? sentLogs : [];

        if (previousLogs.length >= Number(step.step_number || 1)) {
          result.skipped += 1;
          result.skippedAlreadySent += 1;
          continue;
        }

        const lastLog = previousLogs[0] || null;

        if (lastLog) {
          const diffMinutes =
            (Date.now() - new Date(lastLog.created_at).getTime()) / 60000;

          if (diffMinutes < Number(step.delay_minutes || 0)) {
            result.skipped += 1;
            result.skippedByDelay += 1;
            continue;
          }
        } else if (lead.last_message_sent_at) {
          const diffMinutes =
            (Date.now() - new Date(lead.last_message_sent_at).getTime()) / 60000;

          if (diffMinutes < Number(step.delay_minutes || 0)) {
            result.skipped += 1;
            result.skippedByDelay += 1;
            continue;
          }
        }

        const sentResult = await sendTemplateMessage({
          leadId: lead.id,
          phone,
          templateKey: step.template_key,
          nome: lead.nome,
          empresa: lead.empresa || lead.clt_company_name,
        });

        await createAutomationLog({
          userId: step.user_id,
          leadId: lead.id,
          fromStage: step.stage,
          toStage: step.stage,
          phone,
          leadName: lead.nome,
          messageText: sentResult.message,
          status: 'followup_sent',
          errorMessage: null,
        });

        result.sent += 1;
      } catch (error) {
        const errorMessage = error.response?.data || error.message || 'Erro desconhecido';

        result.errors.push({
          lead_id: lead.id,
          lead_name: lead.nome,
          error: errorMessage,
        });

        await createAutomationLog({
          userId: step.user_id,
          leadId: lead.id,
          fromStage: step.stage,
          toStage: step.stage,
          phone,
          leadName: lead.nome,
          messageText: null,
          status: 'followup_error',
          errorMessage:
            typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
        });
      }
    }
  }

  return result;
}

app.get('/run-followups', async (req, res) => {
  try {
    const result = await runFollowups();
    return res.json(result);
  } catch (error) {
    console.error('❌ ERRO EM /run-followups:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno no follow-up',
    });
  }
});

app.post('/run-followups', async (req, res) => {
  try {
    const result = await runFollowups();
    return res.json(result);
  } catch (error) {
    console.error('❌ ERRO EM /run-followups:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno no follow-up',
    });
  }
});

// ========================
// WEBHOOK Z-API
// ========================
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    const phone = normalizePhone(data.phone || data.from || data.sender);
    const buttonId = getWebhookButtonId(data);
    const textMessage = getWebhookText(data);

    if (!phone) {
      return res.sendStatus(200);
    }

    const inboundLabel = buttonId
      ? `[BOTÃO ${buttonId}] ${textMessage || ''}`.trim()
      : textMessage;

    await markClientInteractionByPhone(phone, inboundLabel);

    if (buttonId) {
      if (buttonId === '1') {
        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            etapa: STAGE_NEW_LEAD,
            status: STATUS_NEW_LEAD,
            clt_ready_for_presimulation: false,
          },
          messageText: null,
          questionKey: 'first_positive_interest',
          answerValue: 'sim',
          rawPayload: data,
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_1');

        if (!ok) {
          await sendButtonList(
            phone,
            'Perfeito. Para eu seguir com a análise, me confirma uma informação:\n\nVocê está trabalhando atualmente de carteira assinada?',
            [
              { id: '11', label: 'Sim, estou trabalhando' },
              { id: '12', label: 'Não estou trabalhando' },
            ]
          );
        }

        return res.sendStatus(200);
      }

      if (buttonId === '2') {
        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            status: 'Sem interesse',
          },
          messageText: null,
          questionKey: 'first_positive_interest',
          answerValue: 'nao',
          rawPayload: data,
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_2');

        if (!ok) {
          await sendText(phone, 'Tem certeza? Se mudar de ideia, estaremos à disposição!');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '11') {
        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            etapa: STAGE_IN_ATTENDANCE,
            status: STATUS_IN_ATTENDANCE,
            clt_is_working: true,
            clt_ready_for_presimulation: false,
          },
          messageText: null,
          questionKey: 'is_working_clt',
          answerValue: 'sim',
          rawPayload: data,
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_11');

        if (!ok) {
          await sendButtonList(
            phone,
            'A quanto tempo você está trabalhando na empresa atual?',
            [
              { id: '111', label: 'Menos de 03 meses' },
              { id: '112', label: 'De 03 meses a 01 ano' },
              { id: '113', label: 'Acima de 01 ano' },
            ]
          );
        }

        return res.sendStatus(200);
      }

      if (buttonId === '12') {
        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            clt_is_working: false,
            clt_ready_for_presimulation: false,
            status: 'Não elegível',
          },
          messageText: null,
          questionKey: 'is_working_clt',
          answerValue: 'nao',
          rawPayload: data,
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_12');

        if (!ok) {
          await sendText(phone, 'Essa modalidade exige vínculo CLT ativo.');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '111') {
        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            etapa: STAGE_IN_ATTENDANCE,
            status: 'Não elegível',
            clt_employment_months: 2,
            clt_ready_for_presimulation: false,
          },
          messageText: null,
          questionKey: 'employment_time',
          answerValue: 'menos_3_meses',
          rawPayload: data,
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_111');

        if (!ok) {
          await sendText(phone, 'Necessário mínimo 3 meses.');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '112' || buttonId === '113') {
        const employmentMonths = buttonId === '112' ? 6 : 13;

        await updateLeadKanbanFromWhatsapp({
          phone,
          updates: {
            etapa: STAGE_IN_ATTENDANCE,
            status: STATUS_IN_ATTENDANCE,
            clt_is_working: true,
            clt_employment_months: employmentMonths,
            clt_ready_for_presimulation: false,
          },
          messageText: null,
          questionKey: 'employment_time',
          answerValue: buttonId === '112' ? '3_meses_a_1_ano' : 'acima_1_ano',
          rawPayload: data,
        });

        conversationState[phone] = 'aguardando_dados';

        const ok = await sendTemplateFlow(phone, 'resposta_button_112_113');

        if (!ok) {
          await sendText(phone, 'Me informe Nome completo e CPF para eu seguir com a análise.');
        }

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (conversationState[phone] === 'aguardando_dados' && textMessage.trim()) {
      const parsed = extractNameAndCpf(textMessage);

      const updatePayload = {
        etapa: STAGE_IN_PROPOSAL,
        status: STATUS_IN_PROPOSAL,
        clt_ready_for_presimulation: true,
        clt_triage_completed_at: new Date().toISOString(),
      };

      if (parsed.nome) updatePayload.nome = parsed.nome;
      if (parsed.cpf) updatePayload.cpf = parsed.cpf;

      await updateLeadKanbanFromWhatsapp({
        phone,
        updates: updatePayload,
        messageText: null,
        questionKey: 'name_cpf_received',
        answerValue: textMessage,
        rawPayload: data,
      });

      const ok = await sendTemplateFlow(phone, 'resposta_dados_recebidos');

      if (!ok) {
        await sendText(phone, 'Recebi suas informações. Vou analisar e já retorno.');
      }

      conversationState[phone] = 'humano';
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ ERRO NO WEBHOOK:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// ========================
// START
// ========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Rodando na porta ${PORT}`);
});
