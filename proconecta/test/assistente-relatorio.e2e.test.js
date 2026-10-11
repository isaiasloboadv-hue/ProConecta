// POST /api/ia/assistente-relatorio — gating e validações da rota do Assistente IA (sem bater na
// API da Anthropic de verdade: o servidor de teste sobe sem ANTHROPIC_API_KEY, então cai sempre
// no branch "não configurado" depois de passar pelas checagens de papel/corpo — a lógica de
// chamada à IA em si já é testada isoladamente em test/ia-assistente-relatorio.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosBase() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Suporte PRO', email: 'suporte@promarking.com.br', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Cliente PRO', email: 'cliente@promarking.com.br', papel: 'cliente', status: 'ativo', empresa_id: 1, cliente_id: null, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
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

test('assistente-relatorio: papel errado recusa, sem IA configurada recusa, validação de corpo', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-assistente-ia-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosBase()));
  const porta = 39400 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    // sem ANTHROPIC_API_KEY de propósito: ia.ativa() tem que devolver false aqui
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '', ANTHROPIC_API_KEY: '' },
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
    const tokenSuporte = await login('suporte@promarking.com.br');
    const tokenCliente = await login('cliente@promarking.com.br');
    const authSuporte = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSuporte}` };
    const authCliente = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenCliente}` };

    const corpoValido = { tipo: 'corretiva', mensagens: [{ role: 'user', texto: 'troquei o rolamento' }], campos: [{ chave: 'defeito_informado', rotulo: 'Defeito informado' }] };

    // papel sem permissão pra criar relatório
    const negado = await fetch(`${base}/api/ia/assistente-relatorio`, { method: 'POST', headers: authCliente, body: JSON.stringify(corpoValido) });
    assert.equal(negado.status, 403);

    // IA não configurada (sem ANTHROPIC_API_KEY)
    const naoConfigurada = await fetch(`${base}/api/ia/assistente-relatorio`, { method: 'POST', headers: authSuporte, body: JSON.stringify(corpoValido) });
    assert.equal(naoConfigurada.status, 400);
    assert.match((await naoConfigurada.json()).erro, /não está configurado/);

    // sem tipo/campos
    const semTipo = await fetch(`${base}/api/ia/assistente-relatorio`, { method: 'POST', headers: authSuporte, body: JSON.stringify({ ...corpoValido, tipo: '', campos: [] }) });
    assert.equal(semTipo.status, 400);

    // sem mensagens
    const semMensagens = await fetch(`${base}/api/ia/assistente-relatorio`, { method: 'POST', headers: authSuporte, body: JSON.stringify({ ...corpoValido, mensagens: [] }) });
    assert.equal(semMensagens.status, 400);

    // sem token nenhum
    const semToken = await fetch(`${base}/api/ia/assistente-relatorio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpoValido) });
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
