// RCM/FMEA (evolução "de registro pra análise de manutenção"), Fase 1/passo 1: fundação de dados
// do catálogo em cascata Componente → Modo de falha → Causa → Efeito, cadastrado pelo
// administrador por modelo de equipamento (o item do catálogo com cliente_id null). Prova, pela
// API HTTP de verdade: CRUD completo da cascata, cálculo de RPN = S×O×D, validação da escala
// 1-10, exclusão bloqueada quando há filho cadastrado embaixo, isolamento por empresa, e que só
// administrador escreve (qualquer autenticado lê).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico', email: 'tecnico@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin Dois', email: 'admin2@x.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], agenda: [], visitas: [],
    equipamentos: [
      // catálogo (modelo, sem cliente) — é o que o FMEA referencia como "por modelo de equipamento"
      { id: 1, empresa_id: 1, cliente_id: null, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: '', data_fabricacao: '', localizacao: '' },
      // unidade já atrelada a um cliente — não pode virar componente FMEA (não é um "modelo" do catálogo)
      { id: 2, empresa_id: 1, cliente_id: 1, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: 'SN-001', data_fabricacao: '', localizacao: '' },
      { id: 3, empresa_id: 2, cliente_id: null, tipo: 'Impressora', modelo: 'Y100', numero_serie: '', data_fabricacao: '', localizacao: '' },
    ],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 4, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa Um', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
      { id: 2, nome: 'Empresa Dois', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
  };
}

async function aguardarServidorSubir(porta) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${porta}/api/empresa`);
      if (r.ok) return;
    } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não subiu a tempo');
}

test('FMEA passo 1: cascata Componente→Modo de falha→Causa→Efeito, RPN, validação, exclusão bloqueada e isolamento', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-fmea-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 40500 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const login = async (email) => {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: 'senha1234' }),
      });
      return (await r.json()).token;
    };
    const tokenAdmin = await login('admin@x.com');
    const tokenTecnico = await login('tecnico@x.com');
    const tokenAdmin2 = await login('admin2@x.com');
    const authAdmin = { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' };
    const authTecnico = { Authorization: `Bearer ${tokenTecnico}`, 'Content-Type': 'application/json' };
    const authAdmin2 = { Authorization: `Bearer ${tokenAdmin2}`, 'Content-Type': 'application/json' };

    // técnico não cadastra componente (só lê)
    const tentativaTecnico = await fetch(`${base}/api/fmea/componentes`, {
      method: 'POST', headers: authTecnico, body: JSON.stringify({ catalogo_id: 1, nome: 'Fonte de alimentação' }),
    });
    assert.equal(tentativaTecnico.status, 403);

    // não cadastra componente numa unidade já atrelada a cliente (id 2), só num modelo de catálogo (id 1)
    const componenteUnidadeAtrelada = await fetch(`${base}/api/fmea/componentes`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({ catalogo_id: 2, nome: 'Fonte de alimentação' }),
    });
    assert.equal(componenteUnidadeAtrelada.status, 400);

    // cadastra componente de verdade
    const criarComponente = await fetch(`${base}/api/fmea/componentes`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({ catalogo_id: 1, nome: 'Fonte de alimentação' }),
    });
    assert.equal(criarComponente.status, 201);
    const { componente } = await criarComponente.json();
    assert.equal(componente.catalogo_id, 1);

    // técnico lê (listagem filtrada por catalogo_id)
    const listaComponentes = await (await fetch(`${base}/api/fmea/componentes?catalogo_id=1`, { headers: authTecnico })).json();
    assert.equal(listaComponentes.componentes.length, 1);

    // modo de falha: valida escala 1-10
    const severidadeInvalida = await fetch(`${base}/api/fmea/modos-falha`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ componente_id: componente.id, nome: 'Queima do capacitor', severidade: 11, ocorrencia: 5, deteccao: 3 }),
    });
    assert.equal(severidadeInvalida.status, 400);

    // modo de falha válido — RPN calculado no servidor
    const criarModoFalha = await fetch(`${base}/api/fmea/modos-falha`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ componente_id: componente.id, nome: 'Queima do capacitor', severidade: 8, ocorrencia: 5, deteccao: 3 }),
    });
    assert.equal(criarModoFalha.status, 201);
    const { modo_falha: modoFalha } = await criarModoFalha.json();
    assert.equal(modoFalha.rpn, 8 * 5 * 3);

    // edita o modo de falha — RPN recalculado
    const editarModoFalha = await fetch(`${base}/api/fmea/modos-falha/${modoFalha.id}`, {
      method: 'PUT', headers: authAdmin,
      body: JSON.stringify({ nome: 'Queima do capacitor', severidade: 10, ocorrencia: 10, deteccao: 10 }),
    });
    assert.equal((await editarModoFalha.json()).modo_falha.rpn, 1000);

    // causa e efeito, fechando a cascata
    const criarCausa = await fetch(`${base}/api/fmea/causas`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ modo_falha_id: modoFalha.id, nome: 'Sobretensão na rede elétrica' }),
    });
    assert.equal(criarCausa.status, 201);
    const { causa } = await criarCausa.json();

    const criarEfeito = await fetch(`${base}/api/fmea/efeitos`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ causa_id: causa.id, nome: 'Equipamento desliga e não liga mais' }),
    });
    assert.equal(criarEfeito.status, 201);

    // exclusão bloqueada: componente tem modo de falha embaixo
    const excluirComponenteComFilho = await fetch(`${base}/api/fmea/componentes/${componente.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(excluirComponenteComFilho.status, 400);

    // exclusão bloqueada: modo de falha tem causa embaixo
    const excluirModoFalhaComFilho = await fetch(`${base}/api/fmea/modos-falha/${modoFalha.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(excluirModoFalhaComFilho.status, 400);

    // exclusão bloqueada: causa tem efeito embaixo
    const excluirCausaComFilho = await fetch(`${base}/api/fmea/causas/${causa.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(excluirCausaComFilho.status, 400);

    // isolamento por empresa: admin da empresa 2 não vê nada da empresa 1
    const componentesEmpresa2 = await (await fetch(`${base}/api/fmea/componentes`, { headers: authAdmin2 })).json();
    assert.equal(componentesEmpresa2.componentes.length, 0);

    // admin da empresa 2 não cadastra componente usando o catálogo da empresa 1 (buscar isolado por tenant)
    const vazamentoEntreEmpresas = await fetch(`${base}/api/fmea/componentes`, {
      method: 'POST', headers: authAdmin2, body: JSON.stringify({ catalogo_id: 1, nome: 'Tentativa de vazamento' }),
    });
    assert.equal(vazamentoEntreEmpresas.status, 400);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
