const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// DADOS DA Z-API
const ZAPI_INSTANCE = '3F1EF7EC22F2822DEE1B6E59E5E6857E';
const ZAPI_TOKEN = 'D7AA256B9D782534DC503D1F';
const ZAPI_CLIENT_TOKEN = 'F6812ab433b6247ea87597dbc7e3da7ffS';

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
    const buttonId = data.buttonId;

    if (!phone || !buttonId) {
      return res.sendStatus(200);
    }

    let mensagem = '';

    if (buttonId === '1') {
    mensagem = 'Perfeito! Você está trabalhando atualmente de carteira assinada?';
} else if (buttonId === '2') {
    mensagem = 'Sem problemas. Se precisar no futuro, é só me chamar.';
}

    if (mensagem) {
      await axios.post(
        `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        {
          phone: phone,
          message: mensagem
        },
        {
          headers: {
            'Client-Token': ZAPI_CLIENT_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
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
