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

// ========================
// UPDATE LEAD
// ========================
async function updateLeadMessageInfo(leadId, messageText) {
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

    if (!leadId || !phone || !templateKey) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios faltando',
      });
    }

    const template = await getTemplateByKey(templateKey);

    if (!template) {
      return res.status(400).json({
        success: false,
        error: 'Template não encontrado',
      });
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

    return res.json({
      success: true,
      templateSource: 'supabase',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
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
