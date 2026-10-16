#!/usr/bin/env node
// scripts/seed-pmoc-demo.js — cria uma empresa de demonstração do pacote "Climatização / PMOC"
// (perfil Refrigeração e Climatização + módulo `pmoc` ativo), já com dados de exemplo pra validar
// a Fase 1 (Cadastro) sem precisar preencher tudo manualmente: 2 clientes, 3 locais (estabelecimentos),
// vários ambientes e 15 aparelhos de climatização, mais 1 responsável técnico.
//
// Não existe, hoje, nenhum mecanismo de seed de demonstração no projeto (toda empresa nasce
// vazia, via /api/cadastro ou pelo Super Admin) — por isso isso é um script avulso, não uma rota
// nem parte de migrar()/seed() em db.js, pra não arriscar poluir instalações reais. Idempotente:
// rodar de novo com a empresa já criada só avisa e não duplica nada.
//
// Uso: node scripts/seed-pmoc-demo.js   (ou DB_PATH_ARQUIVO=... node scripts/seed-pmoc-demo.js
// pra rodar contra um arquivo de banco separado, ex. no ambiente de teste manual)
//
// Rode com o servidor PARADO — este script lê/escreve o arquivo de banco direto (mesma técnica
// dos outros scripts/*.js), sem passar pela API, então uma gravação concorrente do servidor rodando
// ao mesmo tempo pode se perder.

const db = require('../db.js');
const tenant = require('../tenant.js');

const NOME_EMPRESA_DEMO = 'Climatiza Demo Refrigeração';
const EMAIL_ADMIN_DEMO = 'admin@climatizademo.com.br';
const SENHA_ADMIN_DEMO = 'demo1234';

async function main() {
  await db.pronto;
  const data = db.load();

  if (data.empresas.some((e) => e.nome === NOME_EMPRESA_DEMO)) {
    const existente = data.empresas.find((e) => e.nome === NOME_EMPRESA_DEMO);
    console.log(`Empresa demo já existe (id ${existente.id}) — nada foi criado de novo.`);
    console.log(`Login: ${EMAIL_ADMIN_DEMO} / ${SENHA_ADMIN_DEMO}`);
    return;
  }

  // ---- empresa (perfil Refrigeração + módulo pmoc, mesmo formato de POST /api/plataforma/empresas) ----
  const preset = db.presetPerfilSegmento('refrigeracao', 'generico');
  const empresa = {
    id: db.nextId(data, 'empresas'),
    nome: NOME_EMPRESA_DEMO,
    subdominio: null,
    site: '', whatsapp: '', telefone: '(12) 3333-4444',
    emails: [EMAIL_ADMIN_DEMO],
    cor_primaria: '#0B2D4F', cor_secundaria: '#0891B2',
    versao_id: null,
    modulos_ativos: ['pmoc'],
    terminologia: preset.terminologia,
    perfil: 'refrigeracao',
    segmento: 'generico',
    tipos_os_ativos: preset.tipos_os_ativos,
    tipos_relatorio_ativos: preset.tipos_relatorio_ativos,
    escala_ativa: preset.escala_ativa,
    limite_tecnicos: null,
    limite_equipamentos: null,
    status: 'ativa',
    plano_valor_mensal: null,
    plano_dia_vencimento: null,
  };
  data.empresas.push(empresa);

  // ---- administrador (pra conseguir logar e navegar na demo) ----
  const { salt, hash } = db.hashSenha(SENHA_ADMIN_DEMO);
  tenant.criar(data, 'usuarios', empresa.id, {
    nome: 'Administrador Demo', email: EMAIL_ADMIN_DEMO, papel: 'administrador',
    cargo: '', setor: '', celular: '', cliente_id: null,
    acesso_total: true, menus: [], departamento: null,
    status: 'ativo', convite_token: null, salt, hash,
  });

  // ---- clientes (os_refrigeracao_clientes — próprio desse perfil, não a coleção núcleo) ----
  const clienteSupermercado = tenant.criar(data, 'os_refrigeracao_clientes', empresa.id, {
    nome: 'Supermercado Boa Compra Ltda', telefone: '(12) 3222-1000', email: 'manutencao@boacompra.com.br',
    cpf_cnpj: '12.345.678/0001-90', endereco: 'Av. Brasil, 1500 — Centro', criado_em: new Date().toISOString(),
  });
  const clienteClinica = tenant.criar(data, 'os_refrigeracao_clientes', empresa.id, {
    nome: 'Clínica Vida Plena', telefone: '(12) 3222-2000', email: 'contato@vidaplena.com.br',
    cpf_cnpj: '98.765.432/0001-10', endereco: 'Rua das Acácias, 220 — Jardim das Flores', criado_em: new Date().toISOString(),
  });

  // ---- locais (3) ----
  function criarLocal(clienteId, campos) {
    return tenant.criar(data, 'os_refrigeracao_pmoc_locais', empresa.id, {
      cliente_id: clienteId, responsavel_nome: '', responsavel_telefone: '', responsavel_email: '',
      criado_em: new Date().toISOString(), ...campos,
    });
  }
  const localLojaCentro = criarLocal(clienteSupermercado.id, {
    nome: 'Loja Centro', endereco: 'Av. Brasil, 1500 — Centro', tipo_atividade: 'loja',
    area_climatizada_m2: 850, ocupantes_fixos: 40, ocupantes_flutuantes: 300,
    responsavel_nome: 'Marcos Silveira', responsavel_telefone: '(12) 98888-1111', responsavel_email: 'marcos@boacompra.com.br',
  });
  const localLojaNorte = criarLocal(clienteSupermercado.id, {
    nome: 'Loja Zona Norte', endereco: 'Rua Palmeiras, 80 — Zona Norte', tipo_atividade: 'loja',
    area_climatizada_m2: 620, ocupantes_fixos: 28, ocupantes_flutuantes: 200,
    responsavel_nome: 'Juliana Prado', responsavel_telefone: '(12) 98888-2222', responsavel_email: 'juliana@boacompra.com.br',
  });
  const localClinica = criarLocal(clienteClinica.id, {
    nome: 'Unidade Matriz', endereco: 'Rua das Acácias, 220 — Jardim das Flores', tipo_atividade: 'clinica',
    area_climatizada_m2: 310, ocupantes_fixos: 18, ocupantes_flutuantes: 60,
    responsavel_nome: 'Dra. Fernanda Costa', responsavel_telefone: '(12) 98888-3333', responsavel_email: 'fernanda@vidaplena.com.br',
  });

  // ---- ambientes + aparelhos (15 no total) ----
  function criarAmbiente(localId, campos) {
    return tenant.criar(data, 'os_refrigeracao_pmoc_ambientes', empresa.id, { local_id: localId, criado_em: new Date().toISOString(), ...campos });
  }
  function criarAparelho(ambienteId, campos) {
    return tenant.criar(data, 'os_refrigeracao_pmoc_aparelhos', empresa.id, {
      marca: '', modelo: '', numero_serie: '', fluido_refrigerante: 'R-410A', tensao: '220V',
      codigo_patrimonio: '', status: 'ativo', qr_token: db.gerarQrToken(), criado_em: new Date().toISOString(),
      ambiente_id: ambienteId, ...campos,
    });
  }

  // Loja Centro — Salão de vendas (3), Depósito (1), Escritório (1) = 5
  const ambSalaoCentro = criarAmbiente(localLojaCentro.id, { nome: 'Salão de vendas', andar: 'Térreo', area_m2: 600, ocupantes: 250 });
  criarAparelho(ambSalaoCentro.id, { tipo: 'Cassete', marca: 'Daikin', modelo: 'FCNQ36', capacidade_btu: '36000', data_instalacao: '2022-03-10', garantia_ate: '2027-03-10' });
  criarAparelho(ambSalaoCentro.id, { tipo: 'Cassete', marca: 'Daikin', modelo: 'FCNQ36', capacidade_btu: '36000', data_instalacao: '2022-03-10', garantia_ate: '2027-03-10' });
  criarAparelho(ambSalaoCentro.id, { tipo: 'Self-contained', marca: 'Carrier', modelo: '42XQ060', capacidade_btu: '60000', data_instalacao: '2021-11-02', garantia_ate: '2024-11-02', status: 'parado' });
  const ambDeposito = criarAmbiente(localLojaCentro.id, { nome: 'Depósito', andar: 'Térreo', area_m2: 120, ocupantes: 6 });
  criarAparelho(ambDeposito.id, { tipo: 'Split hi-wall', marca: 'Springer Midea', modelo: '42MCA12', capacidade_btu: '12000', data_instalacao: '2023-01-20', garantia_ate: '2026-01-20' });
  const ambEscritorioCentro = criarAmbiente(localLojaCentro.id, { nome: 'Escritório', andar: '1º andar', area_m2: 40, ocupantes: 4 });
  criarAparelho(ambEscritorioCentro.id, { tipo: 'Split hi-wall', marca: 'LG', modelo: 'S4-W12', capacidade_btu: '12000', data_instalacao: '2023-06-05', garantia_ate: '2026-06-05' });

  // Loja Zona Norte — Salão de vendas (3), Caixas/Frente de loja (2) = 5
  const ambSalaoNorte = criarAmbiente(localLojaNorte.id, { nome: 'Salão de vendas', andar: 'Térreo', area_m2: 420, ocupantes: 180 });
  criarAparelho(ambSalaoNorte.id, { tipo: 'Piso-teto', marca: 'Fujitsu', modelo: 'ABYG30', capacidade_btu: '30000', data_instalacao: '2022-08-14', garantia_ate: '2025-08-14' });
  criarAparelho(ambSalaoNorte.id, { tipo: 'Piso-teto', marca: 'Fujitsu', modelo: 'ABYG30', capacidade_btu: '30000', data_instalacao: '2022-08-14', garantia_ate: '2025-08-14' });
  criarAparelho(ambSalaoNorte.id, { tipo: 'Cassete', marca: 'LG', modelo: 'ATNQ36', capacidade_btu: '36000', data_instalacao: '2022-08-14', garantia_ate: '2025-08-14', status: 'aguardando_peca' });
  const ambCaixas = criarAmbiente(localLojaNorte.id, { nome: 'Caixas / Frente de loja', andar: 'Térreo', area_m2: 80, ocupantes: 10 });
  criarAparelho(ambCaixas.id, { tipo: 'Split hi-wall', marca: 'Samsung', modelo: 'AR12', capacidade_btu: '12000', data_instalacao: '2023-02-18', garantia_ate: '2026-02-18' });
  criarAparelho(ambCaixas.id, { tipo: 'Split hi-wall', marca: 'Samsung', modelo: 'AR12', capacidade_btu: '12000', data_instalacao: '2023-02-18', garantia_ate: '2026-02-18' });

  // Clínica Vida Plena — Recepção (1), Consultório 1 (1), Consultório 2 (1), Sala de espera (2) = 5
  const ambRecepcao = criarAmbiente(localClinica.id, { nome: 'Recepção', andar: 'Térreo', area_m2: 35, ocupantes: 8 });
  criarAparelho(ambRecepcao.id, { tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'FTKM12', capacidade_btu: '12000', fluido_refrigerante: 'R-32', data_instalacao: '2023-04-01', garantia_ate: '2026-04-01' });
  const ambConsultorio1 = criarAmbiente(localClinica.id, { nome: 'Consultório 1', andar: 'Térreo', area_m2: 18, ocupantes: 3 });
  criarAparelho(ambConsultorio1.id, { tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'FTKM09', capacidade_btu: '9000', fluido_refrigerante: 'R-32', data_instalacao: '2023-04-01', garantia_ate: '2026-04-01' });
  const ambConsultorio2 = criarAmbiente(localClinica.id, { nome: 'Consultório 2', andar: 'Térreo', area_m2: 18, ocupantes: 3 });
  criarAparelho(ambConsultorio2.id, { tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'FTKM09', capacidade_btu: '9000', fluido_refrigerante: 'R-32', data_instalacao: '2023-04-01', garantia_ate: '2026-04-01' });
  const ambEspera = criarAmbiente(localClinica.id, { nome: 'Sala de espera', andar: 'Térreo', area_m2: 45, ocupantes: 15 });
  criarAparelho(ambEspera.id, { tipo: 'Cassete', marca: 'LG', modelo: 'ATNQ18', capacidade_btu: '18000', data_instalacao: '2023-04-01', garantia_ate: '2026-04-01' });
  criarAparelho(ambEspera.id, { tipo: 'Cassete', marca: 'LG', modelo: 'ATNQ18', capacidade_btu: '18000', data_instalacao: '2023-04-01', garantia_ate: '2026-04-01' });

  // ---- responsável técnico ----
  tenant.criar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', empresa.id, {
    nome: 'Carlos Eduardo Lima', formacao: 'Técnico em Refrigeração e Climatização',
    registro_profissional: 'CFT-SP 123456', email: 'carlos.lima@climatizademo.com.br', telefone: '(12) 98888-4444',
    assinatura_img: null, criado_em: new Date().toISOString(),
  });

  db.save(data);

  const totalAparelhos = data.os_refrigeracao_pmoc_aparelhos.filter((a) => a.empresa_id === empresa.id).length;
  console.log(`Empresa demo criada (id ${empresa.id}): ${NOME_EMPRESA_DEMO}`);
  console.log(`Login: ${EMAIL_ADMIN_DEMO} / ${SENHA_ADMIN_DEMO}`);
  console.log(`2 clientes, 3 locais, ${totalAparelhos} aparelhos.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
