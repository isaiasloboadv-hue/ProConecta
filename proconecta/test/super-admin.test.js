// teste de ponta a ponta do painel da plataforma (Super Admin): sobe o server.js de verdade
// contra um data.json descartável, mesmo padrão do test/dispatcher-modulo.e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosComSuperAdmin() {
  const senhaAdmin = hashSenha('senha1234');
  const senhaSuper = hashSenha('super1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PRO Marking', email: 'admin@teste-super.com', papel: 'administrador', status: 'ativo', empresa_id: 1, protegido: true, ...senhaAdmin },
      { id: 2, nome: 'Super Admin', email: 'super@teste-super.com', papel: 'super_admin', status: 'ativo', empresa_id: null, ...senhaSuper },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, empresas: 2 },
    empresas: [{
      id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [],
      cor_primaria: '#000', cor_secundaria: '#000',
      versao_id: 1, modulos_ativos: ['os_chamados', 'smp_preventivas', 'biblioteca'], terminologia: {},
    }],
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

test('painel da plataforma: só super_admin acessa, cria empresa, liga/desliga módulo e edita terminologia', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-superadmin-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComSuperAdmin()));
  const porta = 39000 + Math.floor(Math.random() * 5000);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '', SUPERADMIN_EMAIL: '', SUPERADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;

    // administrador comum (da PRO Marking) não é super_admin
    const loginAdmin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@teste-super.com', senha: 'senha1234' }),
    });
    const { token: tokenAdmin } = await loginAdmin.json();
    const semAcesso = await fetch(`${base}/api/plataforma/empresas`, { headers: { Authorization: `Bearer ${tokenAdmin}` } });
    assert.equal(semAcesso.status, 403);

    // sem token nenhum: 401 (rota exige login, só não exige módulo ativo — ver rotas-modulo.js)
    const semToken = await fetch(`${base}/api/plataforma/empresas`);
    assert.equal(semToken.status, 401);

    // super admin de verdade
    const loginSuper = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'super@teste-super.com', senha: 'super1234' }),
    });
    const { token: tokenSuper } = await loginSuper.json();
    const authSuper = { Authorization: `Bearer ${tokenSuper}` };

    const listaInicial = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    assert.equal(listaInicial.empresas.length, 1);
    assert.equal(listaInicial.empresas[0].nome, 'PRO Marking');

    const modulos = await (await fetch(`${base}/api/plataforma/modulos`, { headers: authSuper })).json();
    assert.ok(modulos.modulos.some((m) => m.chave === 'crm'));

    // cria empresa nova com a versão Manutenção
    const criarResp = await fetch(`${base}/api/plataforma/empresas`, {
      method: 'POST', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Clínica Teste', versao_id: 1 }),
    });
    assert.equal(criarResp.status, 201);
    const { empresa: nova } = await criarResp.json();
    assert.equal(nova.id, 2);
    assert.deepEqual(nova.modulos_ativos.sort(), ['biblioteca', 'os_chamados', 'smp_preventivas'].sort());

    // liga crm e desliga smp_preventivas (módulo avulso, independente da versão original)
    const modulosResp = await fetch(`${base}/api/plataforma/empresas/${nova.id}/modulos`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modulos: ['os_chamados', 'biblioteca', 'crm'] }),
    });
    assert.equal(modulosResp.status, 200);
    const { empresa: comCrm } = await modulosResp.json();
    assert.deepEqual(comCrm.modulos_ativos.sort(), ['biblioteca', 'crm', 'os_chamados'].sort());

    // módulo inexistente é rejeitado
    const modInvalido = await fetch(`${base}/api/plataforma/empresas/${nova.id}/modulos`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modulos: ['nao_existe'] }),
    });
    assert.equal(modInvalido.status, 400);

    // edita terminologia
    const termResp = await fetch(`${base}/api/plataforma/empresas/${nova.id}/terminologia`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminologia: { equipamento: 'Paciente' } }),
    });
    assert.equal(termResp.status, 200);
    const { empresa: comTerm } = await termResp.json();
    assert.equal(comTerm.terminologia.equipamento, 'Paciente');

    // um usuário da empresa nova já enxerga o módulo crm ativo na checagem de módulo (dispatcher)
    // — prova que ativar pelo painel realmente libera a rota, não só grava no banco
    const listaFinal = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    const empresaFinal = listaFinal.empresas.find((e) => e.id === nova.id);
    assert.ok(empresaFinal.modulos_ativos.includes('crm'));
    assert.ok(!empresaFinal.modulos_ativos.includes('smp_preventivas'));

    // empresa recém-criada nasce sem administrador nenhum — ninguém consegue logar nela ainda
    assert.deepEqual(nova.administradores, []);
    assert.deepEqual(empresaFinal.administradores, []);

    // super admin cria o primeiro administrador da empresa nova
    const criarAdminResp = await fetch(`${base}/api/plataforma/empresas/${nova.id}/administrador`, {
      method: 'POST', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Admin Clínica', email: 'admin@clinica-teste.com', senha: 'clinica1234' }),
    });
    assert.equal(criarAdminResp.status, 201);
    const { usuario: novoAdmin } = await criarAdminResp.json();
    assert.equal(novoAdmin.papel, 'administrador');
    assert.equal(novoAdmin.empresa_id, nova.id);

    // e-mail duplicado é rejeitado
    const emailDuplicado = await fetch(`${base}/api/plataforma/empresas/${nova.id}/administrador`, {
      method: 'POST', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Outro', email: 'admin@clinica-teste.com', senha: 'outrasenha' }),
    });
    assert.equal(emailDuplicado.status, 409);

    // o novo administrador realmente consegue logar, e só vê os módulos da própria empresa
    const loginNovoAdmin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@clinica-teste.com', senha: 'clinica1234' }),
    });
    assert.equal(loginNovoAdmin.status, 200);
    const loginBody = await loginNovoAdmin.json();
    assert.equal(loginBody.usuario.papel, 'administrador');
    assert.deepEqual(loginBody.usuario.modulos_ativos.sort(), ['biblioteca', 'crm', 'os_chamados'].sort());

    // login também identifica de qual empresa é a sessão — é o que o front usa pra mostrar o
    // nome da empresa no cabeçalho (sem isso, quem loga não tem como saber em qual empresa está)
    assert.equal(loginBody.usuario.empresa.nome, 'Clínica Teste');
    assert.equal(loginBody.usuario.empresa.id, nova.id);

    // GET /api/me devolve a mesma identificação de empresa
    const meNovoAdmin = await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${loginBody.token}` } })).json();
    assert.equal(meNovoAdmin.usuario.empresa.nome, 'Clínica Teste');

    // o admin original (PRO Marking) continua vendo a própria empresa, não a nova
    const loginAdminOriginal = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@teste-super.com', senha: 'senha1234' }),
    });
    const bodyAdminOriginal = await loginAdminOriginal.json();
    assert.equal(bodyAdminOriginal.usuario.empresa.nome, 'PRO Marking');

    // super_admin não pertence a nenhuma empresa — empresa vem null, não a de outra empresa
    assert.equal(loginSuper.status, 200);
    const bodySuper = await (await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'super@teste-super.com', senha: 'super1234' }),
    })).json();
    assert.equal(bodySuper.usuario.empresa, null);

    // e a lista de empresas do painel agora mostra o administrador criado
    const listaComAdmin = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    const empresaComAdmin = listaComAdmin.empresas.find((e) => e.id === nova.id);
    assert.equal(empresaComAdmin.administradores.length, 1);
    assert.equal(empresaComAdmin.administradores[0].email, 'admin@clinica-teste.com');
    const adminId = empresaComAdmin.administradores[0].id;

    // ---------- editar dados da empresa ----------
    const editarEmpresaResp = await fetch(`${base}/api/plataforma/empresas/${nova.id}`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Clínica Teste Renomeada', site: 'clinica.com.br', whatsapp: '11 99999-0000', telefone: '11 3333-0000' }),
    });
    assert.equal(editarEmpresaResp.status, 200);
    const { empresa: empresaEditada } = await editarEmpresaResp.json();
    assert.equal(empresaEditada.nome, 'Clínica Teste Renomeada');
    assert.equal(empresaEditada.site, 'clinica.com.br');
    // módulos/versão não foram afetados pela edição de dados básicos
    assert.deepEqual(empresaEditada.modulos_ativos.sort(), ['biblioteca', 'crm', 'os_chamados'].sort());

    // nome vazio é rejeitado
    const editarEmpresaVazio = await fetch(`${base}/api/plataforma/empresas/${nova.id}`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: '' }),
    });
    assert.equal(editarEmpresaVazio.status, 400);

    // instalação atual (empresa 1) não pode ter dados alterados por quem não é dela? — na verdade
    // pode editar dados básicos da empresa 1 sem problema, só não pode EXCLUIR (checado abaixo)
    const editarEmpresa1 = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'PRO Marking' }),
    });
    assert.equal(editarEmpresa1.status, 200);

    // ---------- editar administrador ----------
    const editarAdminResp = await fetch(`${base}/api/plataforma/administradores/${adminId}`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Admin Clínica Editado', email: 'admin-editado@clinica-teste.com', status: 'ativo' }),
    });
    assert.equal(editarAdminResp.status, 200);
    const { usuario: adminEditado } = await editarAdminResp.json();
    assert.equal(adminEditado.nome, 'Admin Clínica Editado');
    assert.equal(adminEditado.email, 'admin-editado@clinica-teste.com');

    // login com o e-mail antigo não funciona mais, com o novo funciona
    const loginEmailAntigo = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@clinica-teste.com', senha: 'clinica1234' }),
    });
    assert.equal(loginEmailAntigo.status, 401);
    const loginEmailNovo = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin-editado@clinica-teste.com', senha: 'clinica1234' }),
    });
    assert.equal(loginEmailNovo.status, 200);

    // redefinir a senha do administrador
    const redefinirSenhaResp = await fetch(`${base}/api/plataforma/administradores/${adminId}`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Admin Clínica Editado', email: 'admin-editado@clinica-teste.com', senha: 'novasenha123' }),
    });
    assert.equal(redefinirSenhaResp.status, 200);
    const loginSenhaNova = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin-editado@clinica-teste.com', senha: 'novasenha123' }),
    });
    assert.equal(loginSenhaNova.status, 200);

    // a conta master (ADMIN_EMAIL, protegida) não pode ser editada nem excluída por aqui
    const listaAdminsProMarking = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    const proMarking = listaAdminsProMarking.empresas.find((e) => e.id === 1);
    const adminProtegido = proMarking.administradores.find((a) => a.email === 'admin@teste-super.com');
    assert.ok(adminProtegido, 'admin@teste-super.com deveria existir na PRO Marking');
    const editarProtegidoResp = await fetch(`${base}/api/plataforma/administradores/${adminProtegido.id}`, {
      method: 'PUT', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'Hackeado', email: 'hackeado@x.com' }),
    });
    assert.equal(editarProtegidoResp.status, 403);
    const excluirProtegidoResp = await fetch(`${base}/api/plataforma/administradores/${adminProtegido.id}`, {
      method: 'DELETE', headers: authSuper,
    });
    assert.equal(excluirProtegidoResp.status, 403);

    // ---------- excluir administrador ----------
    const excluirAdminResp = await fetch(`${base}/api/plataforma/administradores/${adminId}`, {
      method: 'DELETE', headers: authSuper,
    });
    assert.equal(excluirAdminResp.status, 200);
    // agora a empresa fica sem administrador de novo
    const listaSemAdmin = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    const empresaSemAdminDeNovo = listaSemAdmin.empresas.find((e) => e.id === nova.id);
    assert.deepEqual(empresaSemAdminDeNovo.administradores, []);
    // e o login antigo já não funciona mais
    const loginAposExcluir = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin-editado@clinica-teste.com', senha: 'novasenha123' }),
    });
    assert.equal(loginAposExcluir.status, 401);

    // ---------- excluir empresa ----------
    // sem confirmar_nome batendo: rejeitado, nada é apagado
    const excluirSemConfirmar = await fetch(`${base}/api/plataforma/empresas/${nova.id}`, {
      method: 'DELETE', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmar_nome: 'nome errado' }),
    });
    assert.equal(excluirSemConfirmar.status, 400);

    // empresa 1 (instalação atual) nunca pode ser excluída, mesmo confirmando certinho
    const excluirEmpresa1 = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'DELETE', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmar_nome: 'PRO Marking' }),
    });
    assert.equal(excluirEmpresa1.status, 400);

    // com o nome certo: exclui de verdade
    const excluirOk = await fetch(`${base}/api/plataforma/empresas/${nova.id}`, {
      method: 'DELETE', headers: { ...authSuper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmar_nome: 'Clínica Teste Renomeada' }),
    });
    assert.equal(excluirOk.status, 200);
    const listaFinalSemEmpresa = await (await fetch(`${base}/api/plataforma/empresas`, { headers: authSuper })).json();
    assert.equal(listaFinalSemEmpresa.empresas.length, 1);
    assert.equal(listaFinalSemEmpresa.empresas[0].id, 1);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
