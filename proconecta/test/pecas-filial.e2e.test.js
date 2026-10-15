// versão Restaurantes/rede multiunidade (Fase 3 — Peças, pedido do usuário): catálogo de peças,
// solicitação com "ciente", cadeia de autorização por valor (gerente/coordenador -> consultor ->
// diretoria) e geração automática da O.S. de instalação quando a peça chega na loja. Prova pela
// API HTTP de verdade.
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
      { id: 1, nome: 'Admin Rede', email: 'admin@rede.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], setores: [], filiais: [], areas: [],
    vistorias: [], vistoria_itens: [], apoios: [], pecas_catalogo: [], solicitacoes_peca: [],
    _seq: {
      usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, setores: 1, filiais: 1, areas: 1,
      vistorias: 1, vistoria_itens: 1, apoios: 1, pecas_catalogo: 1, solicitacoes_peca: 1,
    },
    empresas: [
      {
        id: 1, nome: 'Rede Franquia', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000',
        versao_id: null, modulos_ativos: ['filiais', 'relatorios', 'os_chamados', 'equipe_avancado'], terminologia: {},
        limite_aprovacao_1: 200, limite_aprovacao_2: 1000,
      },
    ],
    versoes: [],
    _migracaoPlanosPadraoV1: true, _migracaoPlanosPadraoV2: true, _migracaoPlanosPadraoV3: true, _migracaoSplitOsChamadosV1: true,
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

test('versão Restaurantes — Fase 3: catálogo de peças, ciente, cadeia de autorização e instalação automática', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pecas-filial-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 39400 + Math.floor(Math.random() * 900);

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
    const tokenAdmin = await login('admin@rede.com');
    const authAdmin = auth(tokenAdmin);
    const post = (rota, body, authHdr) => fetch(`${base}${rota}`, { method: 'POST', headers: authHdr || authAdmin, body: JSON.stringify(body) });
    const put = (rota, body, authHdr) => fetch(`${base}${rota}`, { method: 'PUT', headers: authHdr || authAdmin, body: JSON.stringify(body) });
    const get = (rota, authHdr) => fetch(`${base}${rota}`, { headers: authHdr || authAdmin });

    async function criarUsuario(nome, email, papel, extra) {
      const r = await post('/api/usuarios', { nome, email, papel, ...extra });
      assert.equal(r.status, 201, `falhou criar ${papel} ${email}: ${JSON.stringify(await r.clone().json())}`);
      const corpo = await r.json();
      const token = new URL(corpo.convite.link).searchParams.get('token');
      const ativar = await fetch(`${base}/api/convite/${token}/ativar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'senha1234' }),
      });
      assert.equal(ativar.status, 200);
      return corpo.usuario;
    }

    // --- estrutura: 1 setor, 1 filial, técnico+gerente, coordenador, consultor ---
    const setor = (await (await post('/api/setores', { nome: 'Setor Único' })).json()).setor;
    const coord = await criarUsuario('Coordenador', 'coord@rede.com', 'coordenador_tecnico', { setor_id: setor.id });
    const consultor = await criarUsuario('Consultor', 'consultor@rede.com', 'consultor_mercado', { setor_id: setor.id });
    await put(`/api/setores/${setor.id}`, { nome: 'Setor Único', coordenador_id: coord.id, consultor_id: consultor.id });

    const filial = (await (await post('/api/filiais', { nome: 'Loja 1', setor_id: setor.id })).json()).filial;
    const tecnico = await criarUsuario('Técnico', 'tecnico@rede.com', 'suporte', { filial_id: filial.id });
    const gerente = await criarUsuario('Gerente', 'gerente@rede.com', 'gerente_loja', { filial_id: filial.id });
    await put(`/api/filiais/${filial.id}`, { nome: 'Loja 1', setor_id: setor.id, tecnico_id: tecnico.id, gerente_id: gerente.id });

    const { areas } = await (await get(`/api/areas?filial_id=${filial.id}`)).json();
    const areaCozinha = areas.find((a) => a.nome === 'Cozinha');
    const catalogo = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const equip = (await (await post(`/api/equipamentos/${catalogo.equipamento.id}/atrelar-filial`, { filial_id: filial.id, area_id: areaCozinha.id, numero_serie: 'SN-01' })).json()).equipamento;

    // --- catálogo de peças ---
    const rPeca = await post('/api/pecas-catalogo', { codigo: 'RES-100', descricao: 'Resistência de fritadeira', fornecedor: 'Fornecedor X', ultimo_preco: 50 }, auth(await login('coord@rede.com')));
    assert.equal(rPeca.status, 201);
    const peca = (await rPeca.json()).peca;
    const { pecas: buscaCatalogo } = await (await get('/api/pecas-catalogo?busca=resist')).json();
    assert.ok(buscaCatalogo.some((p) => p.id === peca.id));

    const tokenTecnico = await login('tecnico@rede.com');
    const tokenGerente = await login('gerente@rede.com');
    const tokenCoord = await login('coord@rede.com');
    const tokenConsultor = await login('consultor@rede.com');

    // --- solicitação 1: baixo valor (dentro do limite 1 = 200) ---
    const rSol1 = await post('/api/solicitacoes-peca', {
      equipamento_id: equip.id, prioridade: 'urgente', descricao: 'Troca da resistência',
      peca_catalogo_id: peca.id, quantidade: 2, valor_unitario: 50, justificativa: 'Fritadeira parada',
    }, auth(tokenTecnico));
    assert.equal(rSol1.status, 201);
    const sol1 = (await rSol1.json()).solicitacao;
    assert.equal(sol1.valor_total, 100);
    assert.equal(sol1.filial_nome, 'Loja 1');
    assert.equal(sol1.status, 'pendente');
    assert.equal(sol1.responsavel_atual, RESPONSAVEL_PENDENTE());

    // gerente e coordenador dão ciente (campos independentes)
    const rCienteGerente = await post(`/api/solicitacoes-peca/${sol1.id}/ciente`, {}, auth(tokenGerente));
    assert.equal(rCienteGerente.status, 200);
    assert.equal((await rCienteGerente.json()).solicitacao.status, 'ciente');
    const rCienteCoord = await post(`/api/solicitacoes-peca/${sol1.id}/ciente`, {}, auth(tokenCoord));
    const solComCiente = (await rCienteCoord.json()).solicitacao;
    assert.ok(solComCiente.ciente_gerente_id && solComCiente.ciente_coordenador_id);

    // aprovação local (dentro do limite 1) e compra
    const rAprovarLocal = await post(`/api/solicitacoes-peca/${sol1.id}/aprovar-local`, {}, auth(tokenGerente));
    assert.equal(rAprovarLocal.status, 200);
    assert.equal((await rAprovarLocal.json()).solicitacao.status, 'aprovado');
    const rComprado = await post(`/api/solicitacoes-peca/${sol1.id}/marcar-comprado`, { nota_fiscal_numero: 'NF-001' }, auth(tokenGerente));
    assert.equal((await rComprado.json()).solicitacao.status, 'comprado');

    // peça na loja -> gera O.S. de instalação automaticamente pro técnico fixo da loja
    const rPecaNaLoja = await post(`/api/solicitacoes-peca/${sol1.id}/marcar-peca-na-loja`, {}, auth(tokenGerente));
    assert.equal(rPecaNaLoja.status, 200);
    const { solicitacao: solPecaNaLoja, agenda: osInstalacao } = await rPecaNaLoja.json();
    assert.equal(solPecaNaLoja.status, 'peca_na_loja');
    assert.ok(solPecaNaLoja.instalacao_agenda_id);
    assert.equal(osInstalacao.tecnico_id, tecnico.id);
    assert.match(osInstalacao.problema, /Instalar peça/);

    // técnico confirma instalação
    const rInstalado = await post(`/api/solicitacoes-peca/${sol1.id}/marcar-instalado`, {}, auth(tokenTecnico));
    assert.equal((await rInstalado.json()).solicitacao.status, 'instalado');

    // --- solicitação 2: valor médio (entre limite 1 e limite 2) -> precisa do consultor ---
    const rSol2 = await post('/api/solicitacoes-peca', {
      equipamento_id: equip.id, prioridade: 'nao_urgente', descricao: 'Troca do compressor', quantidade: 1, valor_unitario: 600,
    }, auth(tokenTecnico));
    const sol2 = (await rSol2.json()).solicitacao;
    await post(`/api/solicitacoes-peca/${sol2.id}/ciente`, {}, auth(tokenGerente));
    const negaAprovarLocal = await post(`/api/solicitacoes-peca/${sol2.id}/aprovar-local`, {}, auth(tokenGerente));
    assert.equal(negaAprovarLocal.status, 400);
    const rPedirConsultor = await post(`/api/solicitacoes-peca/${sol2.id}/pedir-autorizacao-consultor`, { observacao: 'acima do limite local' }, auth(tokenGerente));
    assert.equal((await rPedirConsultor.json()).solicitacao.status, 'aguardando_consultor');
    const rConsultorAprova = await post(`/api/solicitacoes-peca/${sol2.id}/consultor-decidir`, { decisao: 'aprovado', observacao: 'ok' }, auth(tokenConsultor));
    assert.equal(rConsultorAprova.status, 200);
    assert.equal((await rConsultorAprova.json()).solicitacao.status, 'aprovado');

    // --- solicitação 3: valor acima do limite 2 -> consultor É OBRIGADO a encaminhar à diretoria ---
    const rSol3 = await post('/api/solicitacoes-peca', {
      equipamento_id: equip.id, prioridade: 'urgente', descricao: 'Troca de equipamento inteiro', quantidade: 1, valor_unitario: 2000,
    }, auth(tokenTecnico));
    const sol3 = (await rSol3.json()).solicitacao;
    await post(`/api/solicitacoes-peca/${sol3.id}/ciente`, {}, auth(tokenCoord));
    await post(`/api/solicitacoes-peca/${sol3.id}/pedir-autorizacao-consultor`, {}, auth(tokenCoord));
    const negaAprovarDireto = await post(`/api/solicitacoes-peca/${sol3.id}/consultor-decidir`, { decisao: 'aprovado' }, auth(tokenConsultor));
    assert.equal(negaAprovarDireto.status, 400);
    const rEncaminha = await post(`/api/solicitacoes-peca/${sol3.id}/consultor-decidir`, { decisao: 'encaminhar_diretoria', observacao: 'valor alto' }, auth(tokenConsultor));
    assert.equal((await rEncaminha.json()).solicitacao.status, 'aguardando_diretoria');
    const rDiretoria = await post(`/api/solicitacoes-peca/${sol3.id}/diretoria-decidir`, { decisao: 'aprovado' }, authAdmin);
    assert.equal((await rDiretoria.json()).solicitacao.status, 'aprovado');

    // --- linha do tempo de responsabilidade: histórico completo registrado ---
    const { solicitacao: sol3Detalhe } = await (await get(`/api/solicitacoes-peca/${sol3.id}`, authAdmin)).json();
    const statusHistorico = sol3Detalhe.historico.map((h) => h.para);
    assert.deepEqual(statusHistorico, ['pendente', 'ciente', 'aguardando_consultor', 'aguardando_diretoria', 'aprovado']);

    // --- visível no QR do equipamento (evita duplicidade, seção 5/9) ---
    const porQr = await (await get(`/api/equipamentos/por-qr/${equip.qr_token}`, auth(tokenGerente))).json();
    assert.ok(porQr.solicitacoes_abertas.some((s) => s.id === sol2.id));
    assert.ok(!porQr.solicitacoes_abertas.some((s) => s.id === sol1.id), 'sol1 já instalada não deveria aparecer como aberta');

    // --- escopo: coordenador não pode decidir como consultor ---
    const negaDecisaoConsultor = await post(`/api/solicitacoes-peca/${sol2.id}/consultor-decidir`, { decisao: 'aprovado' }, auth(tokenCoord));
    assert.equal(negaDecisaoConsultor.status, 403);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});

function RESPONSAVEL_PENDENTE() {
  return 'Gerente da loja / Coordenador técnico (dar ciente)';
}
