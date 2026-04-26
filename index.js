console.log('🔥 VERSAO NOVA DO BACKEND RODANDO - FOLLOWUP LIMITADO');

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ENV
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKEND_API_KEY = process.env.BACKEND_API_KEY || '';

const conversationState = {};

// ========================
// SUPABASE
// ========================
function getSupabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

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
      console.log('⚠️ Template NÃO encontrado:', key);
      return null;
    }

    return rows[0];
  } catch (error) {
    console.error('❌ ERRO AO BUSCAR TEMPLATE:', error.message);
    return null;
  }
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

  return buttons.map((b) => ({
    id: String(b.id),
    label: String(b.text),
  }));
}

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
        phone,
        lead_name: leadName,
        message_text: messageText || null,
        status,
        error_message: errorMessage || null,
      },
      { headers: getSupabaseHeaders() }
    );
  } catch (error) {
    console.error('❌ ERRO AO CRIAR LOG:', error.response?.data || error.message);
  }
}

async function getFollowupSentLogs({ leadId, stage, templateKey }) {
  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/funnel_automation_logs?lead_id=eq.${encodeURIComponent(
      leadId
    )}&from_stage=eq.${encodeURIComponent(stage)}&to_stage=eq.${encodeURIComponent(
      stage
    )}&status=eq.followup_sent&select=id,created_at,message_text&order=created_at.desc`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];

  return rows.filter((row) => {
    if (!templateKey) return true;
    return String(row.message_text || '').length > 0;
  });
}

// ========================
// Z-API
// ========================
async function sendText(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    { phone, message },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function sendButtonList(phone, message, buttons) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-button-list`,
    {
      phone,
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
}

async function sendTemplateFlow(phone, templateKey) {
  const template = await getTemplateByKey(templateKey);

  if (template) {
    const message = renderTemplate(template.message_text, {});
    const buttons = mapButtonsForZApi(template.buttons || []);

    if (buttons.length > 0) {
      await sendButtonList(phone, message, buttons);
    } else {
      await sendText(phone, message);
    }

    console.log('✅ Fluxo via template:', templateKey);
    return true;
  }

  console.log('⚠️ Fluxo fallback:', templateKey);
  return false;
}

async function sendTemplateMessage({ leadId, phone, templateKey, nome, empresa }) {
  if (!leadId || !phone || !templateKey) {
    throw new Error('Campos obrigatórios faltando');
  }

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
    await sendButtonList(phone, message, buttons);
  } else {
    await sendText(phone, message);
  }

  await updateLeadMessageInfo(leadId, message);

  return {
    success: true,
    message,
    templateSource: 'supabase',
  };
}

// ========================
// UPDATE LEAD
// ========================
async function updateLeadMessageInfo(leadId, messageText) {
  if (!isUuid(leadId)) {
    console.log('ℹ️ leadId não é UUID real. Pulando update em leads:', leadId);
    return null;
  }

  const now = new Date().toISOString();

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`,
    {
      last_message_sent_at: now,
      last_message_sent_text: messageText,
    },
    {
      headers: getSupabaseHeaders(),
    }
  );

  return now;
}

// ========================
// HEALTH
// ========================
app.get('/', (req, res) => {
  res.send('Webhook online');
});

// ========================
// DISPARO
// ========================
app.post('/send-indication-message', async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== BACKEND_API_KEY) {
        return res.status(401).json({ success: false });
      }
    }

    const { leadId, phone, templateKey, nome, empresa } = req.body;

    const result = await sendTemplateMessage({
      leadId,
      phone: normalizePhone(phone),
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
// FOLLOW-UP AUTOMÁTICO COM LIMITE
// ========================
async function processFollowups() {
  console.log('🚀 Rodando follow-ups automáticos com limite...');

  const result = {
    success: true,
    checkedRules: 0,
    checkedLeads: 0,
    sent: 0,
    skipped: 0,
    skippedByLimit: 0,
    skippedByInterval: 0,
    errors: [],
  };

  const rulesResponse = await axios.get(
    `${SUPABASE_URL}/rest/v1/funnel_followup_rules?is_active=eq.true&select=*`,
    { headers: getSupabaseHeaders() }
  );

  const rules = Array.isArray(rulesResponse.data) ? rulesResponse.data : [];
  result.checkedRules = rules.length;

  for (const rule of rules) {
    const stage = rule.stage;
    const templateKey = rule.template_key;
    const delayMinutes = Number(rule.delay_minutes || 60);
    const userId = rule.user_id;
    const maxSendsPerLead = Number(rule.max_sends_per_lead || 1);
    const minMinutesBetweenSends = Number(rule.min_minutes_between_sends || 1440);

    if (!stage || !templateKey || !userId) {
      result.skipped += 1;
      continue;
    }

    const leadsResponse = await axios.get(
      `${SUPABASE_URL}/rest/v1/leads?user_id=eq.${encodeURIComponent(
        userId
      )}&etapa=eq.${encodeURIComponent(stage)}&select=*`,
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
            userId,
            leadId: lead.id,
            fromStage: stage,
            toStage: stage,
            phone,
            leadName: lead.nome,
            messageText: null,
            status: 'followup_skipped_no_phone',
            errorMessage: 'Lead sem telefone válido.',
          });

          continue;
        }

        const lastMessageDate = lead.last_message_sent_at
          ? new Date(lead.last_message_sent_at)
          : null;

        if (lastMessageDate) {
          const diffMinutes = (Date.now() - lastMessageDate.getTime()) / 60000;

          if (diffMinutes < delayMinutes) {
            result.skipped += 1;
            result.skippedByInterval += 1;

            await createAutomationLog({
              userId,
              leadId: lead.id,
              fromStage: stage,
              toStage: stage,
              phone,
              leadName: lead.nome,
              messageText: null,
              status: 'followup_skipped_interval',
              errorMessage: `Aguardando delay inicial. Diferença: ${Math.floor(
                diffMinutes
              )} min. Necessário: ${delayMinutes} min.`,
            });

            continue;
          }
        }

        const sentLogs = await getFollowupSentLogs({
          leadId: lead.id,
          stage,
          templateKey,
        });

        if (sentLogs.length >= maxSendsPerLead) {
          result.skipped += 1;
          result.skippedByLimit += 1;

          await createAutomationLog({
            userId,
            leadId: lead.id,
            fromStage: stage,
            toStage: stage,
            phone,
            leadName: lead.nome,
            messageText: null,
            status: 'followup_skipped_limit',
            errorMessage: `Limite atingido. Enviados: ${sentLogs.length}. Máximo permitido: ${maxSendsPerLead}.`,
          });

          continue;
        }

        if (sentLogs.length > 0) {
          const lastFollowupDate = new Date(sentLogs[0].created_at);
          const diffSinceLastFollowup = (Date.now() - lastFollowupDate.getTime()) / 60000;

          if (diffSinceLastFollowup < minMinutesBetweenSends) {
            result.skipped += 1;
            result.skippedByInterval += 1;

            await createAutomationLog({
              userId,
              leadId: lead.id,
              fromStage: stage,
              toStage: stage,
              phone,
              leadName: lead.nome,
              messageText: null,
              status: 'followup_skipped_min_interval',
              errorMessage: `Intervalo mínimo entre follow-ups não cumprido. Diferença: ${Math.floor(
                diffSinceLastFollowup
              )} min. Necessário: ${minMinutesBetweenSends} min.`,
            });

            continue;
          }
        }

        const sentResult = await sendTemplateMessage({
          leadId: lead.id,
          phone,
          templateKey,
          nome: lead.nome,
          empresa: lead.empresa,
        });

        await createAutomationLog({
          userId,
          leadId: lead.id,
          fromStage: stage,
          toStage: stage,
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
          userId,
          leadId: lead.id,
          fromStage: stage,
          toStage: stage,
          phone,
          leadName: lead.nome,
          messageText: null,
          status: 'followup_error',
          errorMessage: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
        });
      }
    }
  }

  return result;
}

app.post('/run-followups', async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== BACKEND_API_KEY) {
        return res.status(401).json({ success: false });
      }
    }

    const result = await processFollowups();
    return res.json(result);
  } catch (error) {
    console.error('❌ ERRO FOLLOW-UP:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno no follow-up',
    });
  }
});

app.get('/run-followups', async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== BACKEND_API_KEY) {
        return res.status(401).json({ success: false });
      }
    }

    const result = await processFollowups();
    return res.json(result);
  } catch (error) {
    console.error('❌ ERRO FOLLOW-UP:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno no follow-up',
    });
  }
});

// ========================
// WEBHOOK FINAL
// ========================
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    const phone = data.phone;
    const buttonId = data.buttonsResponseMessage?.buttonId;
    const textMessage =
      data.text?.message ||
      data.textMessage?.message ||
      data.message ||
      data.body ||
      '';

    if (!phone) return res.sendStatus(200);

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
          await sendText(
            phone,
            'Tem certeza? Se mudar de ideia, estaremos à disposição!'
          );
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
        await sendText(
          phone,
          'Recebi suas informações. Vou analisar e já retorno.'
        );
      }

      conversationState[phone] = 'humano';
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error(error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rodando na porta ${PORT}`);
});
