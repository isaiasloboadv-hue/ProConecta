// varredura de vazamento PRO Marking: buscarBiblioteca(data, filtros) não filtrava por
// empresa_id nenhuma — a ferramenta "buscar_biblioteca" que a IA usa no chat/WhatsApp (ver
// processarTurno) devolvia defeitos/soluções aprovados de QUALQUER empresa pra QUALQUER chamado,
// inclusive os da PRO Marking aparecendo pro cliente de outra empresa. Toda outra rota de
// /api/registros já usa tenant.listar(data, 'registros', empresa_id) — esta é a única que não
// isolava por empresa.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buscarBiblioteca } = require('../ia.js');

function dadosDuasEmpresas() {
  return {
    registros: [
      { id: 1, empresa_id: 1, status: 'aprovado', titulo: 'Laser não grava', equipamento_tipo: 'Smartbox', equipamento_modelo: 'MP5', sintoma: 'não grava', causa: 'lente sujo', solucao: 'limpar lente' },
      { id: 2, empresa_id: 2, status: 'aprovado', titulo: 'Compressor não liga', equipamento_tipo: 'Compressor', equipamento_modelo: 'XYZ-200', sintoma: 'não liga', causa: 'fusível queimado', solucao: 'trocar fusível' },
      { id: 3, empresa_id: 2, status: 'pendente', titulo: 'Compressor vazando óleo', equipamento_tipo: 'Compressor', equipamento_modelo: 'XYZ-200', sintoma: 'vaza óleo', causa: '', solucao: '' },
    ],
  };
}

test('buscarBiblioteca só devolve registros aprovados da própria empresa — nunca de outra', () => {
  const data = dadosDuasEmpresas();
  const resultadoEmpresa2 = buscarBiblioteca(data, {}, 2);
  assert.equal(resultadoEmpresa2.resultados.length, 1);
  assert.equal(resultadoEmpresa2.resultados[0].titulo, 'Compressor não liga');
  // nunca o registro da empresa 1 (PRO Marking) nem o pendente (não aprovado ainda) da própria empresa
  assert.ok(!resultadoEmpresa2.resultados.some((r) => r.titulo.includes('Laser')));
});

test('buscarBiblioteca da empresa 1 (PRO Marking) não vê o registro da empresa 2', () => {
  const data = dadosDuasEmpresas();
  const resultadoEmpresa1 = buscarBiblioteca(data, {}, 1);
  assert.equal(resultadoEmpresa1.resultados.length, 1);
  assert.equal(resultadoEmpresa1.resultados[0].titulo, 'Laser não grava');
});

test('buscarBiblioteca sem empresaId (undefined) não devolve nada — nunca mistura tudo por padrão', () => {
  const data = dadosDuasEmpresas();
  const resultado = buscarBiblioteca(data, {});
  assert.deepEqual(resultado.resultados, []);
  assert.ok(resultado.aviso);
});

test('buscarBiblioteca ainda filtra por termo/equipamento dentro da própria empresa', () => {
  const data = dadosDuasEmpresas();
  const porTermo = buscarBiblioteca(data, { termo: 'fusível' }, 2);
  assert.equal(porTermo.resultados.length, 1);
  const porEquipamentoQueNaoBate = buscarBiblioteca(data, { equipamento: 'Smartbox' }, 2);
  assert.deepEqual(porEquipamentoQueNaoBate.resultados, []);
});
