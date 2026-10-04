// RCM/FMEA Fase 1, passo 3: a cascata Componente→Modo de falha→Causa→Efeito chega no Laudo
// Técnico (visita.laudo), 100% opcional — o fluxo de sempre (laudo em texto livre, sem nenhum
// campo FMEA) continua funcionando sem mudar nada. Prova, pela API HTTP de verdade: (1) enviar o
// laudo sem nenhum campo FMEA funciona exatamente como antes; (2) a cascata completa é validada,
// resolvida (id + nome) e gravada; (3) prefixo incompleto (ex.: causa sem modo de falha) é
// recusado; (4) componente de outro modelo de equipamento é recusado; (5) equipamento sem
// catalogo_id (não vinculado a um modelo) recusa qualquer tentativa de classificar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

function dados() {
  const senha = hashSenha('senha1234');
  const agora = new Date().toISOString();
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico', email: 'tecnico@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Teste', empresa_id: 1, contato: 'Fulano', telefone: '123', email: 'f@x.com', setor: '', endereco: 'Rua A', numero: '10', bairro: 'Centro', cep: '00000-000', cidade: 'Cidade', estado: 'SP' }],
    equipamentos: [
      // catálogo do modelo certo
      { id: 1, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: '', data_fabricacao: '', localizacao: '' },
      // unidade atrelada ao modelo certo (catalogo_id: 1)
      { id: 2, empresa_id: 1, cliente_id: 1, catalogo_id: 1, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: 'SN-001', data_fabricacao: '2024-01-01', localizacao: '' },
      // catálogo de OUTRO modelo
      { id: 3, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Impressora', modelo: 'Y100', numero_serie: '', data_fabricacao: '', localizacao: '' },
      // unidade sem catalogo_id (não casou na migração) — não pode usar FMEA
      { id: 4, empresa_id: 1, cliente_id: 1, catalogo_id: null, tipo: 'Equipamento Antigo', modelo: 'Legado', numero_serie: 'SN-002', data_fabricacao: '', localizacao: '' },
    ],
    agenda: [
      {
        id: 1, empresa_id: 1, numero_os: 'OS-000001', criado_por: 1, tecnico_id: 2, cliente_id: 1, equipamento_id: 2,
        cliente_nome_manual: '', equipamento_manual: '', data_hora_inicio: agora, data_hora_fim: agora,
        tipo: 'corretiva', categoria: 'inloco', problema: 'Não liga', contato: 'Fulano', telefone: '123', email: 'f@x.com', setor_cliente: '',
        endereco: 'Rua A', numero: '10', bairro: 'Centro', cep: '00000-000', cidade: 'Cidade', estado: 'SP',
        garantia: 'sim', garantia_obs: '', sla_nivel: null, sla_pontuacao: null, sla_horas_atendimento: null, sla_dias_manutencao: null, sla_dias_visita_tecnica: null,
        status: 'pendente', valor_servico: null, retrabalho: false, criado_em: agora, lida_tecnico: true,
        deslocamento_iniciado_em: agora, chegada_confirmada_em: agora, confirmado_cliente_em: agora, feedback_cliente_em: null,
        orcamento_aprovado_em: null, orcamento_reprovado_em: null, retorno_pendente_tecnico: false, retorno_confirmado_cliente_em: null,
        retorno_deslocamento_iniciado_em: null, retorno_chegada_confirmada_em: null, viagem_volta_iniciada_em: null, viagem_volta_chegada_em: null,
        viagem_volta_destino_agenda_id: null, bonus_viagem: false, viagem_dia_inicio: '', viagem_dia_fim_previsto: '', justificativa_limite_viagens: '',
        fora_de_ordem_viagem: false, escala_conflito_tipo: null, justificativa_escala_conflito: '', finalizada: false, finalizado_em: null,
        fase_atendimento: null, motivo_pos_venda: null,
      },
      // segunda O.S., pro mesmo técnico, com o equipamento sem catalogo_id
      {
        id: 2, empresa_id: 1, numero_os: 'OS-000002', criado_por: 1, tecnico_id: 2, cliente_id: 1, equipamento_id: 4,
        cliente_nome_manual: '', equipamento_manual: '', data_hora_inicio: agora, data_hora_fim: agora,
        tipo: 'corretiva', categoria: 'inloco', problema: 'Travando', contato: 'Fulano', telefone: '123', email: 'f@x.com', setor_cliente: '',
        endereco: 'Rua A', numero: '10', bairro: 'Centro', cep: '00000-000', cidade: 'Cidade', estado: 'SP',
        garantia: 'sim', garantia_obs: '', sla_nivel: null, sla_pontuacao: null, sla_horas_atendimento: null, sla_dias_manutencao: null, sla_dias_visita_tecnica: null,
        status: 'pendente', valor_servico: null, retrabalho: false, criado_em: agora, lida_tecnico: true,
        deslocamento_iniciado_em: agora, chegada_confirmada_em: agora, confirmado_cliente_em: agora, feedback_cliente_em: null,
        orcamento_aprovado_em: null, orcamento_reprovado_em: null, retorno_pendente_tecnico: false, retorno_confirmado_cliente_em: null,
        retorno_deslocamento_iniciado_em: null, retorno_chegada_confirmada_em: null, viagem_volta_iniciada_em: null, viagem_volta_chegada_em: null,
        viagem_volta_destino_agenda_id: null, bonus_viagem: false, viagem_dia_inicio: '', viagem_dia_fim_previsto: '', justificativa_limite_viagens: '',
        fora_de_ordem_viagem: false, escala_conflito_tipo: null, justificativa_escala_conflito: '', finalizada: false, finalizado_em: null,
        fase_atendimento: null, motivo_pos_venda: null,
      },
    ],
    visitas: [],
    fmea_componentes: [
      { id: 1, empresa_id: 1, catalogo_id: 1, nome: 'Fonte de alimentação', criado_em: new Date().toISOString() },
      { id: 2, empresa_id: 1, catalogo_id: 3, nome: 'Cabeça de impressão', criado_em: new Date().toISOString() },
    ],
    fmea_modos_falha: [
      { id: 1, empresa_id: 1, componente_id: 1, nome: 'Queima do capacitor', severidade: 8, ocorrencia: 5, deteccao: 3, rpn: 120, criado_em: new Date().toISOString() },
    ],
    fmea_causas: [
      { id: 1, empresa_id: 1, modo_falha_id: 1, nome: 'Sobretensão na rede', criado_em: new Date().toISOString() },
    ],
    fmea_efeitos: [
      { id: 1, empresa_id: 1, causa_id: 1, nome: 'Equipamento desliga e não liga mais', criado_em: new Date().toISOString() },
    ],
    _seq: { usuarios: 3, clientes: 2, equipamentos: 5, agenda: 3, visitas: 1, fmea_componentes: 3, fmea_modos_falha: 2, fmea_causas: 2, fmea_efeitos: 2 },
    empresas: [
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
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

function laudoBase(extra) {
  return {
    garantia: 'sim', data_conclusao: new Date().toISOString().slice(0, 16),
    laudo_tecnico: 'Capacitor da fonte queimado.', servico_realizado: 'Substituição do capacitor.',
    pecas: [], fotos: [PNG_1X1], observacoes: '', relevante_biblioteca: false, necessidade_retorno: false,
    ...extra,
  };
}

test('FMEA passo 3: cascata opcional no Laudo Técnico — compatível, validada e resolvida', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-fmea-laudo-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 42500 + Math.floor(Math.random() * 900);

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
    const tokenTecnico = await login('tecnico@x.com');
    const authTecnico = { Authorization: `Bearer ${tokenTecnico}`, 'Content-Type': 'application/json' };

    // 1) sem nenhum campo FMEA — continua funcionando exatamente como antes
    const semFmea = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 1, laudo: laudoBase({}) }),
    });
    assert.equal(semFmea.status, 201);
    const { visita: visitaSemFmea } = await semFmea.json();
    assert.equal(visitaSemFmea.laudo.componente_id, null);
    assert.equal(visitaSemFmea.laudo.componente_nome, '');

    // 2) causa_id sem modo_falha_id — prefixo incompleto, recusado
    const prefixoIncompleto = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 1, laudo: laudoBase({ causa_id: 1 }) }),
    });
    assert.equal(prefixoIncompleto.status, 400);
    assert.match((await prefixoIncompleto.json()).erro, /modo de falha/i);

    // 3) componente de OUTRO modelo (id 2, que é do catálogo da Impressora, não da Gravadora) — recusado
    const componenteErrado = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 1, laudo: laudoBase({ componente_id: 2 }) }),
    });
    assert.equal(componenteErrado.status, 400);

    // 4) cascata completa e correta — resolvida com id e nome (como já existe visita dessa O.S.
    // dos envios acima, o servidor atualiza em vez de duplicar — mesmo comportamento de sempre)
    const cascataCompleta = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 1, laudo: laudoBase({ componente_id: 1, modo_falha_id: 1, causa_id: 1, efeito_id: 1 }) }),
    });
    assert.equal(cascataCompleta.status, 201);
    const { visita: visitaCascata } = await cascataCompleta.json();
    assert.equal(visitaCascata.laudo.componente_id, 1);
    assert.equal(visitaCascata.laudo.componente_nome, 'Fonte de alimentação');
    assert.equal(visitaCascata.laudo.modo_falha_id, 1);
    assert.equal(visitaCascata.laudo.modo_falha_nome, 'Queima do capacitor');
    assert.equal(visitaCascata.laudo.causa_id, 1);
    assert.equal(visitaCascata.laudo.causa_nome, 'Sobretensão na rede');
    assert.equal(visitaCascata.laudo.efeito_id, 1);
    assert.equal(visitaCascata.laudo.efeito_nome, 'Equipamento desliga e não liga mais');

    // GET devolve a mesma classificação já resolvida, sem precisar buscar o catálogo de novo
    const buscar = await (await fetch(`${base}/api/visitas/${visitaCascata.id}`, { headers: authTecnico })).json();
    assert.equal(buscar.visita.laudo.efeito_nome, 'Equipamento desliga e não liga mais');

    // 5) equipamento sem catalogo_id (O.S. 2) — qualquer tentativa de classificar é recusada,
    // com mensagem clara apontando o motivo (equipamento não vinculado a um modelo do catálogo)
    const semCatalogo = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 2, laudo: laudoBase({ componente_id: 1 }) }),
    });
    assert.equal(semCatalogo.status, 400);
    assert.match((await semCatalogo.json()).erro, /não está vinculado a um modelo do catálogo/);

    // mas sem tentar FMEA, a mesma O.S. funciona normalmente (compatibilidade preservada)
    const semCatalogoSemFmea = await fetch(`${base}/api/visitas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ agenda_id: 2, laudo: laudoBase({}) }),
    });
    assert.equal(semCatalogoSemFmea.status, 201);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
