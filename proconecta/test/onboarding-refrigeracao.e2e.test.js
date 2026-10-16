// pedido do usuário (referência: app concorrente iClima) — só o administrador que acabou de
// cadastrar a empresa, perfil "Refrigeração e Climatização" (ver PERFIS_DISPONIVEIS em db.js),
// passa pelo onboarding (especialidades, anos de experiência, foto de perfil, termos de uso) na
// primeira vez que entra. Prova pela API HTTP de verdade: gate por papel (só administrador) e por
// perfil da empresa, validação do aceite dos termos, sucesso grava os campos e popula
// termos_aceitos_em (que é o que destrava onboardingRefrigeracaoPendente no front — ver app.js),
// e que GET /api/me reflete tudo isso depois.
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
      // sem termos_aceitos_em no fixture (nasce undefined) — é exatamente o estado de um
      // administrador recém-cadastrado DEPOIS da migração de onboarding já ter rodado nesta
      // instalação (ver _migracaoOnboardingRefrigeracaoV1 abaixo) — por isso fica pendente de
      // verdade, em vez de ser varrido pelo backfill de quem já existia antes do campo existir.
      { id: 1, nome: 'Admin Refrigeração', email: 'admin@refrigera.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico A', email: 'tecA@refrigera.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin Outro Perfil', email: 'admin@outroperfil.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    // instalação "já madura": a migração de backfill (que marcaria usuário pré-existente como já
    // onboardado) já rodou antes deste fixture existir — sem isso, o admin id 1 acima seria
    // varrido por ela e nasceria "já concluído", quebrando a premissa do teste.
    _migracaoOnboardingRefrigeracaoV1: true,
    empresas: [
      { id: 1, nome: 'Refrigera Clima', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, perfil: 'refrigeracao' },
      { id: 2, nome: 'Empresa Perfil Autônomo', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, perfil: 'autonomo' },
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

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

test('onboarding do administrador (perfil Refrigeração): pendente até aceitar os termos, gate por papel/perfil, grava especialidades/experiência/foto', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-onboarding-refrigeracao-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 43400 + Math.floor(Math.random() * 900);

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
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const tokenAdmin = await login('admin@refrigera.com');
    const tokenTecnico = await login('tecA@refrigera.com');
    const tokenOutroPerfil = await login('admin@outroperfil.com');
    const authAdmin = auth(tokenAdmin);

    // antes do onboarding: GET /api/me já devolve termos_aceitos_em null/ausente — é o que o
    // front usa pra decidir que o assistente está pendente (ver onboardingRefrigeracaoPendente).
    const meAntes = await (await fetch(`${base}/api/me`, { headers: authAdmin })).json();
    assert.ok(!meAntes.usuario.termos_aceitos_em);
    assert.equal(meAntes.usuario.empresa.perfil, 'refrigeracao');

    // técnico (suporte) nunca tem acesso a essa rota — só administrador, mesmo sendo da empresa certa
    const negaPapel = await fetch(`${base}/api/me/onboarding-refrigeracao`, {
      method: 'POST', headers: auth(tokenTecnico), body: JSON.stringify({ termos_aceito: true }),
    });
    assert.equal(negaPapel.status, 403);

    // administrador de empresa com outro perfil também não tem acesso
    const negaPerfil = await fetch(`${base}/api/me/onboarding-refrigeracao`, {
      method: 'POST', headers: auth(tokenOutroPerfil), body: JSON.stringify({ termos_aceito: true }),
    });
    assert.equal(negaPerfil.status, 403);

    // sem aceitar os termos, recusa (não existe "salvar parcial" — só conclusão)
    const semTermos = await fetch(`${base}/api/me/onboarding-refrigeracao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ especialidades: ['instalacao'], anos_experiencia: 5, termos_aceito: false }),
    });
    assert.equal(semTermos.status, 400);

    // especialidade inválida é filtrada silenciosamente (nunca grava chave desconhecida)
    const rConcluir = await fetch(`${base}/api/me/onboarding-refrigeracao`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({
        especialidades: ['instalacao', 'camara_fria', 'chave-invalida'],
        anos_experiencia: '7', foto_perfil: PNG_1X1, termos_aceito: true,
      }),
    });
    assert.equal(rConcluir.status, 200);
    const atualizado = (await rConcluir.json()).usuario;
    assert.deepEqual(atualizado.especialidades.sort(), ['camara_fria', 'instalacao'].sort());
    assert.equal(atualizado.anos_experiencia, 7);
    assert.ok(atualizado.foto_perfil.startsWith('data:image/png;base64,'));
    assert.ok(atualizado.termos_aceitos_em);

    // GET /api/me depois reflete tudo — onboardingRefrigeracaoPendente passa a dar false no front
    const meDepois = await (await fetch(`${base}/api/me`, { headers: authAdmin })).json();
    assert.ok(meDepois.usuario.termos_aceitos_em);
    assert.deepEqual(meDepois.usuario.especialidades.sort(), ['camara_fria', 'instalacao'].sort());

    // sem token nenhum, 401 (rota não é pública — fica em "núcleo" por omissão no rotas-modulo.js)
    const semToken = await fetch(`${base}/api/me/onboarding-refrigeracao`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termos_aceito: true }) });
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
