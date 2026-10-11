// SaaS, passo 1 (Cadastro/trial self-service) — quem ainda não é cliente cria a própria empresa
// (sempre nasce status 'teste') e o primeiro administrador numa chamada só, sem depender do Super
// Admin. Prova pela API HTTP de verdade: validações, token de login imediato, rota pública (sem
// Bearer), e-mail duplicado recusado.
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
      { id: 1, nome: 'Admin PRO', email: 'ja-existe@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, empresas: 2 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000' },
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

test('cadastro self-service: valida campos, cria empresa em teste + administrador, devolve token, recusa e-mail duplicado', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-cadastro-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosBase()));
  const porta = 38900 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;

    // sem campos: recusa, e sem Bearer nenhum (rota pública)
    const semCampos = await fetch(`${base}/api/cadastro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(semCampos.status, 400);

    // senha curta: recusa
    const senhaCurta = await fetch(`${base}/api/cadastro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome_empresa: 'Empresa Nova', nome: 'Fulano', email: 'fulano@empresanova.com.br', senha: '123' }),
    });
    assert.equal(senhaCurta.status, 400);

    // cadastro válido
    const r = await fetch(`${base}/api/cadastro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome_empresa: 'Empresa Nova', nome: 'Fulano', email: 'fulano@empresanova.com.br', senha: 'senha1234' }),
    });
    assert.equal(r.status, 201);
    const { token, usuario } = await r.json();
    assert.ok(token, 'devolve token pra já entrar logado');
    assert.equal(usuario.papel, 'administrador');
    assert.equal(usuario.empresa.nome, 'Empresa Nova');
    assert.deepEqual(usuario.modulos_ativos.sort(), ['biblioteca', 'os_chamados', 'smp_preventivas'].sort());

    // o token devolvido já funciona de verdade
    const me = await fetch(`${base}/api/clientes`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);

    // a empresa nasceu em teste
    const dataNoDisco = JSON.parse(fs.readFileSync(dbTemp, 'utf8'));
    const empresaCriada = dataNoDisco.empresas.find((e) => e.nome === 'Empresa Nova');
    assert.equal(empresaCriada.status, 'teste');
    assert.ok(empresaCriada.criado_em);

    // e-mail já usado: recusa
    const duplicado = await fetch(`${base}/api/cadastro`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome_empresa: 'Outra', nome: 'X', email: 'ja-existe@promarking.com.br', senha: 'senha1234' }),
    });
    assert.equal(duplicado.status, 409);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
