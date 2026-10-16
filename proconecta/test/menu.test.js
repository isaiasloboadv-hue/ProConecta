// testa a lógica de menu dinâmico por módulo ativo (ver public/app.js) sem carregar o app.js
// inteiro (que depende de `document`/`window`, só existem no navegador) — extrai as poucas linhas
// puras de que o teste precisa (NAV, moduloAtivoNoMenu, navDoUsuario) direto do arquivo de
// verdade com vm.Script, então qualquer mudança nessas funções no app.js é testada aqui também,
// sem duplicar a lógica num segundo lugar que possa ficar desatualizado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarLogicaDeMenu() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const inicioNav = src.indexOf('const NAV = {');
  const fimNav = src.indexOf('\n};', inicioNav) + 3;
  const inicioFuncoes = src.indexOf('function moduloAtivoNoMenu(modulo) {');
  const fimFuncoes = src.indexOf('\n}\n', src.indexOf('function navDoUsuario() {')) + 2;
  if (inicioNav < 0 || inicioFuncoes < 0) throw new Error('NAV ou moduloAtivoNoMenu não encontrados em app.js — teste desatualizado?');
  const trecho = src.slice(inicioNav, fimNav) + '\n' + src.slice(inicioFuncoes, fimFuncoes);
  // perfilAtivoNoMenu (gate do menu "Guia de Diagnóstico Rápido", perfil refrigeração) lê
  // window._empresa.perfil — igual ao app.js de verdade (ver window._empresa = null no topo do
  // arquivo), senão a chamada quebra aqui dentro (vm não tem window do navegador).
  const sandbox = { USER: null, window: { _empresa: null }, console };
  vm.createContext(sandbox);
  new vm.Script(trecho + '\nthis.NAV = NAV; this.navDoUsuario = navDoUsuario; this.moduloAtivoNoMenu = moduloAtivoNoMenu; this.perfilAtivoNoMenu = perfilAtivoNoMenu;').runInContext(sandbox);
  return sandbox;
}

test('administrador com todos os módulos ativos vê o menu inteiro', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados', 'smp_preventivas', 'biblioteca'] };
  const nav = ctx.navDoUsuario.call(ctx);
  const chaves = Array.from(nav, (n) => n.key);
  assert.ok(chaves.includes('agenda'));
  assert.ok(chaves.includes('biblioteca'));
  assert.ok(chaves.includes('clientes')); // núcleo, sempre aparece
  assert.ok(chaves.includes('usuarios')); // núcleo, sempre aparece
});

test('administrador sem o módulo os_chamados não vê os itens desse módulo, mas continua vendo núcleo e biblioteca', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['biblioteca'] };
  const nav = ctx.navDoUsuario.call(ctx);
  const chaves = Array.from(nav, (n) => n.key);
  assert.ok(!chaves.includes('agenda'));
  assert.ok(!chaves.includes('equipamentos'));
  assert.ok(!chaves.includes('painel-atendimentos'));
  assert.ok(chaves.includes('biblioteca'));
  assert.ok(chaves.includes('clientes'));
  assert.ok(chaves.includes('usuarios'));
});

test('empresa sem nenhum módulo ativo só vê itens de núcleo', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: [] };
  const nav = ctx.navDoUsuario.call(ctx);
  const chaves = Array.from(nav, (n) => n.key);
  assert.deepEqual(chaves.sort(), ['clientes', 'minha-empresa', 'usuarios'].sort());
});

test('sem modulos_ativos definido (undefined) se comporta como nenhum módulo ativo, não trava', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true };
  const nav = ctx.navDoUsuario.call(ctx);
  assert.deepEqual(Array.from(nav, (n) => n.key).sort(), ['clientes', 'minha-empresa', 'usuarios'].sort());
});

test('restrição por menus (acesso_total: false) continua funcionando por cima do filtro de módulo', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: false, menus: ['agenda', 'clientes'], modulos_ativos: ['os_chamados', 'smp_preventivas', 'biblioteca'] };
  const nav = ctx.navDoUsuario.call(ctx);
  assert.deepEqual(Array.from(nav, (n) => n.key).sort(), ['agenda', 'clientes'].sort());
});

test('cliente só enxerga biblioteca/equipamentos/chamados quando os módulos correspondentes estão ativos', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'cliente', acesso_total: true, modulos_ativos: ['biblioteca'] };
  const nav = ctx.navDoUsuario.call(ctx);
  assert.deepEqual(Array.from(nav, (n) => n.key).sort(), ['biblioteca'].sort());
});

test('moduloAtivoNoMenu trata módulo núcleo/vazio como sempre ativo', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { modulos_ativos: [] };
  assert.equal(ctx.moduloAtivoNoMenu.call(ctx, undefined), true);
  assert.equal(ctx.moduloAtivoNoMenu.call(ctx, 'nucleo'), true);
  assert.equal(ctx.moduloAtivoNoMenu.call(ctx, 'comercial'), false);
});

// pedido do usuário: perfil "Refrigeração e Climatização" (ver PERFIS_DISPONIVEIS em db.js) — o
// menu "Guia de Diagnóstico Rápido" (NAV.suporte/NAV.administrador) é gated por `perfil` no node
// do NAV, não por `modulo`/plano contratado — ver perfilAtivoNoMenu em app.js.
test('perfilAtivoNoMenu trata node sem `perfil` como sempre ativo, e só libera quando window._empresa.perfil bate', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = null;
  assert.equal(ctx.perfilAtivoNoMenu.call(ctx, undefined), true);
  assert.equal(ctx.perfilAtivoNoMenu.call(ctx, 'refrigeracao'), false);
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.equal(ctx.perfilAtivoNoMenu.call(ctx, 'refrigeracao'), false);
  ctx.window._empresa = { perfil: 'refrigeracao' };
  assert.equal(ctx.perfilAtivoNoMenu.call(ctx, 'refrigeracao'), true);
});

test('técnico (suporte) só vê "Guia de Diagnóstico Rápido" quando a empresa é do perfil refrigeração', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('guia-diagnostico-rapido'));
  ctx.window._empresa = { perfil: 'refrigeracao' };
  const chaves = Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key);
  assert.ok(chaves.includes('guia-diagnostico-rapido'));
  // continua sem `modulo` nenhum (não é item de plano contratado) — não some mesmo sem
  // modulos_ativos nenhum, já que moduloAtivoNoMenu só olha `node.modulo` (ausente aqui).
  ctx.USER.modulos_ativos = [];
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('guia-diagnostico-rapido'));
});

test('restrição por menus (acesso_total: false) também vale pro item gated por perfil', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'suporte', acesso_total: false, menus: ['agenda'], modulos_ativos: ['os_chamados'] };
  ctx.window._empresa = { perfil: 'refrigeracao' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('guia-diagnostico-rapido'));
  ctx.USER.menus = ['agenda', 'guia-diagnostico-rapido'];
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('guia-diagnostico-rapido'));
});

// pedido do usuário (referência: app concorrente iClima): painel "Início" no topo do menu do
// perfil Refrigeração (ver os-refrigeracao-home.e2e.test.js em server.js), mesmo gate por `perfil`.
test('administrador e suporte só veem "Início" (Refrigeração) quando a empresa é do perfil refrigeração', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('home-refrigeracao'));
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('home-refrigeracao'));
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('home-refrigeracao'));
});

// pedido do usuário (referência: app concorrente iClima): segundo menu do perfil Refrigeração —
// "Ordens de Serviço" (ver os-refrigeracao-*.test.js em server.js), mesmo gate por `perfil`.
test('administrador e suporte só veem "Ordens de Serviço" (Refrigeração) quando a empresa é do perfil refrigeração', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('os-refrigeracao'));
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('os-refrigeracao'));
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('os-refrigeracao'));
});

// pedido do usuário (referência: app concorrente iClima): 3º atalho do perfil Refrigeração —
// "Orçamentos" (ver os-refrigeracao-orcamento.e2e.test.js em server.js), mesmo gate por `perfil`.
test('administrador e suporte só veem "Orçamentos" (Refrigeração) quando a empresa é do perfil refrigeração', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('orcamentos-refrigeracao'));
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('orcamentos-refrigeracao'));
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('orcamentos-refrigeracao'));
});

// pedido do usuário (referência: app concorrente iClima): 4º atalho do perfil Refrigeração —
// "Agenda" (ver os-refrigeracao-agenda.e2e.test.js em server.js). Mesmo rótulo do item núcleo
// "agenda"/"Agenda geral" — por isso o item núcleo usa `ocultoNoPerfil: 'refrigeracao'` e some
// pra não duplicar "Agenda" no menu com dois conteúdos diferentes (ver navDoUsuario).
test('administrador e suporte só veem "Agenda" (Refrigeração) quando a empresa é do perfil refrigeração, e o "Agenda" do núcleo some nesse perfil', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  let chaves = Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key);
  assert.ok(chaves.includes('agenda-refrigeracao'));
  assert.ok(!chaves.includes('agenda')); // núcleo escondido nesse perfil
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados'] };
  chaves = Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key);
  assert.ok(chaves.includes('agenda-refrigeracao'));
  assert.ok(!chaves.includes('agenda'));
  // empresa de outro perfil: some o item do perfil, volta o item núcleo (continua tendo o módulo
  // os_chamados contratado)
  ctx.window._empresa = { perfil: 'autonomo' };
  chaves = Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key);
  assert.ok(!chaves.includes('agenda-refrigeracao'));
  assert.ok(chaves.includes('agenda'));
});

// pedido do usuário (referência: app concorrente iClima, aba "Ferramentas"): um hub único com
// vários widgets dentro (ver FERRAMENTAS_REF_WIDGETS/renderFerramentasRefrigeracao em app.js), não
// mais um grupo com children no sidebar — "Ferramentas" é uma página própria (page: 'ferramentas-hub').
test('"Ferramentas" (hub de widgets) só aparece quando a empresa é do perfil refrigeração', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['os_chamados'] };
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('ferramentas'));
  ctx.window._empresa = { perfil: 'refrigeracao' };
  const ferramentas = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'ferramentas');
  assert.ok(ferramentas);
  assert.equal(ferramentas.page, 'ferramentas-hub');
});

// pedido do usuário: pacote "Climatização / PMOC" — ÚNICO item do perfil Refrigeração que
// combina os dois gates no mesmo node (`perfil: 'refrigeracao'` + `modulo: 'pmoc'`, ver
// os-refrigeracao-pmoc.e2e.test.js em server.js): só aparece pra empresa que É do perfil
// Refrigeração E tem o módulo `pmoc` contratado — qualquer um dos dois faltando, o item some.
test('"PMOC" só aparece quando a empresa é do perfil refrigeração E tem o módulo `pmoc` ativo — um sem o outro não basta', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['os_chamados'] };
  ctx.window._empresa = { perfil: 'refrigeracao' };
  // perfil certo, sem o módulo `pmoc` contratado: não aparece.
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('pmoc'));
  // módulo `pmoc` contratado, mas empresa de outro perfil: também não aparece.
  ctx.USER.modulos_ativos = ['pmoc'];
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('pmoc'));
  // os dois juntos: aparece, com os submenus das Fases 1 e 2 (Locais, Planos, Modelo de
  // Checklist, Responsáveis técnicos) — "Preventivas pendentes" é só do administrador (ver teste
  // dedicado abaixo).
  ctx.window._empresa = { perfil: 'refrigeracao' };
  const pmoc = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(pmoc);
  const paginasFilhas = pmoc.children.map((c) => c.page);
  assert.ok(paginasFilhas.includes('pmoc-locais'));
  assert.ok(paginasFilhas.includes('pmoc-planos'));
  assert.ok(paginasFilhas.includes('pmoc-modelo-checklist'));
  assert.ok(paginasFilhas.includes('pmoc-responsaveis'));
  // vale pro papel "suporte" também (técnico), não só administrador.
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['pmoc'] };
  assert.ok(Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('pmoc'));
});

// pedido do usuário: "o administrador designa o técnico" — a fila de visitas PMOC sem técnico
// (ver os-refrigeracao-pmoc-planos.e2e.test.js, PUT .../designar-tecnico exige papel
// administrador no server) só entra no menu do administrador, nunca no do técnico (suporte).
test('"Preventivas pendentes" (fila de designação de técnico) só existe no menu do administrador', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocAdmin = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(pmocAdmin.children.map((c) => c.page).includes('pmoc-visitas-pendentes'));
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocSuporte = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(!pmocSuporte.children.map((c) => c.page).includes('pmoc-visitas-pendentes'));
});

// pedido do usuário: Fase 5, item 8 — Painel/dashboard do pacote, mesma regra do item acima
// (GET /api/pmoc/painel exige papel administrador no server).
test('"Painel PMOC" (dashboard) só existe no menu do administrador', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocAdmin = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(pmocAdmin.children.map((c) => c.page).includes('pmoc-painel'));
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocSuporte = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(!pmocSuporte.children.map((c) => c.page).includes('pmoc-painel'));
});

// pedido do usuário: Fase A (análise de concorrentes/conformidade legal) — Relatório de Gás,
// mesma regra gerencial (GET /api/pmoc/relatorio-anual-gas exige papel administrador no server).
test('"Relatório de Gás" só existe no menu do administrador', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.window._empresa = { perfil: 'refrigeracao' };
  ctx.USER = { papel: 'administrador', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocAdmin = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(pmocAdmin.children.map((c) => c.page).includes('pmoc-relatorio-gas'));
  ctx.USER = { papel: 'suporte', acesso_total: true, modulos_ativos: ['pmoc'] };
  const pmocSuporte = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc');
  assert.ok(!pmocSuporte.children.map((c) => c.page).includes('pmoc-relatorio-gas'));
});

// pedido do usuário: Fase 4, item 5 — portal do cliente final do pacote PMOC. Igual ao item
// "pmoc" do administrador/suporte, combina os dois gates (`perfil: 'refrigeracao'` + `modulo:
// 'pmoc'`), só que no menu do papel "cliente" (ver GET /api/pmoc/portal/* em server.js).
test('"PMOC" (portal do cliente) só aparece quando a empresa é do perfil refrigeração E tem o módulo `pmoc` ativo', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'cliente', acesso_total: true, modulos_ativos: ['os_chamados'] };
  ctx.window._empresa = { perfil: 'refrigeracao' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('pmoc-portal'));
  ctx.USER.modulos_ativos = ['pmoc'];
  ctx.window._empresa = { perfil: 'autonomo' };
  assert.ok(!Array.from(ctx.navDoUsuario.call(ctx), (n) => n.key).includes('pmoc-portal'));
  ctx.window._empresa = { perfil: 'refrigeracao' };
  const pmocPortal = Array.from(ctx.navDoUsuario.call(ctx)).find((n) => n.key === 'pmoc-portal');
  assert.ok(pmocPortal);
  const paginasFilhas = pmocPortal.children.map((c) => c.page);
  assert.ok(paginasFilhas.includes('pmoc-portal-locais'));
  assert.ok(paginasFilhas.includes('pmoc-portal-visitas'));
});
