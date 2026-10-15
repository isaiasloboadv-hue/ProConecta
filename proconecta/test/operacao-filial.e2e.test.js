// versão Restaurantes/rede multiunidade (Fase 2 — Operação, pedido do usuário): vistoria guiada
// por área gerando O.S., SLA com prazo configurável + pausa/retomada, validação da conclusão pelo
// gerente e apoio técnico entre setores. Prova pela API HTTP de verdade.
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
    vistorias: [], vistoria_itens: [], apoios: [],
    _seq: { usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, setores: 1, filiais: 1, areas: 1, vistorias: 1, vistoria_itens: 1, apoios: 1 },
    empresas: [
      // SLA de teste: prazos bem curtos (frações de hora) pra não precisar esperar nada de verdade,
      // só comparar os cálculos de data.
      { id: 1, nome: 'Rede Franquia', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['filiais', 'relatorios', 'os_chamados', 'equipe_avancado'], terminologia: {}, sla_prazos_horas: { critico: 1, alto: 2, medio: 24 } },
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

test('versão Restaurantes — Fase 2: vistoria gera O.S., SLA com prazo/pausa, validação e apoio entre setores', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-operacao-filial-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 38300 + Math.floor(Math.random() * 900);

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
      assert.equal(ativar.status, 200, `falhou ativar ${email}`);
      return corpo.usuario;
    }

    // --- 2 setores, 1 filial cada, com técnico+gerente, coordenador por setor ---
    const setorSul = (await (await post('/api/setores', { nome: 'Setor Sul' })).json()).setor;
    const setorNorte = (await (await post('/api/setores', { nome: 'Setor Norte' })).json()).setor;
    const coordSul = await criarUsuario('Coordenador Sul', 'coord.sul@rede.com', 'coordenador_tecnico', { setor_id: setorSul.id });
    const coordNorte = await criarUsuario('Coordenador Norte', 'coord.norte@rede.com', 'coordenador_tecnico', { setor_id: setorNorte.id });
    await put(`/api/setores/${setorSul.id}`, { nome: 'Setor Sul', coordenador_id: coordSul.id });
    await put(`/api/setores/${setorNorte.id}`, { nome: 'Setor Norte', coordenador_id: coordNorte.id });

    const lojaSul = (await (await post('/api/filiais', { nome: 'Loja Sul', setor_id: setorSul.id })).json()).filial;
    // técnico (suporte) não tem setor_id próprio — o setor dele é derivado da filial_id (loja
    // base), ver setorDoTecnico em server.js.
    const tecnicoSul = await criarUsuario('Técnico Sul', 'tecnico.sul@rede.com', 'suporte', { filial_id: lojaSul.id });
    const gerenteSul = await criarUsuario('Gerente Sul', 'gerente.sul@rede.com', 'gerente_loja', { filial_id: lojaSul.id });
    await put(`/api/filiais/${lojaSul.id}`, { nome: 'Loja Sul', setor_id: setorSul.id, tecnico_id: tecnicoSul.id, gerente_id: gerenteSul.id });

    const lojaNorte = (await (await post('/api/filiais', { nome: 'Loja Norte', setor_id: setorNorte.id })).json()).filial;
    const tecnicoNorte = await criarUsuario('Técnico Norte', 'tecnico.norte@rede.com', 'suporte', { filial_id: lojaNorte.id });
    await put(`/api/filiais/${lojaNorte.id}`, { nome: 'Loja Norte', setor_id: setorNorte.id, tecnico_id: tecnicoNorte.id });

    const { areas: areasLojaSul } = await (await get(`/api/areas?filial_id=${lojaSul.id}`)).json();
    const areaCozinha = areasLojaSul.find((a) => a.nome === 'Cozinha');

    const catalogo = await (await post('/api/equipamentos', { tipo: 'Fritadeira', modelo: 'FR-100' })).json();
    const rAtrelar = await post(`/api/equipamentos/${catalogo.equipamento.id}/atrelar-filial`, { filial_id: lojaSul.id, area_id: areaCozinha.id, numero_serie: 'SN-01' });
    const equip = (await rAtrelar.json()).equipamento;

    // --- vistoria: abre, lança pendência crítica na Cozinha, conclui -> gera O.S. pro técnico da loja ---
    const vistoria = (await (await post('/api/vistorias', { filial_id: lojaSul.id })).json()).vistoria;
    const rItem = await post(`/api/vistorias/${vistoria.id}/itens`, {
      area_id: areaCozinha.id, equipamento_id: equip.id, descricao: 'Fritadeira vazando óleo', sla_sugerido: 'critico',
    });
    assert.equal(rItem.status, 201);
    assert.equal((await rItem.json()).aviso_duplicidade, null);

    const rConcluir = await post(`/api/vistorias/${vistoria.id}/concluir`, {});
    assert.equal(rConcluir.status, 200);
    const { criadas } = await rConcluir.json();
    assert.equal(criadas.length, 1);
    const os1 = criadas[0];
    assert.equal(os1.tecnico_id, tecnicoSul.id);
    assert.equal(os1.etapa, 'aberta');
    assert.equal(os1.sla_criticidade, 'critico');
    assert.ok(os1.sla_prazo_em, 'crítico tem prazo');
    // prazo = criado_em + 1h (sla_prazos_horas.critico = 1 nesta fixture)
    const prazoMs = new Date(os1.sla_prazo_em).getTime() - new Date(os1.criado_em).getTime();
    assert.ok(Math.abs(prazoMs - 3600000) < 2000, `prazo deveria ser ~1h, foi ${prazoMs}ms`);

    // segunda vistoria pro MESMO equipamento avisa duplicidade (O.S. já aberta)
    const vistoria2 = (await (await post('/api/vistorias', { filial_id: lojaSul.id })).json()).vistoria;
    const rItemDup = await post(`/api/vistorias/${vistoria2.id}/itens`, { area_id: areaCozinha.id, equipamento_id: equip.id, descricao: 'De novo' });
    const corpoDup = await rItemDup.json();
    assert.equal(corpoDup.aviso_duplicidade.agenda_id, os1.id);

    // --- escopo: coordenador do Setor Norte não pode mexer na O.S. da Loja Sul ---
    const tokenCoordNorte = await login('coord.norte@rede.com');
    const negaCriticidade = await put(`/api/agenda/${os1.id}/sla-criticidade`, { sla_criticidade: 'baixo' }, auth(tokenCoordNorte));
    assert.equal(negaCriticidade.status, 403);

    // coordenador do Setor Sul pode mudar a criticidade — e o prazo é recalculado
    const tokenCoordSul = await login('coord.sul@rede.com');
    const rCrit = await put(`/api/agenda/${os1.id}/sla-criticidade`, { sla_criticidade: 'alto' }, auth(tokenCoordSul));
    assert.equal(rCrit.status, 200);
    const osAlto = (await rCrit.json()).agenda;
    assert.equal(osAlto.sla_criticidade, 'alto');
    assert.equal(osAlto.sla_historico.length, 2);

    // --- técnico avança etapa pra "aguardando_peca" -> pausa o SLA ---
    const tokenTecnicoSul = await login('tecnico.sul@rede.com');
    const rPausa = await put(`/api/agenda/${os1.id}/etapa`, { etapa: 'aguardando_peca' }, auth(tokenTecnicoSul));
    assert.equal(rPausa.status, 200);
    const osPausada = (await rPausa.json()).agenda;
    assert.equal(osPausada.sla_pausas.length, 1);
    assert.equal(osPausada.sla_pausas[0].retomado_em, null);
    const prazoAntesRetomada = osPausada.sla_prazo_em;

    // espera um pouquinho de verdade pra ter uma pausa com duração mensurável, depois retoma
    await new Promise((r) => setTimeout(r, 1100));
    const rRetoma = await put(`/api/agenda/${os1.id}/etapa`, { etapa: 'em_execucao' }, auth(tokenTecnicoSul));
    const osRetomada = (await rRetoma.json()).agenda;
    assert.ok(osRetomada.sla_pausas[0].retomado_em, 'pausa tem que ter sido encerrada');
    assert.ok(new Date(osRetomada.sla_prazo_em).getTime() > new Date(prazoAntesRetomada).getTime(), 'prazo tem que ter esticado pelo tempo pausado');

    // técnico de outra loja não pode mexer nesta O.S.
    const tokenTecnicoNorte = await login('tecnico.norte@rede.com');
    const negaEtapa = await put(`/api/agenda/${os1.id}/etapa`, { etapa: 'em_execucao' }, auth(tokenTecnicoNorte));
    assert.equal(negaEtapa.status, 403);

    // --- técnico conclui (exige foto) ---
    const semFoto = await post(`/api/agenda/${os1.id}/concluir-filial`, { descricao: 'Troquei a resistência' }, auth(tokenTecnicoSul));
    assert.equal(semFoto.status, 400);
    const comFoto = await post(`/api/agenda/${os1.id}/concluir-filial`, {
      descricao: 'Troquei a resistência', fotos: ['data:image/png;base64,' + 'A'.repeat(200)],
    }, auth(tokenTecnicoSul));
    assert.equal(comFoto.status, 200);
    assert.equal((await comFoto.json()).agenda.etapa, 'concluida');

    // --- gerente da loja valida ---
    const tokenGerenteSul = await login('gerente.sul@rede.com');
    const rValidar = await post(`/api/agenda/${os1.id}/validar-filial`, {}, auth(tokenGerenteSul));
    assert.equal(rValidar.status, 200);
    assert.equal((await rValidar.json()).agenda.etapa, 'validada');

    // --- apoio entre setores: coordenador Norte pede O.S. nova e pede apoio do Sul (exemplo
    // inverso de cobertura) ---
    const osNorteResp = await post('/api/agenda/filial', { filial_id: lojaNorte.id, problema: 'Câmara fria parada', sla_criticidade: 'critico' }, auth(tokenCoordNorte));
    assert.equal(osNorteResp.status, 201);
    const osNorte = (await osNorteResp.json()).agenda;
    const rApoio = await post('/api/apoios', { agenda_id: osNorte.id, setor_destino_id: setorSul.id, motivo: 'técnico de folga' }, auth(tokenCoordNorte));
    assert.equal(rApoio.status, 201);
    const apoio = (await rApoio.json()).apoio;
    assert.equal(apoio.status, 'pedido');

    // coordenador errado (o próprio Norte) não pode aceitar o próprio pedido — só o destino (Sul)
    const negaAceitarProprio = await put(`/api/apoios/${apoio.id}/aceitar`, { tecnico_id: tecnicoNorte.id }, auth(tokenCoordNorte));
    assert.equal(negaAceitarProprio.status, 403);

    const rAceitar = await put(`/api/apoios/${apoio.id}/aceitar`, { tecnico_id: tecnicoSul.id }, auth(tokenCoordSul));
    assert.equal(rAceitar.status, 200);
    const osComApoio = (await rAceitar.json()).agenda;
    assert.equal(osComApoio.tecnico_id, tecnicoSul.id);

    // técnico do Sul (designado em apoio) agora vê a O.S. da Loja Norte na própria agenda
    const minhaAgendaTecnicoSul = await (await get('/api/agenda', auth(tokenTecnicoSul))).json();
    assert.ok(minhaAgendaTecnicoSul.agenda.some((a) => a.id === osNorte.id));

    // --- lojas descobertas: marca o técnico fixo da Loja Norte de férias hoje e confere o alerta ---
    const hoje = new Date().toISOString().slice(0, 10);
    const rEscala = await fetch(`${base}/api/escala-folgas`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ usuario_id: tecnicoNorte.id, data: hoje, tipo: 'ferias' }),
    });
    assert.equal(rEscala.status, 201, `falhou marcar férias: ${JSON.stringify(await rEscala.clone().json())}`);
    const rDescobertas = await get(`/api/filiais/descobertas?data=${hoje}`, auth(tokenCoordNorte));
    assert.equal(rDescobertas.status, 200);
    const { descobertas } = await rDescobertas.json();
    assert.ok(descobertas.some((d) => d.filial.id === lojaNorte.id));
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
