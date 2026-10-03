// prova de ponta a ponta, pela API HTTP de verdade (não só as funções puras de tenant.js), que
// duas empresas diferentes na mesma instalação nunca veem dado uma da outra — o requisito central
// de todo o trabalho de SaaS multiempresa. Sobe o server.js de verdade contra um data.json
// descartável com duas empresas já povoadas, mesmo padrão de test/dispatcher-modulo.e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosDuasEmpresas() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin Empresa A', email: 'admin@empresa-a.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin Empresa B', email: 'admin@empresa-b.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [
      { id: 1, nome_empresa: 'Cliente da Empresa A', empresa_id: 1, contato: '', telefone: '', email: '' },
      { id: 2, nome_empresa: 'Cliente da Empresa B', empresa_id: 2, contato: '', telefone: '', email: '' },
    ],
    equipamentos: [
      { id: 1, empresa_id: 1, cliente_id: 1, tipo: 'Impressora A', modelo: 'X', numero_serie: 'SN-A', data_fabricacao: '', localizacao: '' },
      { id: 2, empresa_id: 2, cliente_id: 2, tipo: 'Impressora B', modelo: 'Y', numero_serie: 'SN-B', data_fabricacao: '', localizacao: '' },
    ],
    agenda: [
      {
        id: 1, empresa_id: 1, numero_os: 'OS-A-0001', tecnico_id: 1, cliente_id: 1, equipamento_id: 1,
        tipo: 'treinamento_online', categoria: 'online', status: 'pendente', finalizada: false,
        data_hora_inicio: '2026-10-01T10:00', data_hora_fim: '2026-10-01T11:00',
        contato: '', telefone: '', email: '', criado_em: new Date().toISOString(),
      },
    ],
    visitas: [],
    _seq: { usuarios: 3, clientes: 3, equipamentos: 3, agenda: 2, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa A', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca'], terminologia: {} },
      { id: 2, nome: 'Empresa B', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados', 'smp_preventivas', 'biblioteca'] }],
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

test('empresa A não enxerga dados de empresa B em nenhuma consulta, pela API HTTP de verdade', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-isolamento-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresas()));
  const porta = 37000 + Math.floor(Math.random() * 1900);

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
    const tokenA = await login('admin@empresa-a.com');
    const tokenB = await login('admin@empresa-b.com');
    const authA = { Authorization: `Bearer ${tokenA}` };
    const authB = { Authorization: `Bearer ${tokenB}` };

    // GET /api/agenda: empresa B nunca vê a O.S. da empresa A na listagem
    const agendaB = await (await fetch(`${base}/api/agenda`, { headers: authB })).json();
    assert.equal(agendaB.agenda.length, 0);
    const agendaA = await (await fetch(`${base}/api/agenda`, { headers: authA })).json();
    assert.equal(agendaA.agenda.length, 1);
    assert.equal(agendaA.agenda[0].numero_os, 'OS-A-0001');

    // empresa B tentando acessar a O.S. da empresa A direto pelo id: 404, não um erro genérico e
    // nunca os dados de verdade (isso é o que tenant.buscar garante em toda rota que passa por ele)
    const putComoB = await fetch(`${base}/api/agenda/1`, {
      method: 'PUT', headers: { ...authB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tecnico_id: 1, cliente_id: 1, equipamento_id: 1, data_hora_inicio: 'x', data_hora_fim: 'x', tipo: 'treinamento_online', contato: 'x', telefone: 'x', email: 'x' }),
    });
    assert.equal(putComoB.status, 404);

    const deleteComoB = await fetch(`${base}/api/agenda/1`, { method: 'DELETE', headers: authB });
    assert.equal(deleteComoB.status, 404);

    // GET /api/clientes e /api/equipamentos: cada empresa só vê os seus
    const clientesA = await (await fetch(`${base}/api/clientes`, { headers: authA })).json();
    const clientesB = await (await fetch(`${base}/api/clientes`, { headers: authB })).json();
    assert.deepEqual(clientesA.clientes.map((c) => c.nome_empresa), ['Cliente da Empresa A']);
    assert.deepEqual(clientesB.clientes.map((c) => c.nome_empresa), ['Cliente da Empresa B']);

    const equipA = await (await fetch(`${base}/api/equipamentos`, { headers: authA })).json();
    const equipB = await (await fetch(`${base}/api/equipamentos`, { headers: authB })).json();
    assert.deepEqual(equipA.equipamentos.map((e) => e.numero_serie), ['SN-A']);
    assert.deepEqual(equipB.equipamentos.map((e) => e.numero_serie), ['SN-B']);

    // empresa B não pode editar o cliente da empresa A mesmo sabendo o id certo
    const editarClienteDeOutraEmpresa = await fetch(`${base}/api/clientes/1`, {
      method: 'PUT', headers: { ...authB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome_empresa: 'Sequestrado' }),
    });
    assert.equal(editarClienteDeOutraEmpresa.status, 404);
    const clienteAContinuaIntacto = await (await fetch(`${base}/api/clientes`, { headers: authA })).json();
    assert.equal(clienteAContinuaIntacto.clientes[0].nome_empresa, 'Cliente da Empresa A');
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
