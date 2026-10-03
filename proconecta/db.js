// db.js — "banco de dados". Por padrão, um arquivo JSON local (sem dependências externas).
// Se a variável de ambiente DATABASE_URL estiver definida, usa Postgres (ex.: Supabase) —
// guarda o mesmo objeto inteiro como um único registro JSONB, então nenhuma outra parte do
// sistema precisa mudar (load()/save() continuam funcionando exatamente igual).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DB_PATH é configurável (DB_PATH_ARQUIVO) pra testes de ponta a ponta poderem subir o servidor
// de verdade contra um arquivo descartável, sem tocar no data.json real do ambiente.
const DB_PATH = process.env.DB_PATH_ARQUIVO || path.join(__dirname, 'data.json');
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

// módulos que o próprio código sabe suportar — lista fixa, não é dado editável: pra existir um
// módulo de verdade é preciso ter código pra ele. O que É editável por empresa é só QUAIS desses
// módulos estão ligados (empresa.modulos_ativos, ver moduloAtivo abaixo) — isso sim é dado.
// "núcleo" não entra aqui: é sempre ativo pra toda empresa, não passa por essa checagem.
const MODULOS_DISPONIVEIS = [
  { chave: 'os_chamados', nome: 'O.S. e Chamados' },
  { chave: 'smp_preventivas', nome: 'Procedimentos e Preventivas' },
  { chave: 'biblioteca', nome: 'Biblioteca' },
  { chave: 'prestacao_contas', nome: 'Prestação de Contas' },
  { chave: 'crm', nome: 'CRM' },
  { chave: 'agendamento', nome: 'Agendamento Online' },
  { chave: 'financeiro', nome: 'Financeiro' },
  { chave: 'assistente_ia', nome: 'Assistente IA' },
];
const CHAVES_MODULOS = MODULOS_DISPONIVEIS.map((m) => m.chave);

// módulos padrão da versão "Manutenção" — o pacote que toda empresa migrada do sistema antigo
// (só a PRO Marking, por enquanto) já usa hoje.
const MODULOS_VERSAO_MANUTENCAO = ['os_chamados', 'smp_preventivas', 'biblioteca'];

function moduloAtivo(data, empresaId, chave) {
  if (!CHAVES_MODULOS.includes(chave)) return false;
  const empresa = data.empresas.find((e) => e.id === empresaId);
  return !!empresa && Array.isArray(empresa.modulos_ativos) && empresa.modulos_ativos.includes(chave);
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
    feriados: [],
    escala_folgas: [],
    // "versões" = pacotes prontos de módulos, escolhidos ao cadastrar uma empresa (ver
    // sincronizarEmpresaPadrao) — depois disso, módulo avulso pode ser ligado/desligado por
    // empresa independente da versão original (empresa.modulos_ativos).
    versoes: [{ id: 1, nome: 'Manutenção', modulos: MODULOS_VERSAO_MANUTENCAO }],
    // empresas começa em 2: o id 1 é sempre a empresa dona da instalação (ver sincronizarEmpresaPadrao),
    // carimbado direto, nunca através de nextId — a plataforma só usa esse contador a partir da 2ª.
    _seq: { usuarios: 1, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, registros: 1, chamados: 1, relatorios_manutencao: 1, mensagens_internas: 1, solicitacoes_rh: 1, feriados: 1, escala_folgas: 1, versoes: 2, empresas: 2 },
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
  // multiempresa: empresa 1 (PRO Marking) já usa o sistema hoje com os módulos da versão
  // Manutenção — isso também cobre quem já tinha essa empresa criada antes desses 3 campos
  // existirem (roda em todo boot, idempotente).
  if (empresa.versao_id === undefined) empresa.versao_id = 1;
  if (!Array.isArray(empresa.modulos_ativos)) empresa.modulos_ativos = [...MODULOS_VERSAO_MANUTENCAO];
  if (!empresa.terminologia || typeof empresa.terminologia !== 'object') empresa.terminologia = {};
  // subdomínio: identifica a empresa pela URL antes do login (ver resolverEmpresaPorRequisicao em
  // server.js). Fica null até alguém configurar — nesse caso toda requisição cai na empresa 1
  // (comportamento de hoje, preservado).
  if (empresa.subdominio === undefined) empresa.subdominio = null;
  if (process.env.EMPRESA_NOME) empresa.nome = process.env.EMPRESA_NOME;
  if (process.env.EMPRESA_SITE) empresa.site = process.env.EMPRESA_SITE;
  if (process.env.EMPRESA_WHATSAPP) empresa.whatsapp = process.env.EMPRESA_WHATSAPP;
  if (process.env.EMPRESA_TELEFONE) empresa.telefone = process.env.EMPRESA_TELEFONE;
  if (process.env.EMPRESA_EMAILS) empresa.emails = process.env.EMPRESA_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);
  if (process.env.EMPRESA_COR_PRIMARIA) empresa.cor_primaria = process.env.EMPRESA_COR_PRIMARIA;
  if (process.env.EMPRESA_COR_SECUNDARIA) empresa.cor_secundaria = process.env.EMPRESA_COR_SECUNDARIA;
  if (process.env.EMPRESA_SUBDOMINIO) empresa.subdominio = process.env.EMPRESA_SUBDOMINIO.trim().toLowerCase();
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
    cargo: '', setor: '', celular: '', foto_perfil: '', cliente_id: null,
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

// dono da plataforma (não pertence a nenhuma empresa — empresa_id fica null de propósito, pra
// nunca ser confundido com a empresa 1 nem entrar em nenhum tenant.listar/buscar). Mesmo padrão
// de bootstrap do ADMIN_EMAIL/ADMIN_SENHA, com variáveis próprias — assim dá pra ter os dois tipos
// de conta master ativos ao mesmo tempo (o admin da PRO Marking e o super admin da plataforma).
function bootstrapSuperAdmin(data) {
  const email = process.env.SUPERADMIN_EMAIL;
  const senha = process.env.SUPERADMIN_SENHA;
  if (!email || !senha) return false;
  if (data.usuarios.some((u) => u.email === email)) return false;
  const { salt, hash } = hashSenha(senha);
  data.usuarios.push({
    id: nextId(data, 'usuarios'),
    nome: 'Super Admin', email, papel: 'super_admin', empresa_id: null,
    cargo: '', setor: '', celular: '', foto_perfil: '', cliente_id: null,
    status: 'ativo', convite_token: null, salt, hash,
    protegido: true,
  });
  console.log(`[db] Conta de super admin criada automaticamente: ${email}`);
  return true;
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
  // Entrega para Teste ganhou um link público (token_publico) pro cliente preencher/assinar sem
  // login — relatórios desse tipo criados antes disso existir ficam sem o token; carimba um
  // agora e considera já concluídos (não tem como saber se estavam esperando o cliente ou não, e
  // reabrir o link de um relatório antigo sem controle nenhum seria pior do que só deixar como está).
  data.relatorios_manutencao.filter((r) => r.tipo === 'entrega_teste').forEach((r) => {
    if (!r.token_publico) r.token_publico = gerarTokenConvite();
    if (!r.status_preenchimento) r.status_preenchimento = 'concluido';
    if (r.concluido_em === undefined) r.concluido_em = r.status_preenchimento === 'concluido' ? (r.criado_em || null) : null;
  });
  if (!data.mensagens_internas) data.mensagens_internas = [];
  if (!data.solicitacoes_rh) data.solicitacoes_rh = [];
  if (!data._seq.solicitacoes_rh) data._seq.solicitacoes_rh = 1;
  // escala de folga: feriados (nacional/estadual/municipal, cadastrados pelo administrador — o
  // sistema não vem com nenhum pré-cadastrado, pra nunca arriscar uma data errada) e os dias
  // marcados de cada usuário (DSR, compensação de banco de horas, home office, férias).
  if (!data.feriados) data.feriados = [];
  if (!data._seq.feriados) data._seq.feriados = 1;
  if (!data.escala_folgas) data.escala_folgas = [];
  if (!data._seq.escala_folgas) data._seq.escala_folgas = 1;
  // multiempresa: bancos anteriores ao conceito de "versão" (pacote de módulos) ganham a versão
  // Manutenção, que é o que o sistema sempre ofereceu até agora.
  if (!data.versoes) data.versoes = [{ id: 1, nome: 'Manutenção', modulos: MODULOS_VERSAO_MANUTENCAO }];
  if (!data._seq.versoes) data._seq.versoes = 2;
  // empresa 1 (a dona da instalação) é sempre carimbada direto, nunca via nextId — o contador só
  // precisa existir a partir da 2ª empresa, que o painel da plataforma cria.
  if (!data._seq.empresas) data._seq.empresas = 2;
  sincronizarEmpresaPadrao(data);
  // bancos anteriores ao empresa_id (preparação pra multi-tenant) ganham empresa_id 1 — hoje só
  // existe essa empresa mesmo, então todo registro já criado pertence a ela.
  for (const lista of [data.usuarios, data.clientes, data.equipamentos, data.agenda, data.visitas, data.registros, data.chamados, data.relatorios_manutencao, data.solicitacoes_rh, data.mensagens_internas, data.feriados, data.escala_folgas]) {
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
    // categoria sempre foi derivada do tipo (treinamento online e atendimento do chat não têm
    // deslocamento até o cliente) — recalcula sempre, não só quando ausente, porque O.S. criadas
    // antes dessa regra existir ficaram gravadas com 'inloco' mesmo sendo treinamento online
    a.categoria = (a.tipo === 'treinamento_online' || a.tipo === 'atendimento') ? 'online' : 'inloco';
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
    if (a.viagem_volta_iniciada_em === undefined) a.viagem_volta_iniciada_em = null;
    if (a.viagem_volta_chegada_em === undefined) a.viagem_volta_chegada_em = null;
    if (a.viagem_volta_destino_agenda_id === undefined) a.viagem_volta_destino_agenda_id = null;
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
    // bônus de viagem (R$200/diária) — o administrador marca na O.S. quando ela dá direito ao
    // bônus (nem toda região paga) e informa o dia de início do deslocamento e o dia previsto de
    // retorno; conta 1 diária por dia corrido entre os dois, contra o limite de 7 diárias por
    // técnico/mês (ver diasBonusViagem/contarDiariasBonusMes em server.js). O.S. antigas que já
    // tinham bonus_viagem marcado (de quando era só 1 bônus fixo por O.S., sem diária) ganham
    // início = fim = o dia do atendimento, preservando o valor de 1 diária que já valiam.
    if (a.bonus_viagem === undefined) a.bonus_viagem = false;
    if (a.viagem_dia_inicio === undefined) a.viagem_dia_inicio = a.bonus_viagem ? String(a.data_hora_inicio || '').slice(0, 10) : '';
    if (a.viagem_dia_fim_previsto === undefined) a.viagem_dia_fim_previsto = a.bonus_viagem ? String(a.data_hora_inicio || '').slice(0, 10) : '';
    if (a.justificativa_limite_viagens === undefined) a.justificativa_limite_viagens = '';
    // marca se essa viagem foi escolhida fora da ordem do rodízio (ver motivoExigeJustificativaViagem
    // em server.js) — O.S. antigas, de antes desse controle existir, não têm como saber, então
    // entram como false (não conta pro selo do painel de acompanhamento).
    if (a.fora_de_ordem_viagem === undefined) a.fora_de_ordem_viagem = false;
    // conflito com a escala de folga (DSR ou compensação de banco de horas do técnico no dia da
    // O.S. — férias bloqueia direto, não chega a salvar) — ver conflitoEscalaTecnico em server.js
    if (a.escala_conflito_tipo === undefined) a.escala_conflito_tipo = null;
    if (a.justificativa_escala_conflito === undefined) a.justificativa_escala_conflito = '';
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
  // backfill: relatórios criados antes do cruzamento automático com Clientes/Equipamentos existir
  // (ver sincronizarClienteDoRelatorio em server.js) passam por aqui uma vez, na ordem em que
  // foram criados, pra alimentar a lista com o que já tinha sido reportado em campo e ficou de
  // fora até agora. Mesma regra de sempre — idempotente, roda de novo a cada boot sem duplicar:
  // nome de empresa repetido (mesmo em caixa diferente) não cria outro cliente, só completa o que
  // estava vazio; nº de série repetido não duplica o equipamento.
  const relatoriosOrdenados = [...data.relatorios_manutencao].sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  for (const r of relatoriosOrdenados) {
    const nomeEmpresa = String(r.empresa || '').trim();
    if (!nomeEmpresa) continue;
    const empresaId = r.empresa_id;
    const clientesDaEmpresa = data.clientes.filter((c) => c.empresa_id === empresaId);
    let cliente = clientesDaEmpresa.find((c) => String(c.nome_empresa || '').trim().toLowerCase() === nomeEmpresa.toLowerCase());
    if (cliente) {
      const preencheSeVazio = (campo, valor) => { if (!cliente[campo] && valor) cliente[campo] = valor; };
      preencheSeVazio('contato', r.contato);
      preencheSeVazio('telefone', r.telefone);
      preencheSeVazio('endereco', r.endereco);
      preencheSeVazio('numero', r.numero);
      preencheSeVazio('bairro', r.bairro);
      preencheSeVazio('cep', r.cep);
      preencheSeVazio('cidade', r.cidade);
      preencheSeVazio('estado', r.estado);
    } else {
      cliente = {
        id: nextId(data, 'clientes'), empresa_id: empresaId,
        nome_empresa: nomeEmpresa,
        contato: r.contato || '', telefone: r.telefone || '', email: '',
        nivel_acesso: 'completo', setor: '',
        endereco: r.endereco || '', numero: r.numero || '', bairro: r.bairro || '',
        cep: r.cep || '', cidade: r.cidade || '', estado: r.estado || '',
      };
      data.clientes.push(cliente);
    }

    const numeroSerie = String(r.numero_serie || '').trim();
    if (!numeroSerie) continue;
    const equipamentosDaEmpresa = data.equipamentos.filter((e) => e.empresa_id === empresaId);
    const existente = equipamentosDaEmpresa.find((e) => String(e.numero_serie || '').trim().toLowerCase() === numeroSerie.toLowerCase());
    if (!existente) {
      const descricao = String(r.modelo_maquina || r.equipamento || r.equipamento_demonstrado || '').trim();
      data.equipamentos.push({
        id: nextId(data, 'equipamentos'), empresa_id: empresaId,
        cliente_id: cliente.id,
        tipo: descricao || 'Equipamento',
        modelo: String(r.marca || '').trim(),
        numero_serie: numeroSerie,
        data_fabricacao: r.data_fabricacao || '',
        localizacao: '',
      });
    } else if (existente.cliente_id === null) {
      existente.cliente_id = cliente.id;
    }
  }
  // ficha cadastral (menu Equipe > Cadastros): foto de perfil opcional — sem ela, o front mostra
  // uma silhueta padrão, então aqui só garante que o campo exista (string vazia) em vez de undefined.
  data.usuarios.forEach((u) => { if (u.foto_perfil === undefined) u.foto_perfil = ''; });
  // ficha cadastral ampliada: certificados (arquivo + validade), integrações com empresas-cliente
  // (acesso/credencial pra atuar nelas, com validade) e competências (nível de conhecimento num
  // tipo de equipamento) — cada uma é uma coleção própria, um registro por item, presa ao técnico
  // dono (usuario_id) e à empresa (empresa_id, como tudo mais no sistema).
  if (!data.certificados_colaborador) data.certificados_colaborador = [];
  if (!data._seq.certificados_colaborador) data._seq.certificados_colaborador = 1;
  if (!data.integracoes_colaborador) data.integracoes_colaborador = [];
  if (!data._seq.integracoes_colaborador) data._seq.integracoes_colaborador = 1;
  if (!data.competencias_colaborador) data.competencias_colaborador = [];
  if (!data._seq.competencias_colaborador) data._seq.competencias_colaborador = 1;
  protegerAdminMaster(data);
  return data;
}

// ---------- modo arquivo (padrão, sem DATABASE_URL) ----------

function carregarDoArquivo() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    bootstrapAdminMaster(data);
    bootstrapSuperAdmin(data);
    sincronizarEmpresaPadrao(data);
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  const data = migrar(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  const criouAlguem = bootstrapAdminMaster(data) | bootstrapSuperAdmin(data);
  if (criouAlguem) salvarNoArquivo(data);
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

// ---------- Etapa 4 (briefing white label) — tabelas indexadas por empresa, fase 1 ----------
// Fase "segura": cria as tabelas (vazias) e deixa prontas pra receber os dados via script de
// migração (scripts/migrar-para-tabelas.js) — o app continua lendo/escrevendo pelo blob JSONB
// de sempre (app_state), sem nenhuma mudança de comportamento. Nada aqui é lido pelo resto do
// sistema ainda; é só a fundação. O corte de verdade (tenant.js passar a consultar essas tabelas
// em vez do array em memória) é um trabalho grande à parte — torna as consultas assíncronas,
// o que mexe em centenas de pontos de server.js — e fica pra uma etapa futura, feita aos poucos.
//
// Cada linha guarda o registro inteiro em `dados` (JSONB) — mais simples e resistente a ficar
// desatualizado que replicar campo por campo numa coluna própria, já que o schema de cada
// coleção ainda muda com frequência do lado do db.js/server.js. `empresa_id` (e, pra agenda,
// também técnico/data) viram colunas de verdade, indexadas — é isso que dá a consulta rápida por
// empresa (e por empresa+técnico+data na agenda) que o diagnóstico apontou como faltando, e é
// o que permite ligar Row Level Security depois (cada empresa só enxerga suas próprias linhas no
// nível do próprio banco — hoje impossível, porque tudo mora numa linha JSONB só).
// 'agenda' entra na lista por completude (pro script de migração saber que ela também tem tabela
// própria), mas é criada à parte logo abaixo, com as colunas extras de técnico/data.
const COLECOES_EM_TABELA = ['usuarios', 'clientes', 'equipamentos', 'agenda', 'visitas', 'relatorios_manutencao', 'chamados', 'registros'];
const COLECOES_SEM_COLUNAS_EXTRAS = COLECOES_EM_TABELA.filter((c) => c !== 'agenda');

async function inicializarTabelasMultiempresa(p) {
  for (const colecao of COLECOES_SEM_COLUNAS_EXTRAS) {
    await p.query(`CREATE TABLE IF NOT EXISTS t_${colecao} (
      id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, dados JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_t_${colecao}_empresa ON t_${colecao} (empresa_id)`);
  }
  // agenda: além de empresa_id, técnico + data — é a combinação mais consultada do sistema
  // (agenda do técnico, calendário geral do mês)
  await p.query(`CREATE TABLE IF NOT EXISTS t_agenda (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, tecnico_id INTEGER, data_hora_inicio TEXT,
    dados JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_agenda_empresa_tecnico_data ON t_agenda (empresa_id, tecnico_id, data_hora_inicio)');
  // busca de texto na biblioteca técnica (registros) e nos relatórios — gerada automaticamente a
  // partir do próprio JSON (mais simples que listar campo por campo e manter isso sincronizado
  // manualmente; o tokenizador do Postgres já ignora a pontuação/estrutura do JSON sozinho)
  await p.query(`ALTER TABLE t_registros ADD COLUMN IF NOT EXISTS busca_texto TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('portuguese', dados::text)) STORED`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_registros_busca ON t_registros USING GIN (busca_texto)');
  await p.query(`ALTER TABLE t_relatorios_manutencao ADD COLUMN IF NOT EXISTS busca_texto TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('portuguese', dados::text)) STORED`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_relatorios_manutencao_busca ON t_relatorios_manutencao USING GIN (busca_texto)');
}

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
  await inicializarTabelasMultiempresa(p);
  const r = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length === 0) {
    const data = seed();
    bootstrapAdminMaster(data);
    bootstrapSuperAdmin(data);
    sincronizarEmpresaPadrao(data);
    await p.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
    cache = data;
  } else {
    const data = migrar(r.rows[0].data);
    const criouAlguem = bootstrapAdminMaster(data) | bootstrapSuperAdmin(data);
    if (criouAlguem) {
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
//
// Com SUPABASE_URL + SUPABASE_SERVICE_KEY configuradas, fotos NOVAS vão pro Supabase Storage (um
// serviço de arquivo de verdade, fora do processo do servidor — sobrevive a redeploy, diferente do
// disco local do modo arquivo) em vez da tabela/pasta antiga. A referência vira a própria URL
// pública da foto (em vez de um id curto), então carregarFoto reconhece isso e devolve na hora, sem
// precisar buscar em lugar nenhum. Fotos antigas continuam exatamente onde estavam — nada migra
// sozinho (ver scripts/migrar-fotos-supabase.js pra mover as existentes quando quiser).
const FOTOS_DIR = path.join(__dirname, 'fotos');
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'fotos';

function supabaseStorageConfigurado() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

async function salvarFotoSupabase(dadosBase64) {
  const texto = dadosBase64.trim();
  // só o prefixo precisa bater com a regex (sem precisar alcançar o fim da string) — extrair o
  // base64 por posição do "," é mais resistente a essa string vir com espaço/quebra de linha
  // sobrando na ponta (ex.: uma foto antiga lida de um arquivo) do que tentar casar tudo de uma vez.
  const m = /^data:([^;]+);base64,/.exec(texto);
  const mime = m ? m[1] : 'application/octet-stream';
  const base64 = m ? texto.slice(m[0].length) : texto;
  const buffer = Buffer.from(base64, 'base64');
  const extensao = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg');
  const nome = `${crypto.randomBytes(12).toString('hex')}.${extensao}`;
  const resp = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${nome}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': mime },
    body: buffer,
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Supabase Storage respondeu ${resp.status}: ${detalhe}`);
  }
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${nome}`;
}

// lê uma foto do backend ANTIGO (Postgres ou disco local), ignorando o Supabase mesmo que esteja
// configurado — usado pelo script de migração, que precisa ler de onde a foto já está antes de
// subir pro Supabase; o carregarFoto "normal" abaixo não serve pra isso porque, com Supabase
// configurado, uma referência nova (URL) nunca chega até aqui.
async function carregarFotoAntiga(id) {
  if (!id) return null;
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT dados FROM fotos WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].dados : null;
  }
  const caminho = path.join(FOTOS_DIR, String(id));
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : null;
}

async function salvarFoto(dadosBase64) {
  if (supabaseStorageConfigurado()) return salvarFotoSupabase(dadosBase64);
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
  // referência do Supabase Storage já é a própria URL pública — nada pra buscar
  if (typeof id === 'string' && /^https?:\/\//.test(id)) return id;
  return carregarFotoAntiga(id);
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
  supabaseStorageConfigurado, salvarFotoSupabase, carregarFotoAntiga,
  salvarMensagemChamado, carregarMensagensChamado,
  salvarMensagemInterna, carregarMensagensInternas, marcarMensagensInternasLidas, resumoContatoInterno,
  MODULOS_DISPONIVEIS, CHAVES_MODULOS, moduloAtivo, migrar,
  obterPool, COLECOES_EM_TABELA,
};
