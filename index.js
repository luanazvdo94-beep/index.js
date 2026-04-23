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
// FALLBACK TEMPORÁRIO
// ========================
// Mantido para não quebrar nada durante a migração.
// O ideal é migrarmos tudo depois para a tabela whatsapp_templates.
const templates = {
  modelo_1: (nome, empresa) => `
Oi ${nome}, tudo bem?

Vi uma possibilidade que pode fazer sentido para você pela ${empresa}, na linha do crédito Privado CLT.

Queria só confirmar duas coisas rapidamente:
• Você ainda trabalha na ${empresa}?
• De quanto você precisa hoje?

Se fizer sentido, eu verifico isso pra você sem compromisso.
`.trim(),

  modelo_2: (nome, empresa) => `
Olá ${nome},

Analisei um cenário aqui que pode ser interessante para quem trabalha na ${empresa}.

Posso te mostrar como funciona sem compromisso?
`.trim(),
};

// ========================
// FUNÇÕES AUXILIARES SUPABASE
// ========================
function getSupabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function getTemplateByKey(key) {
  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/whatsapp_templates?key=eq.${encodeURIComponent(
      key
    )}&is_active=eq.true&select=*`,
    {
      headers: getSupabaseHeaders(),
    }
  );

  const rows = response.data;

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

function renderTemplate(templateText, variables = {}) {
  let output = templateText || '';

  Object.entries(variables).forEach(([key, value]) => {
    const safeValue = value ?? '';
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    output = output.replace(regex, String(safeValue));
  });

  return output;
}

function mapButtonsForZApi(buttons = []) {
  if (!Array.isArray(buttons)) return [];

  return buttons
    .filter((button) => button && button.id && button.text)
    .map((button) => ({
      id: String(button.id),
      label: String(button.text),
    }));
}

async function buildMessageFromTemplate({ templateKey, nome, empresa }) {
  const dbTemplate = await getTemplateByKey(templateKey);

  if (dbTemplate) {
    const message = renderTemplate(dbTemplate.message_text, {
      nome: nome || 'Cliente',
      empresa: empresa || 'sua empresa',
    });

    const buttons = mapButtonsForZApi(dbTemplate.buttons || []);

    return {
      source: 'supabase',
      message,
      buttons,
      template: dbTemplate,
    };
  }

  const fallbackTemplateFn = templates[templateKey];

  if (!fallbackTemplateFn) {
    return null;
  }

  return {
    source: 'fallback',
    message: fallbackTemplateFn(nome || 'Cliente', empresa || 'sua empresa'),
    buttons: [
      { id: '1', label: 'Sim, quero ver' },
      { id: '2', label: 'Não tenho interesse' },
    ],
    template: null,
  };
}

// ========================
// FUNÇÕES Z-API
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
// SUPABASE UPDATE
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
// DISPARO VIA CRM
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
        error: 'leadId, phone e templateKey são obrigatórios',
      });
    }

    const builtTemplate = await buildMessageFromTemplate({
      templateKey,
      nome,
      empresa,
    });

    if (!builtTemplate) {
      return res.status(400).json({
        success: false,
        error: 'Template inválido',
      });
    }

    const { message, buttons, source } = builtTemplate;

    if (buttons.length > 0) {
      await sendButtonList(phone, message, buttons);
    } else {
      await sendText(phone, message);
    }

    await updateLeadMessageInfo(leadId, message);

    return res.json({
      success: true,
      templateSource: source,
    });
  } catch (error) {
    console.error(
      'Erro em /send-indication-message:',
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao enviar mensagem',
    });
  }
});

// ========================
// WEBHOOK AUTOMAÇÃO
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
        await sendButtonList(
          phone,
          'Perfeito. Para eu seguir com a análise, me confirma uma informação:\n\nVocê está trabalhando atualmente de carteira assinada?',
          [
            { id: '11', label: 'Sim, estou trabalhando' },
            { id: '12', label: 'Não estou trabalhando' },
          ]
        );
      }

      if (buttonId === '2') {
        await sendText(
          phone,
          'Tem certeza? Se mudar de ideia, estaremos à disposição!\nSiga @numonpromotora.\nObrigado.'
        );
      }

      if (buttonId === '11') {
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

      if (buttonId === '12') {
        await sendText(
          phone,
          'Essa modalidade exige vínculo CLT ativo.\nSe mudar, estamos aqui.'
        );
      }

      if (buttonId === '111') {
        await sendText(phone, 'Necessário mínimo 3 meses de empresa.');
      }

      if (buttonId === '112' || buttonId === '113') {
        conversationState[phone] = 'aguardando_dados';

        await sendText(
          phone,
          'Perfeito! Agora me informe Nome Completo e CPF:'
        );
      }

      return res.sendStatus(200);
    }

    if (conversationState[phone] === 'aguardando_dados' && textMessage.trim()) {
      await sendText(
        phone,
        'Recebi suas informações. Vou analisar e já retorno.'
      );

      conversationState[phone] = 'humano';
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Erro em /webhook:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rodando na porta ${PORT}`);
});
