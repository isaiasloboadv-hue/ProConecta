// pedido do usuário: pacote "Climatização / PMOC" (Lei 13.589/2018), Fase 1 — Cadastro de
// Locais/Ambientes/Aparelhos de climatização e Responsáveis técnicos. Único item do perfil
// Refrigeração que combina DOIS gates no mesmo recurso: `perfil: 'refrigeracao'` (como o resto do
// perfil) E o módulo `pmoc` contratado à parte (nem toda empresa de Refrigeração usa PMOC) — ver
// comentário em MODULOS_DISPONIVEIS (db.js) e no prefixo '/api/pmoc' (rotas-modulo.js). Prova pela
// API HTTP de verdade: os dois gates (separados — um não basta sem o outro), CRUD completo de
// locais/ambientes/aparelhos/responsáveis técnicos, cascade delete (local arrasta ambientes e
// aparelhos; ambiente arrasta aparelhos) e isolamento entre empresas (tenant).
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
      // empresa 1: perfil certo + módulo `pmoc` ativo — é quem consegue usar as rotas de verdade.
      { id: 1, nome: 'Admin PMOC', email: 'admin@pmoc.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico PMOC', email: 'tec@pmoc.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      // empresa 2: perfil Refrigeração certo, mas SEM o módulo `pmoc` contratado.
      { id: 3, nome: 'Admin Sem Módulo', email: 'admin@semmodulo.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
      // empresa 3: módulo `pmoc` contratado, mas perfil ERRADO (não é Refrigeração).
      { id: 4, nome: 'Admin Perfil Errado', email: 'admin@perfilerrado.com', papel: 'administrador', status: 'ativo', empresa_id: 3, ...senha },
      // empresa 4: igual à empresa 1 (perfil + módulo certos), só pra provar isolamento entre
      // empresas (não enxerga locais/ambientes/aparelhos uma da outra).
      { id: 5, nome: 'Admin Outra Empresa PMOC', email: 'admin@outrapmoc.com', papel: 'administrador', status: 'ativo', empresa_id: 4, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    _seq: {
      usuarios: 6, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
      { id: 2, nome: 'Refrigera Sem PMOC', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: [], terminologia: {}, perfil: 'refrigeracao' },
      { id: 3, nome: 'Empresa Perfil Errado', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'autonomo' },
      { id: 4, nome: 'Outra Clima Certa', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

test('PMOC (Fase 1 — Cadastro): gate duplo (perfil + módulo), CRUD de locais/ambientes/aparelhos/responsáveis técnicos, cascade delete e isolamento entre empresas', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44400 + Math.floor(Math.random() * 900);

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
    const authAdmin = auth(await login('admin@pmoc.com'));
    const authTecnico = auth(await login('tec@pmoc.com'));
    const authSemModulo = auth(await login('admin@semmodulo.com'));
    const authPerfilErrado = auth(await login('admin@perfilerrado.com'));
    const authOutraEmpresa = auth(await login('admin@outrapmoc.com'));

    // ---- gates: perfil certo sem módulo NÃO basta, módulo certo sem perfil também não ----
    const semModulo = await fetch(`${base}/api/pmoc/locais`, { headers: authSemModulo });
    assert.equal(semModulo.status, 403);
    const perfilErrado = await fetch(`${base}/api/pmoc/locais`, { headers: authPerfilErrado });
    assert.equal(perfilErrado.status, 403);
    const semToken = await fetch(`${base}/api/pmoc/locais`);
    assert.equal(semToken.status, 401);
    // os dois juntos: passa.
    const rVazio = await fetch(`${base}/api/pmoc/locais`, { headers: authAdmin });
    assert.equal(rVazio.status, 200);
    assert.deepEqual((await rVazio.json()).locais, []);
    // técnico (suporte) também tem acesso — mesmos papéis de O.S./Orçamento/Agenda do perfil.
    const rVazioTecnico = await fetch(`${base}/api/pmoc/locais`, { headers: authTecnico });
    assert.equal(rVazioTecnico.status, 200);

    // ---- cliente (base pro local — reaproveita os_refrigeracao_clientes) ----
    const rCliente = await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Shopping Vale Verde' }) });
    const cliente = (await rCliente.json()).cliente;

    // ---- locais: validação e criação ----
    const semCliente = await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Loja A' }) });
    assert.equal(semCliente.status, 400);
    const semNome = await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id }) });
    assert.equal(semNome.status, 400);

    const rLocal = await fetch(`${base}/api/pmoc/locais`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        cliente_id: cliente.id, nome: 'Loja Centro', tipo_atividade: 'loja', endereco: 'Rua A, 123',
        area_climatizada_m2: 500, ocupantes_fixos: 20, ocupantes_flutuantes: 150,
        responsavel_nome: 'João', responsavel_telefone: '12999999999', responsavel_email: 'joao@x.com',
      }),
    });
    assert.equal(rLocal.status, 201);
    const local = (await rLocal.json()).local;
    assert.equal(local.cliente_nome, 'Shopping Vale Verde');
    assert.equal(local.total_ambientes, 0);
    assert.equal(local.total_aparelhos, 0);

    // busca por texto encontra por nome do local e por nome do cliente.
    const rBuscaLocal = await fetch(`${base}/api/pmoc/locais?q=Centro`, { headers: authAdmin });
    assert.equal((await rBuscaLocal.json()).locais.length, 1);
    const rBuscaCliente = await fetch(`${base}/api/pmoc/locais?q=Vale Verde`, { headers: authAdmin });
    assert.equal((await rBuscaCliente.json()).locais.length, 1);
    const rBuscaNada = await fetch(`${base}/api/pmoc/locais?q=inexistente`, { headers: authAdmin });
    assert.equal((await rBuscaNada.json()).locais.length, 0);

    // edição.
    const rEditaLocal = await fetch(`${base}/api/pmoc/locais/${local.id}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Loja Centro (editada)', tipo_atividade: 'escritorio' }),
    });
    assert.equal(rEditaLocal.status, 200);
    assert.equal((await rEditaLocal.json()).local.nome, 'Loja Centro (editada)');

    // ---- ambientes ----
    const ambSemLocal = await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: 999999, nome: 'Recepção' }) });
    assert.equal(ambSemLocal.status, 400);
    const rAmbiente = await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Recepção', andar: 'Térreo', area_m2: 40, ocupantes: 8 }) });
    assert.equal(rAmbiente.status, 201);
    const ambiente = (await rAmbiente.json()).ambiente;

    // detalhe do local já vem com o ambiente aninhado (e ainda sem aparelhos).
    const rLocalDetalhe1 = await fetch(`${base}/api/pmoc/locais/${local.id}`, { headers: authAdmin });
    const detalhe1 = await rLocalDetalhe1.json();
    assert.equal(detalhe1.ambientes.length, 1);
    assert.deepEqual(detalhe1.ambientes[0].aparelhos, []);

    // ---- aparelhos ----
    const apSemAmbiente = await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: 999999, tipo: 'Split hi-wall' }) });
    assert.equal(apSemAmbiente.status, 400);
    const apSemTipo = await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id }) });
    assert.equal(apSemTipo.status, 400);

    const rAparelho = await fetch(`${base}/api/pmoc/aparelhos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({
        ambiente_id: ambiente.id, tipo: 'Split hi-wall', marca: 'Daikin', modelo: 'FTKM12',
        numero_serie: 'SN123', capacidade_btu: '12000', fluido_refrigerante: 'R-32', tensao: '220V',
        data_instalacao: '2023-01-10', garantia_ate: '2026-01-10', codigo_patrimonio: 'PAT-1',
      }),
    });
    assert.equal(rAparelho.status, 201);
    const aparelho = (await rAparelho.json()).aparelho;
    assert.equal(aparelho.status, 'ativo');
    assert.ok(aparelho.qr_token && aparelho.qr_token.length >= 16); // QR único, gerado na criação (ver item 6 do pedido)

    // filtro por ambiente/local.
    const rApPorAmbiente = await fetch(`${base}/api/pmoc/aparelhos?ambiente_id=${ambiente.id}`, { headers: authAdmin });
    assert.equal((await rApPorAmbiente.json()).aparelhos.length, 1);
    const rApPorLocal = await fetch(`${base}/api/pmoc/aparelhos?local_id=${local.id}`, { headers: authAdmin });
    assert.equal((await rApPorLocal.json()).aparelhos.length, 1);

    // edição do cadastro.
    const rEditaAparelho = await fetch(`${base}/api/pmoc/aparelhos/${aparelho.id}`, {
      method: 'PUT', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'Split hi-wall', marca: 'LG', modelo: 'S4-W12' }),
    });
    assert.equal(rEditaAparelho.status, 200);
    assert.equal((await rEditaAparelho.json()).aparelho.marca, 'LG');

    // troca rápida de status.
    const statusInvalido = await fetch(`${base}/api/pmoc/aparelhos/${aparelho.id}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'quebrado' }) });
    assert.equal(statusInvalido.status, 400);
    const rStatus = await fetch(`${base}/api/pmoc/aparelhos/${aparelho.id}/status`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ status: 'aguardando_peca' }) });
    assert.equal(rStatus.status, 200);
    assert.equal((await rStatus.json()).aparelho.status, 'aguardando_peca');

    // o local agora reflete o total de aparelhos.
    const rLocalDetalhe2 = await fetch(`${base}/api/pmoc/locais/${local.id}`, { headers: authAdmin });
    const detalhe2 = await rLocalDetalhe2.json();
    assert.equal(detalhe2.local.total_aparelhos, 1);
    assert.equal(detalhe2.ambientes[0].aparelhos.length, 1);

    // ---- responsáveis técnicos ----
    const rtSemNome = await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ formacao: 'Técnico' }) });
    assert.equal(rtSemNome.status, 400);
    const rResponsavel = await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Carlos Lima', formacao: 'Técnico em Refrigeração', registro_profissional: 'CFT-123', telefone: '12988887777', email: 'carlos@x.com' }),
    });
    assert.equal(rResponsavel.status, 201);
    const responsavel = (await rResponsavel.json()).responsavel;
    const rListaResp = await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, { headers: authAdmin });
    assert.equal((await rListaResp.json()).responsaveis.length, 1);
    const rEditaResp = await fetch(`${base}/api/pmoc/responsaveis-tecnicos/${responsavel.id}`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ nome: 'Carlos Eduardo Lima' }) });
    assert.equal(rEditaResp.status, 200);
    assert.equal((await rEditaResp.json()).responsavel.nome, 'Carlos Eduardo Lima');
    const rExcluiResp = await fetch(`${base}/api/pmoc/responsaveis-tecnicos/${responsavel.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluiResp.status, 200);
    const rListaRespVazia = await fetch(`${base}/api/pmoc/responsaveis-tecnicos`, { headers: authAdmin });
    assert.equal((await rListaRespVazia.json()).responsaveis.length, 0);

    // ---- isolamento entre empresas (tenant) ----
    const rLocaisOutraEmpresa = await fetch(`${base}/api/pmoc/locais`, { headers: authOutraEmpresa });
    assert.deepEqual((await rLocaisOutraEmpresa.json()).locais, []);
    const rAcessoCruzado = await fetch(`${base}/api/pmoc/locais/${local.id}`, { headers: authOutraEmpresa });
    assert.equal(rAcessoCruzado.status, 404); // existe, mas é de outra empresa — tratado como "não encontrado"

    // ---- cascade delete: excluir ambiente arrasta o aparelho dele ----
    const rExcluiAmbiente = await fetch(`${base}/api/pmoc/ambientes/${ambiente.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluiAmbiente.status, 200);
    const rApDepoisAmbiente = await fetch(`${base}/api/pmoc/aparelhos?ambiente_id=${ambiente.id}`, { headers: authAdmin });
    assert.deepEqual((await rApDepoisAmbiente.json()).aparelhos, []);

    // recria ambiente + aparelho pra provar que excluir o LOCAL também arrasta tudo.
    const rAmbiente2 = await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Depósito' }) });
    const ambiente2 = (await rAmbiente2.json()).ambiente;
    await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente2.id, tipo: 'Janela' }) });

    const rExcluiLocal = await fetch(`${base}/api/pmoc/locais/${local.id}`, { method: 'DELETE', headers: authAdmin });
    assert.equal(rExcluiLocal.status, 200);
    const rLocalSumiu = await fetch(`${base}/api/pmoc/locais/${local.id}`, { headers: authAdmin });
    assert.equal(rLocalSumiu.status, 404);
    const rAmbientesSumiram = await fetch(`${base}/api/pmoc/ambientes?local_id=${local.id}`, { headers: authAdmin });
    assert.deepEqual((await rAmbientesSumiram.json()).ambientes, []);
    const rAparelhosSumiram = await fetch(`${base}/api/pmoc/aparelhos?ambiente_id=${ambiente2.id}`, { headers: authAdmin });
    assert.deepEqual((await rAparelhosSumiram.json()).aparelhos, []);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
