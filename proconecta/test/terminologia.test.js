// testa o helper t() de terminologia configurável (ver public/app.js) do mesmo jeito que
// test/menu.test.js testa navDoUsuario: extrai a função de verdade do app.js via vm.Script, sem
// duplicar a lógica.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarT() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const inicio = src.indexOf('function t(chave, padrao) {');
  const fim = src.indexOf('\n}\n', inicio) + 2;
  if (inicio < 0) throw new Error('função t() não encontrada em app.js — teste desatualizado?');
  const sandbox = { USER: null, console };
  vm.createContext(sandbox);
  new vm.Script(src.slice(inicio, fim) + '\nthis.t = t;').runInContext(sandbox);
  return sandbox;
}

test('t() devolve o termo padrão quando a empresa não tem terminologia configurada', () => {
  const ctx = carregarT();
  ctx.USER = { terminologia: {} };
  assert.equal(ctx.t('equipamento', 'Equipamento'), 'Equipamento');
});

test('t() devolve o termo padrão quando USER.terminologia nem existe', () => {
  const ctx = carregarT();
  ctx.USER = {};
  assert.equal(ctx.t('equipamento', 'Equipamento'), 'Equipamento');
});

test('t() devolve o termo customizado da empresa quando existe', () => {
  const ctx = carregarT();
  ctx.USER = { terminologia: { equipamento: 'Paciente' } };
  assert.equal(ctx.t('equipamento', 'Equipamento'), 'Paciente');
});

test('t() não confunde chaves diferentes', () => {
  const ctx = carregarT();
  ctx.USER = { terminologia: { equipamento: 'Paciente' } };
  assert.equal(ctx.t('cliente', 'Cliente'), 'Cliente');
});
