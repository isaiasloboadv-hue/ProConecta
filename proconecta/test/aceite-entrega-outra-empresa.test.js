// testa relatorioAceitePadrao() (ver public/app.js) do mesmo jeito que test/empresa-contato.test.js:
// extrai as funções de verdade via vm.Script, sem duplicar a lógica.
//
// Pedido do usuário, vendo o formulário de Termo de Aceite logado como BRB: "No aceite de entrega
// aparece coisas da Promarking" — CHECKLIST_CORRETIVA (Instalação mecânica, Lente, Treinamento
// operacional etc.) é a lista de instalação de equipamento a laser da PRO Marking; outra empresa
// não pode herdar esse checklist por padrão.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarRelatorioAceitePadrao() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const trechoChecklist = src.slice(src.indexOf('const CHECKLIST_CORRETIVA = ['), src.indexOf('\n];\n', src.indexOf('const CHECKLIST_CORRETIVA = [')) + 3);
  const trechoEhPromarking = src.slice(src.indexOf('function ehEmpresaPromarking() {'), src.indexOf('\n', src.indexOf('function ehEmpresaPromarking() {')) + 1);
  const inicioFn = src.indexOf('function relatorioAceitePadrao() {');
  const trechoFn = src.slice(inicioFn, src.indexOf('\n}\n', inicioFn) + 2);
  if (!trechoChecklist.includes('CHECKLIST_CORRETIVA') || !trechoFn.includes('relatorioAceitePadrao')) {
    throw new Error('trechos não encontrados em app.js — teste desatualizado?');
  }
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  new vm.Script(
    trechoChecklist + '\n' + trechoEhPromarking + '\n' + trechoFn +
    '\nthis.relatorioAceitePadrao = relatorioAceitePadrao; this.CHECKLIST_CORRETIVA = CHECKLIST_CORRETIVA;'
  ).runInContext(sandbox);
  return sandbox;
}

test('PRO Marking (empresa id 1): Termo de Aceite nasce com o check-list de instalação a laser de sempre', () => {
  const ctx = carregarRelatorioAceitePadrao();
  ctx.window._empresa = { id: 1 };
  const padrao = ctx.relatorioAceitePadrao();
  assert.equal(padrao.checklist.length, ctx.CHECKLIST_CORRETIVA.length);
  assert.equal(padrao.checklist[0].item, 'Instalação mecânica');
});

test('empresa diferente de PRO Marking: Termo de Aceite nasce com o check-list em branco', () => {
  const ctx = carregarRelatorioAceitePadrao();
  ctx.window._empresa = { id: 2, nome: 'BRB' };
  const padrao = ctx.relatorioAceitePadrao();
  // [...] copia pra um array do realm de fora — ver nota equivalente em empresa-contato.test.js
  assert.deepEqual([...padrao.checklist], []);
});
