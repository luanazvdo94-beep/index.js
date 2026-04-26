console.log('🔥 BACKEND NUMON ESTÁVEL: DISPARO + FUNIL + FOLLOWUP + HISTÓRICO IA');

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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(
    String(value || '')
  );
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

// ========================
// SUPABASE - TEMPLATES
// ========================
async function getTemplateByKey(key) {
  try {
    console.log('🔍 Buscando template:', key);

    const url = `${SUPABASE_URL}/rest/v1/whatsapp_templates?key=eq.${encodeURIComponent(
      key
    )}&is_active=eq.true&select=*`;

    const response = await axios.get(url, {
      headers: getSupabaseHeaders(),
    });

    const rows = response.data;

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
  if (!isUuid(leadId)) {
    console.log('ℹ️ leadId não é UUID válido. Pulando update em leads:', leadId);
    return null;
  }

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

  if (!lead) {
    console.log('ℹ️ Nenhum lead encontrado para telefone:', normalizedPhone);
    return null;
  }

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

  console.log('📩 Cliente respondeu → histórico salvo e follow-up bloqueado:', normalizedPhone);

  return lead;
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

  console.log('✅ Fluxo via template:', templateKey);
  return true;
}

// ========================
// HEALTH
// ========================
app.get('/', (req, res) => {
  res.send('Webhook online');
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
