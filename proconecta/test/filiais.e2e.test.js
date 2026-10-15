// versão Restaurantes/rede multiunidade (Fase 1 — Base, pedido do usuário): setores → filiais →
// áreas, papéis novos (gerente_loja/coordenador_tecnico/consultor_mercado) com escopo de acesso
// (ver escopo.js), equipamento com QR Code. Prova pela API HTTP de verdade, com uma fixture no
// mesmo formato do pedido do usuário (1 grupo, 2 setores, 6 filiais com técnico+gerente, 2
// coordenadores, 2 consultores, equipamentos em áreas).
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
      // empresa sem o módulo "filiais" — só pra provar que o papel novo é recusado nela.
      { id: 2, nome: 'Admin Sem Filiais', email: 'admin@semfiliais.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], setores: [], filiais: [], areas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, setores: 1, filiais: 1, areas: 1 },
    empresas: [
      { id: 1, nome: 'Rede Franquia', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['filiais', 'relatorios', 'os_chamados'], terminologia: {} },
      { id: 2, nome: 'Empresa Sem Filiais', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['relatorios'], terminologia: {} },
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

test('versão Restaurantes: setores/filiais/áreas, papéis novos com escopo, equipamento com QR', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-filiais-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 37300 + Math.floor(Math.random() * 900);

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

    // --- gating: papéis novos recusados numa empresa sem o módulo "filiais" ---
    const tokenAdminSemFiliais = await login('admin@semfiliais.com');
    const negado = await post('/api/usuarios', { nome: 'Fulano', email: 'fulano@semfiliais.com', papel: 'gerente_loja' }, auth(tokenAdminSemFiliais));
    assert.equal(negado.status, 400);

    // --- 2 setores ---
    const setor1 = await (await post('/api/setores', { nome: 'Setor Sul' })).json();
    const setor2 = await (await post('/api/setores', { nome: 'Setor Norte' })).json();
    assert.ok(setor1.setor.id && setor2.setor.id);

    // --- 2 coordenadores, 2 consultores (um por setor) ---
    // POST /api/usuarios só manda convite (sem senha) — ativa na hora com a mesma senha de todo
    // mundo nesta fixture, pra depois dar pra logar como essa pessoa (ver login() acima).
    async function criarUsuario(nome, email, papel, extra) {
      const r = await post('/api/usuarios', { nome, email, papel, ...extra });
      assert.equal(r.status, 201, `falhou criar ${papel} ${email}: ${JSON.stringify(await r.clone().json())}`);
      const corpo = await r.json();
      const token = new URL(corpo.convite.link).searchParams.get('token');
      const ativar = await fetch(`${base}/api/convite/${token}/ativar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'senha1234' }),
      });
      assert.equal(ativar.status, 200, `falhou ativar ${email}`);
      return corpo.usuario;
    }
    const coord1 = await criarUsuario('Coordenador Sul', 'coord.sul@rede.com', 'coordenador_tecnico', { setor_id: setor1.setor.id });
    const coord2 = await criarUsuario('Coordenador Norte', 'coord.norte@rede.com', 'coordenador_tecnico', { setor_id: setor2.setor.id });
    const consult1 = await criarUsuario('Consultor Sul', 'consult.sul@rede.com', 'consultor_mercado', { setor_id: setor1.setor.id });
    const consult2 = await criarUsuario('Consultor Norte', 'consult.norte@rede.com', 'consultor_mercado', { setor_id: setor2.setor.id });
    assert.equal(coord1.setor_id, setor1.setor.id);

    // atribuir no próprio setor também sincroniza (re-afirma o vínculo, PUT idempotente)
    const setor1Editado = await (await put(`/api/setores/${setor1.setor.id}`, { nome: 'Setor Sul', coordenador_id: coord1.id, consultor_id: consult1.id })).json();
    assert.equal(setor1Editado.setor.coordenador_id, coord1.id);

    // --- 6 filiais (3 por setor): a filial nasce sem gerente/técnico (ninguém existe ainda —
    // gerente_loja exige filial_id já existente pra ser criado, ver validarReferenciasEstruturaFiliais
    // em server.js), depois os usuários são criados JÁ apontando pra ela, e por fim a filial é
    // atualizada com as referências — prova o fluxo real, não um atalho de teste.
    const filiais = [];
    for (let i = 1; i <= 6; i++) {
      const setorId = i <= 3 ? setor1.setor.id : setor2.setor.id;
      const rf = await post('/api/filiais', { nome: `Loja ${i}`, setor_id: setorId });
      assert.equal(rf.status, 201);
      const filial = (await rf.json()).filial;
      const tecnico = await criarUsuario(`Técnico Loja ${i}`, `tecnico${i}@rede.com`, 'suporte', { filial_id: filial.id });
      const gerente = await criarUsuario(`Gerente Loja ${i}`, `gerente${i}@rede.com`, 'gerente_loja', { filial_id: filial.id });
      const rfEditada = await put(`/api/filiais/${filial.id}`, { nome: filial.nome, setor_id: setorId, tecnico_id: tecnico.id, gerente_id: gerente.id });
      assert.equal(rfEditada.status, 200);
      filiais.push({ filial, tecnico, gerente });
    }
    assert.equal(filiais.length, 6);

    // usuario.filial_id já tinha vindo certo da própria criação (acima); confirma que a filial
    // também guarda a referência de volta (pro cadastro mostrar quem é o gerente/técnico).
    const { filiais: filiaisAtuais } = await (await get('/api/filiais')).json();
    const filial1Atual = filiaisAtuais.find((f) => f.id === filiais[0].filial.id);
    assert.equal(filial1Atual.gerente_id, filiais[0].gerente.id);
    assert.equal(filial1Atual.tecnico_id, filiais[0].tecnico.id);

    // --- áreas padrão foram criadas automaticamente em cada filial ---
    const { areas: areasLoja1 } = await (await get(`/api/areas?filial_id=${filiais[0].filial.id}`)).json();
    assert.deepEqual(areasLoja1.map((a) => a.nome).sort(), ['Balcão', 'Conservação', 'Cozinha', 'Fundo', 'Salão', 'Área externa'].sort());

    // --- equipamento: catálogo -> atrelar à filial 1, área "Cozinha" -> ganha QR ---
    const catalogo = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const areaCozinha1 = areasLoja1.find((a) => a.nome === 'Cozinha');
    const rAtrelar = await post(`/api/equipamentos/${catalogo.equipamento.id}/atrelar-filial`, {
      filial_id: filiais[0].filial.id, area_id: areaCozinha1.id, numero_serie: 'SN-001', codigo_interno: 'FR01',
    });
    assert.equal(rAtrelar.status, 201);
    const equipFritadeira = (await rAtrelar.json()).equipamento;
    assert.ok(equipFritadeira.qr_token);
    assert.equal(equipFritadeira.status_operacional, 'operando');
    assert.equal(equipFritadeira.area_id, areaCozinha1.id);

    // --- equipamento na filial 4 (outro setor), pra testar isolamento de escopo ---
    const catalogo2 = await (await post('/api/equipamentos', { tipo: 'Câmara fria', modelo: 'CF-200' })).json();
    const rAtrelar2 = await post(`/api/equipamentos/${catalogo2.equipamento.id}/atrelar-filial`, { filial_id: filiais[3].filial.id, numero_serie: 'SN-002' });
    const equipCamaraFria = (await rAtrelar2.json()).equipamento;

    // --- GET /api/equipamentos/por-qr/:token (seção 5 do pedido do usuário) ---
    const porQr = await (await get(`/api/equipamentos/por-qr/${equipFritadeira.qr_token}`)).json();
    assert.equal(porQr.equipamento.id, equipFritadeira.id);
    assert.deepEqual(porQr.agenda_aberta, []);

    // --- escopo: gerente da loja 1 só vê equipamentos da própria filial (+ catálogo) ---
    const tokenGerente1 = await login('gerente1@rede.com');
    const equipGerente1 = await (await get('/api/equipamentos', auth(tokenGerente1))).json();
    const idsGerente1 = equipGerente1.equipamentos.map((e) => e.id);
    assert.ok(idsGerente1.includes(equipFritadeira.id), 'gerente da loja 1 deveria ver o equipamento da própria loja');
    assert.ok(!idsGerente1.includes(equipCamaraFria.id), 'gerente da loja 1 NÃO deveria ver equipamento de outra loja');

    // gerente da loja 1 não pode ler o QR de equipamento de outra loja (404, não 403 — não denuncia existência)
    const porQrNegado = await get(`/api/equipamentos/por-qr/${equipCamaraFria.qr_token}`, auth(tokenGerente1));
    assert.equal(porQrNegado.status, 404);

    // --- escopo: coordenador do Setor Sul vê equipamentos das 3 lojas do setor, não do outro ---
    const tokenCoord1 = await login('coord.sul@rede.com');
    const equipCoord1 = await (await get('/api/equipamentos', auth(tokenCoord1))).json();
    const idsCoord1 = equipCoord1.equipamentos.map((e) => e.id);
    assert.ok(idsCoord1.includes(equipFritadeira.id));
    assert.ok(!idsCoord1.includes(equipCamaraFria.id));

    // --- técnico (suporte) vê TODAS as lojas, mesmo as de outro setor ---
    const tokenTecnico1 = await login('tecnico1@rede.com');
    const equipTecnico1 = await (await get('/api/equipamentos', auth(tokenTecnico1))).json();
    const idsTecnico1 = equipTecnico1.equipamentos.map((e) => e.id);
    assert.ok(idsTecnico1.includes(equipFritadeira.id) && idsTecnico1.includes(equipCamaraFria.id));

    // --- exclusões bloqueadas quando há vínculo ---
    const negaExcluirSetor = await fetch(`${base}/api/setores/${setor1.setor.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(negaExcluirSetor.status, 400);
    const negaExcluirFilial = await fetch(`${base}/api/filiais/${filiais[0].filial.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(negaExcluirFilial.status, 400);
    const negaExcluirArea = await fetch(`${base}/api/areas/${areaCozinha1.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(negaExcluirArea.status, 400);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
