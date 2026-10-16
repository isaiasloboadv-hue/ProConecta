// SaaS, passo 2 (Validade do trial) — empresa com status 'teste' e criado_em mais antigo que
// DIAS_TRIAL vira 'teste_expirado' na primeira requisição que detectar isso (login ou qualquer
// rota autenticada), bloqueando como a empresa suspensa já bloqueia, mas com mensagem própria.
// Usa DIAS_TRIAL=1 via env pra não depender de esperar dias de verdade no teste.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function diasAtras(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function dadosComTrials() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PRO', email: 'admin@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin Trial Vencido', email: 'admin@trialvencido.com.br', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
      { id: 3, nome: 'Admin Trial Novo', email: 'admin@trialnovo.com.br', papel: 'administrador', status: 'ativo', empresa_id: 3, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, status: 'ativa' },
      { id: 2, nome: 'Trial Vencido', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, status: 'teste', criado_em: diasAtras(30) },
      { id: 3, nome: 'Trial Novo', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, status: 'teste', criado_em: diasAtras(0) },
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

test('trial expirado: bloqueia login e rotas, vira teste_expirado na primeira detecção, trial novo não é afetado, empresa 1 nunca é afetada', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-trial-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComTrials()));
  const porta = 39100 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '', DIAS_TRIAL: '14' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const login = async (email) => fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha: 'senha1234' }),
    });

    // trial vencido (30 dias, limite 14): login bloqueado com mensagem própria
    const loginVencido = await login('admin@trialvencido.com.br');
    assert.equal(loginVencido.status, 403);
    const corpoVencido = await loginVencido.json();
    assert.equal(corpoVencido.codigo, 'teste_expirado');
    assert.match(corpoVencido.erro, /período de teste acabou/);

    // o status já virou teste_expirado no disco, na primeira detecção (o próprio login)
    const dataAposLogin = JSON.parse(fs.readFileSync(dbTemp, 'utf8'));
    assert.equal(dataAposLogin.empresas.find((e) => e.id === 2).status, 'teste_expirado');

    // trial novo (criado agora, dentro do limite): loga normalmente
    const loginNovo = await login('admin@trialnovo.com.br');
    assert.equal(loginNovo.status, 200);
    const { token: tokenNovo } = await loginNovo.json();
    assert.ok(tokenNovo);
    const rotaNovo = await fetch(`${base}/api/clientes`, { headers: { Authorization: `Bearer ${tokenNovo}` } });
    assert.equal(rotaNovo.status, 200);

    // empresa 1 nunca é afetada (status 'ativa', nunca passa a ser 'teste')
    const loginPro = await login('admin@promarking.com.br');
    assert.equal(loginPro.status, 200);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

test('trial expirado: bloqueia também quem já estava logado (checagem central no dispatcher), não só o login novo', async () => {
  const dados = dadosComTrials();
  // nasce dentro do prazo (5 dias, limite 14) — login tem que funcionar normalmente primeiro
  dados.empresas[1].criado_em = diasAtras(5);
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-trial-sessao-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados));
  const porta = 39200 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '', DIAS_TRIAL: '14' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;

    // loga dentro do prazo: funciona, pega o token (sessão já aberta)
    const loginOk = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@trialvencido.com.br', senha: 'senha1234' }),
    });
    assert.equal(loginOk.status, 200);
    const { token } = await loginOk.json();
    const authHeader = { Authorization: `Bearer ${token}` };

    // token funciona normalmente enquanto o trial está válido
    const antesDeVencer = await fetch(`${base}/api/clientes`, { headers: authHeader });
    assert.equal(antesDeVencer.status, 200);

    // o prazo vence "enquanto a sessão já estava aberta" — reescreve o arquivo com criado_em
    // mais antigo que o limite (db.load() em modo arquivo sempre lê do disco de novo, ver db.js)
    const dadosNoDisco = JSON.parse(fs.readFileSync(dbTemp, 'utf8'));
    dadosNoDisco.empresas.find((e) => e.id === 2).criado_em = diasAtras(30);
    fs.writeFileSync(dbTemp, JSON.stringify(dadosNoDisco));

    // mesmo token, sem logar de novo: a checagem central no dispatcher (não só o login) pega
    const depoisDeVencer = await fetch(`${base}/api/clientes`, { headers: authHeader });
    assert.equal(depoisDeVencer.status, 403);
    assert.equal((await depoisDeVencer.json()).codigo, 'teste_expirado');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
