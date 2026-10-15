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
  assert.equal(db.moduloAtivo(data, 1, 'comercial'), false);
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

// "relatorios" e "equipe_avancado" entraram no catálogo pedido do usuário: "nosso sistema deve
// ser do mais simples ao completo" — Relatório/Equipamentos/IA e Equipe/Escala/KPIs/FMEA saíram
// de dentro de "os_chamados" e viraram módulos próprios (ver rotas-modulo.js).
test('MODULOS_DISPONIVEIS lista todos os 11 módulos da spec', () => {
  const chaves = db.MODULOS_DISPONIVEIS.map((m) => m.chave).sort();
  assert.deepEqual(chaves, [
    'agendamento', 'assistente_ia', 'biblioteca', 'comercial', 'equipe_avancado',
    'financeiro', 'filiais', 'os_chamados', 'prestacao_contas', 'relatorios', 'smp_preventivas',
  ].sort());
});

// categorias de plano em cascata — pedido do usuário: "ajude a criar categorias de plano. Ao
// selecionar já é selecionado automático o que é liberado até o plano em que todas as funções é
// liberada". recalcularModulosVersoes é a função que garante isso: cada versão só guarda em
// modulos_proprios o que ELA introduz, e o campo modulos (consumido por toda troca de plano) vira
// sempre o acumulado por ordem.
test('recalcularModulosVersoes: versão de ordem maior acumula os módulos de todas as de ordem menor', () => {
  const data = {
    versoes: [
      { id: 1, nome: 'Básico', ordem: 1, modulos_proprios: ['os_chamados'] },
      { id: 2, nome: 'Intermediário', ordem: 2, modulos_proprios: ['biblioteca'] },
      { id: 3, nome: 'Completo', ordem: 3, modulos_proprios: ['comercial', 'financeiro'] },
    ],
  };
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 1).modulos, ['os_chamados']);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos, ['os_chamados', 'biblioteca']);
  assert.deepEqual(data.versoes.find((v) => v.id === 3).modulos, ['os_chamados', 'biblioteca', 'comercial', 'financeiro']);
});

test('recalcularModulosVersoes: plano de maior ordem com todos os módulos próprios do catálogo libera tudo', () => {
  const data = {
    versoes: [
      { id: 1, nome: 'Básico', ordem: 1, modulos_proprios: ['os_chamados'] },
      { id: 2, nome: 'Completo', ordem: 2, modulos_proprios: db.CHAVES_MODULOS.filter((c) => c !== 'os_chamados') },
    ],
  };
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos.sort(), [...db.CHAVES_MODULOS].sort());
});

test('recalcularModulosVersoes: editar os módulos próprios de uma versão de ordem baixa reflete nas de ordem mais alta', () => {
  const data = {
    versoes: [
      { id: 1, nome: 'Básico', ordem: 1, modulos_proprios: ['os_chamados'] },
      { id: 2, nome: 'Completo', ordem: 2, modulos_proprios: ['comercial'] },
    ],
  };
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos, ['os_chamados', 'comercial']);
  // admin acrescenta "biblioteca" no plano Básico (ordem 1)
  data.versoes.find((v) => v.id === 1).modulos_proprios.push('biblioteca');
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos, ['os_chamados', 'biblioteca', 'comercial']);
});

test('recalcularModulosVersoes: módulo repetido em modulos_proprios de versões diferentes não duplica no acumulado', () => {
  const data = {
    versoes: [
      { id: 1, nome: 'Básico', ordem: 1, modulos_proprios: ['os_chamados'] },
      { id: 2, nome: 'Completo', ordem: 2, modulos_proprios: ['os_chamados', 'comercial'] },
    ],
  };
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos, ['os_chamados', 'comercial']);
});

test('recalcularModulosVersoes: ordem de entrada no array não importa, só o campo ordem', () => {
  const data = {
    versoes: [
      { id: 2, nome: 'Completo', ordem: 2, modulos_proprios: ['comercial'] },
      { id: 1, nome: 'Básico', ordem: 1, modulos_proprios: ['os_chamados'] },
    ],
  };
  db.recalcularModulosVersoes(data);
  assert.deepEqual(data.versoes.find((v) => v.id === 2).modulos, ['os_chamados', 'comercial']);
});
