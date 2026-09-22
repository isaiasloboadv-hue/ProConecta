// db.js — "banco de dados". Por padrão, um arquivo JSON local (sem dependências externas).
// Se a variável de ambiente DATABASE_URL estiver definida, usa Postgres (ex.: Supabase) —
// guarda o mesmo objeto inteiro como um único registro JSONB, então nenhuma outra parte do
// sistema precisa mudar (load()/save() continuam funcionando exatamente igual).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.json');
const usaPostgres = !!process.env.DATABASE_URL;

function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function conferirSenha(senha, salt, hash) {
  const tentativa = crypto.scryptSync(senha, salt, 64);
  const alvo = Buffer.from(hash, 'hex');
  return tentativa.length === alvo.length && crypto.timingSafeEqual(tentativa, alvo);
}

function gerarTokenConvite() {
  return crypto.randomBytes(24).toString('hex');
}

// banco novo começa vazio — o primeiro acesso vem do bootstrap de admin master
// (ADMIN_EMAIL/ADMIN_SENHA) ou de um convite criado manualmente por quem tiver acesso ao banco.
function seed() {
  return {
    usuarios: [],
    clientes: [],
    equipamentos: [],
    agenda: [],
    visitas: [],
    registros: [],
    chamados: [],
    chamados_rr_index: 0,
    relatorios_manutencao: [],
    push_subscriptions: [],
    vapid: null,
    empresas: [],
    mensagens_internas: [],
    solicitacoes_rh: [],
    _seq: { usuarios: 1, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, registros: 1, chamados: 1, relatorios_manutencao: 1, mensagens_internas: 1, solicitacoes_rh: 1 },
  };
}

// dados da empresa "dona" da instalação — hoje só existe a de id 1, mas já mora numa lista própria
// (com empresa_id nos demais registros) pra um dia dar pra ter mais de uma empresa usando o mesmo
// sistema sem redesenhar o banco. Configurável por variável de ambiente: uma instalação nova (outra
// empresa comprando o sistema) só precisa trocar as variáveis no hospedeiro, sem mexer em código.
// Roda a cada carregamento, então mudar a variável de ambiente reflete sem precisar apagar o banco.
function sincronizarEmpresaPadrao(data) {
  if (!data.empresas) data.empresas = [];
  let empresa = data.empresas.find((e) => e.id === 1);
  if (!empresa) {
    empresa = {
      id: 1,
      nome: 'PRO Marking',
      site: 'promarking.com.br',
      whatsapp: '12 99718-7506',
      telefone: '12 3902-3453',
      emails: ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'],
      cor_primaria: '#0A2647',
      cor_secundaria: '#0E7C86',
    };
    data.empresas.push(empresa);
  }
  if (process.env.EMPRESA_NOME) empresa.nome = process.env.EMPRESA_NOME;
  if (process.env.EMPRESA_SITE) empresa.site = process.env.EMPRESA_SITE;
  if (process.env.EMPRESA_WHATSAPP) empresa.whatsapp = process.env.EMPRESA_WHATSAPP;
  if (process.env.EMPRESA_TELEFONE) empresa.telefone = process.env.EMPRESA_TELEFONE;
  if (process.env.EMPRESA_EMAILS) empresa.emails = process.env.EMPRESA_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);
  if (process.env.EMPRESA_COR_PRIMARIA) empresa.cor_primaria = process.env.EMPRESA_COR_PRIMARIA;
  if (process.env.EMPRESA_COR_SECUNDARIA) empresa.cor_secundaria = process.env.EMPRESA_COR_SECUNDARIA;
}

// se as variáveis de ambiente ADMIN_EMAIL/ADMIN_SENHA estiverem definidas e ainda não existir
// usuário com esse e-mail, cria um administrador ativo — assim a senha nunca precisa ficar
// escrita em código/commit, só no painel de variáveis de ambiente do hospedeiro (Render etc.).
// Roda a cada carregamento (idempotente: só cria uma vez). Devolve true se criou alguém.
function bootstrapAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  const senha = process.env.ADMIN_SENHA;
  if (!email || !senha) return false;
  if (data.usuarios.some((u) => u.email === email)) return false;
  const { salt, hash } = hashSenha(senha);
  data.usuarios.push({
    id: nextId(data, 'usuarios'),
    nome: 'Desenvolvedor', email, papel: 'administrador',
    cargo: '', setor: '', celular: '', cliente_id: null,
    status: 'ativo', convite_token: null, salt, hash,
    protegido: true,
  });
  console.log(`[db] Conta master criada automaticamente: ${email}`);
  return true;
}

// garante que a conta master (e-mail em ADMIN_EMAIL) fique sempre marcada como protegida —
// cobre também quem já existia antes dessa flag existir, ou foi criado numa corrida em que
// bootstrapAdminMaster ainda não tinha essa marca. Roda a cada carregamento (idempotente).
function protegerAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  if (!email) return;
  const master = data.usuarios.find((u) => u.email === email);
  if (!master) return;
  if (master.nome === 'Administrador') master.nome = 'Desenvolvedor';
  master.protegido = true;
}

// migração leve: bancos criados antes destes campos existirem ganham valores padrão.
// Roda uma vez ao carregar (seja do arquivo ou do Postgres) — mutila e devolve o mesmo objeto.
function migrar(data) {
  if (!data.registros) data.registros = [];
  if (!data.push_subscriptions) data.push_subscriptions = [];
  // gera o par de chaves VAPID (push notification) uma única vez e guarda no próprio banco,
  // assim não depende de configurar variável de ambiente manualmente no hospedeiro
  if (!data.vapid) {
    const { publicKey, privateKey } = require('web-push').generateVAPIDKeys();
    data.vapid = { publicKey, privateKey };
  }
  if (!data.chamados) data.chamados = [];
  if (data.chamados_rr_index === undefined) data.chamados_rr_index = 0;
  if (!data.relatorios_manutencao) data.relatorios_manutencao = [];
  if (!data.mensagens_internas) data.mensagens_internas = [];
  if (!data.solicitacoes_rh) data.solicitacoes_rh = [];
  if (!data._seq.solicitacoes_rh) data._seq.solicitacoes_rh = 1;
  sincronizarEmpresaPadrao(data);
  // bancos anteriores ao empresa_id (preparação pra multi-tenant) ganham empresa_id 1 — hoje só
  // existe essa empresa mesmo, então todo registro já criado pertence a ela.
  for (const lista of [data.usuarios, data.clientes, data.equipamentos, data.agenda, data.visitas, data.registros, data.chamados, data.relatorios_manutencao]) {
    for (const item of lista) {
      if (item.empresa_id === undefined) item.empresa_id = 1;
    }
  }
  // "chamados" virou o atendimento por chat (IA -> técnico), unificando o que antes era
  // conversas_whatsapp (histórico solto por telefone) com o antigo chamado (só criado quando a
  // IA escalava). Bancos antigos que ainda tenham chamados no formato de antes do chat ganham os
  // campos novos com valor neutro, pra não quebrar a leitura.
  for (const c of data.chamados) {
    if (!Array.isArray(c.mensagens)) c.mensagens = [];
    if (c.status === undefined) c.status = 'aguardando_tecnico';
    if (c.telefone_whatsapp === undefined) c.telefone_whatsapp = null;
    if (c.origem === undefined) c.origem = 'app';
    if (c.tecnico_id === undefined) c.tecnico_id = null;
    if (c.os_id === undefined) c.os_id = null;
    if (c.prioridade === undefined) c.prioridade = 'normal';
    if (c.resolvido_por === undefined) c.resolvido_por = null;
    if (c.resolvido_em === undefined) c.resolvido_em = null;
    if (c.assumido_em === undefined) c.assumido_em = null;
    if (c.lida_tecnico === undefined) c.lida_tecnico = true;
    if (c.lida_cliente === undefined) c.lida_cliente = true;
    // resumo (primeira mensagem do cliente) usado na fila/lista sem precisar buscar o histórico
    // de mensagens (que agora mora numa tabela à parte — ver migrarMensagensParaTabelas)
    if (c.primeira_mensagem_cliente === undefined) c.primeira_mensagem_cliente = '';
  }
  if (!data._seq.registros) data._seq.registros = 1;
  if (!data._seq.chamados) data._seq.chamados = 1;
  if (!data._seq.relatorios_manutencao) data._seq.relatorios_manutencao = 1;
  if (!data._seq.mensagens_internas) data._seq.mensagens_internas = 1;
  for (const u of data.usuarios) {
    if (!u.status) u.status = 'ativo';
    if (u.convite_token === undefined) u.convite_token = null;
    if (u.cargo === undefined) u.cargo = '';
    if (u.setor === undefined) u.setor = '';
    // presença do técnico pra fila de atendimento (round-robin) — online_desde marca quando
    // ele ficou online pela última vez, e decide a ordem da fila entre quem está online agora
    if (u.online === undefined) u.online = false;
    if (u.online_desde === undefined) u.online_desde = null;
    // unificação dos papéis "Técnico" (campo) e "Setor Reparo" (interno) num único papel
    // "suporte" — o que cada um pode acessar agora é decidido por acesso_total/menus, não mais
    // por papéis separados. acesso_total=true preserva o acesso completo que já tinham antes
    // dessa mudança, pro admin restringir depois se quiser.
    if (u.papel === 'tecnico' || u.papel === 'reparo') u.papel = 'suporte';
    if (u.acesso_total === undefined) u.acesso_total = true;
    if (!Array.isArray(u.menus)) u.menus = [];
    // departamento de um administrador (Suporte/Pós-venda) — vazio (null) é o administrador geral,
    // que continua vendo e cadastrando todo mundo (é sempre o caso de quem já existia antes dessa
    // separação por departamento existir).
    if (u.departamento === undefined) u.departamento = null;
    // Estoque deixou de ser um departamento de administrador (só sobrou como tipo de acesso comum,
    // sem administrador dedicado) — quem já tinha esse departamento vira administrador geral,
    // preservando o acesso completo que já tinha (o admin geral reatribui/restringe se quiser).
    if (u.papel === 'administrador' && u.departamento === 'estoque') u.departamento = null;
  }
  for (const c of data.clientes) {
    for (const campo of ['setor', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado', 'email']) {
      if (c[campo] === undefined) c[campo] = '';
    }
  }
  for (const a of data.agenda) {
    if (a.email === undefined) a.email = '';
    if (a.criado_em === undefined) a.criado_em = a.data_hora_inicio || new Date().toISOString();
    for (const campo of ['garantia', 'garantia_obs']) {
      if (a[campo] === undefined) a[campo] = '';
    }
    // SLA (nível de prioridade) — vem da IA no chat (antes de escalar) ou preenchido manualmente
    // na abertura da O.S.; fica null até ser definido
    for (const campo of ['sla_nivel', 'sla_pontuacao', 'sla_horas_atendimento', 'sla_dias_manutencao', 'sla_dias_visita_tecnica']) {
      if (a[campo] === undefined) a[campo] = null;
    }
    if (a.lida_tecnico === undefined) a.lida_tecnico = false;
    if (a.deslocamento_iniciado_em === undefined) a.deslocamento_iniciado_em = null;
    if (a.chegada_confirmada_em === undefined) {
      // mesma lógica do confirmado_cliente_em: O.S. que já tinham relatório enviado (ou já
      // finalizadas) antes desse controle existir já passaram desse ponto na prática — só as
      // que ainda estão a caminho, sem relatório, passam a exigir o registro da chegada.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const jaAvancou = a.finalizada || visitaDoItem;
      a.chegada_confirmada_em = jaAvancou ? (a.deslocamento_iniciado_em || a.criado_em || new Date().toISOString()) : null;
    }
    if (a.lembrete_deslocamento_enviado === undefined) a.lembrete_deslocamento_enviado = false;
    if (a.confirmado_cliente_em === undefined) {
      // O.S. que já tinham avançado (deslocamento, relatório ou já finalizadas) antes desse
      // controle existir claramente já passaram do aceite do cliente na prática — não faz
      // sentido bloquear elas retroativamente; só as que ainda nem começaram esperam a
      // confirmação a partir de agora.
      const jaAvancou = a.finalizada || a.deslocamento_iniciado_em || data.visitas.some((v) => v.agenda_id === a.id);
      a.confirmado_cliente_em = jaAvancou ? (a.criado_em || new Date().toISOString()) : null;
    }
    if (a.feedback_cliente_em === undefined) {
      // mesma lógica: O.S. que já estavam aprovadas (ou finalizadas) antes desse controle
      // existir já passaram desse ponto na prática — só as aprovações novas, a partir de
      // agora, exigem o registro explícito do feedback antes de finalizar.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.feedback_cliente_em = jaAprovado ? (a.finalizado_em || (visitaDoItem && visitaDoItem.data_aprovacao) || new Date().toISOString()) : null;
    }
    if (a.retrabalho === undefined) a.retrabalho = false;
    if (a.retorno_pendente_tecnico === undefined) a.retorno_pendente_tecnico = false;
    if (a.retorno_confirmado_cliente_em === undefined) a.retorno_confirmado_cliente_em = null;
    if (a.retorno_deslocamento_iniciado_em === undefined) a.retorno_deslocamento_iniciado_em = null;
    if (a.retorno_chegada_confirmada_em === undefined) a.retorno_chegada_confirmada_em = null;
    if (a.orcamento_aprovado_em === undefined) {
      // se o relatório já aprovado tinha peças fornecidas, mas esse controle de orçamento
      // ainda não existia, considera que o orçamento já foi tratado por fora do sistema —
      // não bloqueia O.S. antigas que já passaram desse ponto na prática.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const temPecas = visitaDoItem && visitaDoItem.laudo && Array.isArray(visitaDoItem.laudo.pecas) && visitaDoItem.laudo.pecas.length > 0;
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.orcamento_aprovado_em = (temPecas && jaAprovado) ? (a.feedback_cliente_em || a.criado_em || new Date().toISOString()) : null;
    }
    if (a.orcamento_reprovado_em === undefined) a.orcamento_reprovado_em = null;
    // fluxo de pós-venda/reparo (só usado em O.S. tipo "atendimento", nascidas de um chamado do
    // chat) — ver server.js, seção "pós-venda / setor reparo"
    if (a.fase_atendimento === undefined) a.fase_atendimento = null;
    if (a.motivo_pos_venda === undefined) a.motivo_pos_venda = null;
    if (a.encaminhado_pos_venda_em === undefined) a.encaminhado_pos_venda_em = null;
    if (a.equipamento_recebido_em === undefined) a.equipamento_recebido_em = null;
    if (a.pos_venda_orcamento_enviado_em === undefined) a.pos_venda_orcamento_enviado_em = null;
    if (a.pos_venda_decisao === undefined) a.pos_venda_decisao = null;
    if (a.pos_venda_decisao_em === undefined) a.pos_venda_decisao_em = null;
    if (a.tecnico_chat_id === undefined) a.tecnico_chat_id = null;
    // estoque (chegada/saída) e handoff pra O.S. de visita técnica — ver server.js
    if (a.estoque_recebido_em === undefined) a.estoque_recebido_em = null;
    if (a.equipamento_liberado_reparo_em === undefined) a.equipamento_liberado_reparo_em = null;
    if (a.estoque_saida_em === undefined) a.estoque_saida_em = null;
    if (a.os_criada_id === undefined) a.os_criada_id = null;
    // O.S. de atendimento criadas antes desse fluxo existir (fase_atendimento nunca foi
    // preenchida) entram agora em "em_atendimento" — do jeito que já estavam, só passam a
    // seguir a linha do tempo nova a partir daqui em vez da antiga (deslocamento/orçamento)
    if (a.tipo === 'atendimento' && !a.finalizada && !a.fase_atendimento) {
      a.fase_atendimento = 'em_atendimento';
      if (!a.tecnico_chat_id) a.tecnico_chat_id = a.tecnico_id;
    }
    // bônus de viagem (R$200) — o administrador marca na O.S. quando ela dá direito ao bônus
    // (nem toda região paga); conta pro limite de 7 viagens com bônus por técnico/mês (ver
    // contarViagensBonusMes em server.js)
    if (a.bonus_viagem === undefined) a.bonus_viagem = false;
    if (a.justificativa_limite_viagens === undefined) a.justificativa_limite_viagens = '';
  }
  for (const e of data.equipamentos) {
    if (e.cliente_id === undefined) e.cliente_id = null;
    if (e.data_fabricacao === undefined) e.data_fabricacao = '';
  }
  for (const v of data.visitas) {
    if (v.lida_tecnico === undefined) v.lida_tecnico = false;
    if (v.rodada === undefined) v.rodada = 1;
  }
  // relatórios de manutenção criados antes do e-mail do técnico ser buscado corretamente
  // ficaram com esse campo em branco — preenche retroativamente a partir do cadastro atual
  for (const r of data.relatorios_manutencao) {
    if (!r.tecnico_email) {
      const autor = data.usuarios.find((u) => u.id === r.autor_id);
      if (autor && autor.email) r.tecnico_email = autor.email;
    }
    // relatórios criados antes da "ficha de equipamento" (leitura automática de etiqueta) existir
    // são todos do tipo "completo" (o formulário manual de sempre).
    if (!r.tipo) r.tipo = 'completo';
    if (!Array.isArray(r.campos)) r.campos = [];
    if (r.mtbf_encontrado === undefined) r.mtbf_encontrado = '';
    if (r.resultado_ensaio === undefined) r.resultado_ensaio = '';
    if (!Array.isArray(r.ciclos)) r.ciclos = [];
    if (r.conclusao_ensaio === undefined) r.conclusao_ensaio = '';
    if (r.tecnico_cargo === undefined) r.tecnico_cargo = '';
    if (r.tecnico_setor === undefined) r.tecnico_setor = '';
  }
  protegerAdminMaster(data);
  return data;
}

// ---------- modo arquivo (padrão, sem DATABASE_URL) ----------

function carregarDoArquivo() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    bootstrapAdminMaster(data);
    sincronizarEmpresaPadrao(data);
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  const data = migrar(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  if (bootstrapAdminMaster(data)) salvarNoArquivo(data);
  return data;
}

function salvarNoArquivo(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------- modo Postgres (opcional, via DATABASE_URL) ----------
// Guarda tudo como um único registro JSONB — mantém load()/save() síncronos com um cache em
// memória (populado uma vez no boot), pra não precisar tornar todo o server.js assíncrono.

let pool = null;
function obterPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  }
  return pool;
}

let cache = null;

async function inicializarPostgres() {
  const p = obterPool();
  await p.query('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL)');
  await p.query('CREATE TABLE IF NOT EXISTS fotos (id TEXT PRIMARY KEY, dados TEXT NOT NULL, criado_em TIMESTAMPTZ DEFAULT now())');
  await p.query(`CREATE TABLE IF NOT EXISTS mensagens_chamado (
    id SERIAL PRIMARY KEY, chamado_id INTEGER NOT NULL, autor TEXT NOT NULL, texto TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_mensagens_chamado_chamado_id ON mensagens_chamado (chamado_id)');
  await p.query(`CREATE TABLE IF NOT EXISTS mensagens_internas_tbl (
    id SERIAL PRIMARY KEY, remetente_id INTEGER NOT NULL, destinatario_id INTEGER NOT NULL,
    texto TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), lida BOOLEAN NOT NULL DEFAULT false
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_mensagens_internas_par ON mensagens_internas_tbl (remetente_id, destinatario_id)');
  const r = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length === 0) {
    const data = seed();
    bootstrapAdminMaster(data);
    sincronizarEmpresaPadrao(data);
    await p.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
    cache = data;
  } else {
    const data = migrar(r.rows[0].data);
    if (bootstrapAdminMaster(data)) {
      await p.query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)]);
    }
    cache = data;
  }
  console.log('Conectado ao Postgres — os dados persistem entre reinícios.');
}

// server.js aguarda essa promise antes de abrir a porta. No modo arquivo, resolve na hora.
// Se a conexão com o Postgres falhar, cai pro arquivo local em vez de derrubar o servidor.
const pronto = (usaPostgres
  ? inicializarPostgres().catch((e) => {
      console.error('Falha ao conectar no Postgres — usando o arquivo local como reserva:', e.message);
      cache = null;
    })
  : Promise.resolve()
).then(() => migrarMensagensSeNecessario());

function load() {
  if (usaPostgres && cache) return cache;
  return carregarDoArquivo();
}

function save(data) {
  if (usaPostgres && cache) {
    cache = data;
    obterPool()
      .query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)])
      .catch((e) => console.error('Erro ao salvar no Postgres:', e.message));
    return;
  }
  salvarNoArquivo(data);
}

function nextId(data, tabela) {
  const id = data._seq[tabela]++;
  return id;
}

function estaUsandoPostgres() {
  return usaPostgres && !!cache;
}

// ---------- fotos (guardadas à parte do bloco principal — antes ficavam dentro do mesmo JSON
// que fica sempre carregado na memória, e isso foi o que estourou o limite de RAM do plano
// gratuito do Render conforme foram se acumulando; agora só uma referência pequena fica no bloco
// principal, e a foto de verdade só é buscada quando alguém realmente precisa dela) ----------

const FOTOS_DIR = path.join(__dirname, 'fotos');

async function salvarFoto(dadosBase64) {
  const id = crypto.randomBytes(12).toString('hex');
  if (estaUsandoPostgres()) {
    await obterPool().query('INSERT INTO fotos (id, dados) VALUES ($1, $2)', [id, dadosBase64]);
  } else {
    if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(FOTOS_DIR, id), dadosBase64);
  }
  return id;
}

async function carregarFoto(id) {
  if (!id) return null;
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT dados FROM fotos WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].dados : null;
  }
  const caminho = path.join(FOTOS_DIR, String(id));
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : null;
}

// ---------- mensagens de chat (atendimento por chamado + chat interno da equipe) — mesma ideia
// das fotos: antes ficavam embutidas dentro do bloco principal (chamados[].mensagens e o array
// mensagens_internas), e como são a parte que mais cresce e mais escreve (uma mensagem nova
// reescrevia o banco inteiro), agora moram à parte. Só uma migração automática (abaixo) move o
// que já existia de dado antigo pra cá, uma única vez.

const MENSAGENS_CHAMADO_PATH = path.join(__dirname, 'mensagens_chamado.json');
const MENSAGENS_INTERNAS_PATH = path.join(__dirname, 'mensagens_internas.json');

function carregarMensagensChamadoArquivo() {
  if (!fs.existsSync(MENSAGENS_CHAMADO_PATH)) return [];
  return JSON.parse(fs.readFileSync(MENSAGENS_CHAMADO_PATH, 'utf8'));
}
function salvarMensagensChamadoArquivo(lista) {
  fs.writeFileSync(MENSAGENS_CHAMADO_PATH, JSON.stringify(lista));
}
function carregarMensagensInternasArquivo() {
  if (!fs.existsSync(MENSAGENS_INTERNAS_PATH)) return [];
  return JSON.parse(fs.readFileSync(MENSAGENS_INTERNAS_PATH, 'utf8'));
}
function salvarMensagensInternasArquivo(lista) {
  fs.writeFileSync(MENSAGENS_INTERNAS_PATH, JSON.stringify(lista));
}

// o driver do Postgres devolve TIMESTAMPTZ como objeto Date — o resto do sistema sempre trabalha
// com string ISO (comparação, fmtData no front, etc.), então converte de volta na leitura.
function isoDe(valor) {
  return valor instanceof Date ? valor.toISOString() : valor;
}

async function salvarMensagemChamado(chamadoId, msg) {
  const autor = msg.autor;
  const texto = msg.texto;
  const criado_em = msg.criado_em || new Date().toISOString();
  if (estaUsandoPostgres()) {
    await obterPool().query('INSERT INTO mensagens_chamado (chamado_id, autor, texto, criado_em) VALUES ($1, $2, $3, $4)', [chamadoId, autor, texto, criado_em]);
  } else {
    const lista = carregarMensagensChamadoArquivo();
    lista.push({ chamado_id: chamadoId, autor, texto, criado_em });
    salvarMensagensChamadoArquivo(lista);
  }
  return { autor, texto, criado_em };
}

async function carregarMensagensChamado(chamadoId) {
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT autor, texto, criado_em FROM mensagens_chamado WHERE chamado_id = $1 ORDER BY id ASC', [chamadoId]);
    return r.rows.map((row) => ({ autor: row.autor, texto: row.texto, criado_em: isoDe(row.criado_em) }));
  }
  return carregarMensagensChamadoArquivo()
    .filter((m) => m.chamado_id === chamadoId)
    .map((m) => ({ autor: m.autor, texto: m.texto, criado_em: m.criado_em }));
}

async function salvarMensagemInterna({ remetente_id, destinatario_id, texto }) {
  const criado_em = new Date().toISOString();
  if (estaUsandoPostgres()) {
    const r = await obterPool().query(
      'INSERT INTO mensagens_internas_tbl (remetente_id, destinatario_id, texto, criado_em, lida) VALUES ($1, $2, $3, $4, false) RETURNING id',
      [remetente_id, destinatario_id, texto, criado_em]
    );
    return { id: r.rows[0].id, remetente_id, destinatario_id, texto, criado_em, lida: false };
  }
  const lista = carregarMensagensInternasArquivo();
  const id = lista.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  const msg = { id, remetente_id, destinatario_id, texto, criado_em, lida: false };
  lista.push(msg);
  salvarMensagensInternasArquivo(lista);
  return msg;
}

async function carregarMensagensInternas(usuarioId, outroId) {
  if (estaUsandoPostgres()) {
    const r = await obterPool().query(
      `SELECT id, remetente_id, destinatario_id, texto, criado_em, lida FROM mensagens_internas_tbl
       WHERE (remetente_id = $1 AND destinatario_id = $2) OR (remetente_id = $2 AND destinatario_id = $1)
       ORDER BY id ASC`,
      [usuarioId, outroId]
    );
    return r.rows.map((row) => ({ ...row, criado_em: isoDe(row.criado_em) }));
  }
  return carregarMensagensInternasArquivo()
    .filter((m) => (m.remetente_id === usuarioId && m.destinatario_id === outroId) || (m.remetente_id === outroId && m.destinatario_id === usuarioId))
    .sort((a, b) => a.id - b.id);
}

async function marcarMensagensInternasLidas(usuarioId, outroId) {
  if (estaUsandoPostgres()) {
    await obterPool().query(
      'UPDATE mensagens_internas_tbl SET lida = true WHERE destinatario_id = $1 AND remetente_id = $2 AND lida = false',
      [usuarioId, outroId]
    );
    return;
  }
  const lista = carregarMensagensInternasArquivo();
  let mudou = false;
  for (const m of lista) {
    if (m.destinatario_id === usuarioId && m.remetente_id === outroId && !m.lida) { m.lida = true; mudou = true; }
  }
  if (mudou) salvarMensagensInternasArquivo(lista);
}

// resumo de uma conversa (última mensagem + não lidas) — usado pra montar a lista de contatos
// do chat interno sem carregar o histórico inteiro de todo mundo em memória a cada 15s.
async function resumoContatoInterno(usuarioId, outroId) {
  const conversa = await carregarMensagensInternas(usuarioId, outroId);
  if (!conversa.length) return { ultima_mensagem_texto: null, ultima_mensagem_em: null, ultima_mensagem_propria: false, nao_lidas: 0 };
  const ultima = conversa[conversa.length - 1];
  const nao_lidas = conversa.filter((m) => m.destinatario_id === usuarioId && m.remetente_id === outroId && !m.lida).length;
  return {
    ultima_mensagem_texto: ultima.texto,
    ultima_mensagem_em: ultima.criado_em,
    ultima_mensagem_propria: ultima.remetente_id === usuarioId,
    nao_lidas,
  };
}

// migração única (idempotente): move qualquer mensagem que ainda esteja embutida no bloco
// principal (banco de antes dessa mudança existir) pra cá, preservando texto/autor/data/lida
// originais. Depois da primeira vez os arrays ficam vazios, então não faz nada nas próximas.
async function migrarMensagensParaTabelas(data) {
  let mudou = false;
  for (const c of data.chamados) {
    if (Array.isArray(c.mensagens) && c.mensagens.length) {
      if (estaUsandoPostgres()) {
        for (const m of c.mensagens) {
          await obterPool().query('INSERT INTO mensagens_chamado (chamado_id, autor, texto, criado_em) VALUES ($1, $2, $3, $4)', [c.id, m.autor, m.texto, m.criado_em]);
        }
      } else {
        const lista = carregarMensagensChamadoArquivo();
        for (const m of c.mensagens) lista.push({ chamado_id: c.id, autor: m.autor, texto: m.texto, criado_em: m.criado_em });
        salvarMensagensChamadoArquivo(lista);
      }
      if (!c.primeira_mensagem_cliente) {
        const primeira = c.mensagens.find((m) => m.autor === 'cliente');
        c.primeira_mensagem_cliente = primeira ? primeira.texto : '';
      }
      c.mensagens = [];
      mudou = true;
    }
  }
  if (Array.isArray(data.mensagens_internas) && data.mensagens_internas.length) {
    if (estaUsandoPostgres()) {
      for (const m of data.mensagens_internas) {
        await obterPool().query(
          'INSERT INTO mensagens_internas_tbl (remetente_id, destinatario_id, texto, criado_em, lida) VALUES ($1, $2, $3, $4, $5)',
          [m.remetente_id, m.destinatario_id, m.texto, m.criado_em, !!m.lida]
        );
      }
    } else {
      const lista = carregarMensagensInternasArquivo();
      let proximoId = lista.reduce((max, m) => Math.max(max, m.id), 0);
      for (const m of data.mensagens_internas) {
        proximoId += 1;
        lista.push({ id: proximoId, remetente_id: m.remetente_id, destinatario_id: m.destinatario_id, texto: m.texto, criado_em: m.criado_em, lida: !!m.lida });
      }
      salvarMensagensInternasArquivo(lista);
    }
    data.mensagens_internas = [];
    mudou = true;
  }
  return mudou;
}

// roda uma vez no boot (via `pronto`, antes de qualquer rota aceitar requisição) — nunca faz
// parte do load()/save() de cada requisição, pra não tornar o caminho normal assíncrono.
async function migrarMensagensSeNecessario() {
  const data = usaPostgres && cache ? cache : carregarDoArquivo();
  const mudou = await migrarMensagensParaTabelas(data);
  if (mudou) save(data);
}

module.exports = {
  load, save, nextId, hashSenha, conferirSenha, gerarTokenConvite, DB_PATH, pronto, estaUsandoPostgres, salvarFoto, carregarFoto,
  salvarMensagemChamado, carregarMensagensChamado,
  salvarMensagemInterna, carregarMensagensInternas, marcarMensagensInternasLidas, resumoContatoInterno,
};
