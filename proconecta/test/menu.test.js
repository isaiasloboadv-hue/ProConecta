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
  const sandbox = { USER: null, console };
  vm.createContext(sandbox);
  new vm.Script(trecho + '\nthis.NAV = NAV; this.navDoUsuario = navDoUsuario; this.moduloAtivoNoMenu = moduloAtivoNoMenu;').runInContext(sandbox);
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
  assert.deepEqual(chaves.sort(), ['clientes', 'usuarios'].sort());
});

test('sem modulos_ativos definido (undefined) se comporta como nenhum módulo ativo, não trava', () => {
  const ctx = carregarLogicaDeMenu();
  ctx.USER = { papel: 'administrador', acesso_total: true };
  const nav = ctx.navDoUsuario.call(ctx);
  assert.deepEqual(Array.from(nav, (n) => n.key).sort(), ['clientes', 'usuarios'].sort());
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
  assert.equal(ctx.moduloAtivoNoMenu.call(ctx, 'crm'), false);
});
