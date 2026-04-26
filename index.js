console.log('🔥 BACKEND COM SEQUÊNCIA INTELIGENTE ATIVO');

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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

// ========================
// UTILS
// ========================
function getHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// ========================
// TEMPLATE
// ========================
async function getTemplate(key) {
  const res = await axios.get(
    `${SUPABASE_URL}/rest/v1/whatsapp_templates?key=eq.${key}&is_active=eq.true`,
    { headers: getHeaders() }
  );

  return res.data?.[0] || null;
}

function render(text, vars = {}) {
  let out = text || '';
  Object.entries(vars).forEach(([k, v]) => {
    out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v || '');
  });
  return out;
}

// ========================
// ENVIO
// ========================
async function sendText(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    { phone, message },
    { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
  );
}

async function sendTemplate({ lead, templateKey }) {
  const tpl = await getTemplate(templateKey);
  if (!tpl) throw new Error('Template não encontrado');

  const msg = render(tpl.message_text, {
    nome: lead.nome,
    empresa: lead.empresa,
  });

  await sendText(lead.telefone, msg);

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`,
    {
      last_message_sent_at: new Date().toISOString(),
    },
    { headers: getHeaders() }
  );

  return msg;
}

// ========================
// LOG
// ========================
async function log(data) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/funnel_automation_logs`,
    data,
    { headers: getHeaders() }
  );
}

// ========================
// SEQUÊNCIA INTELIGENTE
// ========================
async function runFollowups() {
  console.log('🚀 Sequência inteligente rodando...');

  const steps = (
    await axios.get(
      `${SUPABASE_URL}/rest/v1/funnel_followup_sequence_steps?is_active=eq.true&order=step_number.asc`,
      { headers: getHeaders() }
    )
  ).data;

  let result = {
    success: true,
    sent: 0,
    skipped: 0,
  };

  for (const step of steps) {
    const leads = (
      await axios.get(
        `${SUPABASE_URL}/rest/v1/leads?etapa=eq.${step.stage}&user_id=eq.${step.user_id}`,
        { headers: getHeaders() }
      )
    ).data;

    for (const lead of leads) {
      // 🔴 CLIENTE RESPONDEU → PARA TUDO
      if (lead.last_client_interaction_at) {
        result.skipped++;

        await log({
          user_id: step.user_id,
          lead_id: lead.id,
          from_stage: step.stage,
          to_stage: step.stage,
          status: 'blocked_by_response',
          error_message: 'Cliente respondeu',
        });

        continue;
      }

      // 🔍 VERIFICAR QUAL STEP JÁ FOI ENVIADO
      const logs = (
        await axios.get(
          `${SUPABASE_URL}/rest/v1/funnel_automation_logs?lead_id=eq.${lead.id}&status=eq.followup_sent&order=created_at.desc`,
          { headers: getHeaders() }
        )
      ).data;

      const lastLog = logs[0];

      // Se já enviou esse step → pula
      if (logs.length >= step.step_number) {
        result.skipped++;
        continue;
      }

      // ⏱ DELAY
      if (lastLog) {
        const diff =
          (Date.now() - new Date(lastLog.created_at).getTime()) / 60000;

        if (diff < step.delay_minutes) {
          result.skipped++;
          continue;
        }
      }

      // 🚀 ENVIO
      const msg = await sendTemplate({
        lead,
        templateKey: step.template_key,
      });

      await log({
        user_id: step.user_id,
        lead_id: lead.id,
        from_stage: step.stage,
        to_stage: step.stage,
        status: 'followup_sent',
        message_text: msg,
      });

      result.sent++;
    }
  }

  return result;
}

// ========================
// ROTAS
// ========================
app.get('/', (req, res) => res.send('OK'));

app.get('/run-followups', async (req, res) => {
  try {
    const r = await runFollowups();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: true });
  }
});

// ========================
// WEBHOOK
// ========================
app.post('/webhook', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);

    if (!phone) return res.sendStatus(200);

    await axios.patch(
      `${SUPABASE_URL}/rest/v1/leads?telefone=eq.${phone}`,
      {
        last_client_interaction_at: new Date().toISOString(),
      },
      { headers: getHeaders() }
    );

    console.log('📩 Cliente respondeu → bloqueado');

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log('Rodando na porta 3000');
});
