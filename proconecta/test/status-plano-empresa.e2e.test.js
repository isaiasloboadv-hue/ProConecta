// Etapa 7 do briefing white label (painel do Super Admin), passo 1 (status da empresa) e passo 2
// (plano e cobrança). Prova, pela API HTTP de verdade, que: (1) empresa "suspensa" bloqueia login
// novo; (2) empresa "suspensa" bloqueia qualquer requisição de quem JÁ estava logado antes da
// suspensão (token continua válido, mas o servidor recusa na próxima chamada); (3) a empresa 1
// (instalação atual) nunca pode ser suspensa; (4) o Super Admin reativa e o acesso volta; (5) o
// Super Admin edita e lê de volta os campos de plano/cobrança, inclusive voltando pra "sem valor".
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
      { id: 2, nome: 'Super Admin', email: 'super@x.com', papel: 'super_admin', empresa_id: null, status: 'ativo', ...senha },
      { id: 3, nome: 'Admin Empresa 2', email: 'admin2@x.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
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

test('status da empresa: suspende login novo e sessão já aberta; empresa 1 nunca suspende; plano edita e lê de volta', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-status-plano-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 37500 + Math.floor(Math.random() * 900);

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
      return r;
    };
    const tokenSuper = (await (await login('super@x.com')).json()).token;
    const authSuper = { Authorization: `Bearer ${tokenSuper}`, 'Content-Type': 'application/json' };

    // empresa 2 nasce "ativa" (default) — login e uso funcionam normalmente
    const loginEmpresa2 = await login('admin2@x.com');
    assert.equal(loginEmpresa2.status, 200);
    const tokenEmpresa2 = (await loginEmpresa2.json()).token;
    const authEmpresa2 = { Authorization: `Bearer ${tokenEmpresa2}`, 'Content-Type': 'application/json' };
    const usoAntesDeSuspender = await fetch(`${base}/api/usuarios`, { headers: authEmpresa2 });
    assert.equal(usoAntesDeSuspender.status, 200);

    // status inválido é recusado
    const statusInvalido = await fetch(`${base}/api/plataforma/empresas/2/status`, {
      method: 'PUT', headers: authSuper, body: JSON.stringify({ status: 'bloqueada' }),
    });
    assert.equal(statusInvalido.status, 400);

    // empresa 1 (instalação atual) nunca pode ser suspensa
    const suspenderEmpresa1 = await fetch(`${base}/api/plataforma/empresas/1/status`, {
      method: 'PUT', headers: authSuper, body: JSON.stringify({ status: 'suspensa' }),
    });
    assert.equal(suspenderEmpresa1.status, 400);

    // Super Admin suspende a empresa 2
    const suspender = await fetch(`${base}/api/plataforma/empresas/2/status`, {
      method: 'PUT', headers: authSuper, body: JSON.stringify({ status: 'suspensa' }),
    });
    assert.equal(suspender.status, 200);
    assert.equal((await suspender.json()).empresa.status, 'suspensa');

    // login novo passa a ser bloqueado
    const loginBloqueado = await login('admin2@x.com');
    assert.equal(loginBloqueado.status, 403);

    // a sessão que já estava logada (token ainda "válido") é bloqueada na próxima requisição
    const usoDepoisDeSuspender = await fetch(`${base}/api/usuarios`, { headers: authEmpresa2 });
    assert.equal(usoDepoisDeSuspender.status, 403);
    const corpoUsoDepoisDeSuspender = await usoDepoisDeSuspender.json();
    assert.match(corpoUsoDepoisDeSuspender.erro, /suspensa/);
    // código de erro específico (Etapa 7, melhoria): o front usa isso pra fazer logout automático
    // e mostrar um aviso claro, mesmo em chamadas silenciosas de fundo (sino, chat), que nunca
    // mostram mensagem de erro pro usuário.
    assert.equal(corpoUsoDepoisDeSuspender.codigo, 'empresa_suspensa');
    assert.equal((await loginBloqueado.json()).codigo, 'empresa_suspensa');

    // super_admin nunca é afetado (não pertence a empresa nenhuma)
    const superAindaFunciona = await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper });
    assert.equal(superAindaFunciona.status, 200);

    // Super Admin reativa — login e uso voltam a funcionar
    const reativar = await fetch(`${base}/api/plataforma/empresas/2/status`, {
      method: 'PUT', headers: authSuper, body: JSON.stringify({ status: 'ativa' }),
    });
    assert.equal(reativar.status, 200);
    const loginDeNovo = await login('admin2@x.com');
    assert.equal(loginDeNovo.status, 200);
    const usoDepoisDeReativar = await fetch(`${base}/api/usuarios`, { headers: authEmpresa2 });
    assert.equal(usoDepoisDeReativar.status, 200);

    // plano e cobrança: nasce null/null, Super Admin define, lê de volta, depois volta pra null
    const planoAntes = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    const empresa1Antes = planoAntes.empresas.find((e) => e.id === 1);
    assert.equal(empresa1Antes.plano_valor_mensal, null);
    assert.equal(empresa1Antes.plano_dia_vencimento, null);

    const definirPlano = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', plano_valor_mensal: 499.9, plano_dia_vencimento: 10 }),
    });
    assert.equal(definirPlano.status, 200);
    const corpoDefinirPlano = await definirPlano.json();
    assert.equal(corpoDefinirPlano.empresa.plano_valor_mensal, 499.9);
    assert.equal(corpoDefinirPlano.empresa.plano_dia_vencimento, 10);

    // editar só o plano não apaga site/whatsapp/telefone (PUT parcial preserva o que não foi enviado)
    const comSite = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', site: 'empresa.com.br', whatsapp: '11999999999' }),
    });
    assert.equal((await comSite.json()).empresa.site, 'empresa.com.br');
    const planoParcial = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', plano_valor_mensal: 599 }),
    });
    const corpoPlanoParcial = await planoParcial.json();
    assert.equal(corpoPlanoParcial.empresa.site, 'empresa.com.br');
    assert.equal(corpoPlanoParcial.empresa.whatsapp, '11999999999');
    assert.equal(corpoPlanoParcial.empresa.plano_valor_mensal, 599);

    const removerPlano = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', plano_valor_mensal: null, plano_dia_vencimento: null }),
    });
    const corpoRemoverPlano = await removerPlano.json();
    assert.equal(corpoRemoverPlano.empresa.plano_valor_mensal, null);
    assert.equal(corpoRemoverPlano.empresa.plano_dia_vencimento, null);

    // empresa nova nasce "teste"
    const criarEmpresa = await fetch(`${base}/api/plataforma/empresas`, {
      method: 'POST', headers: authSuper, body: JSON.stringify({ nome: 'Empresa Nova' }),
    });
    assert.equal(criarEmpresa.status, 201);
    assert.equal((await criarEmpresa.json()).empresa.status, 'teste');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
