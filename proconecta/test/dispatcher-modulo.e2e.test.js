// teste de ponta a ponta: sobe o server.js de verdade (processo separado, contra um data.json
// descartável) e bate na API por HTTP de verdade — prova que o bloqueio por módulo funciona mesmo
// pra quem chama a API direto (sem passar pelo menu do front, que é só cosmético).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosComSoBiblioteca() {
  const { salt, hash } = hashSenha('senha1234');
  return {
    usuarios: [{ id: 1, nome: 'Admin Teste', email: 'admin@teste-modulo.com', papel: 'administrador', status: 'ativo', empresa_id: 1, salt, hash }],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [{
      id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [],
      cor_primaria: '#000', cor_secundaria: '#000',
      versao_id: 1, modulos_ativos: ['biblioteca'], terminologia: {},
    }],
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

test('rota de módulo inativo devolve 403 pela API de verdade, mesmo direto por fetch', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-modulo-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComSoBiblioteca()));
  const porta = 34000 + Math.floor(Math.random() * 5000);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);

    // sem login nenhum: rota de núcleo exige autenticação
    const semLogin = await fetch(`http://localhost:${porta}/api/clientes`);
    assert.equal(semLogin.status, 401);

    const loginResp = await fetch(`http://localhost:${porta}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@teste-modulo.com', senha: 'senha1234' }),
    });
    assert.equal(loginResp.status, 200);
    const { token } = await loginResp.json();
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    // núcleo: sempre disponível, qualquer que seja o módulo ativo
    const me = await fetch(`http://localhost:${porta}/api/me`, auth);
    assert.equal(me.status, 200);

    // biblioteca está ativa pra essa empresa: passa
    const registros = await fetch(`http://localhost:${porta}/api/registros`, auth);
    assert.equal(registros.status, 200);

    // os_chamados NÃO está ativo pra essa empresa: 403, mesmo com token válido e rota existindo
    const agenda = await fetch(`http://localhost:${porta}/api/agenda`, auth);
    assert.equal(agenda.status, 403);
    const corpoAgenda = await agenda.json();
    assert.match(corpoAgenda.erro, /os_chamados/);

    // POST também é bloqueado, não só GET
    const novaOs = await fetch(`http://localhost:${porta}/api/agenda`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(novaOs.status, 403);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
