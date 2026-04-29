console.log('🔥 BACKEND NUMON ESTÁVEL + IA + CNPJ + BUSCA EMPRESA + TRIAGEM CLT + KANBAN AUTOMÁTICO + TELEFONE BR V3 + EMPRESA + NASCIMENTO + CONSIGNADO');

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
// CONSTANTES DO KANBAN
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

function cleanCPF(cpf) {
  return String(cpf || '').replace(/\D/g, '');
}

function normalizeUuid(value) {
  return String(value || '')
    .trim()
    .replace(/[^\w-]/g, '');
}

function isUuid(value) {
  const normalized = normalizeUuid(value);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalized
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
    label: String(button.text || button.label || ''),
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

function compactText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cleanExtractedField(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—\s]+/, '')
    .replace(/[:\-–—\s]+$/, '')
    .trim();
}

function parseNameCpfFromText(text) {
  const raw = String(text || '').trim();
  const cpfMatch = raw.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
  const cpf = cpfMatch ? cleanCPF(cpfMatch[1]) : '';

  let name = raw;

  if (cpfMatch) {
    name = raw.replace(cpfMatch[1], '').trim();
  }

  name = name
    .replace(/cpf/gi, '')
    .replace(/nome/gi, '')
    .replace(/[:\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.length < 2) {
    name = '';
  }

  return {
    name,
    cpf: cpf.length === 11 ? cpf : '',
  };
}

function extractLabeledValue(text, labels, stopLabels = []) {
  const normalizedText = compactText(text);

  if (!normalizedText) return '';

  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const escapedStops = stopLabels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const stopPattern = escapedStops.length
    ? `(?=\\n\\s*(?:${escapedStops.join('|')})\\s*[:\\-–—]|$)`
    : '(?=$)';

  const regex = new RegExp(
    `(?:^|\\n)\\s*(?:${escapedLabels.join('|')})\\s*[:\\-–—]?\\s*([\\s\\S]*?)${stopPattern}`,
    'i'
  );

  const match = normalizedText.match(regex);

  if (!match?.[1]) return '';

  return cleanExtractedField(match[1]);
}

function parseBirthDateFromText(text) {
  const raw = compactText(text);

  const labeledBirthDate = extractLabeledValue(
    raw,
    ['data de nascimento', 'nascimento', 'data nascimento', 'dt nascimento'],
    ['nome completo', 'nome', 'cpf', 'empresa onde trabalha', 'empresa', 'local de trabalho', 'empresa atual']
  );

  const birthDateSource = labeledBirthDate || raw;
  const match = birthDateSource.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);

  if (!match) {
    return {
      birthDate: '',
      age: null,
    };
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (!day || !month || !year || month < 1 || month > 12 || day < 1 || day > 31) {
    return {
      birthDate: '',
      age: null,
    };
  }

  const birthDate = new Date(year, month - 1, day);

  if (
    Number.isNaN(birthDate.getTime()) ||
    birthDate.getFullYear() !== year ||
    birthDate.getMonth() !== month - 1 ||
    birthDate.getDate() !== day
  ) {
    return {
      birthDate: '',
      age: null,
    };
  }

  const today = new Date();

  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  const dayDiff = today.getDate() - birthDate.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  if (age < 14 || age > 100) {
    return {
      birthDate: '',
      age: null,
    };
  }

  const isoBirthDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    birthDate: isoBirthDate,
    age,
  };
}

function parseNameCpfCompanyBirthDateFromText(text) {
  const raw = compactText(text);

  const cpfMatch = raw.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
  const cpf = cpfMatch ? cleanCPF(cpfMatch[1]) : '';

  const birthDateResult = parseBirthDateFromText(raw);

  const nameFromLabel = extractLabeledValue(
    raw,
    ['nome completo', 'nome'],
    ['cpf', 'data de nascimento', 'nascimento', 'data nascimento', 'empresa onde trabalha', 'empresa', 'local de trabalho']
  );

  const companyFromLabel = extractLabeledValue(
    raw,
    ['empresa onde trabalha', 'empresa', 'local de trabalho', 'empresa atual'],
    ['nome completo', 'nome', 'cpf', 'data de nascimento', 'nascimento', 'data nascimento']
  );

  let name = nameFromLabel;
  let company = companyFromLabel;

  if (!name || !company) {
    const lines = raw
      .split('\n')
      .map((line) => cleanExtractedField(line))
      .filter(Boolean);

    const cleanedLines = lines
      .map((line) =>
        line
          .replace(
            /^(nome completo|nome|cpf|data de nascimento|nascimento|data nascimento|empresa onde trabalha|empresa|local de trabalho|empresa atual)\s*[:\-–—]?\s*/i,
            ''
          )
          .trim()
      )
      .filter(Boolean);

    if (!name && cleanedLines.length > 0) {
      const firstNameLine = cleanedLines.find((line) => {
        const isCpf = cleanCPF(line).length === 11;
        const hasBirthDate = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/.test(line);
        return !isCpf && !hasBirthDate;
      });

      if (firstNameLine) {
        name = firstNameLine;
      }
    }

    if (!company && cleanedLines.length > 0) {
      const possibleCompany = cleanedLines
        .filter((line) => cleanCPF(line).length !== 11)
        .filter((line) => !/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/.test(line))
        .filter((line) => line !== name)
        .pop();

      if (possibleCompany) {
        company = possibleCompany;
      }
    }
  }

  if (!name) {
    const fallback = parseNameCpfFromText(raw);
    name = fallback.name;
  }

  if (!company) {
    const withoutCpf = cpfMatch ? raw.replace(cpfMatch[1], '') : raw;
    const withoutBirthDate = withoutCpf.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/g, '');
    const companyKeywordMatch = withoutBirthDate.match(
      /(?:empresa onde trabalha|empresa|local de trabalho|empresa atual)\s*[:\-–—]?\s*([^\n]+)/i
    );

    if (companyKeywordMatch?.[1]) {
      company = cleanExtractedField(companyKeywordMatch[1]);
    }
  }

  name = cleanExtractedField(name)
    .replace(/^(nome completo|nome)\s*[:\-–—]?\s*/i, '')
    .trim();

  company = cleanExtractedField(company)
    .replace(/^(empresa onde trabalha|empresa|local de trabalho|empresa atual)\s*[:\-–—]?\s*/i, '')
    .trim();

  if (name.length < 2) name = '';
  if (company.length < 2) company = '';

  return {
    name,
    cpf: cpf.length === 11 ? cpf : '',
    birthDate: birthDateResult.birthDate,
    age: birthDateResult.age,
    company,
  };
}

function stripBrazilCountryCode(phone) {
  const normalized = normalizePhone(phone);

  if (normalized.startsWith('55') && normalized.length > 11) {
    return normalized.slice(2);
  }

  return normalized;
}

function buildBrazilMobileVariants(phone) {
  const raw = normalizePhone(phone);
  const local = stripBrazilCountryCode(raw);
  const variants = new Set();

  if (!local) return [];

  variants.add(local);

  if (local.length === 10) {
    const ddd = local.slice(0, 2);
    const subscriber = local.slice(2);

    if (subscriber.length === 8) {
      variants.add(`${ddd}9${subscriber}`);
    }
  }

  if (local.length === 11 && local[2] === '9') {
    const ddd = local.slice(0, 2);
    const subscriberWithoutNine = local.slice(3);

    if (subscriberWithoutNine.length === 8) {
      variants.add(`${ddd}${subscriberWithoutNine}`);
    }
  }

  if (local.length === 9 && local[0] === '9') {
    variants.add(local.slice(1));
  }

  if (local.length === 8) {
    variants.add(`9${local}`);
  }

  return Array.from(variants).filter(Boolean);
}

function buildPhoneVariants(phone) {
  const normalized = normalizePhone(phone);
  const variants = new Set();

  if (!normalized) return [];

  variants.add(normalized);

  const local = stripBrazilCountryCode(normalized);
  const brVariants = buildBrazilMobileVariants(local);

  variants.add(local);

  for (const brVariant of brVariants) {
    variants.add(brVariant);
    variants.add(`55${brVariant}`);

    if (brVariant.length >= 11) variants.add(brVariant.slice(-11));
    if (brVariant.length >= 10) variants.add(brVariant.slice(-10));
    if (brVariant.length >= 9) variants.add(brVariant.slice(-9));
    if (brVariant.length >= 8) variants.add(brVariant.slice(-8));
  }

  if (normalized.startsWith('55') && normalized.length > 11) {
    variants.add(normalized.slice(2));
  }

  if (!normalized.startsWith('55')) {
    variants.add(`55${normalized}`);
  }

  if (normalized.length >= 11) variants.add(normalized.slice(-11));
  if (normalized.length >= 10) variants.add(normalized.slice(-10));
  if (normalized.length >= 9) variants.add(normalized.slice(-9));
  if (normalized.length >= 8) variants.add(normalized.slice(-8));

  if (local.length >= 11) variants.add(local.slice(-11));
  if (local.length >= 10) variants.add(local.slice(-10));
  if (local.length >= 9) variants.add(local.slice(-9));
  if (local.length >= 8) variants.add(local.slice(-8));

  return Array.from(variants).filter(Boolean);
}

function buildSupabaseInList(values) {
  return `(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(',')})`;
}

function getWebhookPhone(data) {
  return normalizePhone(
    data?.phone ||
      data?.from ||
      data?.sender ||
      data?.participantPhone ||
      data?.connectedPhone ||
      data?.chatId ||
      ''
  );
}

function getWebhookButtonId(data) {
  return (
    data?.buttonsResponseMessage?.buttonId ||
    data?.buttonReply?.id ||
    data?.listResponseMessage?.selectedRowId ||
    data?.selectedButtonId ||
    ''
  );
}

function getWebhookText(data) {
  return (
    data?.text?.message ||
    data?.textMessage?.message ||
    data?.message ||
    data?.body ||
    data?.buttonsResponseMessage?.message ||
    data?.buttonsResponseMessage?.buttonText ||
    data?.buttonsResponseMessage?.selectedDisplayText ||
    ''
  );
}

function getPhoneMatchScore(incomingPhone, savedPhone) {
  const incoming = normalizePhone(incomingPhone);
  const saved = normalizePhone(savedPhone);

  if (!incoming || !saved) return 0;

  const incomingVariants = buildPhoneVariants(incoming);
  const savedVariants = buildPhoneVariants(saved);

  if (incoming === saved) return 100;

  for (const incomingVariant of incomingVariants) {
    for (const savedVariant of savedVariants) {
      if (!incomingVariant || !savedVariant) continue;

      if (incomingVariant === savedVariant) {
        if (incomingVariant.length >= 11) return 98;
        if (incomingVariant.length >= 10) return 95;
        if (incomingVariant.length >= 9) return 88;
        if (incomingVariant.length >= 8) return 80;
      }
    }
  }

  const incomingLocal = stripBrazilCountryCode(incoming);
  const savedLocal = stripBrazilCountryCode(saved);

  if (incomingLocal === savedLocal) return 96;

  const incomingDdd = incomingLocal.length >= 10 ? incomingLocal.slice(0, 2) : '';
  const savedDdd = savedLocal.length >= 10 ? savedLocal.slice(0, 2) : '';
  const incomingLast8 = incomingLocal.length >= 8 ? incomingLocal.slice(-8) : '';
  const savedLast8 = savedLocal.length >= 8 ? savedLocal.slice(-8) : '';

  if (
    incomingDdd &&
    savedDdd &&
    incomingDdd === savedDdd &&
    incomingLast8 &&
    savedLast8 &&
    incomingLast8 === savedLast8
  ) {
    return 93;
  }

  if (
    incomingLocal.length >= 11 &&
    savedLocal.length >= 11 &&
    incomingLocal.slice(-11) === savedLocal.slice(-11)
  ) {
    return 90;
  }

  if (
    incomingLocal.length >= 10 &&
    savedLocal.length >= 10 &&
    incomingLocal.slice(-10) === savedLocal.slice(-10)
  ) {
    return 85;
  }

  if (
    incomingLocal.length >= 9 &&
    savedLocal.length >= 9 &&
    incomingLocal.slice(-9) === savedLocal.slice(-9)
  ) {
    return 75;
  }

  if (
    incomingLocal.length >= 8 &&
    savedLocal.length >= 8 &&
    incomingLocal.slice(-8) === savedLocal.slice(-8)
  ) {
    return 65;
  }

  return 0;
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

  const variants = buildPhoneVariants(normalizedPhone);

  console.log('🔎 Buscando lead por telefone. Entrada:', normalizedPhone, 'Variantes:', variants);

  try {
    const exactResponse = await axios.get(
      `${SUPABASE_URL}/rest/v1/leads?telefone=in.${buildSupabaseInList(
        variants
      )}&select=*&order=created_at.desc&limit=20`,
      { headers: getSupabaseHeaders() }
    );

    const exactRows = Array.isArray(exactResponse.data) ? exactResponse.data : [];

    if (exactRows.length > 0) {
      const rankedRows = exactRows
        .map((row) => ({
          row,
          score: getPhoneMatchScore(normalizedPhone, row.telefone),
        }))
        .sort((a, b) => b.score - a.score);

      console.log('✅ Lead encontrado por busca exata:', {
        leadId: rankedRows[0].row.id,
        telefoneSalvo: rankedRows[0].row.telefone,
        score: rankedRows[0].score,
      });

      return rankedRows[0].row;
    }
  } catch (error) {
    console.warn('⚠️ Busca exata por telefone falhou:', error.response?.data || error.message);
  }

  const orderedVariants = variants
    .filter((variant) => variant.length >= 8)
    .sort((a, b) => b.length - a.length);

  for (const variant of orderedVariants) {
    try {
      const response = await axios.get(
        `${SUPABASE_URL}/rest/v1/leads?telefone=ilike.*${encodeURIComponent(
          variant
        )}*&select=*&order=created_at.desc&limit=20`,
        { headers: getSupabaseHeaders() }
      );

      const rows = Array.isArray(response.data) ? response.data : [];

      if (rows.length > 0) {
        const rankedRows = rows
          .map((row) => ({
            row,
            score: getPhoneMatchScore(normalizedPhone, row.telefone),
          }))
          .filter((item) => item.score >= 65)
          .sort((a, b) => b.score - a.score);

        if (rankedRows.length > 0) {
          console.log('✅ Lead encontrado por ilike + score:', {
            leadId: rankedRows[0].row.id,
            telefoneSalvo: rankedRows[0].row.telefone,
            variante: variant,
            score: rankedRows[0].score,
          });

          return rankedRows[0].row;
        }
      }
    } catch (error) {
      console.warn(
        '⚠️ Busca por ilike telefone falhou:',
        variant,
        error.response?.data || error.message
      );
    }
  }

  try {
    const fallbackResponse = await axios.get(
      `${SUPABASE_URL}/rest/v1/leads?select=*&order=created_at.desc&limit=3000`,
      { headers: getSupabaseHeaders() }
    );

    const candidates = Array.isArray(fallbackResponse.data) ? fallbackResponse.data : [];

    const matches = candidates
      .map((lead) => ({
        lead,
        score: getPhoneMatchScore(normalizedPhone, lead.telefone),
      }))
      .filter((item) => item.score >= 65)
      .sort((a, b) => b.score - a.score);

    if (matches.length > 0) {
      console.log('✅ Lead encontrado por fallback JS normalizado:', {
        leadId: matches[0].lead.id,
        telefoneSalvo: matches[0].lead.telefone,
        score: matches[0].score,
        totalMatches: matches.length,
      });

      return matches[0].lead;
    }

    console.log('⚠️ Fallback JS não encontrou lead compatível:', {
      entrada: normalizedPhone,
      candidatosVerificados: candidates.length,
    });
  } catch (error) {
    console.warn('⚠️ Fallback JS por telefone falhou:', error.response?.data || error.message);
  }

  console.log('❌ Nenhum lead encontrado para telefone:', normalizedPhone);

  return null;
}

async function getLeadById(leadId) {
  const normalizedLeadId = normalizeUuid(leadId);

  if (!normalizedLeadId || !isUuid(normalizedLeadId)) return null;

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${encodeURIComponent(normalizedLeadId)}&select=*`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows[0] || null;
}

async function getLeadMessages(leadId, limit = 12) {
  const normalizedLeadId = normalizeUuid(leadId);

  if (!normalizedLeadId || !isUuid(normalizedLeadId)) return [];

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/lead_messages?lead_id=eq.${encodeURIComponent(
      normalizedLeadId
    )}&select=direction,message_text,created_at&order=created_at.desc&limit=${limit}`,
    { headers: getSupabaseHeaders() }
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows.reverse();
}

async function saveLeadMessage({ leadId, direction, messageText }) {
  const normalizedLeadId = normalizeUuid(leadId);

  if (!normalizedLeadId || !isUuid(normalizedLeadId) || !messageText) return;

  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/lead_messages`,
      {
        lead_id: normalizedLeadId,
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
  const normalizedLeadId = normalizeUuid(leadId);

  if (!isUuid(normalizedLeadId)) return null;

  const now = new Date().toISOString();

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${normalizedLeadId}`,
    {
      last_message_sent_at: now,
      last_message_sent_text: messageText,
    },
    { headers: getSupabaseHeaders() }
  );

  return now;
}

async function updateLeadFields(leadId, fields) {
  const normalizedLeadId = normalizeUuid(leadId);

  if (!isUuid(normalizedLeadId)) {
    console.log('ℹ️ leadId inválido para atualização:', leadId);
    return null;
  }

  const safeFields = Object.fromEntries(
    Object.entries(fields || {}).filter(([, value]) => value !== undefined)
  );

  if (Object.keys(safeFields).length === 0) {
    return null;
  }

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/leads?id=eq.${normalizedLeadId}`,
    safeFields,
    { headers: getSupabaseHeaders() }
  );

  console.log('✅ Lead atualizado:', {
    leadId: normalizedLeadId,
    fields: safeFields,
  });

  return safeFields;
}

async function markClientInteractionByPhone(phone, messageText = '') {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) return null;

  const lead = await getLeadByPhone(normalizedPhone);

  if (!lead) {
    console.log('⚠️ Interação recebida, mas lead não encontrado:', normalizedPhone);
    return null;
  }

  await updateLeadFields(lead.id, {
    last_client_interaction_at: new Date().toISOString(),
  });

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
// SUPABASE - TRIAGEM CLT
// ========================
async function saveLeadTriageAnswer({
  leadId,
  phone,
  questionKey,
  questionText,
  answerValue,
  source = 'whatsapp',
}) {
  if (!questionKey || !answerValue) return null;

  const normalizedLeadId = normalizeUuid(leadId);

  try {
    const payload = {
      lead_id: isUuid(normalizedLeadId) ? normalizedLeadId : null,
      phone: normalizePhone(phone),
      question_key: questionKey,
      question_text: questionText || null,
      answer_value: String(answerValue),
      source,
    };

    await axios.post(
      `${SUPABASE_URL}/rest/v1/lead_triage_answers`,
      payload,
      { headers: getSupabaseHeaders() }
    );

    return payload;
  } catch (error) {
    console.error('⚠️ Erro ao salvar lead_triage_answers:', error.response?.data || error.message);
    return null;
  }
}

async function saveTriageByPhone({
  phone,
  questionKey,
  questionText,
  answerValue,
  leadPatch = {},
}) {
  const normalizedPhone = normalizePhone(phone);
  const lead = await getLeadByPhone(normalizedPhone);

  await saveLeadTriageAnswer({
    leadId: lead?.id || null,
    phone: normalizedPhone,
    questionKey,
    questionText,
    answerValue,
  });

  if (!lead?.id) {
    console.log('❌ Triagem salva sem lead_id porque lead não foi encontrado:', {
      phone: normalizedPhone,
      questionKey,
      answerValue,
    });

    return null;
  }

  if (Object.keys(leadPatch).length > 0) {
    await updateLeadFields(lead.id, leadPatch);
  }

  return lead;
}

async function getLeadTriageAnswers(leadId) {
  const normalizedLeadId = normalizeUuid(leadId);

  if (!isUuid(normalizedLeadId)) return [];

  const response = await axios.get(
    `${SUPABASE_URL}/rest/v1/lead_triage_answers?lead_id=eq.${encodeURIComponent(
      normalizedLeadId
    )}&select=*&order=created_at.asc`,
    { headers: getSupabaseHeaders() }
  );

  return Array.isArray(response.data) ? response.data : [];
}

async function markLeadReadyForPresimulationByPhone(phone, messageText) {
  const normalizedPhone = normalizePhone(phone);
  const lead = await getLeadByPhone(normalizedPhone);

  if (!lead) {
    console.log('ℹ️ Lead não encontrado para marcar pré-simulação:', normalizedPhone);
    return null;
  }

  const parsed = parseNameCpfCompanyBirthDateFromText(messageText);

  await saveLeadTriageAnswer({
    leadId: lead.id,
    phone: normalizedPhone,
    questionKey: 'dados_finais_pre_simulacao',
    questionText: 'Informe nome completo, CPF, data de nascimento e empresa onde trabalha para simulação',
    answerValue: messageText,
  });

  const patch = {
    clt_ready_for_presimulation: true,
    clt_triage_completed_at: new Date().toISOString(),
    etapa: STAGE_IN_PROPOSAL,
    status: STATUS_IN_PROPOSAL,
    is_archived: false,
  };

  if (parsed.name) {
    patch.nome = parsed.name;
  }

  if (parsed.cpf) {
    patch.cpf = parsed.cpf;
  }

  if (typeof parsed.age === 'number') {
    patch.clt_age = parsed.age;
  }

  if (parsed.company) {
    patch.clt_company_name = parsed.company;
    patch.empresa = parsed.company;
  }

  await updateLeadFields(lead.id, patch);

  console.log('✅ Lead pronto para pré-simulação e movido para Em proposta:', {
    leadId: lead.id,
    phone: normalizedPhone,
    parsed,
  });

  return {
    lead,
    parsed,
  };
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
  const normalizedLeadId = normalizeUuid(leadId);

  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/funnel_automation_logs`,
      {
        user_id: userId,
        lead_id: isUuid(normalizedLeadId) ? normalizedLeadId : null,
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
    console.log('⚠️ Template de fluxo não encontrado:', templateKey);
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
// DADOS ROBUSTOS PARA PRÉ-SIMULAÇÃO
// ========================
app.get('/lead-presimulation/:leadId', async (req, res) => {
  try {
    if (!requireBackendApiKey(req, res)) return;

    const receivedLeadId = req.params.leadId;
    const normalizedLeadId = normalizeUuid(receivedLeadId);

    if (!isUuid(normalizedLeadId)) {
      return res.status(400).json({
        success: false,
        error: 'leadId inválido',
        receivedLeadId,
        normalizedLeadId,
      });
    }

    const lead = await getLeadById(normalizedLeadId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado',
        leadId: normalizedLeadId,
      });
    }

    const answers = await getLeadTriageAnswers(normalizedLeadId);

    return res.json({
      success: true,
      data: {
        lead,
        answers,
      },
    });
  } catch (error) {
    console.error('❌ ERRO EM /lead-presimulation:', error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || 'Erro ao buscar dados de pré-simulação',
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

    const phone = getWebhookPhone(data);
    const buttonId = getWebhookButtonId(data);
    const textMessage = getWebhookText(data);

    console.log('📥 WEBHOOK RECEBIDO:', {
      phone,
      buttonId,
      textMessage,
      hasButtonsResponseMessage: Boolean(data?.buttonsResponseMessage),
      type: data?.type || data?.event || null,
    });

    if (!phone) {
      console.log('⚠️ Webhook sem telefone identificável.');
      return res.sendStatus(200);
    }

    const inboundMessage = buttonId
      ? `[BOTÃO ${buttonId}] ${textMessage || ''}`.trim()
      : textMessage;

    await markClientInteractionByPhone(phone, inboundMessage);

    if (buttonId) {
      if (buttonId === '1') {
        await saveTriageByPhone({
          phone,
          questionKey: 'interesse_credito_clt',
          questionText: 'Cliente demonstrou interesse em seguir com a análise?',
          answerValue: 'sim',
          leadPatch: {
            etapa: STAGE_NEW_LEAD,
            status: STATUS_NEW_LEAD,
            is_archived: false,
            clt_ready_for_presimulation: false,
          },
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
        await saveTriageByPhone({
          phone,
          questionKey: 'interesse_credito_clt',
          questionText: 'Cliente demonstrou interesse em seguir com a análise?',
          answerValue: 'nao',
          leadPatch: {
            status: 'Sem interesse',
            clt_ready_for_presimulation: false,
          },
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_2');

        if (!ok) {
          await sendText(phone, 'Tudo bem. Se mudar de ideia, ficamos à disposição.');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '11') {
        await saveTriageByPhone({
          phone,
          questionKey: 'clt_is_working',
          questionText: 'Está trabalhando atualmente?',
          answerValue: 'sim',
          leadPatch: {
            clt_is_working: true,
            etapa: STAGE_IN_ATTENDANCE,
            status: STATUS_IN_ATTENDANCE,
            is_archived: false,
            clt_ready_for_presimulation: false,
          },
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
        await saveTriageByPhone({
          phone,
          questionKey: 'clt_is_working',
          questionText: 'Está trabalhando atualmente?',
          answerValue: 'nao',
          leadPatch: {
            clt_is_working: false,
            clt_ready_for_presimulation: false,
            status: 'Não elegível',
          },
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_12');

        if (!ok) {
          await sendText(phone, 'Essa modalidade exige vínculo CLT ativo.');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '111') {
        await saveTriageByPhone({
          phone,
          questionKey: 'clt_employment_months',
          questionText: 'Há quanto tempo está na empresa atual?',
          answerValue: 'menos_3_meses',
          leadPatch: {
            clt_employment_months: 2,
            clt_ready_for_presimulation: false,
            status: 'Não elegível',
          },
        });

        const ok = await sendTemplateFlow(phone, 'resposta_button_111');

        if (!ok) {
          await sendText(phone, 'Necessário mínimo 3 meses.');
        }

        return res.sendStatus(200);
      }

      if (buttonId === '112' || buttonId === '113') {
        const months = buttonId === '112' ? 6 : 12;
        const answerValue = buttonId === '112' ? '3_a_12_meses' : 'acima_12_meses';

        await saveTriageByPhone({
          phone,
          questionKey: 'clt_employment_months',
          questionText: 'Há quanto tempo está na empresa atual?',
          answerValue,
          leadPatch: {
            clt_employment_months: months,
            etapa: STAGE_IN_ATTENDANCE,
            status: STATUS_IN_ATTENDANCE,
            is_archived: false,
            clt_ready_for_presimulation: false,
          },
        });

        conversationState[phone] = 'aguardando_consignado';

        await sendButtonList(
          phone,
          'Perfeito. Antes de finalizar a pré-análise, me confirma:\n\nVocê já possui consignado ativo?',
          [
            { id: '114', label: 'Sim, possuo' },
            { id: '115', label: 'Não possuo' },
          ]
        );

        return res.sendStatus(200);
      }

      if (buttonId === '114' || buttonId === '115') {
        const hasActiveLoan = buttonId === '114';

        await saveTriageByPhone({
          phone,
          questionKey: 'clt_has_active_loan',
          questionText: 'Cliente possui consignado ativo?',
          answerValue: hasActiveLoan ? 'sim' : 'nao',
          leadPatch: {
            clt_has_active_loan: hasActiveLoan,
            etapa: STAGE_IN_ATTENDANCE,
            status: STATUS_IN_ATTENDANCE,
            is_archived: false,
            clt_ready_for_presimulation: false,
          },
        });

        conversationState[phone] = 'aguardando_dados';

        await sendText(
          phone,
          'Perfeito. Para eu seguir com a análise, me envie seus dados neste formato:\n\nNome completo:\nCPF:\nData de nascimento:\nEmpresa onde trabalha:'
        );

        return res.sendStatus(200);
      }

      console.log('ℹ️ Botão recebido sem regra mapeada:', buttonId);
      return res.sendStatus(200);
    }

    if (conversationState[phone] === 'aguardando_dados' && textMessage.trim()) {
      await markLeadReadyForPresimulationByPhone(phone, textMessage);

      const ok = await sendTemplateFlow(phone, 'resposta_dados_recebidos');

      if (!ok) {
        await sendText(phone, 'Recebi suas informações. Vou analisar e já retorno.');
      }

      conversationState[phone] = 'humano';
      return res.sendStatus(200);
    }

    console.log('ℹ️ Mensagem recebida sem botão e sem estado aguardando dados:', {
      phone,
      state: conversationState[phone] || null,
      textMessage,
    });

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
