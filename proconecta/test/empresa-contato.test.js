// testa os helpers empresaWhatsapp()/empresaTelefone()/empresaEmails()/empresaSite() (ver
// public/app.js) do mesmo jeito que test/terminologia.test.js testa t(): extrai as funções de
// verdade via vm.Script, sem duplicar a lógica.
//
// Pedido do usuário: "na última página aparece o contato da Promarking isso não deve
// acontecer" — empresa diferente da PRO Marking (id 1), sem whatsapp/telefone/e-mails próprios
// configurados, não pode herdar o contato real da PRO Marking nos relatórios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const inicio = src.indexOf('function ehEmpresaPromarking() {');
  const fim = src.indexOf('\n}\n', src.indexOf('function empresaEmails() {')) + 2;
  if (inicio < 0 || fim < 0) throw new Error('helpers de empresa não encontrados em app.js — teste desatualizado?');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  new vm.Script(src.slice(inicio, fim) +
    '\nthis.empresaNome = empresaNome; this.empresaSite = empresaSite; this.empresaWhatsapp = empresaWhatsapp; ' +
    'this.empresaTelefone = empresaTelefone; this.empresaEmails = empresaEmails;'
  ).runInContext(sandbox);
  return sandbox;
}

test('PRO Marking (empresa id 1) continua com o contato real de sempre', () => {
  const ctx = carregarHelpers();
  ctx.window._empresa = { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [] };
  assert.equal(ctx.empresaWhatsapp(), '12 99718-7506');
  assert.equal(ctx.empresaTelefone(), '12 3902-3453');
  assert.equal(ctx.empresaSite(), 'promarking.com.br');
  // [...] copia pra um array do realm de fora — o array devolvido pela função extraída via vm
  // é de outro realm (outro construtor Array), então deepEqual direto falsamente acusa
  // diferença mesmo com conteúdo idêntico (compara o protótipo também).
  assert.deepEqual([...ctx.empresaEmails()], ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br']);
});

test('empresa diferente de PRO Marking, sem contato configurado, não herda o contato da PRO Marking', () => {
  const ctx = carregarHelpers();
  ctx.window._empresa = { id: 2, nome: 'BRB', site: '', whatsapp: '', telefone: '', emails: [] };
  assert.equal(ctx.empresaWhatsapp(), '');
  assert.equal(ctx.empresaTelefone(), '');
  assert.equal(ctx.empresaSite(), '');
  assert.deepEqual([...ctx.empresaEmails()], []);
});

test('empresa diferente de PRO Marking com contato próprio configurado usa o próprio', () => {
  const ctx = carregarHelpers();
  ctx.window._empresa = { id: 2, nome: 'BRB', site: 'brb.com.br', whatsapp: '11 90000-0000', telefone: '11 3000-0000', emails: ['contato@brb.com.br'] };
  assert.equal(ctx.empresaWhatsapp(), '11 90000-0000');
  assert.equal(ctx.empresaTelefone(), '11 3000-0000');
  assert.equal(ctx.empresaSite(), 'brb.com.br');
  assert.deepEqual(ctx.empresaEmails(), ['contato@brb.com.br']);
});

test('sem empresa nenhuma carregada (window._empresa null), trata como padrão', () => {
  const ctx = carregarHelpers();
  ctx.window._empresa = null;
  assert.equal(ctx.empresaNome(), 'PRO Marking');
  assert.equal(ctx.empresaWhatsapp(), '12 99718-7506');
});
