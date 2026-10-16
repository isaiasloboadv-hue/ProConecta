// CRM nativo, passo 3 (Propostas/Orçamentos) — abertas a partir da tela da Oportunidade: itens de
// linha de verdade (quantidade x valor unitário), valor_total calculado no servidor, fluxo de
// status (rascunho → enviada → aceita/recusada), isolamento por empresa via tenant.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosDuasEmpresas() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Comercial PRO', email: 'comercial@promarking.com.br', papel: 'comercial', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin BRB', email: 'admin@brb.com.br', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], leads: [],
    oportunidades: [
      { id: 1, titulo: 'Retrofit linha 2', cliente_id: null, lead_id: null, estagio: 'proposta', valor_estimado: '', descricao: '', observacoes: '', origem: 'manual', devolutivo_id: null, empresa_id: 1 },
    ],
    propostas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, leads: 1, oportunidades: 2, propostas: 1 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial'], terminologia: {} },
      { id: 2, nome: 'BRB', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#333', cor_secundaria: '#666', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados', 'smp_preventivas', 'biblioteca'] }],
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

test('propostas: cadastro com itens calcula total, fluxo de status, validações, isolamento por empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-propostas-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresas()));
  const porta = 38500 + Math.floor(Math.random() * 900);

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
    const tokenPro = await login('comercial@promarking.com.br');
    const tokenBrb = await login('admin@brb.com.br');
    const authPro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPro}` };
    const authBrb = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenBrb}` };

    // sem itens válidos: recusa
    const semItens = await fetch(`${base}/api/propostas`, {
      method: 'POST', headers: authPro, body: JSON.stringify({ oportunidade_id: 1, itens: [] }),
    });
    assert.equal(semItens.status, 400);

    // oportunidade de outra empresa: recusa
    const oportunidadeErrada = await fetch(`${base}/api/propostas`, {
      method: 'POST', headers: authBrb, body: JSON.stringify({ oportunidade_id: 1, itens: [{ descricao: 'x', quantidade: 1, valor_unitario: 10 }] }),
    });
    assert.equal(oportunidadeErrada.status, 400);

    // cadastro válido: total calculado no servidor
    const criar = await fetch(`${base}/api/propostas`, {
      method: 'POST', headers: authPro,
      body: JSON.stringify({
        oportunidade_id: 1,
        itens: [
          { descricao: 'Sensor de presença', quantidade: 2, valor_unitario: 500 },
          { descricao: 'Instalação', quantidade: 1, valor_unitario: 1200 },
        ],
        validade: '2026-12-31',
        observacoes: '50% de entrada, 50% na entrega. Garantia de 12 meses.',
      }),
    });
    assert.equal(criar.status, 201);
    const proposta = (await criar.json()).proposta;
    assert.equal(proposta.valor_total, 2200);
    assert.equal(proposta.status, 'rascunho');
    // pedido do usuário: "gerador de orçamento profissional" — condições de pagamento/garantia
    // que entram no PDF (ver gerarPdfProposta, app.js).
    assert.equal(proposta.observacoes, '50% de entrada, 50% na entrega. Garantia de 12 meses.');

    // edita só as observações, sem mexer nos itens
    const editaObs = await fetch(`${base}/api/propostas/${proposta.id}`, {
      method: 'PUT', headers: authPro, body: JSON.stringify({ observacoes: 'Frete por conta do cliente.' }),
    });
    const propostaEditada = (await editaObs.json()).proposta;
    assert.equal(propostaEditada.observacoes, 'Frete por conta do cliente.');
    assert.equal(propostaEditada.valor_total, 2200);

    // fluxo de status
    const enviar = await fetch(`${base}/api/propostas/${proposta.id}`, { method: 'PUT', headers: authPro, body: JSON.stringify({ status: 'enviada' }) });
    assert.equal((await enviar.json()).proposta.status, 'enviada');
    const aceitar = await fetch(`${base}/api/propostas/${proposta.id}`, { method: 'PUT', headers: authPro, body: JSON.stringify({ status: 'aceita' }) });
    assert.equal((await aceitar.json()).proposta.status, 'aceita');

    // status inválido é recusado
    const statusInvalido = await fetch(`${base}/api/propostas/${proposta.id}`, { method: 'PUT', headers: authPro, body: JSON.stringify({ status: 'cancelada' }) });
    assert.equal(statusInvalido.status, 400);

    // filtro por oportunidade_id
    const lista = await fetch(`${base}/api/propostas?oportunidade_id=1`, { headers: authPro });
    assert.equal((await lista.json()).propostas.length, 1);

    // isolamento: BRB não vê a proposta da PRO Marking
    const listaBrb = await fetch(`${base}/api/propostas`, { headers: authBrb });
    assert.equal((await listaBrb.json()).propostas.length, 0);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
