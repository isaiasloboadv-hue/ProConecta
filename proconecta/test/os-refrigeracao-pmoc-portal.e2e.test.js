// pedido do usuário: pacote "Climatização / PMOC", Fase 4 — Documento PMOC e portal do cliente
// final. Prova pela API HTTP de verdade: vínculo usuário "cliente" ↔ os_refrigeracao_cliente_id
// (ver POST/PUT /api/usuarios e exigirClientePortalPmoc em server.js), isolamento total entre
// clientes diferentes da mesma empresa (cada um só vê os próprios locais/ambientes/aparelhos/
// visitas), CRUD de Qualidade do Ar, corretude dos dados do Documento PMOC e do Relatório Mensal
// consolidado, e o fluxo de "abrir chamado" avulso a partir de um aparelho específico do portal.
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
      { id: 1, nome: 'Admin PMOC', email: 'admin@pmoc4.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      // cliente "cliente" ainda sem vínculo nenhum de PMOC — prova o 403 de exigirClientePortalPmoc.
      { id: 2, nome: 'Cliente Sem Vínculo', email: 'semvinculo@pmoc4.com', papel: 'cliente', status: 'ativo', empresa_id: 1, cliente_id: null, os_refrigeracao_cliente_id: null, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [],
    _seq: {
      usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa', site: '', whatsapp: '', telefone: '', emails: ['contato@climacerta.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: [] }],
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

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PDF_1X1 = 'data:application/pdf;base64,JVBERi0xLjQK';

test('PMOC (Fase 4 — Documento PMOC e portal do cliente): vínculo/isolamento, qualidade do ar, documento, relatório mensal e portal', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-portal-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44700 + Math.floor(Math.random() * 900);

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
    const authAdmin = auth(await login('admin@pmoc4.com'));

    // ---- cadastro base: dois clientes PMOC, cada um com seu local/ambiente/aparelho ----
    const clienteA = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente A' }) })).json()).cliente;
    const clienteB = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente B' }) })).json()).cliente;
    const localA = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: clienteA.id, nome: 'Loja A', tipo_atividade: 'loja', endereco: 'Rua A, 1' }) })).json()).local;
    const localB = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: clienteB.id, nome: 'Loja B', tipo_atividade: 'loja', endereco: 'Rua B, 2' }) })).json()).local;
    const ambienteA = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localA.id, nome: 'Salão A' }) })).json()).ambiente;
    const ambienteB = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: localB.id, nome: 'Salão B' }) })).json()).ambiente;
    const aparelhoA = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambienteA.id, tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'X1' }) })).json()).aparelho;
    const aparelhoB = (await (await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambienteB.id, tipo: 'Cassete' }) })).json()).aparelho;

    // ---- usuários "cliente" ligados a cada um (POST /api/usuarios com os_refrigeracao_cliente_id)
    // — nasce como convite pendente (sem senha), igual a qualquer outro usuário; ativa pelo link
    // público do convite (mesmo fluxo real do ativar.html) pra então logar de verdade. ----
    const rCriaUsuarioA = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Portal A', email: 'portalA@pmoc4.com', papel: 'cliente', os_refrigeracao_cliente_id: clienteA.id }),
    });
    assert.equal(rCriaUsuarioA.status, 201);
    const usuarioA = (await rCriaUsuarioA.json()).usuario;
    assert.equal(usuarioA.os_refrigeracao_cliente_id, clienteA.id);
    const rCriaUsuarioB = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Portal B', email: 'portalB@pmoc4.com', papel: 'cliente', os_refrigeracao_cliente_id: clienteB.id }),
    });
    const usuarioB = (await rCriaUsuarioB.json()).usuario;
    assert.equal(usuarioB.os_refrigeracao_cliente_id, clienteB.id);

    // ativa pelo convite_token salvo direto no banco de teste (o e-mail de convite real não roda aqui).
    const dbAtual = () => JSON.parse(fs.readFileSync(dbTemp, 'utf8'));
    const tokenA = dbAtual().usuarios.find((u) => u.email === 'portalA@pmoc4.com').convite_token;
    const tokenB = dbAtual().usuarios.find((u) => u.email === 'portalB@pmoc4.com').convite_token;
    const rAtivaA = await fetch(`${base}/api/convite/${tokenA}/ativar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'senha1234' }) });
    assert.equal(rAtivaA.status, 200);
    const authPortalA = auth((await rAtivaA.json()).token);
    const rAtivaB = await fetch(`${base}/api/convite/${tokenB}/ativar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'senha1234' }) });
    const authPortalB = auth((await rAtivaB.json()).token);
    const authSemVinculo = auth(await login('semvinculo@pmoc4.com'));

    // ---- gate: cliente sem os_refrigeracao_cliente_id não acessa o portal ----
    const rSemVinculo = await fetch(`${base}/api/pmoc/portal/locais`, { headers: authSemVinculo });
    assert.equal(rSemVinculo.status, 403);
    // administrador (outro papel) também não acessa as rotas do portal.
    const rPapelErrado = await fetch(`${base}/api/pmoc/portal/locais`, { headers: authAdmin });
    assert.equal(rPapelErrado.status, 403);

    // ---- isolamento: Portal A só vê a Loja A, nunca a Loja B ----
    const { locais: locaisA } = await (await fetch(`${base}/api/pmoc/portal/locais`, { headers: authPortalA })).json();
    assert.equal(locaisA.length, 1);
    assert.equal(locaisA[0].id, localA.id);
    assert.equal(locaisA[0].total_ambientes, 1);
    assert.equal(locaisA[0].total_aparelhos, 1);
    const { locais: locaisB } = await (await fetch(`${base}/api/pmoc/portal/locais`, { headers: authPortalB })).json();
    assert.equal(locaisB.length, 1);
    assert.equal(locaisB[0].id, localB.id);

    // Portal A não consegue ver o detalhe da Loja B pelo id (404, não 200 com dado de outro cliente).
    const rCruzado = await fetch(`${base}/api/pmoc/portal/locais/${localB.id}`, { headers: authPortalA });
    assert.equal(rCruzado.status, 404);
    const rProprio = await fetch(`${base}/api/pmoc/portal/locais/${localA.id}`, { headers: authPortalA });
    assert.equal(rProprio.status, 200);
    const detalheA = await rProprio.json();
    assert.equal(detalheA.ambientes.length, 1);
    assert.equal(detalheA.ambientes[0].aparelhos.length, 1);
    assert.equal(detalheA.ambientes[0].aparelhos[0].id, aparelhoA.id);

    // ---- plano + responsável técnico (pra alimentar o Documento PMOC da Loja A) ----
    const responsavel = (await (await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Eng. Fulano', registro_profissional: 'CREA 12345', assinatura_img: PNG_1X1 }),
    })).json()).responsavel;
    const plano = (await (await fetch(`${base}/api/pmoc/planos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: localA.id, responsavel_tecnico_id: responsavel.id, data_inicio: '2026-01-10',
        art_trt_numero: 'ART-999', art_trt_anexo: PDF_1X1,
        itens: [{ descricao: 'Limpeza de filtros', periodicidade: 'mensal', tipos_aparelho: [] }],
      }),
    })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${plano.id}/ativar?hoje=2026-01-10`, { method: 'PUT', headers: authAdmin });

    // ---- qualidade do ar: CRUD pelo admin, leitura (só da própria) pelo portal ----
    const analise = (await (await fetch(`${base}/api/pmoc/qualidade-ar`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        local_id: localA.id, data: '2026-01-15', laboratorio: 'Lab Ar Puro',
        temperatura: '23', umidade: '55', co2: '650', observacoes: 'Dentro dos parâmetros.', laudo_pdf: PDF_1X1,
      }),
    })).json()).analise;
    assert.ok(analise.laudo_pdf); // hidratado de volta (data URI).
    const rEditaAnalise = await fetch(`${base}/api/pmoc/qualidade-ar/${analise.id}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ data: '2026-01-15', laboratorio: 'Lab Ar Puro', temperatura: '24', umidade: '55', co2: '650', observacoes: 'Revisado.' }),
    });
    assert.equal(rEditaAnalise.status, 200);
    assert.equal((await rEditaAnalise.json()).analise.temperatura, '24');

    const { analises: analisesPortalA } = await (await fetch(`${base}/api/pmoc/portal/locais/${localA.id}/qualidade-ar`, { headers: authPortalA })).json();
    assert.equal(analisesPortalA.length, 1);
    assert.equal(analisesPortalA[0].laboratorio, 'Lab Ar Puro');
    assert.ok(analisesPortalA[0].laudo_pdf);
    // Portal A não acessa qualidade do ar da Loja B (404, nem lista vazia silenciosa de um id que não é dele).
    const rQualidadeArCruzada = await fetch(`${base}/api/pmoc/portal/locais/${localB.id}/qualidade-ar`, { headers: authPortalA });
    assert.equal(rQualidadeArCruzada.status, 404);

    // ---- Documento PMOC (admin e portal devem bater, mesma função de montagem) ----
    const documentoAdmin = await (await fetch(`${base}/api/pmoc/locais/${localA.id}/documento`, { headers: authAdmin })).json();
    const documentoPortal = await (await fetch(`${base}/api/pmoc/portal/locais/${localA.id}/documento`, { headers: authPortalA })).json();
    assert.equal(documentoAdmin.local.nome, 'Loja A');
    assert.equal(documentoPortal.local.nome, 'Loja A');
    assert.equal(documentoPortal.responsavel_tecnico.nome, 'Eng. Fulano');
    assert.equal(documentoPortal.plano.art_trt_numero, 'ART-999');
    assert.ok(documentoPortal.plano.art_trt_anexo); // anexo não-imagem (PDF) hidratado via extrairAnexoGenerico.
    assert.equal(documentoPortal.cronograma.length, 12);
    assert.equal(documentoPortal.qualidade_ar.length, 1);
    assert.deepEqual(documentoAdmin.cronograma, documentoPortal.cronograma);
    // Documento PMOC da Loja B não é acessível pelo Portal A.
    const rDocumentoCruzado = await fetch(`${base}/api/pmoc/portal/locais/${localB.id}/documento`, { headers: authPortalA });
    assert.equal(rDocumentoCruzado.status, 404);

    // ---- visitas geradas pela ativação do plano: aparecem no portal, isoladas por cliente ----
    const { visitas: visitasPortalA } = await (await fetch(`${base}/api/pmoc/portal/visitas`, { headers: authPortalA })).json();
    assert.ok(visitasPortalA.length >= 1);
    assert.ok(visitasPortalA.every((v) => v.cliente_nome.startsWith('Cliente A')));
    const { visitas: visitasPortalB } = await (await fetch(`${base}/api/pmoc/portal/visitas`, { headers: authPortalB })).json();
    assert.deepEqual(visitasPortalB, []); // Cliente B não tem plano ativo, nenhuma visita.
    const visitaId = visitasPortalA[0].id;
    const rVisitaCruzada = await fetch(`${base}/api/pmoc/portal/visitas/${visitaId}`, { headers: authPortalB });
    assert.equal(rVisitaCruzada.status, 404);
    const rVisitaPropria = await fetch(`${base}/api/pmoc/portal/visitas/${visitaId}`, { headers: authPortalA });
    assert.equal(rVisitaPropria.status, 200);
    assert.equal((await rVisitaPropria.json()).visita.id, visitaId);

    // ---- abrir chamado a partir de um aparelho específico (vira O.S. corretiva avulsa, pendente) ----
    const rChamadoSemDescricao = await fetch(`${base}/api/pmoc/portal/aparelhos/${aparelhoA.id}/chamado`, { method: 'POST', headers: authPortalA, body: JSON.stringify({}) });
    assert.equal(rChamadoSemDescricao.status, 400);
    const rChamado = await fetch(`${base}/api/pmoc/portal/aparelhos/${aparelhoA.id}/chamado`, { method: 'POST', headers: authPortalA, body: JSON.stringify({ descricao: 'Ar não está gelando' }) });
    assert.equal(rChamado.status, 201);
    const osChamado = (await rChamado.json()).os;
    assert.equal(osChamado.status, 'pendente');
    assert.equal(osChamado.tecnico_id, null);
    assert.equal(osChamado.cliente_nome, 'Cliente A');
    assert.equal(osChamado.equipamento.tipo, 'Split hi-wall');
    assert.equal(osChamado.problema_relatado, 'Ar não está gelando');
    // Portal A não pode abrir chamado num aparelho que não é de um local seu.
    const rChamadoCruzado = await fetch(`${base}/api/pmoc/portal/aparelhos/${aparelhoB.id}/chamado`, { method: 'POST', headers: authPortalA, body: JSON.stringify({ descricao: 'Tentativa indevida' }) });
    assert.equal(rChamadoCruzado.status, 403);

    // ---- relatório mensal consolidado (admin, por cliente) ----
    const relatorio = await (await fetch(`${base}/api/pmoc/clientes/${clienteA.id}/relatorio-mensal?mes=2026-01`, { headers: authAdmin })).json();
    assert.equal(relatorio.cliente.nome, 'Cliente A');
    assert.equal(relatorio.total_visitas, visitasPortalA.filter((v) => v.data.startsWith('2026-01')).length || relatorio.total_visitas);
    assert.ok(relatorio.total_visitas >= 1);
    assert.equal(typeof relatorio.percentual_no_prazo, 'number');
    assert.equal(relatorio.nao_conformidades_abertas, 0); // nenhuma visita concluída ainda com item não conforme sem corretiva.
    assert.ok(Array.isArray(relatorio.visitas));
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
