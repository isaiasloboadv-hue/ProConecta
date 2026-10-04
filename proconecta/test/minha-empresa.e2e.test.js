// Etapa 5 do briefing white label (marca e configurações por empresa): PUT /api/empresa, a rota
// que deixa o próprio administrador editar a marca da empresa (nome, contato, cores, logo) e os
// valores padrão de bônus de viagem, sem precisar do Super Admin. Prova, pela API HTTP de
// verdade, que: (1) o administrador consegue editar e ver o resultado refletido em GET /api/me;
// (2) a logo enviada (data: URI) volta hidratada como data: URI de novo, não como referência
// bruta; (3) uma empresa nunca edita a outra; (4) só administrador acessa a rota.
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
      { id: 1, nome: 'Admin A', email: 'admin@a.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico A', email: 'tecnico@a.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin B', email: 'admin@b.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa A', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, logo_url: null, valor_bonus_viagem: 200, limite_viagens_bonus_mes: 7 },
      { id: 2, nome: 'Empresa B', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, logo_url: null, valor_bonus_viagem: 200, limite_viagens_bonus_mes: 7 },
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

// um PNG 1x1 válido, pequeno — só pra passar pela validação de tipo/tamanho de extrairFotosProfundo
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

test('PUT /api/empresa: administrador edita a própria marca, logo e bônus — sem afetar outra empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-minha-empresa-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresas()));
  const porta = 38000 + Math.floor(Math.random() * 900);

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
    const tokenAdminA = await login('admin@a.com');
    const tokenTecnicoA = await login('tecnico@a.com');
    const tokenAdminB = await login('admin@b.com');
    const authAdminA = { Authorization: `Bearer ${tokenAdminA}` };
    const authTecnicoA = { Authorization: `Bearer ${tokenTecnicoA}` };
    const authAdminB = { Authorization: `Bearer ${tokenAdminB}` };

    // técnico não pode editar a empresa — só administrador
    const comoTecnico = await fetch(`${base}/api/empresa`, {
      method: 'PUT', headers: { ...authTecnicoA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Hackeado' }),
    });
    assert.equal(comoTecnico.status, 403);

    // administrador da empresa A edita nome, cor, logo e valores de bônus
    const edicao = await fetch(`${base}/api/empresa`, {
      method: 'PUT', headers: { ...authAdminA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: 'Empresa A Renovada', cor_primaria: '#ff0000', cor_secundaria: '#00ff00',
        logo_url: PNG_1X1, valor_bonus_viagem: 250, limite_viagens_bonus_mes: 5,
      }),
    });
    assert.equal(edicao.status, 200);
    const corpoEdicao = await edicao.json();
    assert.equal(corpoEdicao.empresa.nome, 'Empresa A Renovada');
    assert.equal(corpoEdicao.empresa.valor_bonus_viagem, 250);
    assert.equal(corpoEdicao.empresa.limite_viagens_bonus_mes, 5);
    // a logo volta hidratada como data: URI de verdade, não como referência bruta {__foto_ref}
    assert.ok(corpoEdicao.empresa.logo_url.startsWith('data:image/png;base64,'));

    // GET /api/me reflete a edição
    const me = await (await fetch(`${base}/api/me`, { headers: authAdminA })).json();
    assert.equal(me.usuario.empresa.nome, 'Empresa A Renovada');
    assert.ok(me.usuario.empresa.logo_url.startsWith('data:image/png;base64,'));

    // empresa B nunca foi afetada
    const meB = await (await fetch(`${base}/api/me`, { headers: authAdminB })).json();
    assert.equal(meB.usuario.empresa.nome, 'Empresa B');
    assert.equal(meB.usuario.empresa.logo_url, null);
    assert.equal(meB.usuario.empresa.valor_bonus_viagem, 200);

    // remover a logo (null explícito) volta pro padrão (sem logo própria)
    const remocao = await fetch(`${base}/api/empresa`, {
      method: 'PUT', headers: { ...authAdminA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Empresa A Renovada', logo_url: null }),
    });
    assert.equal(remocao.status, 200);
    const corpoRemocao = await remocao.json();
    assert.equal(corpoRemocao.empresa.logo_url, null);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
