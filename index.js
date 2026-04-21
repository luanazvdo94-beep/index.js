const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// DADOS DA Z-API
const ZAPI_INSTANCE = '3F1EF7EC22F2822DEE1B6E59E5E6857E';
const ZAPI_TOKEN = 'D7AA256B9D782534DC503D1F';
const ZAPI_CLIENT_TOKEN = 'F6812ab433b6247ea87597dbc7e3da7ffS';

// MEMÓRIA TEMPORÁRIA DAS CONVERSAS
const conversationState = {};

// FUNÇÃO PARA ENVIAR TEXTO
async function sendText(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    {
      phone: phone,
      message: message
    },
    {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
}

// TESTE DE STATUS
app.get('/', (req, res) => {
  res.send('Webhook online');
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
      data.message ||
      data.body ||
      data.textMessage?.message ||
      '';

    if (!phone) {
      return res.sendStatus(200);
    }

    // 1) TRATAMENTO DE BOTÕES
    if (buttonId) {
      let mensagem = '';

      if (buttonId === '1') {
        mensagem = 'Perfeito. Para eu seguir com a análise, me confirma uma informação:\n\nVocê está trabalhando atualmente de carteira assinada?';
      } else if (buttonId === '2') {
        mensagem = 'Tem certeza? Se mudar de ideia, estaremos à disposição!\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.';
      } else if (buttonId === '11') {
        mensagem = 'A quanto tempo você está trabalhando na empresa atual?';
      } else if (buttonId === '12') {
        mensagem = 'Entendi. Hoje essa modalidade é destinada para quem está com vínculo CLT ativo.\n\nSe sua situação mudar, estaremos à disposição!\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.';
      } else if (buttonId === '111') {
        mensagem = 'O crédito privado é destinado a pessoas com vínculo CLT ativo há pelo menos 03 meses.\n\nNão desanime, assim que estiver elegível entraremos em contato.\nPara mais informações, siga-nos nas redes sociais no Instagram @numonpromotora.\nObrigado pela atenção.';
      } else if (buttonId === '112' || buttonId === '113') {
        mensagem = 'Perfeito! Agora para a simulação, informe: Nome Completo e CPF:';
        conversationState[phone] = 'aguardando_dados';
      }

      if (mensagem) {
        await sendText(phone, mensagem);
      }

      return res.sendStatus(200);
    }

    // 2) TRATAMENTO DE TEXTO LIVRE APÓS 112 OU 113
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
    console.error('Erro no webhook:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
