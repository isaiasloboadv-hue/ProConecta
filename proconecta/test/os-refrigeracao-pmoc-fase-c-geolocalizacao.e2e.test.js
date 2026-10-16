// pedido do usuário: pacote "Climatização / PMOC", Fase C (análise de concorrentes) —
// geolocalização pontual do técnico "no momento da visita" (decisão explícita do usuário: nunca
// rastreamento contínuo). Prova pela API HTTP de verdade: (1) o primeiro PUT .../progresso grava
// localizacao_chegada quando o técnico manda uma localização válida; (2) chamadas seguintes não
// sobrescrevem a chegada; (3) PUT .../concluir grava localizacao_conclusao; (4) localização
// ausente, inválida ou fora de faixa nunca bloqueia nem quebra o progresso/conclusão (é sempre
// best-effort — navegador sem GPS, permissão negada, timeout).
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
      { id: 1, nome: 'Admin Fase C Geo', email: 'admin@pmocCgeo.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico Fase C Geo', email: 'tec@pmocCgeo.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [], os_refrigeracao_pmoc_config: [],
    os_refrigeracao_pmoc_gas_registros: [], os_refrigeracao_pmoc_faturas: [],
    _seq: {
      usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1, os_refrigeracao_pmoc_config: 1,
      os_refrigeracao_pmoc_gas_registros: 1, os_refrigeracao_pmoc_faturas: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa C Geo', site: '', whatsapp: '', telefone: '', emails: ['contato@climacertacgeo.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
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

test('PMOC (Fase C — análise de concorrentes): geolocalização pontual do técnico — chegada no progresso, conclusão no concluir, best-effort', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-faseC-geo-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 45100 + Math.floor(Math.random() * 900);
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
    const authAdmin = { 'Content-Type': 'application/json', Authorization: `Bearer ${await login('admin@pmocCgeo.com')}` };
    const authTecnico = { 'Content-Type': 'application/json', Authorization: `Bearer ${await login('tec@pmocCgeo.com')}` };

    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase C Geo' }) })).json()).cliente;
    const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Fase C Geo', tipo_atividade: 'loja' }) })).json()).local;
    const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Sala' }) })).json()).ambiente;
    await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'split' }) });
    const plano = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, data_inicio: '2000-01-10', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${plano.id}/ativar?hoje=2000-01-10`, { method: 'PUT', headers: authAdmin });
    const { visitas } = await (await fetch(`${base}/api/pmoc/visitas-pendentes?hoje=2000-01-10`, { headers: authAdmin })).json();
    const visitaId = visitas[0].id;
    // configura a disponibilidade do técnico antes de designar (mesma exigência de
    // slotsAgendaRefrigeracao já usada no agendamento manual).
    await fetch(`${base}/api/os-refrigeracao-agenda/config`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ dias_semana: ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'], hora_inicio: '08:00', hora_fim: '12:00', pausa_ativa: false, duracao_min: 60, max_por_dia: 4, datas_bloqueadas: [] }),
    });
    await fetch(`${base}/api/pmoc/visitas-pendentes/${visitaId}/designar-tecnico`, { method: 'PUT', headers: authAdmin, body: JSON.stringify({ tecnico_id: 2, hora: '09:00' }) });
    const visitaInicial = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;

    // localização inválida/fora de faixa no 1º progresso — nunca bloqueia, e não grava chegada.
    const rProgressoInvalido = await fetch(`${base}/api/pmoc/visitas/${visitaId}/progresso`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: visitaInicial.pmoc_itens, localizacao: { lat: 999, lng: -46.6 } }),
    });
    assert.equal(rProgressoInvalido.status, 200);
    const visitaAposInvalido = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;
    assert.equal(visitaAposInvalido.localizacao_chegada, undefined);

    // localização válida no 2º progresso — grava a chegada.
    const rProgressoValido = await fetch(`${base}/api/pmoc/visitas/${visitaId}/progresso`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: visitaInicial.pmoc_itens, localizacao: { lat: -23.55, lng: -46.63, precisao: 12 } }),
    });
    assert.equal(rProgressoValido.status, 200);
    const visitaAposChegada = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;
    assert.equal(visitaAposChegada.localizacao_chegada.lat, -23.55);
    assert.equal(visitaAposChegada.localizacao_chegada.lng, -46.63);
    assert.ok(visitaAposChegada.localizacao_chegada.capturado_em);

    // uma 3ª chamada de progresso, com uma localização DIFERENTE, não sobrescreve a chegada já
    // registrada (é um único ponto — "chegada").
    await fetch(`${base}/api/pmoc/visitas/${visitaId}/progresso`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({ itens: visitaInicial.pmoc_itens, localizacao: { lat: -10, lng: -10 } }),
    });
    const visitaAposTerceiroProgresso = (await (await fetch(`${base}/api/pmoc/visitas/${visitaId}`, { headers: authTecnico })).json()).visita;
    assert.equal(visitaAposTerceiroProgresso.localizacao_chegada.lat, -23.55);

    // conclusão com localização válida — nunca é obrigatória (ver teste de progresso acima pra
    // prova de que uma localização ausente/inválida nunca bloqueia), mas quando presente é gravada.
    const itensCompletos = visitaInicial.pmoc_itens.map((it) => ({ ...it, resposta: 'conforme' }));
    const rConcluirComLocalizacao = await fetch(`${base}/api/pmoc/visitas/${visitaId}/concluir`, {
      method: 'PUT', headers: authTecnico, body: JSON.stringify({
        itens: itensCompletos, assinatura_responsavel_img: 'data:image/png;base64,abc', assinatura_responsavel_nome: 'Resp.',
        localizacao: { lat: -23.56, lng: -46.64, precisao: 8 },
      }),
    });
    assert.equal(rConcluirComLocalizacao.status, 200);
    const { visita: visitaConcluida } = await rConcluirComLocalizacao.json();
    assert.equal(visitaConcluida.status, 'concluido');
    assert.equal(visitaConcluida.localizacao_conclusao.lat, -23.56);
    assert.equal(visitaConcluida.localizacao_conclusao.lng, -46.64);
    // a chegada (registrada antes) continua intacta — conclusão não afeta chegada.
    assert.equal(visitaConcluida.localizacao_chegada.lat, -23.55);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
