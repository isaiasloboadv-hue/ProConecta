// Categorias de plano em cascata — pedido do usuário: "ajude a criar categorias de plano. Ao
// selecionar já é selecionado automático o que é liberado até o plano em que todas as funções é
// liberada". Testa, pela API HTTP de verdade, as 3 rotas novas (POST/PUT/DELETE
// /api/plataforma/versoes): gating de papel, validação, e que o acumulado por ordem (campo
// "modulos", consumido por PUT /api/meu-plano) é recalculado certo a cada mutação.
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
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, versoes: 2, empresas: 2 },
    empresas: [
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
    ],
    // sem ordem/modulos_proprios de propósito — testa que a migração automática (db.migrar, que
    // roda em todo db.load()) faz o backfill sozinha antes de qualquer rota rodar.
    versoes: [{ id: 1, nome: 'Básico', modulos: ['os_chamados'] }],
    // já "rodada" de propósito — a criação automática dos planos (Autônomo/Manutenção/Completo)
    // tem teste próprio em test/migracao.test.js; aqui o que se testa é o CRUD manual, então as
    // flags evitam que a auto-criação mexa na contagem/ids que este teste assume.
    _migracaoPlanosPadraoV1: true,
    _migracaoPlanosPadraoV2: true,
    _migracaoPlanosPadraoV3: true,
    _migracaoSplitOsChamadosV1: true,
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

test('categorias de plano: CRUD em cascata via /api/plataforma/versoes', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-categorias-plano-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 37700 + Math.floor(Math.random() * 900);

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
    const tokenSuper = await login('super@x.com');
    const authAdmin = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAdmin}` };
    const authSuper = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSuper}` };

    // --- gating de papel: administrador comum não acessa nenhuma das 3 rotas ---
    const negadoPost = await fetch(`${base}/api/plataforma/versoes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'X', modulos_proprios: [] }) });
    assert.equal(negadoPost.status, 403);
    const negadoPut = await fetch(`${base}/api/plataforma/versoes/1`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ nome: 'X' }) });
    assert.equal(negadoPut.status, 403);
    const negadoDelete = await fetch(`${base}/api/plataforma/versoes/1`, { method: 'DELETE', headers: authAdmin });
    assert.equal(negadoDelete.status, 403);

    // --- migração automática: a versão seedada sem ordem/modulos_proprios ganhou os dois ---
    const listaInicial = await (await fetch(`${base}/api/plataforma/versoes`, { headers: authSuper })).json();
    assert.equal(listaInicial.versoes.length, 1);
    assert.equal(listaInicial.versoes[0].ordem, 1);
    assert.deepEqual(listaInicial.versoes[0].modulos_proprios, ['os_chamados']);

    // --- validação: nome vazio e módulo inexistente são recusados ---
    const semNome = await fetch(`${base}/api/plataforma/versoes`, { method: 'POST', headers: authSuper, body: JSON.stringify({ nome: '', modulos_proprios: [] }) });
    assert.equal(semNome.status, 400);
    const moduloInvalido = await fetch(`${base}/api/plataforma/versoes`, { method: 'POST', headers: authSuper, body: JSON.stringify({ nome: 'X', modulos_proprios: ['nao_existe'] }) });
    assert.equal(moduloInvalido.status, 400);

    // --- criação em cascata: plano "Intermediário" (ordem 2) libera "biblioteca" a mais —
    // o campo "modulos" final tem que vir com os_chamados (herdado do Básico) + biblioteca ---
    const criarIntermediario = await fetch(`${base}/api/plataforma/versoes`, {
      method: 'POST', headers: authSuper, body: JSON.stringify({ nome: 'Intermediário', ordem: 2, modulos_proprios: ['biblioteca'] }),
    });
    assert.equal(criarIntermediario.status, 200);
    const { versoes: aposIntermediario } = await criarIntermediario.json();
    const intermediario = aposIntermediario.find((v) => v.nome === 'Intermediário');
    assert.deepEqual([...intermediario.modulos].sort(), ['biblioteca', 'os_chamados'].sort());

    // --- criação do plano "Completo" (ordem 3) com TODOS os módulos que faltam — tem que acumular
    // o catálogo inteiro (pedido do usuário: "até o plano em que todas as funções é liberada") ---
    const { modulos: catalogo } = await (await fetch(`${base}/api/plataforma/modulos`, { headers: authSuper })).json();
    const chavesCatalogo = catalogo.map((m) => m.chave);
    const restantes = chavesCatalogo.filter((c) => c !== 'os_chamados' && c !== 'biblioteca');
    const criarCompleto = await fetch(`${base}/api/plataforma/versoes`, {
      method: 'POST', headers: authSuper, body: JSON.stringify({ nome: 'Completo', ordem: 3, modulos_proprios: restantes }),
    });
    const { versoes: aposCompleto } = await criarCompleto.json();
    const completo = aposCompleto.find((v) => v.nome === 'Completo');
    assert.deepEqual([...completo.modulos].sort(), [...chavesCatalogo].sort());

    // --- editar o plano Básico (ordem 1) acrescentando um módulo: tem que refletir em cascata nos
    // dois planos de ordem maior também ---
    const basico = aposCompleto.find((v) => v.nome === 'Básico');
    const editarBasico = await fetch(`${base}/api/plataforma/versoes/${basico.id}`, {
      method: 'PUT', headers: authSuper, body: JSON.stringify({ modulos_proprios: ['os_chamados', 'smp_preventivas'] }),
    });
    assert.equal(editarBasico.status, 200);
    const { versoes: aposEditar } = await editarBasico.json();
    assert.ok(aposEditar.find((v) => v.nome === 'Intermediário').modulos.includes('smp_preventivas'));
    assert.ok(aposEditar.find((v) => v.nome === 'Completo').modulos.includes('smp_preventivas'));

    // --- excluir plano em uso é bloqueado ---
    const excluirEmUso = await fetch(`${base}/api/plataforma/versoes/${basico.id}`, { method: 'DELETE', headers: authSuper });
    assert.equal(excluirEmUso.status, 400);

    // --- plano não encontrado dá 404 nas 3 rotas ---
    const editarInexistente = await fetch(`${base}/api/plataforma/versoes/9999`, { method: 'PUT', headers: authSuper, body: JSON.stringify({ nome: 'X' }) });
    assert.equal(editarInexistente.status, 404);
    const excluirInexistente = await fetch(`${base}/api/plataforma/versoes/9999`, { method: 'DELETE', headers: authSuper });
    assert.equal(excluirInexistente.status, 404);

    // --- excluir plano sem empresa nenhuma usando ele funciona ---
    const excluirIntermediario = await fetch(`${base}/api/plataforma/versoes/${aposEditar.find((v) => v.nome === 'Intermediário').id}`, { method: 'DELETE', headers: authSuper });
    assert.equal(excluirIntermediario.status, 200);
    const { versoes: aposExcluir } = await excluirIntermediario.json();
    assert.equal(aposExcluir.length, 2);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
