const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// CORS BÁSICO PARA O CRM
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// DADOS DA Z-API
const ZAPI_INSTANCE = '3F1EF7EC22F2822DEE1B6E59E5E6857E';
const ZAPI_TOKEN = 'D7AA256B9D782534DC503D1F';
const ZAPI_CLIENT_TOKEN = 'F6812ab433b6247ea87597dbc7e3da7ffS';

// DADOS DO SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// CHAVE OPCIONAL PARA PROTEGER O ENDPOINT DO CRM
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || '';

// MEMÓRIA TEMPORÁRIA DAS CONVERSAS
const conversationState = {};

// FUNÇÃO PARA NORMALIZAR TELEFONE
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

// FUNÇÃO PARA ENVIAR TEXTO
async function sendText(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    {
      phone,
      message
    },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
}

// FUNÇÃO PARA ENVIAR BOTÕES
async function sendButtonList(phone, message, buttons) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-button-list`,
    {
      phone,
      message,
      buttonList: {
        buttons
      }
    },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
}

// FUNÇÃO PARA ATUALIZAR LEAD NO SUPABASE
async function updateLeadMessageInfo(leadId, messageText) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.');
  }

  const nowIso = new Date().toISOString();

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`,
    {
      last_message_sent_at: nowIso,
      last_message_sent_text: messageText
    },
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      }
    }
  );

  return nowIso;
}

// TESTE DE STATUS
app.get('/', (req, res) => {
  res.send('Webhook online');
});

// ENDPOINT DE DISPARO PELO CRM
app.post('/send-indication-message', async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const requestApiKey = req.headers['x-api-key'];
      if (requestApiKey !== BACKEND_API_KEY) {
        return res.status(401).json({
          success: false,
          error: 'Não autorizado.'
        });
      }
    }

    const { leadId, phone, message } = req.body;

    if (!leadId || !phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'leadId, phone e message são obrigatórios.'
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Telefone inválido.'
      });
    }

    await sendText(normalizedPhone, message);
    const sentAt = await updateLeadMessageInfo(leadId, message);

    return res.status(200).json({
      success: true,
      last_message_sent_at: sentAt,
      last_message_sent_text: message
    });
  } catch (error) {
    console.error(
      'Erro em /send-indication-message:',
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error: 'Falha ao enviar mensagem e registrar disparo.'
    });
  }
});

// WEBHOOK
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    console.log('Evento recebido:', JSON.stringify(data, null, 2));

    const phone = data.phone;
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

    // TRATAMENTO DE CLIQUE NOS BOTÕES
    if (buttonId) {
      if (buttonId === '1') {
        await sendButtonList(
          phone,
          'Perfeito. Para eu seguir com a análise, me confirma uma informação:\n\nVocê está trabalhando atualmente de carteira assinada?',
          [
            { id: '11', label: 'Sim, estou trabalhando' },
            { id: '12', label: 'Não estou trabalhando' }
          ]
        );
      } else if (buttonId === '2') {
        await sendText(
          phone,
          'Tem certeza? Se mudar de ideia, estaremos à disposição!\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.'
        );
      } else if (buttonId === '11') {
        await sendButtonList(
          phone,
          'A quanto tempo você está trabalhando na empresa atual?',
          [
            { id: '111', label: 'Menos de 03 meses' },
            { id: '112', label: 'De 03 meses a 01 ano' },
            { id: '113', label: 'Acima de 01 ano' }
          ]
        );
      } else if (buttonId === '12') {
        await sendText(
          phone,
          'Entendi. Hoje essa modalidade é destinada para quem está com vínculo CLT ativo.\n\nSe sua situação mudar, estaremos à disposição!\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.'
        );
      } else if (buttonId === '111') {
        await sendText(
          phone,
          'O crédito privado é destinado a pessoas com vínculo CLT ativo há pelo menos 03 meses.\n\nNão desanime, assim que estiver elegível entraremos em contato.\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.'
        );
      } else if (buttonId === '112' || buttonId === '113') {
        conversationState[phone] = 'aguardando_dados';

        await sendText(
          phone,
          'Perfeito! Agora para a simulação, informe: Nome Completo e CPF:'
        );
      }

      return res.sendStatus(200);
    }

    // TRATAMENTO DE TEXTO LIVRE APÓS 112 OU 113
    if (conversationState[phone] === 'aguardando_dados' && textMessage.trim()) {
      await sendText(
        phone,
        'Perfeito, recebi suas informações.\n\nAgora vou iniciar a análise e a simulação das possibilidades para você. Assim que eu finalizar, retorno por aqui com os detalhes.'
      );

      conversationState[phone] = 'atendimento_humano';
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      'Erro no webhook:',
      error.response?.data || error.message
    );
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
