// ========================
// CNPJ - CONSULTA BRASILAPI
// ========================

function cleanCNPJ(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

async function fetchCNPJFromBrasilAPI(cnpj) {
  const clean = cleanCNPJ(cnpj);

  if (clean.length !== 14) {
    throw new Error('CNPJ inválido');
  }

  const url = `https://brasilapi.com.br/api/cnpj/v1/${clean}`;

  const response = await axios.get(url);

  return response.data;
}

async function upsertCompanyProfile(data) {
  const payload = {
    cnpj: data.cnpj,
    razao_social: data.razao_social,
    nome_fantasia: data.nome_fantasia,
    situacao_cadastral: data.descricao_situacao_cadastral,
    data_abertura: data.data_inicio_atividade,
    natureza_juridica: data.natureza_juridica,
    porte: data.porte,

    cnae_principal_codigo: data.cnae_fiscal,
    cnae_principal_descricao: data.cnae_fiscal_descricao,

    cnaes_secundarios: data.cnaes_secundarios || [],

    endereco: {
      logradouro: data.logradouro,
      numero: data.numero,
      municipio: data.municipio,
      uf: data.uf,
      cep: data.cep,
    },

    socios: data.qsa || [],
    raw_data: data,

    last_checked_at: new Date().toISOString(),
  };

  await axios.post(
    `${SUPABASE_URL}/rest/v1/company_profiles`,
    payload,
    {
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'resolution=merge-duplicates'
      }
    }
  );

  return payload;
}
