const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

function empresaFake(modulosAtivos) {
  return {
    empresas: [{ id: 1, nome: 'Empresa Teste', modulos_ativos: modulosAtivos }],
  };
}

test('moduloAtivo devolve true só pro módulo que está na lista da empresa', () => {
  const data = empresaFake(['os_chamados', 'biblioteca']);
  assert.equal(db.moduloAtivo(data, 1, 'os_chamados'), true);
  assert.equal(db.moduloAtivo(data, 1, 'biblioteca'), true);
  assert.equal(db.moduloAtivo(data, 1, 'crm'), false);
});

test('moduloAtivo devolve false pra chave de módulo que não existe', () => {
  const data = empresaFake(['os_chamados']);
  assert.equal(db.moduloAtivo(data, 1, 'modulo_inventado'), false);
});

test('moduloAtivo devolve false pra empresa que não existe', () => {
  const data = empresaFake(['os_chamados']);
  assert.equal(db.moduloAtivo(data, 999, 'os_chamados'), false);
});

test('moduloAtivo devolve false se a empresa não tem modulos_ativos definido', () => {
  const data = { empresas: [{ id: 1, nome: 'Sem módulos' }] };
  assert.equal(db.moduloAtivo(data, 1, 'os_chamados'), false);
});

test('desativar um módulo não afeta os outros da mesma empresa', () => {
  const data = empresaFake(['os_chamados', 'smp_preventivas', 'biblioteca']);
  data.empresas[0].modulos_ativos = data.empresas[0].modulos_ativos.filter((m) => m !== 'smp_preventivas');
  assert.equal(db.moduloAtivo(data, 1, 'os_chamados'), true);
  assert.equal(db.moduloAtivo(data, 1, 'biblioteca'), true);
  assert.equal(db.moduloAtivo(data, 1, 'smp_preventivas'), false);
});

test('MODULOS_DISPONIVEIS lista todos os 8 módulos da spec', () => {
  const chaves = db.MODULOS_DISPONIVEIS.map((m) => m.chave).sort();
  assert.deepEqual(chaves, [
    'agendamento', 'assistente_ia', 'biblioteca', 'crm',
    'financeiro', 'os_chamados', 'prestacao_contas', 'smp_preventivas',
  ].sort());
});
