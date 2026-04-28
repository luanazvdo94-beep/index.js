console.log('🔥 BACKEND NUMON ESTÁVEL + IA DE ATENDIMENTO PARA LEAD QUENTE + CONSULTA CNPJ + BUSCA EMPRESA');

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

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
// UTILS
// ========================
function getSupabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function cleanCNPJ(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function isHotLead(lead) {
  if (!lead) return false;
  const etapa = String(lead.etapa || '').trim().toLowerCase();
  return ['em atendimento', 'em proposta'].includes(etapa);
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
    label: String(button.text),
  }));
}

function requireBackendApiKey(req, res) {
  if (!BACKEND_API_KEY) return true;

  const apiKey = req.headers['x-api-key'];

  if (apiKey !== BACKEND_API_KEY) {
    res.status(401).json({
      success: false,
      error: 'Não autorizado',
    });
    return false;
  }

  return true;
}

// ========================
// SUPABASE - TEMPLATES
// ========================
async function getTemplateByKey(key) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/whatsapp_templates?key=eq.${encodeURIComponent(
      key
    )}&is_active=eq.true&select=*`;

    const response = await axios.get(url, {
      headers: getSupabaseHeaders(),
    });

    const rows = response.data;

    if (!Array.isArray(rows) || rows.length === 0) {
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
async function getLeadByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) return null;

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/leads?telefone=eq.${encodeURIComponent(
      normalizedPhone
    )}&select=*`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows[0] || null;
}

async function getLeadById(leadId) {
  if (!leadId) return null;

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}&select=*`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows[0] || null;
}

async function getLeadMessages(leadId, limit = 12) {
  if (!leadId) return [];

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/lead_messages?lead_id=eq.${encodeURIComponent(
      leadId
    )}&select=direction,message_text,created_at&order=created_at.desc&limit=${limit}`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows.reverse();
}

async function saveLeadMessage({ leadId, direction, messageText }) {
  if (!leadId || !messageText) return;

  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/lead_messages`,
      {
        lead_id: leadId,
        direction,
        message_text: messageText,
      },
      { headers: getSupabaseHeaders() }
    );
  } catch (error) {
    console.error('⚠️ Erro ao salvar lead_messages:', error.response?.data || error.message);
  }
}

async function updateLeadMessageInfo(leadId, messageText) {
  if (!isUuid(leadId)) return null;

  const now = new Date().toISOString();

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`,
    {
      last_message_sent_at: now,
      last_message_sent_text: messageText,
    },
    { headers: getSupabaseHeaders() }
  );

  return now;
}

async function markClientInteractionByPhone(phone, messageText = '') {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) return null;

  const lead = await getLeadByPhone(normalizedPhone);

  if (!lead) return null;

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`,
    {
      last_client_interaction_at: new Date().toISOString(),
    },
    { headers: getSupabaseHeaders() }
  );

  if (messageText) {
    await saveLeadMessage({
      leadId: lead.id,
      direction: 'in',
      messageText,
    });
  }

  return lead;
}

// ========================
// CNPJ - BRASILAPI + SUPABASE
// ========================
async function fetchCNPJFromBrasilAPI(cnpj) {
  const clean = cleanCNPJ(cnpj);

  if (clean.length !== 14) {
    throw new Error('CNPJ inválido');
  }

  const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${clean}`);
  return response.data;
}

async function upsertCompanySearchIndex(data) {
  const payload = {
    cnpj: cleanCNPJ(data.cnpj),
    razao_social: data.razao_social || null,
    nome_fantasia: data.nome_fantasia || null,
    municipio: data.municipio || null,
    uf: data.uf || null,
    situacao_cadastral: data.descricao_situacao_cadastral || null,
    cnae_principal_codigo: data.cnae_fiscal ? String(data.cnae_fiscal) : null,
    cnae_principal_descricao: data.cnae_fiscal_descricao || null,
    porte: data.porte || null,
  };

  await axios.post(
    `${SUPABASE_URL}/rest/v1/company_search_index?on_conflict=cnpj`,
    payload,
    {
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'resolution=merge-duplicates',
      },
    }
  );

  return payload;
}

async function upsertCompanyProfile(data) {
  const payload = {
    cnpj: cleanCNPJ(data.cnpj),
    razao_social: data.razao_social || null,
    nome_fantasia: data.nome_fantasia || null,
    situacao_cadastral: data.descricao_situacao_cadastral || null,
    data_abertura: data.data_inicio_atividade || null,
    natureza_juridica: data.natureza_juridica || null,
    porte: data.porte || null,

    cnae_principal_codigo: data.cnae_fiscal ? String(data.cnae_fiscal) : null,
    cnae_principal_descricao: data.cnae_fiscal_descricao || null,
    cnaes_secundarios: data.cnaes_secundarios || [],

    endereco: {
      logradouro: data.logradouro || null,
      numero: data.numero || null,
      complemento: data.complemento || null,
      bairro: data.bairro || null,
      municipio: data.municipio || null,
      uf: data.uf || null,
      cep: data.cep || null,
    },

    socios: data.qsa || [],
    raw_data: data,
    source: 'brasilapi',
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await axios.post(
    `${SUPABASE_URL}/rest/v1/company_profiles?on_conflict=cnpj`,
    payload,
    {
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'resolution=merge-duplicates',
      },
    }
  );

  await upsertCompanySearchIndex(data);

  return payload;
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
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/funnel_automation_logs`,
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
      { headers: getSupabaseHeaders() }
    );
  } catch (error) {
    console.error('❌ Erro ao criar log de automação:', error.response?.data || error.message);
  }
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

  return true;
}

// ========================
// IA
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
Empresa: ${lead.empresa || 'Não informada'}
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

// ========================
// CONSULTA CNPJ
// ========================
app.post('/consult-cnpj', async (req, res) => {
  try {
    if (!requireBackendApiKey(req, res)) return;

    const { cnpj } = req.body;

    if (!cnpj) {
      return res.status(400).json({
        success: false,
        error: 'CNPJ é obrigatório',
      });
    }

    const data = await fetchCNPJFromBrasilAPI(cnpj);
    const saved = await upsertCompanyProfile(data);

    return res.json({
      success: true,
      data: saved,
    });
  } catch (error) {
    console.error('❌ ERRO EM /consult-cnpj:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Erro ao consultar CNPJ',
    });
  }
});

// ========================
// TESTE CNPJ VIA NAVEGADOR
// ========================
app.get('/test-cnpj/:cnpj', async (req, res) => {
  try {
    if (!requireBackendApiKey(req, res)) return;

    const data = await fetchCNPJFromBrasilAPI(req.params.cnpj);
    const saved = await upsertCompanyProfile(data);

    return res.json({
      success: true,
      data: saved,
    });
  } catch (error) {
    console.error('❌ ERRO EM /test-cnpj:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Erro ao consultar CNPJ',
    });
  }
});

// ========================
// BUSCAR EMPRESA POR NOME
// ========================
app.get('/search-company', async (req, res) => {
  try {
    if (!requireBackendApiKey(req, res)) return;

    const { name, uf } = req.query;

    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro name é obrigatório e precisa ter pelo menos 2 caracteres',
      });
    }

    const search = `%${String(name).trim()}%`;

    let query = `${SUPABASE_URL}/rest/v1/company_search_index?select=*&limit=10`;

    query += `&or=(nome_fantasia.ilike.${encodeURIComponent(search)},razao_social.ilike.${encodeURIComponent(search)})`;

    if (uf) {
      query += `&uf=eq.${encodeURIComponent(String(uf).trim().toUpperCase())}`;
    }

    query += '&order=nome_fantasia.asc.nullslast';

    const response = await axios.get(query, {
      headers: getSupabaseHeaders(),
    });

    return res.json({
      success: true,
      data: Array.isArray(response.data) ? response.data : [],
    });
  } catch (error) {
    console.error('❌ ERRO EM /search-company:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Erro ao buscar empresas',
    });
  }
});

// ========================
// DISPARO USADO PELO CRM / ABA DE DISPARO / FUNIL
// ========================
app.post('/send-indication-message', async (req, res) => {
  try {
    if (!requireBackendApiKey(req, res)) return;

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

  const stepsResponse = await axios.get(
    `${SUPABASE_URL}/rest/v1/funnel_followup_sequence_steps?is_active=eq.true&select=*&order=step_number.asc`,
    { headers: getSupabaseHeaders() }
  );

  const steps = Array.isArray(stepsResponse.data) ? stepsResponse.data : [];
  result.checkedSteps = steps.length;

  for (const step of steps) {
    const leadsResponse = await axios.get(
      `${SUPABASE_URL}/rest/v1/leads?etapa=eq.${encodeURIComponent(
        step.stage
      )}&user_id=eq.${encodeURIComponent(step.user_id)}&select=*`,
      { headers: getSupabaseHeaders() }
    );

    const leads = Array.isArray(leadsResponse.data) ? leadsResponse.data : [];
    result.checkedLeads += leads.length;

    for (const lead of leads) {
      const phone = normalizePhone(lead.telefone);

      try {
        if (!phone) {
          result.skipped += 1;
          continue;
        }

        if (lead.last_client_interaction_at) {
          result.skipped += 1;
          result.skippedByResponse += 1;
          continue;
        }

        const sentLogsResponse = await axios.get(
          `${SUPABASE_URL}/rest/v1/funnel_automation_logs?lead_id=eq.${encodeURIComponent(
            lead.id
          )}&status=eq.followup_sent&select=id,created_at,message_text&order=created_at.desc`,
          { headers: getSupabaseHeaders() }
        );

        const sentLogs = Array.isArray(sentLogsResponse.data) ? sentLogsResponse.data : [];

        if (sentLogs.length >= Number(step.step_number || 1)) {
          result.skipped += 1;
          result.skippedAlreadySent += 1;
          continue;
        }

        const lastLog = sentLogs[0] || null;

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
          empresa: lead.empresa,
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

    const phone = normalizePhone(data.phone);

    const buttonId = data.buttonsResponseMessage?.buttonId;

    const textMessage =
      data.text?.message ||
      data.textMessage?.message ||
      data.message ||
      data.body ||
      '';

    if (!phone) {
      return res.sendStatus(200);
    }

    await markClientInteractionByPhone(phone, textMessage);

    if (buttonId) {
      if (buttonId === '1') {
        const ok = await sendTemplateFlow(phone, 'resposta_button_1');

        if (!ok) {
          await sendButtonList(
            phone,
            'Perfeito. Para eu seguir com a análise...',
            [
              { id: '11', label: 'Sim, estou trabalhando' },
              { id: '12', label: 'Não estou trabalhando' },
            ]
          );
        }
      }

      if (buttonId === '2') {
        const ok = await sendTemplateFlow(phone, 'resposta_button_2');

        if (!ok) {
          await sendText(phone, 'Tem certeza? Se mudar de ideia, estaremos à disposição!');
        }
      }

      if (buttonId === '11') {
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
      }

      if (buttonId === '12') {
        const ok = await sendTemplateFlow(phone, 'resposta_button_12');

        if (!ok) {
          await sendText(phone, 'Essa modalidade exige vínculo CLT ativo.');
        }
      }

      if (buttonId === '111') {
        const ok = await sendTemplateFlow(phone, 'resposta_button_111');

        if (!ok) {
          await sendText(phone, 'Necessário mínimo 3 meses.');
        }
      }

      if (buttonId === '112' || buttonId === '113') {
        conversationState[phone] = 'aguardando_dados';

        const ok = await sendTemplateFlow(phone, 'resposta_button_112_113');

        if (!ok) {
          await sendText(phone, 'Me informe Nome e CPF');
        }
      }

      return res.sendStatus(200);
    }

    if (conversationState[phone] === 'aguardando_dados' && textMessage.trim()) {
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
