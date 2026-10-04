const test = require('node:test');
const assert = require('node:assert/strict');
const tenant = require('../tenant.js');

function dadosFake() {
  return {
    clientes: [
      { id: 1, empresa_id: 1, nome_empresa: 'Cliente da Empresa A' },
      { id: 2, empresa_id: 2, nome_empresa: 'Cliente da Empresa B' },
    ],
    agenda: [
      { id: 1, empresa_id: 1, numero_os: 'OS-A-1' },
      { id: 2, empresa_id: 2, numero_os: 'OS-B-1' },
      { id: 3, empresa_id: 1, numero_os: 'OS-A-2' },
    ],
    _seq: { clientes: 3, agenda: 4 },
  };
}

test('listar só devolve registros da empresa pedida', () => {
  const data = dadosFake();
  const daA = tenant.listar(data, 'agenda', 1);
  const daB = tenant.listar(data, 'agenda', 2);
  assert.equal(daA.length, 2);
  assert.ok(daA.every((a) => a.empresa_id === 1));
  assert.equal(daB.length, 1);
  assert.equal(daB[0].numero_os, 'OS-B-1');
});

test('buscar nunca devolve registro de outra empresa, mesmo com id certo', () => {
  const data = dadosFake();
  // id 2 existe e é uma OS de verdade, mas é da empresa 2 — empresa 1 pedindo o id 2 não pode achar
  assert.equal(tenant.buscar(data, 'agenda', 2, 1), null);
  // a própria empresa dona do registro consegue achar normalmente
  const achado = tenant.buscar(data, 'agenda', 2, 2);
  assert.ok(achado);
  assert.equal(achado.numero_os, 'OS-B-1');
});

test('buscar devolve null pra id que não existe em nenhuma empresa', () => {
  const data = dadosFake();
  assert.equal(tenant.buscar(data, 'agenda', 999, 1), null);
});

test('criar carimba empresa_id e id sequencial automaticamente', () => {
  const data = dadosFake();
  const novo = tenant.criar(data, 'agenda', 1, { numero_os: 'OS-A-3' });
  assert.equal(novo.id, 4);
  assert.equal(novo.empresa_id, 1);
  assert.equal(data.agenda.length, 4);
  // empresa 2 continua sem ver o registro novo, criado pra empresa 1
  assert.equal(tenant.listar(data, 'agenda', 2).length, 1);
});

test('criar em coleções diferentes não deixa ids colidirem entre empresas', () => {
  const data = dadosFake();
  const deA = tenant.criar(data, 'clientes', 1, { nome_empresa: 'Outro cliente A' });
  const deB = tenant.criar(data, 'clientes', 2, { nome_empresa: 'Outro cliente B' });
  assert.notEqual(deA.id, deB.id);
  assert.equal(tenant.buscar(data, 'clientes', deB.id, 1), null);
  assert.equal(tenant.buscar(data, 'clientes', deB.id, 2).nome_empresa, 'Outro cliente B');
});
