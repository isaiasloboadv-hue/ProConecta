// versão Restaurantes/rede multiunidade (Fase 5 — Gestão e comunicação, pedido do usuário):
// dashboard de equipamentos parados aguardando peça (com cards e matriz de compras), mural de
// avisos (setor/geral) e chat por canal (geral/setor/loja, com referência a O.S.). Prova pela API
// HTTP de verdade.
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
    pedidos_compra: [], pedido_itens: [], estoque_central: [], estoque_loja: [], transferencias: [],
    avisos: [], mensagens_canal: [],
    _seq: {
      usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, setores: 1, filiais: 1, areas: 1,
      vistorias: 1, vistoria_itens: 1, apoios: 1, pecas_catalogo: 1, solicitacoes_peca: 1,
      pedidos_compra: 1, pedido_itens: 1, estoque_central: 1, estoque_loja: 1, transferencias: 1,
      avisos: 1, mensagens_canal: 1,
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

test('versão Restaurantes — Fase 5: dashboard de equipamentos parados, mural de avisos e chat por canal', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-gestao-filial-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 41400 + Math.floor(Math.random() * 900);

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

    // --- 2 setores, 1 loja cada ---
    const setorA = (await (await post('/api/setores', { nome: 'Setor A' })).json()).setor;
    const setorB = (await (await post('/api/setores', { nome: 'Setor B' })).json()).setor;
    const coordA = await criarUsuario('Coordenador A', 'coordA@rede.com', 'coordenador_tecnico', { setor_id: setorA.id });
    const consultorA = await criarUsuario('Consultor A', 'consultorA@rede.com', 'consultor_mercado', { setor_id: setorA.id });
    await put(`/api/setores/${setorA.id}`, { nome: 'Setor A', coordenador_id: coordA.id, consultor_id: consultorA.id });

    const lojaA = (await (await post('/api/filiais', { nome: 'Loja A', setor_id: setorA.id })).json()).filial;
    const tecnicoA = await criarUsuario('Técnico A', 'tecnicoA@rede.com', 'suporte', { filial_id: lojaA.id });
    const gerenteA = await criarUsuario('Gerente A', 'gerenteA@rede.com', 'gerente_loja', { filial_id: lojaA.id });
    await put(`/api/filiais/${lojaA.id}`, { nome: 'Loja A', setor_id: setorA.id, tecnico_id: tecnicoA.id, gerente_id: gerenteA.id });

    const lojaB = (await (await post('/api/filiais', { nome: 'Loja B', setor_id: setorB.id })).json()).filial;
    const gerenteB = await criarUsuario('Gerente B', 'gerenteB@rede.com', 'gerente_loja', { filial_id: lojaB.id });

    const { areas } = await (await get(`/api/areas?filial_id=${lojaA.id}`)).json();
    const areaCozinha = areas.find((a) => a.nome === 'Cozinha');
    const cat1 = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const equip1 = (await (await post(`/api/equipamentos/${cat1.equipamento.id}/atrelar-filial`, { filial_id: lojaA.id, area_id: areaCozinha.id, numero_serie: 'SN-1' })).json()).equipamento;
    const cat2 = await (await post('/api/equipamentos', { tipo: 'Câmara fria', modelo: 'CF-200' })).json();
    const equip2 = (await (await post(`/api/equipamentos/${cat2.equipamento.id}/atrelar-filial`, { filial_id: lojaA.id, area_id: areaCozinha.id, numero_serie: 'SN-2' })).json()).equipamento;

    const tokenTecnicoA = await login('tecnicoA@rede.com');
    const tokenGerenteA = await login('gerenteA@rede.com');
    const tokenCoordA = await login('coordA@rede.com');
    const tokenConsultorA = await login('consultorA@rede.com');
    const tokenGerenteB = await login('gerenteB@rede.com');

    // --- duas solicitações: uma barata (fica "aprovado"/aguardando compra) e uma cara
    // (sobe pro consultor) — alimenta o dashboard e a matriz de compras ---
    const rSol1 = await post('/api/solicitacoes-peca', { equipamento_id: equip1.id, prioridade: 'urgente', descricao: 'Resistência', quantidade: 1, valor_unitario: 50 }, auth(tokenTecnicoA));
    const sol1 = (await rSol1.json()).solicitacao;
    await post(`/api/solicitacoes-peca/${sol1.id}/ciente`, {}, auth(tokenGerenteA));
    await post(`/api/solicitacoes-peca/${sol1.id}/aprovar-local`, {}, auth(tokenGerenteA));

    const rSol2 = await post('/api/solicitacoes-peca', { equipamento_id: equip2.id, prioridade: 'nao_urgente', descricao: 'Compressor', quantidade: 1, valor_unitario: 600 }, auth(tokenTecnicoA));
    const sol2 = (await rSol2.json()).solicitacao;
    await post(`/api/solicitacoes-peca/${sol2.id}/ciente`, {}, auth(tokenGerenteA));
    await post(`/api/solicitacoes-peca/${sol2.id}/pedir-autorizacao-consultor`, {}, auth(tokenGerenteA));

    // --- dashboard: coordenador do Setor A vê as duas solicitações em aberto ---
    const { parados, matriz_compras } = await (await get('/api/dashboards/filiais', auth(tokenCoordA))).json();
    assert.equal(parados.cards.total, 2);
    assert.equal(parados.cards.aguardando_consultor, 1);
    assert.equal(parados.cards.aguardando_entrega, 0); // sol1 está só "aprovado" (ainda não comprado)
    assert.equal(matriz_compras.urgente.aprovado, 1); // sol1
    assert.equal(matriz_compras.nao_urgente.pendente, 1); // sol2, status "aguardando_consultor" cai no bucket "pendente"

    // gerente da Loja B (outro setor) não vê nada do Setor A no dashboard
    const dashGerenteB = await (await get('/api/dashboards/filiais', auth(tokenGerenteB))).json();
    assert.equal(dashGerenteB.parados.cards.total, 0);

    // --- mural de avisos: administrador publica geral, coordenador A publica no próprio setor ---
    const rAvisoGeral = await post('/api/avisos', { titulo: 'Recall de peça', corpo: 'Atenção a todos.' }, authAdmin);
    assert.equal(rAvisoGeral.status, 201);
    const rAvisoSetor = await post('/api/avisos', { titulo: 'Nova preventiva', corpo: 'Só pro Setor A.' }, auth(tokenCoordA));
    assert.equal(rAvisoSetor.status, 201);

    // gerente da Loja A (Setor A) vê os dois avisos
    const { avisos: avisosGerenteA } = await (await get('/api/avisos', auth(tokenGerenteA))).json();
    assert.equal(avisosGerenteA.length, 2);
    // gerente da Loja B (Setor B) só vê o geral
    const { avisos: avisosGerenteB } = await (await get('/api/avisos', auth(tokenGerenteB))).json();
    assert.equal(avisosGerenteB.length, 1);
    assert.equal(avisosGerenteB[0].setor_nome, 'Geral');

    // consultor de mercado não publica aviso de setor de outro (nem existe nesse teste, mas
    // confirma que um papel sem permissão de publicar é recusado)
    const negaPublicar = await post('/api/avisos', { titulo: 'x', corpo: 'y' }, auth(tokenGerenteA));
    assert.equal(negaPublicar.status, 403);

    // --- chat por canal ---
    const { canais: canaisGerenteA } = await (await get('/api/mensagens-canal/canais', auth(tokenGerenteA))).json();
    assert.ok(canaisGerenteA.some((c) => c.canal === 'geral'));
    assert.ok(canaisGerenteA.some((c) => c.canal === `filial:${lojaA.id}`));
    assert.ok(canaisGerenteA.some((c) => c.canal === `setor:${setorA.id}`));

    // gerente A manda mensagem no canal da própria loja, citando a solicitação 1
    const rMsg = await post('/api/mensagens-canal', {
      canal: `filial:${lojaA.id}`, texto: 'Já pedimos a peça da fritadeira', referencia: { tipo: 'solicitacao', id: sol1.id },
    }, auth(tokenGerenteA));
    assert.equal(rMsg.status, 201);
    assert.deepEqual((await rMsg.json()).mensagem.referencia, { tipo: 'solicitacao', id: sol1.id });

    // coordenador do Setor A (mesmo setor da loja) consegue ler
    const { mensagens: msgsCoord } = await (await get(`/api/mensagens-canal?canal=filial:${lojaA.id}`, auth(tokenCoordA))).json();
    assert.equal(msgsCoord.length, 1);

    // gerente da Loja B (outro setor) NÃO pode ler nem escrever no canal da Loja A
    const negaLer = await get(`/api/mensagens-canal?canal=filial:${lojaA.id}`, auth(tokenGerenteB));
    assert.equal(negaLer.status, 403);
    const negaEscrever = await post('/api/mensagens-canal', { canal: `filial:${lojaA.id}`, texto: 'oi' }, auth(tokenGerenteB));
    assert.equal(negaEscrever.status, 403);

    // qualquer um no escopo da operação pode falar no canal geral
    const rMsgGeral = await post('/api/mensagens-canal', { canal: 'geral', texto: 'Bom dia a todos' }, auth(tokenGerenteB));
    assert.equal(rMsgGeral.status, 201);

    // consultor do Setor A também acessa o canal do setor
    const { mensagens: msgsSetor } = await (await get(`/api/mensagens-canal?canal=setor:${setorA.id}`, auth(tokenConsultorA))).json();
    assert.deepEqual(msgsSetor, []); // ninguém mandou mensagem nesse canal específico ainda, só confirma acesso (200, não 403)
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
