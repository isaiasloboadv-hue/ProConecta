// pedido do usuário (empresa JBPA): cliente com contrato mensal — a empresa registra TUDO que é
// feito (data, descrição do serviço, valor), pra depois exportar um PDF (gerado no navegador,
// não testado aqui) comparando com o valor do contrato. Prova pela API HTTP de verdade: CRUD,
// filtros por cliente/período, quem pode editar/excluir, isolamento entre empresas, módulo
// "atividades" bloqueando quem não contratou.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin JBPA', email: 'admin@jbpa.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico A', email: 'tecA@jbpa.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Tecnico B', email: 'tecB@jbpa.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 4, nome: 'Admin Sem Modulo', email: 'admin@semmodulo.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [
      { id: 1, nome_empresa: 'Cliente Contrato Mensal', contato: 'Fulano', telefone: '', email: 'fulano@cliente.com', nivel_acesso: 'completo', setor: '', endereco: '', numero: '', bairro: '', cep: '', cidade: '', estado: '', empresa_id: 1, valor_contrato_mensal: 5000 },
      { id: 2, nome_empresa: 'Outro Cliente', contato: '', telefone: '', email: '', nivel_acesso: 'completo', setor: '', endereco: '', numero: '', bairro: '', cep: '', cidade: '', estado: '', empresa_id: 1, valor_contrato_mensal: null },
      { id: 1, nome_empresa: 'Cliente da outra empresa', contato: '', telefone: '', email: '', nivel_acesso: 'completo', setor: '', endereco: '', numero: '', bairro: '', cep: '', cidade: '', estado: '', empresa_id: 2, valor_contrato_mensal: null },
    ],
    equipamentos: [], agenda: [], visitas: [], atividades_diarias: [],
    _seq: { usuarios: 5, clientes: 3, equipamentos: 1, agenda: 1, visitas: 1, atividades_diarias: 1 },
    empresas: [
      { id: 1, nome: 'JBPA', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'atividades'], terminologia: {} },
      { id: 2, nome: 'Empresa Sem Módulo', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
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

test('Registro de Atividades: CRUD, filtros, quem edita/exclui, isolamento, módulo "atividades"', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-atividades-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 41600 + Math.floor(Math.random() * 900);

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
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const tokenAdmin = await login('admin@jbpa.com');
    const tokenA = await login('tecA@jbpa.com');
    const tokenB = await login('tecB@jbpa.com');
    const tokenOutraEmpresa = await login('admin@semmodulo.com');
    const authAdmin = auth(tokenAdmin);
    const authA = auth(tokenA);
    const authB = auth(tokenB);

    // empresa sem o módulo "atividades" ativo recebe 403 (bloqueio por módulo, ver rotas-modulo.js)
    const negaModulo = await fetch(`${base}/api/atividades-diarias`, { headers: auth(tokenOutraEmpresa) });
    assert.equal(negaModulo.status, 403);

    // técnico A registra uma atividade pro cliente com contrato
    const rCriar = await fetch(`${base}/api/atividades-diarias`, {
      method: 'POST', headers: authA,
      body: JSON.stringify({ cliente_id: 1, data: '2026-01-05', descricao: 'Troca de resistência da fritadeira', valor: 350 }),
    });
    assert.equal(rCriar.status, 201);
    const corpoCriar = await rCriar.json();
    assert.equal(corpoCriar.atividade.cliente_nome, 'Cliente Contrato Mensal');
    assert.equal(corpoCriar.atividade.autor_nome, 'Tecnico A');
    const idA = corpoCriar.atividade.id;

    // técnico B registra outra, no mesmo cliente, outra data
    const rCriarB = await fetch(`${base}/api/atividades-diarias`, {
      method: 'POST', headers: authB,
      body: JSON.stringify({ cliente_id: 1, data: '2026-01-12', descricao: 'Limpeza do sistema de exaustão', valor: 200 }),
    });
    assert.equal(rCriarB.status, 201);

    // uma terceira, em outro cliente, fora do período que vamos filtrar
    await fetch(`${base}/api/atividades-diarias`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ cliente_id: 2, data: '2026-02-01', descricao: 'Visita avulsa', valor: 100 }),
    });

    // validações: sem cliente, sem data, sem descrição, valor negativo
    const semCliente = await fetch(`${base}/api/atividades-diarias`, { method: 'POST', headers: authA, body: JSON.stringify({ data: '2026-01-05', descricao: 'x', valor: 10 }) });
    assert.equal(semCliente.status, 400);
    const semDescricao = await fetch(`${base}/api/atividades-diarias`, { method: 'POST', headers: authA, body: JSON.stringify({ cliente_id: 1, data: '2026-01-05', descricao: '', valor: 10 }) });
    assert.equal(semDescricao.status, 400);
    const valorNegativo = await fetch(`${base}/api/atividades-diarias`, { method: 'POST', headers: authA, body: JSON.stringify({ cliente_id: 1, data: '2026-01-05', descricao: 'x', valor: -5 }) });
    assert.equal(valorNegativo.status, 400);

    // administrador vê tudo
    const { atividades: todasAdmin } = await (await fetch(`${base}/api/atividades-diarias`, { headers: authAdmin })).json();
    assert.equal(todasAdmin.length, 3);

    // filtro por cliente
    const { atividades: doCliente1 } = await (await fetch(`${base}/api/atividades-diarias?cliente_id=1`, { headers: authAdmin })).json();
    assert.equal(doCliente1.length, 2);

    // filtro por período (só a de 05/01 a 10/01 — exclui a de 12/01 e a de fevereiro)
    const { atividades: doPeriodo } = await (await fetch(`${base}/api/atividades-diarias?cliente_id=1&periodo_inicio=2026-01-01&periodo_fim=2026-01-10`, { headers: authAdmin })).json();
    assert.equal(doPeriodo.length, 1);
    assert.equal(doPeriodo[0].id, idA);

    // técnico B NÃO edita a atividade do técnico A (não é dele, não é admin)
    const negaEditar = await fetch(`${base}/api/atividades-diarias/${idA}`, {
      method: 'PUT', headers: authB, body: JSON.stringify({ cliente_id: 1, data: '2026-01-05', descricao: 'Editado por B', valor: 999 }),
    });
    assert.equal(negaEditar.status, 403);

    // o próprio técnico A edita a própria
    const rEditar = await fetch(`${base}/api/atividades-diarias/${idA}`, {
      method: 'PUT', headers: authA, body: JSON.stringify({ cliente_id: 1, data: '2026-01-06', descricao: 'Troca de resistência (atualizado)', valor: 380 }),
    });
    assert.equal(rEditar.status, 200);
    assert.equal((await rEditar.json()).atividade.valor, 380);

    // administrador edita/exclui qualquer uma, mesmo não sendo o autor
    const rEditarAdmin = await fetch(`${base}/api/atividades-diarias/${idA}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ cliente_id: 1, data: '2026-01-06', descricao: 'Troca de resistência (ajustado pelo admin)', valor: 400 }),
    });
    assert.equal(rEditarAdmin.status, 200);

    // técnico B não exclui a atividade de A; admin exclui
    const negaExcluir = await fetch(`${base}/api/atividades-diarias/${idA}`, { method: 'DELETE', headers: authB });
    assert.equal(negaExcluir.status, 403);
    const rExcluir = await fetch(`${base}/api/atividades-diarias/${idA}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluir.status, 200);
    const { atividades: depoisExcluir } = await (await fetch(`${base}/api/atividades-diarias?cliente_id=1`, { headers: authAdmin })).json();
    assert.equal(depoisExcluir.length, 1);

    // cliente "valor_contrato_mensal" veio junto no GET /api/clientes (usado pro PDF comparar)
    const { clientes } = await (await fetch(`${base}/api/clientes`, { headers: authAdmin })).json();
    assert.equal(clientes.find((c) => c.id === 1).valor_contrato_mensal, 5000);
    assert.equal(clientes.find((c) => c.id === 2).valor_contrato_mensal, null);

    // administrador edita o valor do contrato de um cliente
    const rEditarCliente = await fetch(`${base}/api/clientes/2`, {
      method: 'PUT', headers: authAdmin,
      body: JSON.stringify({ nome_empresa: 'Outro Cliente', valor_contrato_mensal: 1200 }),
    });
    assert.equal(rEditarCliente.status, 200);
    assert.equal((await rEditarCliente.json()).cliente.valor_contrato_mensal, 1200);

    // cliente com atividade vinculada não pode ser excluído
    const negaExcluirCliente = await fetch(`${base}/api/clientes/2`, { method: 'DELETE', headers: authAdmin });
    assert.equal(negaExcluirCliente.status, 400);

  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
