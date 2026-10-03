// Etapa 6 do briefing white label (módulos contratáveis), passo 1: papéis supervisor (só leitura
// de tudo) e financeiro (ainda sem tela própria, ver próximo passo desta etapa). Prova, pela API
// HTTP de verdade, que supervisor lê os dados principais (agenda, clientes, usuários, chamados,
// relatórios, viagens/bônus, escala de folga) mas qualquer rota de escrita continua recusando —
// "só visualização" é garantido pelo servidor, não só pelo menu escondido no front.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosComSupervisor() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Super Visor', email: 'supervisor@x.com', papel: 'supervisor', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Fulano Financeiro', email: 'financeiro@x.com', papel: 'financeiro', status: 'ativo', empresa_id: 1, ...senha },
      { id: 4, nome: 'Tecnico', email: 'tecnico@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Teste', empresa_id: 1, contato: '', telefone: '', email: '' }],
    equipamentos: [], agenda: [
      { id: 1, empresa_id: 1, numero_os: 'OS-0001', tecnico_id: 4, cliente_id: 1, equipamento_id: null,
        tipo: 'treinamento_online', categoria: 'online', status: 'pendente', finalizada: false,
        data_hora_inicio: '2026-10-01T10:00', data_hora_fim: '2026-10-01T11:00',
        contato: '', telefone: '', email: '', criado_em: new Date().toISOString() },
    ],
    visitas: [],
    _seq: { usuarios: 5, clientes: 2, equipamentos: 1, agenda: 2, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca'], terminologia: {} },
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

test('papel supervisor: lê tudo, mas qualquer escrita continua recusada pelo servidor', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-supervisor-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComSupervisor()));
  const porta = 37500 + Math.floor(Math.random() * 900);

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
    const tokenSupervisor = await login('supervisor@x.com');
    const tokenFinanceiro = await login('financeiro@x.com');
    assert.ok(tokenSupervisor, 'supervisor consegue logar');
    assert.ok(tokenFinanceiro, 'financeiro consegue logar');
    const authSupervisor = { Authorization: `Bearer ${tokenSupervisor}` };

    // leitura: todas liberadas
    const agenda = await fetch(`${base}/api/agenda`, { headers: authSupervisor });
    assert.equal(agenda.status, 200);
    assert.equal((await agenda.json()).agenda.length, 1);

    const clientes = await fetch(`${base}/api/clientes`, { headers: authSupervisor });
    assert.equal(clientes.status, 200);
    assert.equal((await clientes.json()).clientes.length, 1);

    const usuarios = await fetch(`${base}/api/usuarios`, { headers: authSupervisor });
    assert.equal(usuarios.status, 200);
    assert.equal((await usuarios.json()).usuarios.length, 4);

    const chamados = await fetch(`${base}/api/chamados`, { headers: authSupervisor });
    assert.equal(chamados.status, 200);

    const viagens = await fetch(`${base}/api/tecnicos/viagens`, { headers: authSupervisor });
    assert.equal(viagens.status, 200);

    const escalas = await fetch(`${base}/api/escala-folgas`, { headers: authSupervisor });
    assert.equal(escalas.status, 200);

    const solicitacoesRh = await fetch(`${base}/api/solicitacoes-rh`, { headers: authSupervisor });
    assert.equal(solicitacoesRh.status, 200);

    // escrita: tudo continua recusado, mesmo tendo acesso de leitura às mesmas áreas
    const criarEmpresaCliente = await fetch(`${base}/api/clientes`, {
      method: 'POST', headers: { ...authSupervisor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome_empresa: 'Tentativa supervisor' }),
    });
    assert.equal(criarEmpresaCliente.status, 403);

    const criarUsuario = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: { ...authSupervisor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: 'X', email: 'x@x.com', papel: 'suporte' }),
    });
    assert.equal(criarUsuario.status, 403);

    const editarOS = await fetch(`${base}/api/agenda/1`, {
      method: 'PUT', headers: { ...authSupervisor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tecnico_id: 4, cliente_id: 1, equipamento_id: null, data_hora_inicio: 'x', data_hora_fim: 'x', tipo: 'treinamento_online', contato: 'x', telefone: 'x', email: 'x' }),
    });
    assert.equal(editarOS.status, 403);

    const definirEscala = await fetch(`${base}/api/escala-folgas`, {
      method: 'POST', headers: { ...authSupervisor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_id: 4, data: '2026-10-05', tipo: 'dsr' }),
    });
    assert.equal(definirEscala.status, 403);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
