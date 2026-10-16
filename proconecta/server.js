// server.js — Nexor Connect, backend real (Fase 1 + Biblioteca técnica), sem dependências externas.
// Rode com: node server.js
// Abra: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const email = require('./email');
const ia = require('./ia');
const whatsapp = require('./whatsapp');
const outlook = require('./outlook');
const agendaEmail = require('./agenda-email');
const webpush = require('web-push');
const { gerarToken, verificarToken, cifrar, decifrar } = require('./auth');
const { hashSenha, conferirSenha, nextId, gerarTokenConvite } = db;
const { moduloDaRota } = require('./rotas-modulo');
const tenant = require('./tenant');
const escopo = require('./escopo');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ---------- utilidades ----------

function enviarJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    const LIMITE = 25 * 1024 * 1024; // 25MB — dá folga para fotos em base64 anexadas nas etapas
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMITE) { reject(new Error('Corpo da requisição excede o limite permitido.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function usuarioAutenticado(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verificarToken(token);
}

function exigirPapel(user, papeis) {
  return user && papeis.includes(user.papel);
}

// menus de topo do sidebar (ver NAV no app.js) que cada tipo de acesso pode ter — quem cadastra o
// usuário escolhe, por pessoa, se libera todos ou só alguns (ver acesso_total/menus no cadastro).
// Quem tem acesso_total considera tudo liberado — só restringe de verdade quando acesso_total ===
// false, e aí só os menus marcados aqui aparecem pra essa pessoa.
const MENUS_POR_PAPEL = {
  suporte: ['agenda', 'minha-loja', 'solicitacoes-peca', 'transferencias', 'fila-atendimento', 'relatorio-manutencao', 'calendario-tecnico', 'biblioteca', 'fila-reparo', 'chat-interno'],
  administrador: ['agenda', 'painel-atendimentos', 'solicitacao-atendimento', 'aprovacoes-visitas', 'biblioteca', 'clientes', 'equipamentos', 'usuarios', 'chat-interno', 'solicitacoes-peca', 'catalogo-pecas', 'compras-estoque', 'transferencias'],
  cliente: ['biblioteca', 'equipamentos', 'chamados'],
  producao: ['biblioteca', 'clientes', 'equipamentos', 'chat-interno'],
  pos_venda: ['fila-pos-venda', 'chat-interno'],
  estoque: ['fila-estoque', 'chat-interno'],
  // versão Restaurantes/rede multiunidade — Fase 2/3/4 (Operação/Peças/Compras).
  gerente_loja: ['minha-loja', 'solicitacoes-peca', 'transferencias', 'equipamentos', 'chat-interno'],
  coordenador_tecnico: ['painel-setor', 'solicitacoes-peca', 'catalogo-pecas', 'compras-estoque', 'transferencias', 'equipamentos', 'chat-interno'],
  consultor_mercado: ['painel-setor', 'solicitacoes-peca', 'equipamentos', 'chat-interno'],
};
// todo tipo de acesso interno (todo mundo menos cliente) pode usar o chat interno — é comunicação
// entre a própria equipe, cliente não faz parte.
const PAPEIS_CHAT_INTERNO = ['suporte', 'administrador', 'producao', 'pos_venda', 'estoque', 'gerente_loja', 'coordenador_tecnico', 'consultor_mercado'];
// o token (JWT) só carrega id/papel/nome/cliente_id (ver gerarToken) — acesso_total/menus não vêm
// nele, então sempre busca o cadastro completo em `data.usuarios` pelo id antes de decidir. Único
// uso hoje é o submenu "Setor Reparo" do suporte (as outras rotas não são gated por menu, só por
// papel — o filtro dos demais menus acontece no sidebar do front, ver navDoUsuario em app.js).
// o token (JWT) só carrega id/papel/nome/cliente_id/empresa_id (ver gerarToken) — filial_id/
// setor_id (versão Restaurantes/rede multiunidade) não vêm nele, igual acesso_total/menus já não
// vinham. Mesmo padrão de temAcessoMenu abaixo: relê o cadastro completo antes de decidir escopo.
function usuarioCompleto(data, user) {
  return data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
}
function temAcessoMenu(data, user, chave) {
  if (!user) return false;
  const completo = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
  if (completo.papel !== 'suporte') return true;
  if (completo.acesso_total !== false) return true;
  return Array.isArray(completo.menus) && completo.menus.includes(chave);
}
function sanitizarMenusAcesso(papel, body) {
  const acesso_total = body.acesso_total !== false;
  const validos = MENUS_POR_PAPEL[papel] || [];
  const menus = Array.isArray(body.menus) ? body.menus.filter((m) => validos.includes(m)) : [];
  return { acesso_total, menus };
}

// cada líder de setor (Suporte, Pós-venda) tem seu próprio administrador, que só cadastra gente do
// próprio setor — assim o cadastro de usuários não fica todo dependendo de um administrador único.
// Clientes ficam visíveis pros administradores de Suporte e Pós-venda (as duas frentes que lidam
// direto com cliente) — não entram no escopo de um eventual administrador de outro setor. Produção
// usa um único login compartilhado (não precisa de administrador próprio) e Estoque não tem mais
// administrador dedicado (só o geral cuida), por isso nenhum dos dois entra nessa lista. Um
// administrador sem `departamento` (campo vazio) é o administrador geral: continua enxergando e
// cadastrando todo mundo, inclusive outros administradores — é sempre o caso da conta master
// (ADMIN_EMAIL).
const DEPARTAMENTOS_ADMIN = ['suporte', 'pos_venda'];
function papelGerenciavelPorAdmin(admin, papelAlvo) {
  if (!admin.departamento) return true;
  if (papelAlvo === admin.departamento) return true;
  if (papelAlvo === 'cliente') return admin.departamento === 'suporte' || admin.departamento === 'pos_venda';
  return false;
}

// pedido do usuário: "o perfil comercial é quando já é uma empresa grande e já é dividido em
// vários departamento comercial, financeiro, etc" — alinhado com o modelo de Greiner de estágios
// de crescimento organizacional (a departamentalização por função, ex. vendas/financeiro como
// setores PRÓPRIOS com gente dedicada, é característica do estágio em que o dono não dá mais
// conta de fazer tudo sozinho, não do estágio inicial/autônomo). Um perfil de login dedicado
// "comercial" ou "financeiro" (alguém cuja função é só aquilo, separado do administrador) só faz
// sentido a partir desse estágio — por isso exige o módulo "equipe_avancado" (o mesmo que já
// marca "a equipe cresceu" nos planos, ver db.js), e não o módulo "comercial"/"financeiro" em si
// (esses liberam a FERRAMENTA — orçamento, despesas — que o próprio dono usa sozinho desde o
// plano de entrada). Toda empresa que já tinha "os_chamados" ativo antes desta mudança (inclusive
// a PRO Marking) já ganhou "equipe_avancado" automaticamente na migração de divisão de módulos —
// então nenhum uso já existente desses perfis é afetado por esta checagem.
const PAPEIS_DEPARTAMENTALIZADOS = ['comercial', 'financeiro'];
function papelExigeDepartamentalizacao(data, empresaId, papel) {
  return PAPEIS_DEPARTAMENTALIZADOS.includes(papel) && !db.moduloAtivo(data, empresaId, 'equipe_avancado');
}

// versão Restaurantes/rede multiunidade (Fase 1 — Base, pedido do usuário): gerente_loja/
// coordenador_tecnico/consultor_mercado só fazem sentido numa empresa que já tem a hierarquia de
// setores/filiais (módulo "filiais") — mesmo padrão de papelExigeDepartamentalizacao acima.
function papelExigeEstruturaFiliais(data, empresaId, papel) {
  return escopo.PAPEIS_ESTRUTURA_FILIAIS.includes(papel) && !db.moduloAtivo(data, empresaId, 'filiais');
}

// resolve/valida filial_id (gerente_loja) ou setor_id (coordenador_tecnico/consultor_mercado) no
// cadastro/edição de usuário — gerente só pode gerenciar a própria loja, coordenador/consultor só
// o próprio setor, então o vínculo nasce aqui, não é escolha livre de qualquer id. Técnico
// (suporte) tem filial_id opcional (loja base, em destaque — ele continua vendo todas). Demais
// papéis (administrador, cliente, comercial/financeiro, etc.) não participam da estrutura.
function validarReferenciasEstruturaFiliais(data, empresaId, papel, body) {
  if (papel === 'gerente_loja') {
    if (!body.filial_id) return { erro: 'Informe a filial deste gerente.' };
    const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), empresaId);
    if (!filial) return { erro: 'Filial não encontrada.' };
    return { filial_id: filial.id, setor_id: null };
  }
  if (papel === 'coordenador_tecnico' || papel === 'consultor_mercado') {
    if (!body.setor_id) return { erro: 'Informe o setor deste usuário.' };
    const setor = tenant.buscar(data, 'setores', Number(body.setor_id), empresaId);
    if (!setor) return { erro: 'Setor não encontrado.' };
    return { filial_id: null, setor_id: setor.id };
  }
  if (papel === 'suporte' && body.filial_id) {
    const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), empresaId);
    if (!filial) return { erro: 'Filial não encontrada.' };
    return { filial_id: filial.id, setor_id: null };
  }
  return { filial_id: null, setor_id: null };
}

// bônus de viagem (R$200/diária) — nem toda O.S. dá direito (depende da região), então o
// administrador marca isso manualmente ao abrir/editar a O.S. e informa o dia em que o técnico
// precisa começar a se deslocar e o dia previsto de retorno; o bônus conta 1 diária por dia
// corrido entre esses dois, inclusive (ex.: sai e volta no mesmo dia = 1 diária; sai um dia
// antes = 2; sai um dia antes e só volta um dia depois do atendimento = 3). Acima de 7 diárias
// somadas no mês, o administrador tem que justificar antes de atribuir mais uma.
const LIMITE_VIAGENS_BONUS_MES = 7;
const VALOR_BONUS_VIAGEM = 200;

// diferença em dias corridos entre o início do deslocamento e a chegada de volta, inclusive as
// duas pontas — "AAAA-MM-DD" simples, sem hora (a hora do atendimento em si não importa aqui,
// só em que dia o técnico precisou estar na estrada).
function diasBonusViagem(diaInicio, diaFim) {
  if (!diaInicio || !diaFim) return 0;
  const ini = new Date(`${diaInicio}T00:00:00`);
  const fim = new Date(`${diaFim}T00:00:00`);
  if (isNaN(ini) || isNaN(fim) || fim < ini) return 0;
  return Math.round((fim - ini) / 86400000) + 1;
}

function contarDiariasBonusMes(data, empresaId, tecnicoId, dataIso, excluirId) {
  const mesAno = String(dataIso || '').slice(0, 7); // "AAAA-MM"
  return tenant.listar(data, 'agenda', empresaId)
    .filter((a) => a.id !== excluirId && a.tecnico_id === tecnicoId && a.bonus_viagem && String(a.data_hora_inicio || '').slice(0, 7) === mesAno)
    .reduce((soma, a) => soma + diasBonusViagem(a.viagem_dia_inicio, a.viagem_dia_fim_previsto), 0);
}

// rodízio justo de viagens: o "técnico da vez" é quem está há mais tempo sem uma O.S. com bônus
// de viagem (quem nunca viajou vem primeiro entre si). Só conta O.S. com bonus_viagem — uma O.S.
// sem viagem não muda a vez de ninguém.
function tecnicoDaVez(data, empresaId, excluirId) {
  const tecnicos = tenant.listar(data, 'usuarios', empresaId).filter((u) => u.papel === 'suporte' && u.status === 'ativo');
  if (!tecnicos.length) return null;
  const ultimaViagemPorTecnico = {};
  for (const a of tenant.listar(data, 'agenda', empresaId)) {
    if (a.id === excluirId || !a.bonus_viagem) continue;
    const atual = ultimaViagemPorTecnico[a.tecnico_id];
    if (!atual || (a.criado_em || '') > atual) ultimaViagemPorTecnico[a.tecnico_id] = a.criado_em || '';
  }
  const ordenados = [...tecnicos].sort((a, b) => {
    const da = ultimaViagemPorTecnico[a.id] || ''; // nunca viajou = string vazia, vem primeiro
    const db = ultimaViagemPorTecnico[b.id] || '';
    if (da !== db) return da.localeCompare(db);
    return a.nome.localeCompare(b.nome); // empate (ex.: os dois nunca viajaram) — desempata por nome, só pra ter uma ordem estável
  });
  return ordenados[0];
}

// o técnico "da vez" pode já ter outra O.S. marcada nos dias da nova viagem — olha o período
// inteiro de deslocamento de cada O.S. dele quando ela também tiver bônus de viagem (fica fora
// da base o dia inteiro), senão só o dia do próprio atendimento.
function conflitoDeAgendaTecnico(data, empresaId, tecnicoId, diaInicio, diaFim, excluirId) {
  const inicioTs = new Date(`${diaInicio}T00:00:00`).getTime();
  const fimTs = new Date(`${diaFim}T23:59:59`).getTime();
  if (isNaN(inicioTs) || isNaN(fimTs)) return null;
  const doTecnico = tenant.listar(data, 'agenda', empresaId).filter((a) => a.id !== excluirId && a.tecnico_id === tecnicoId && !a.finalizada);
  for (const a of doTecnico) {
    const oIni = a.bonus_viagem && a.viagem_dia_inicio ? a.viagem_dia_inicio : String(a.data_hora_inicio || '').slice(0, 10);
    const oFim = a.bonus_viagem && a.viagem_dia_fim_previsto ? a.viagem_dia_fim_previsto : String(a.data_hora_fim || a.data_hora_inicio || '').slice(0, 10);
    if (!oIni || !oFim) continue;
    const oIniTs = new Date(`${oIni}T00:00:00`).getTime();
    const oFimTs = new Date(`${oFim}T23:59:59`).getTime();
    if (isNaN(oIniTs) || isNaN(oFimTs)) continue;
    if (oIniTs <= fimTs && oFimTs >= inicioTs) {
      return { id: a.id, numero_os: a.numero_os || `OS-${String(a.id).padStart(6, '0')}`, inicio: oIni, fim: oFim };
    }
  }
  return null;
}

// o técnico escolhido pode estar de férias, DSR ou compensando banco de horas nos dias da O.S. —
// mesma lógica de período do conflitoDeAgendaTecnico acima (usa o intervalo de viagem quando a
// própria O.S. também tiver bônus de viagem, senão só o dia do atendimento). Devolve a marcação
// da escala de folga (ver /api/escala-folgas) se houver alguma nesse período, senão null.
// marcações que valem pra esse técnico num dia: as dele mesmo (usuario_id = ele) mais as
// coletivas (usuario_id = null, ver POST /api/escala-folgas com { coletiva: true }, ex.: DSR de
// fim de semana pra equipe inteira) — quando os dois existem no mesmo dia, a individual
// prevalece (é uma exceção deliberada à regra coletiva pra essa pessoa).
function escalasEfetivasTecnico(data, empresaId, tecnicoId) {
  const todas = tenant.listar(data, 'escala_folgas', empresaId);
  const individuais = todas.filter((e) => e.usuario_id === tecnicoId);
  const datasComExcecao = new Set(individuais.map((e) => e.data));
  const coletivas = todas.filter((e) => e.usuario_id === null && !datasComExcecao.has(e.data));
  return [...individuais, ...coletivas];
}

function conflitoEscalaTecnico(data, empresaId, tecnicoId, diaInicio, diaFim) {
  const inicioTs = new Date(`${diaInicio}T00:00:00`).getTime();
  const fimTs = new Date(`${diaFim}T23:59:59`).getTime();
  if (isNaN(inicioTs) || isNaN(fimTs)) return null;
  const escalas = escalasEfetivasTecnico(data, empresaId, tecnicoId);
  for (const e of escalas) {
    const ts = new Date(`${e.data}T12:00:00`).getTime();
    if (ts >= inicioTs && ts <= fimTs) return e;
  }
  return null;
}

const LABEL_ESCALA_FOLGA = { dsr: 'DSR (descanso semanal remunerado)', banco_horas: 'compensação de banco de horas' };

// checa a escala de folga do técnico escolhido nos dias da O.S. — férias bloqueia direto (sem
// opção de justificar); DSR e banco de horas exigem justificativa; home office não bloqueia nem
// pede nada, é só informativo. Devolve { bloqueado, motivo, tipo } — motivo != null quando algo
// precisa de resposta do administrador (bloqueio ou pedido de justificativa).
function checarEscalaAntesDeSalvar(data, empresaId, tecnicoId, diaInicioOS, diaFimOS) {
  const conflito = conflitoEscalaTecnico(data, empresaId, tecnicoId, diaInicioOS, diaFimOS);
  if (!conflito) return { bloqueado: false, motivo: null, tipo: null };
  if (conflito.tipo === 'ferias') {
    return { bloqueado: true, motivo: 'Este técnico está de férias nesse período — escolha outro técnico ou outra data.', tipo: 'ferias' };
  }
  if (conflito.tipo === 'dsr' || conflito.tipo === 'banco_horas') {
    const dataFmt = String(conflito.data || '').split('-').reverse().join('/');
    return { bloqueado: false, motivo: `Justifique pra continuar — este técnico está de ${LABEL_ESCALA_FOLGA[conflito.tipo]} em ${dataFmt}.`, tipo: conflito.tipo };
  }
  return { bloqueado: false, motivo: null, tipo: null }; // home_office — só informativo
}

// ---------- atividades não programadas (dia ocioso) ----------
// pedido do usuário: num dia sem O.S./atendimento marcado pro técnico e sem folga aprovada (ver
// escalasEfetivasTecnico), o sistema considera o dia "ocioso" e pede pro próprio técnico
// preencher o que fez — uma ou mais atividades, cada uma com início/fim — pra dar ao
// administrador um relatório diário de ocupação por técnico (identificar quem está com muito ou
// pouco serviço).

function diaTemAgendaTecnico(data, empresaId, tecnicoId, diaISO) {
  return tenant.listar(data, 'agenda', empresaId)
    .some((a) => a.tecnico_id === tecnicoId && String(a.data_hora_inicio || '').slice(0, 10) === diaISO);
}

function diaTemFolgaTecnico(data, empresaId, tecnicoId, diaISO) {
  return escalasEfetivasTecnico(data, empresaId, tecnicoId).some((e) => e.data === diaISO);
}

// status de um dia específico pro relatório: 'futuro' (ainda não chegou, nada a avaliar), 'os'
// (tinha atendimento/O.S. marcado), 'folga' (férias/DSR/banco de horas/home office aprovados),
// 'justificado' (técnico já preencheu atividade não programada) ou 'pendente' (dia ocioso, ainda
// esperando o técnico preencher).
function statusDiaTecnico(data, empresaId, tecnicoId, diaISO, hojeISO) {
  if (diaISO > hojeISO) return 'futuro';
  if (diaTemAgendaTecnico(data, empresaId, tecnicoId, diaISO)) return 'os';
  if (diaTemFolgaTecnico(data, empresaId, tecnicoId, diaISO)) return 'folga';
  const existente = tenant.listar(data, 'atividades_nao_programadas', empresaId)
    .find((a) => a.usuario_id === tecnicoId && a.data === diaISO);
  return existente ? 'justificado' : 'pendente';
}

function hojeBrasiliaISO() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// todos os dias de um mês (AAAA-MM) pra um técnico, já com status e (quando justificado) as
// atividades preenchidas — usado tanto na tela do próprio técnico quanto no drill-down do
// administrador pra um técnico específico.
function diasDoMesTecnico(data, empresaId, tecnicoId, mesISO) {
  const hojeISO = hojeBrasiliaISO();
  const [ano, mes] = mesISO.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const justificadas = tenant.listar(data, 'atividades_nao_programadas', empresaId).filter((a) => a.usuario_id === tecnicoId);
  const dias = [];
  for (let d = 1; d <= ultimoDia; d++) {
    const diaISO = `${mesISO}-${String(d).padStart(2, '0')}`;
    const status = statusDiaTecnico(data, empresaId, tecnicoId, diaISO, hojeISO);
    const registro = status === 'justificado' ? justificadas.find((a) => a.data === diaISO) : null;
    dias.push({ data: diaISO, status, atividades: registro ? registro.atividades : null });
  }
  return dias;
}

// mesma ideia de diasDoMesTecnico, mas pra um intervalo arbitrário de datas (ver KPI de Mão de
// Obra abaixo, cujo período vem dos mesmos filtros de data do resto do dashboard de KPIs, não só
// um mês fechado). Limitado a 400 dias por segurança (evita um filtro de período absurdo travar
// o servidor); nunca avalia além de hoje.
function diasNoIntervaloTecnico(data, empresaId, tecnicoId, inicioISO, fimISO) {
  const hojeISO = hojeBrasiliaISO();
  const fimEfetivo = fimISO > hojeISO ? hojeISO : fimISO;
  const inicioTs = Date.UTC(...inicioISO.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const fimTs = Date.UTC(...fimEfetivo.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const dias = [];
  if (!Number.isFinite(inicioTs) || !Number.isFinite(fimTs) || fimTs < inicioTs) return dias;
  // junto com o status, já traz a marcação de escala do dia (quando for 'folga') — o KPI de Mão de
  // Obra precisa saber se é banco_horas (pra abater do colchão, ver calcularMaoDeObra) ou outro
  // tipo (dsr/férias/home_office, que não mexem no saldo).
  const escalas = escalasEfetivasTecnico(data, empresaId, tecnicoId);
  for (let cursor = inicioTs, n = 0; cursor <= fimTs && n < 400; cursor += 24 * 60 * 60 * 1000, n++) {
    const d = new Date(cursor);
    const diaISO = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const status = statusDiaTecnico(data, empresaId, tecnicoId, diaISO, hojeISO);
    const escala = status === 'folga' ? escalas.find((e) => e.data === diaISO) : null;
    dias.push({ data: diaISO, status, escala });
  }
  return dias;
}

// pedido do usuário: cada atividade também tem um tipo (o que é, ex.: "manutenção", texto livre
// do técnico) e um status — pendente (ainda não começou), em andamento ou concluído — porque uma
// atividade não programada (ex.: consertar algo no próprio setor) pode continuar depois do dia em
// que o técnico está preenchendo. Por isso o horário também muda de exigência conforme o status:
// concluída pede início e fim; em andamento só pede início (ainda não tem fim); pendente não
// exige nenhum dos dois (pode nem ter começado).
const STATUS_ATIVIDADE_NAO_PROGRAMADA = ['pendente', 'em_andamento', 'concluido'];

// valida a lista de atividades do POST: tipo e descrição sempre obrigatórios; início/fim conforme
// o status (ver comentário acima); entre as que têm início E fim preenchidos, não podem se
// sobrepor (uma atividade por vez, como no dia real de trabalho). Devolve { erro } ou
// { atividades } já normalizadas, na mesma ordem em que o técnico informou.
function validarAtividadesNaoProgramadas(lista) {
  if (!Array.isArray(lista) || !lista.length) return { erro: 'Informe ao menos uma atividade.' };
  const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const normalizadas = [];
  for (const a of lista) {
    const tipo = String((a || {}).tipo || '').trim();
    const status = (a || {}).status;
    const inicio = String((a || {}).inicio || '') || null;
    const fim = String((a || {}).fim || '') || null;
    const descricao = String((a || {}).descricao || '').trim();
    if (!tipo) return { erro: 'Informe o tipo de cada atividade.' };
    if (!STATUS_ATIVIDADE_NAO_PROGRAMADA.includes(status)) return { erro: 'Informe o status (pendente, em andamento ou concluído) de cada atividade.' };
    if (!descricao) return { erro: 'Descreva o que foi feito em todas as atividades.' };
    if (inicio && !HORA_RE.test(inicio)) return { erro: 'Horário de início inválido em alguma atividade.' };
    if (fim && !HORA_RE.test(fim)) return { erro: 'Horário de fim inválido em alguma atividade.' };
    if (status === 'concluido' && (!inicio || !fim)) return { erro: 'Informe início e fim das atividades já concluídas.' };
    if (status === 'em_andamento' && !inicio) return { erro: 'Informe ao menos o horário de início das atividades em andamento.' };
    if (inicio && fim && inicio >= fim) return { erro: 'O horário de início precisa ser antes do horário de fim em todas as atividades.' };
    normalizadas.push({ tipo, status, inicio, fim, descricao });
  }
  const comHorario = normalizadas.filter((a) => a.inicio && a.fim).sort((a, b) => a.inicio.localeCompare(b.inicio));
  for (let i = 1; i < comHorario.length; i++) {
    if (comHorario[i].inicio < comHorario[i - 1].fim) return { erro: 'As atividades não podem ter horários sobrepostos.' };
  }
  return { atividades: normalizadas };
}

// reúne os dois motivos que exigem justificativa do administrador antes de salvar uma O.S. com
// bônus de viagem: (1) esse técnico já passou do limite de diárias no mês, (2) esse técnico não é
// quem está na vez do rodízio de viagens — a não ser que quem está na vez já tenha outra O.S.
// marcada nesse período (conflito), caso em que pular a vez dele já é justificativa suficiente,
// sem precisar de texto. Devolve { motivo: null, foraDeOrdem: false } se nenhum dos dois motivos
// se aplica. foraDeOrdem (motivo 2, sozinho) fica salvo na O.S. em fora_de_ordem_viagem, pro
// painel de acompanhamento contar quantas vezes cada técnico foi escolhido fora da vez.
function motivoExigeJustificativaViagem(data, empresaId, tecnicoId, dataHoraInicio, viagemDiaInicio, viagemDiaFimPrevisto, diasNovaViagem, excluirId) {
  const motivos = [];
  let foraDeOrdem = false;
  const limite = limiteViagensBonusMes(data.empresas.find((e) => e.id === empresaId));
  const jaTem = contarDiariasBonusMes(data, empresaId, tecnicoId, dataHoraInicio, excluirId);
  if (jaTem + diasNovaViagem > limite) {
    motivos.push(`este técnico já tem ${jaTem} diária(s) de bônus neste mês e essa viagem soma mais ${diasNovaViagem} (limite: ${limite})`);
  }
  const vez = tecnicoDaVez(data, empresaId, excluirId);
  if (vez && vez.id !== tecnicoId) {
    const conflitoDaVez = conflitoDeAgendaTecnico(data, empresaId, vez.id, viagemDiaInicio, viagemDiaFimPrevisto, excluirId);
    if (!conflitoDaVez) {
      motivos.push(`pelo rodízio de viagens quem está na vez é ${vez.nome}, não este técnico`);
      foraDeOrdem = true;
    }
  }
  return { motivo: motivos.length ? `Justifique pra continuar — ${motivos.join(' — ')}.` : null, foraDeOrdem };
}

// junta dados de exibição (nome do técnico/cliente/equipamento) numa agenda
function agendaComDetalhes(data, item) {
  const tecnico = data.usuarios.find((u) => u.id === item.tecnico_id && u.empresa_id === item.empresa_id);
  const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  const equipamento = data.equipamentos.find((e) => e.id === item.equipamento_id && e.empresa_id === item.empresa_id);
  const visita = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && (v.rodada || 1) === 1);
  const visitaRetorno = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && v.rodada === 2);
  const osCriada = item.os_criada_id ? tenant.buscar(data, 'agenda', item.os_criada_id, item.empresa_id) : null;
  return {
    ...item,
    visita_id: visita ? visita.id : null,
    visita_status: visita ? visita.status_aprovacao : null,
    visita_data_aprovacao: visita ? visita.data_aprovacao : null,
    visita_solicitacao_reabertura: visita ? visita.solicitacao_reabertura : null,
    visita_tem_pecas: !!(visita && visita.laudo && Array.isArray(visita.laudo.pecas) && visita.laudo.pecas.length > 0),
    visita_necessidade_retorno: !!(visita && visita.laudo && visita.laudo.necessidade_retorno),
    visita_retorno_id: visitaRetorno ? visitaRetorno.id : null,
    finalizada: item.finalizada || false,
    finalizado_em: item.finalizado_em || null,
    dias_bonus_viagem: item.bonus_viagem ? diasBonusViagem(item.viagem_dia_inicio, item.viagem_dia_fim_previsto) : 0,
    tecnico_nome: tecnico ? tecnico.nome : null,
    tecnico_setor: tecnico ? tecnico.setor : null,
    // Demonstração Técnica sem cliente/equipamento cadastrado (ver POST/PUT /api/agenda) cai
    // pro texto livre digitado na abertura da O.S.
    cliente_nome: cliente ? cliente.nome_empresa : (item.cliente_nome_manual || null),
    cliente_contato: cliente ? cliente.contato : null,
    cliente_telefone: cliente ? cliente.telefone : null,
    cliente_email: cliente ? cliente.email : null,
    cliente_setor: cliente ? cliente.setor : null,
    cliente_endereco: cliente ? cliente.endereco : null,
    cliente_numero: cliente ? cliente.numero : null,
    cliente_bairro: cliente ? cliente.bairro : null,
    cliente_cep: cliente ? cliente.cep : null,
    cliente_cidade: cliente ? cliente.cidade : null,
    cliente_estado: cliente ? cliente.estado : null,
    equipamento_tipo: equipamento ? equipamento.tipo : (item.equipamento_manual || null),
    equipamento_modelo: equipamento ? equipamento.modelo : null,
    equipamento_serie: equipamento ? equipamento.numero_serie : null,
    equipamento_data_fabricacao: equipamento ? equipamento.data_fabricacao : null,
    // tri-estado (true/false/null) — usado pela tela de encaminhamento pro pós-venda pra travar a
    // pergunta "plano_preventiva_ativo" do SLA quando o contrato já estiver definido (passo 11).
    equipamento_tem_contrato_manutencao: equipamento ? equipamento.tem_contrato_manutencao : null,
    // modelo do catálogo de origem (RCM/FMEA, passo 2) — a tela do Laudo Técnico usa pra buscar
    // só os componentes FMEA cadastrados pra este modelo específico, não de todos os modelos.
    equipamento_catalogo_id: equipamento ? equipamento.catalogo_id : null,
    os_criada_numero: osCriada ? (osCriada.numero_os || `OS-${String(osCriada.id).padStart(6, '0')}`) : null,
    // quem abriu a O.S. — normalmente o administrador, mas O.S. nascida de um atendimento do chat
    // assumido direto pelo técnico (ver POST /api/chamados/:id/assumir) tem o próprio técnico aqui.
    // null em O.S. antiga, de antes desse campo existir.
    criado_por_nome: item.criado_por ? ((data.usuarios.find((u) => u.id === item.criado_por && u.empresa_id === item.empresa_id) || {}).nome || null) : null,
    // versão Restaurantes/rede multiunidade (Fase 2 — Operação): nomes pra exibição direta nas
    // telas, sem o front precisar cruzar com o cache de filiais/áreas toda vez.
    ...(item.filial_id != null ? {
      filial_nome: (data.filiais.find((f) => f.id === item.filial_id && f.empresa_id === item.empresa_id) || {}).nome || null,
      area_nome: item.area_id ? ((data.areas.find((a) => a.id === item.area_id && a.empresa_id === item.empresa_id) || {}).nome || null) : null,
      // Fase 3 — Peças: solicitações ainda não instaladas pro equipamento desta O.S. (seção 9 —
      // "a tela da O.S. ... mostra automaticamente as solicitações existentes", evita duplicidade).
      solicitacoes_peca_abertas: item.equipamento_id ? data.solicitacoes_peca.filter((s) => (
        s.equipamento_id === item.equipamento_id && s.empresa_id === item.empresa_id && !['instalado', 'nao_aprovado'].includes(s.status)
      )).map((s) => ({ id: s.id, descricao: s.descricao, status: s.status, responsavel_atual: RESPONSAVEL_POR_STATUS[s.status] || null })) : [],
    } : {}),
  };
}

// fecha o chamado (chat) vinculado quando a O.S. de atendimento finaliza de vez — libera o
// cliente pra abrir um novo atendimento. Se o técnico encerrou direto no chat, isso acontece na
// hora; se passou pelo pós-venda, só quando o pós-venda/reparo realmente concluir (aprovado e
// reparado, ou reprovado pelo cliente) — enquanto isso o chamado continua "aberto" e bloqueando
// um novo chamado do cliente, mesmo com a conversa parada.
function chamadoEstaComPosVenda(data, chamado) {
  if (!chamado.os_id) return false;
  const os = tenant.buscar(data, 'agenda', chamado.os_id, chamado.empresa_id);
  return !!(os && os.tipo === 'atendimento' && os.fase_atendimento && os.fase_atendimento !== 'em_atendimento');
}

async function encerrarChamadoDaOS(data, agendaItem) {
  if (!agendaItem.origem_chamado_id) return;
  const chamado = data.chamados.find((c) => c.id === agendaItem.origem_chamado_id && c.empresa_id === agendaItem.empresa_id);
  if (!chamado || chamado.status === 'encerrado') return;
  const agora = new Date().toISOString();
  chamado.status = 'encerrado';
  chamado.resolvido_em = agora;
  chamado.atualizado_em = agora;
  await db.salvarMensagemChamado(chamado.id, { autor: 'sistema', texto: 'Atendimento encerrado.', criado_em: agora });
}

// "2026-09-20T14:00" -> "20/09 às 14:00", pro texto das notificações push
function fmtDataHoraCurta(isoDataHora) {
  if (!isoDataHora) return '';
  const [dataParte, horaParte] = String(isoDataHora).split('T');
  if (!dataParte) return '';
  const [ano, mes, dia] = dataParte.split('-');
  const hora = (horaParte || '').slice(0, 5);
  return hora ? `${dia}/${mes} às ${hora}` : `${dia}/${mes}`;
}

// ---------- notificação push (barra de notificação do celular) ----------

let vapidConfigurado = false;
function garantirVapidConfigurado(data) {
  if (vapidConfigurado) return;
  const emailContato = ((data.empresas.find((e) => e.id === 1) || {}).emails || [])[0] || 'contato@example.com';
  webpush.setVapidDetails(`mailto:${emailContato}`, data.vapid.publicKey, data.vapid.privateKey);
  vapidConfigurado = true;
}

// manda uma notificação push pra todas as inscrições (dispositivos) de um usuário. Silenciosa:
// nunca derruba a rota que chamou — só registra erro e, se a inscrição não existe mais no
// aparelho (410/404), remove ela do banco pra não tentar de novo à toa.
async function enviarPush(data, usuarioId, payload) {
  garantirVapidConfigurado(data);
  const inscricoes = data.push_subscriptions.filter((s) => s.usuario_id === usuarioId);
  if (!inscricoes.length) return;
  let mudou = false;
  await Promise.all(inscricoes.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        data.push_subscriptions = data.push_subscriptions.filter((s) => s.endpoint !== sub.endpoint);
        mudou = true;
      } else {
        console.error('[push] falha ao enviar:', e.message);
      }
    }
  }));
  if (mudou) db.save(data);
}

// data_hora_inicio/fim vêm de um <input type="datetime-local"> sem fuso (ex: "2026-09-21T21:37")
// — é sempre horário de Brasília, já que é o técnico/admin no Brasil quem escolhe. Sem isso,
// "new Date(string)" interpreta a string usando o fuso do PROCESSO Node, que no servidor
// (Render, container, etc.) normalmente é UTC — 3h à frente de Brasília — fazendo qualquer
// comparação de horário (tipo "já passou da hora?") disparar 3h adiantada.
function horarioBrasiliaParaData(dataHoraLocal) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(dataHoraLocal || ''));
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}:00-03:00`);
}

// pedido do usuário: depois de passar 24h sem o técnico registrar a ação (ex: esqueceu de "Iniciar
// retorno" numa O.S. antiga, ou nunca mais vai confirmar aquele passo), o lembrete recorrente
// precisa PARAR de mandar push — senão fica empilhando notificação pra sempre, a cada 5 minutos,
// ciclo após ciclo (ver screenshot: dezenas de "Iniciar retorno" acumuladas).
const LIMITE_LEMBRETE_RECORRENTE_MS = 24 * 60 * 60 * 1000;

// true quando já se passaram 24h desde que a etapa ficou pendente (referenciaIso é o timestamp
// real de quando aquele passo específico começou a esperar o técnico) — nesse caso o lembrete
// correspondente é pulado neste ciclo. Sem referência nenhuma (O.S. muito antiga, de antes desses
// campos existirem) usa o início agendado da O.S. como última instância, nunca deixando passar
// sem corte algum.
function lembreteExpirado(item, referenciaIso, agora) {
  const ref = referenciaIso ? new Date(referenciaIso) : horarioBrasiliaParaData(item.data_hora_inicio);
  return !!ref && (agora.getTime() - ref.getTime()) > LIMITE_LEMBRETE_RECORRENTE_MS;
}

// lembretes de deslocamento/chegada: cada etapa em que o técnico precisa tocar num botão (sair
// pro atendimento, chegar no cliente, sair/chegar no retorno pendente da mesma O.S., sair/chegar
// na viagem de volta pra empresa/hotel) manda um push A CADA CICLO enquanto o botão certo não é
// tocado — constante até o técnico executar, não só uma vez (um lembrete que passa despercebido
// não pode ficar esquecido pro resto do dia) — mas só até completar 24h sem resposta (ver
// lembreteExpirado): passado isso, considera que o técnico não vai mais registrar aquele passo e
// para de notificar, evitando o acúmulo infinito. Não é um cron de verdade — só funciona enquanto
// o processo do servidor estiver de pé; num plano que "dorme" por inatividade isso pode não disparar.
async function verificarLembretesRecorrentes() {
  try {
    const data = db.load();
    const agora = new Date();
    // "hoje" também precisa ser o dia em Brasília, não em UTC — perto da meia-noite os dois
    // calendários divergem (ex: 22h de Brasília já é o dia seguinte em UTC)
    const hojeISO = new Date(agora.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const item of data.agenda) {
      if (item.finalizada) continue;

      // 1) sair pro atendimento — só depois do horário marcado, só visita presencial (categoria
      // 'online' — treinamento online e o "atendimento" nascido de assumir um chamado do chat —
      // não tem deslocamento nenhum), e só quando o cliente já confirmou (antes disso o botão
      // "Iniciar deslocamento" nem aparece pro técnico apertar, ver botaoDeslocamento no front)
      if (item.categoria === 'inloco' && !item.retorno_pendente_tecnico && item.status !== 'concluida'
          && item.confirmado_cliente_em && !item.deslocamento_iniciado_em
          && item.data_hora_inicio && item.data_hora_inicio.startsWith(hojeISO)) {
        const horario = horarioBrasiliaParaData(item.data_hora_inicio);
        if (horario && agora >= horario) {
          const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
          await enviarPush(data, item.tecnico_id, {
            titulo: 'Atendimento hoje',
            corpo: `Não esqueça: ${cliente ? cliente.nome_empresa : 'seu atendimento'} hoje (${fmtDataHoraCurta(item.data_hora_inicio)}). Toque pra marcar "Iniciar deslocamento".`,
            url: '/',
          });
        }
      }
      // 2) chegou no cliente?
      if (item.deslocamento_iniciado_em && !item.chegada_confirmada_em
          && !lembreteExpirado(item, item.deslocamento_iniciado_em, agora)) {
        await enviarPush(data, item.tecnico_id, {
          titulo: 'Chegou no cliente?',
          corpo: 'Toque em "Registrar chegada" assim que chegar, pra liberar o atendimento.',
          url: '/',
        });
      }
      // 3) retorno pendente da mesma O.S. — sair de novo
      if (item.retorno_pendente_tecnico && item.retorno_confirmado_cliente_em && !item.retorno_deslocamento_iniciado_em
          && !lembreteExpirado(item, item.retorno_confirmado_cliente_em, agora)) {
        await enviarPush(data, item.tecnico_id, {
          titulo: 'Retorno pendente',
          corpo: 'Toque em "Iniciar deslocamento" assim que sair pro retorno.',
          url: '/',
        });
      }
      // 4) retorno — chegou de novo?
      if (item.retorno_deslocamento_iniciado_em && !item.retorno_chegada_confirmada_em
          && !lembreteExpirado(item, item.retorno_deslocamento_iniciado_em, agora)) {
        await enviarPush(data, item.tecnico_id, {
          titulo: 'Chegou no cliente (retorno)?',
          corpo: 'Toque em "Registrar chegada" assim que chegar.',
          url: '/',
        });
      }
      // 5) viagem de volta pra empresa/hotel — só depois do relatório enviado (status "concluida")
      if (item.categoria === 'inloco' && item.status === 'concluida' && !item.viagem_volta_chegada_em) {
        if (!item.viagem_volta_iniciada_em) {
          if (!lembreteExpirado(item, item.concluida_em, agora)) {
            await enviarPush(data, item.tecnico_id, {
              titulo: 'Iniciar retorno',
              corpo: 'Toque em "Iniciar retorno" assim que sair do cliente.',
              url: '/',
            });
          }
        } else if (!item.viagem_volta_destino_agenda_id) {
          // seguiu direto pra outra O.S. (viagem_volta_destino_agenda_id) — não tem chegada de
          // volta pra cobrar aqui, o "retorno" dela termina quando a próxima O.S. começa a dela
          if (!lembreteExpirado(item, item.viagem_volta_iniciada_em, agora)) {
            await enviarPush(data, item.tecnico_id, {
              titulo: 'Chegou de volta?',
              corpo: 'Toque em "Registrar chegada" da viagem de volta assim que chegar.',
              url: '/',
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[lembrete] erro ao verificar pendências:', e.message);
  }
}

// ---------- relatório técnico de atendimento corretivo ----------

const CHECKLIST_CORRETIVA = [
  'Instalação mecânica', 'Instalação elétrica', 'Instalação software', 'Sistema de segurança',
  'Tryout', 'Utilização de nobreak', 'Aterramento da máquina', 'Tomada dedicada', 'Lente',
  'I/O da máquina', 'Sistema de refrigeração', 'Acompanhamento da linha',
  'Treinamento operacional', 'Treinamento configuração', 'Treinamento manutenção', 'Entrega de documentação',
];

// tipos de OS que usam o Laudo Técnico (diagnóstico + serviço realizado + peças + fotos, sem assinatura)
const TIPOS_LAUDO_TECNICO = ['corretiva', 'preventiva', 'atendimento'];
// tipos que usam o termo de aceite com checklist/assinatura — hoje só treinamento presencial,
// enquanto o modelo de referência específico dele não chega
const TIPOS_TERMO_ACEITE = ['treinamento_presencial'];

// treinamento online e atendimento (nascido do chat) são os únicos tipos sem deslocamento até
// o cliente — os demais (corretiva, preventiva, treinamento presencial, demonstração técnica)
// exigem o técnico se deslocar. categoria 'online' desliga as etapas de deslocamento/chegada na
// linha do tempo e nas ações do técnico (ver timelineOS/botaoDeslocamento/acoesOSCalendarioTecnico
// em app.js).
function categoriaDoTipo(tipo) { return (tipo === 'treinamento_online' || tipo === 'atendimento') ? 'online' : 'inloco'; }

// garantia de fábrica: 1 ano a partir da data de fabricação (MM/AAAA) — mesma regra do front
// (dentroDaGarantiaDeFabrica em public/app.js) e da IA (ia.js), usada aqui pra preencher sozinha
// a pergunta de garantia_fabricacao do SLA quando o admin preenche a O.S. manualmente
function dentroDaGarantiaDeFabrica(dataFabricacao) {
  const m = /^(\d{2})\/(\d{4})$/.exec(String(dataFabricacao || '').trim());
  if (!m) return null;
  const limite = new Date(Number(m[2]), Number(m[1]) - 1, 1);
  limite.setFullYear(limite.getFullYear() + 1);
  return new Date() <= limite;
}

// contrato de manutenção preventiva (RCM/SAP PM, passo 11): pode ser definido em 3 lugares —
// Atrelar/Editar equipamento (admin, sempre sobrescreve, ver rotas de equipamentos), abertura da
// O.S. (campo dedicado em POST/PUT /api/agenda) e a pergunta "plano_preventiva_ativo" do
// questionário de SLA (slaDoBody abaixo). Essa função é o ponto único de "quem preenche primeiro
// trava": só grava se o equipamento ainda não tiver essa informação (null) — depois disso, só o
// Atrelar/Editar equipamento consegue mudar.
function aplicarContratoDoValor(equipamento, valor) {
  if (equipamento && equipamento.tem_contrato_manutencao === null && (valor === true || valor === false)) {
    equipamento.tem_contrato_manutencao = valor;
  }
}

// calcula o SLA a partir das respostas enviadas na abertura/edição manual da O.S. (mesma
// pontuação usada pela IA no chat) — retorna null se o admin não preencheu o questionário
function slaDoBody(body, equipamento) {
  if (!body.sla_respostas || typeof body.sla_respostas !== 'object') return null;
  const respostas = { ...body.sla_respostas };
  if (respostas.garantia_fabricacao === undefined) {
    respostas.garantia_fabricacao = equipamento ? (dentroDaGarantiaDeFabrica(equipamento.data_fabricacao) || false) : false;
  }
  // a pergunta "o cliente tem plano de manutenção preventiva ativo?" é o mesmo dado do contrato
  // de manutenção do equipamento (ver aplicarContratoDoValor) — alimenta a trava quando ainda não
  // tiver sido respondida em nenhum dos outros 2 lugares.
  if (equipamento && typeof respostas.plano_preventiva_ativo === 'boolean') {
    aplicarContratoDoValor(equipamento, respostas.plano_preventiva_ativo);
  }
  const sla = ia.calcularSla(respostas);
  return {
    sla_nivel: sla.nivel,
    sla_pontuacao: sla.pontuacao,
    sla_horas_atendimento: sla.horas_atendimento,
    sla_dias_manutencao: sla.dias_manutencao,
    sla_dias_visita_tecnica: sla.dias_visita_tecnica,
  };
}

// dados do atendimento definidos pelo administrador na abertura da OS — o técnico só visualiza,
// nunca são aceitos a partir do que o técnico envia (mesmo que ele tente via chamada direta à API)
function dadosAtendimentoBloqueados(data, agendaItem, user) {
  const cliente = data.clientes.find((c) => c.id === agendaItem.cliente_id && c.empresa_id === agendaItem.empresa_id);
  const equipamento = data.equipamentos.find((e) => e.id === agendaItem.equipamento_id && e.empresa_id === agendaItem.empresa_id);
  // o token de sessão só carrega id/papel/nome/cliente_id — o e-mail vem do cadastro completo
  const usuarioCompleto = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  return {
    empresa: cliente ? cliente.nome_empresa : '',
    contato: agendaItem.contato || (cliente ? cliente.contato : ''),
    telefone: agendaItem.telefone || (cliente ? cliente.telefone : ''),
    email: agendaItem.email || (cliente ? cliente.email : ''),
    setor_cliente: agendaItem.setor_cliente || (cliente ? cliente.setor : ''),
    endereco: agendaItem.endereco || (cliente ? cliente.endereco : ''),
    numero: agendaItem.numero || (cliente ? cliente.numero : ''),
    bairro: agendaItem.bairro || (cliente ? cliente.bairro : ''),
    cep: agendaItem.cep || (cliente ? cliente.cep : ''),
    cidade: agendaItem.cidade || (cliente ? cliente.cidade : ''),
    estado: agendaItem.estado || (cliente ? cliente.estado : ''),
    data_inicial: (agendaItem.data_hora_inicio || '').slice(0, 10),
    data_final: (agendaItem.data_hora_fim || '').slice(0, 10),
    equipamento_tipo: equipamento ? equipamento.tipo : '',
    modelo_maquina: equipamento ? equipamento.modelo : '',
    numero_serie: equipamento ? equipamento.numero_serie : '',
    data_fabricacao: equipamento ? equipamento.data_fabricacao : '',
    garantia: agendaItem.garantia || '',
    garantia_obs: agendaItem.garantia_obs || '',
    defeito_informado: agendaItem.problema || '',
    servico: agendaItem.problema || '',
    tecnico_nome: user.nome,
    tecnico_email: usuarioCompleto ? usuarioCompleto.email : '',
  };
}

function validarRelatorio(r) {
  if (!r || typeof r !== 'object') return 'Relatório técnico é obrigatório para este tipo de atendimento.';
  const camposTexto = ['empresa', 'contato', 'telefone', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado',
    'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie', 'servico', 'tecnico_nome', 'observacoes'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando no relatório: ${c}`;
  }
  if (!Array.isArray(r.checklist) || r.checklist.length !== CHECKLIST_CORRETIVA.length) {
    return 'Checklist do relatório incompleto.';
  }
  for (const item of r.checklist) {
    if (!item || !['sim', 'nao', 'na'].includes(item.resposta)) return 'Todo item do checklist precisa de uma resposta (Sim/Não/N-A).';
  }
  if (r.aceite !== 'aceito' && r.aceite !== 'nao_aceito') return 'É preciso registrar o aceite do cliente.';
  if (!r.avaliacao || !(r.avaliacao.estrelas >= 1 && r.avaliacao.estrelas <= 5)) return 'Avaliação de desempenho (estrelas) é obrigatória.';
  if (r.avaliacao.duvidas_sanadas !== 'sim' && r.avaliacao.duvidas_sanadas !== 'nao') return 'Responda se as dúvidas foram sanadas.';
  if (r.avaliacao.apto_operar !== 'sim' && r.avaliacao.apto_operar !== 'nao') return 'Responda se o cliente se julga apto a operar o equipamento.';
  if (!r.assinatura_cliente_nome || !r.assinatura_cliente_img) return 'Assinatura do cliente é obrigatória.';
  if (!r.assinatura_tecnico_nome || !r.assinatura_tecnico_img) return 'Assinatura do técnico é obrigatória.';
  if (!Array.isArray(r.emails_copia) || r.emails_copia.length === 0) return 'Informe ao menos um e-mail para envio do termo.';
  return null;
}

// ---------- Termo de Manutenção Preventiva (Relatório > Manual > Preventiva) ----------
// relatório avulso de manutenção interna (não vinculado a nenhuma O.S.), mesma família do
// "Relatório Manual" (relatorios_manutencao), com seu próprio checklist e fluxo de assinatura.
// O equipamento atendido pode ser variado (não só laser), então o checklist não tem uma lista
// fixa de itens nem um tamanho fixo — o front já vem com um modelo pronto (equipamento a laser),
// mas o técnico pode adicionar, renomear ou remover itens; aqui só valida que cada item tenha
// nome e resposta.
function validarRelatorioPreventiva(r) {
  if (!r || typeof r !== 'object') return 'Dados do termo são obrigatórios.';
  const camposTexto = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico_realizado', 'empresa', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'setor_maquina',
    'observacoes_checklist', 'servico_feito', 'observacoes_servico'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!Array.isArray(r.checklist) || !r.checklist.length) {
    return 'Adicione ao menos um item no check-list.';
  }
  for (const item of r.checklist) {
    if (!item || !String(item.item || '').trim()) return 'Todo item do check-list precisa de um nome.';
    if (!item || !['sim', 'nao', 'na'].includes(item.resposta)) return 'Todo item do check-list precisa de uma resposta (Sim/Não/N/A).';
  }
  // o conjunto de fotos varia por modelo de máquina (ver EQUIPAMENTOS_PREVENTIVA no front) —
  // em todo modelo o último grupo ("Fotos adicionais") é opcional, os anteriores são obrigatórios
  const fotos = Array.isArray(r.fotos) ? r.fotos : [];
  if (!fotos.length) return 'Selecione o modelo da máquina pra liberar os grupos de fotos.';
  for (let idx = 0; idx < fotos.length - 1; idx++) {
    const bloco = fotos[idx];
    if (!bloco || !Array.isArray(bloco.fotos) || !bloco.fotos.length) return 'Anexe as fotos obrigatórias do termo.';
  }
  if (!(r.satisfacao_estrelas >= 1 && r.satisfacao_estrelas <= 5)) return 'Avaliação de satisfação (estrelas) é obrigatória.';
  if (r.satisfacao_autoriza !== 'sim' && r.satisfacao_autoriza !== 'nao') return 'Responda se autoriza o uso do feedback.';
  if (!r.assinatura_cliente_nome || !r.assinatura_cliente_img) return 'Assinatura do cliente é obrigatória.';
  if (!r.assinatura_tecnico_nome || !r.assinatura_tecnico_img) return 'Assinatura do técnico é obrigatória.';
  if (!Array.isArray(r.emails_copia) || r.emails_copia.length === 0) return 'Informe ao menos um e-mail para envio do termo.';
  return null;
}

// ---------- Termo de Manutenção Corretiva (Relatório > Manual > Corretiva) ----------
// mesma família do "Relatório Manual" (relatorios_manutencao) e mesma infraestrutura da
// Preventiva (identificação, fotos por modelo de máquina — reaproveita EQUIPAMENTOS_PREVENTIVA
// do front, pesquisa de satisfação, assinatura, envio por e-mail), mas sem check-list — no lugar
// tem defeito informado / ações executadas / observações em texto livre.
function validarRelatorioCorretiva(r) {
  if (!r || typeof r !== 'object') return 'Dados do termo são obrigatórios.';
  const camposTexto = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico_realizado', 'empresa', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'setor_maquina',
    'defeito_informado', 'acoes_executadas', 'observacoes'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  const fotos = Array.isArray(r.fotos) ? r.fotos : [];
  if (!fotos.length) return 'Selecione o modelo da máquina pra liberar os grupos de fotos.';
  for (let idx = 0; idx < fotos.length - 1; idx++) {
    const bloco = fotos[idx];
    if (!bloco || !Array.isArray(bloco.fotos) || !bloco.fotos.length) return 'Anexe as fotos obrigatórias do termo.';
  }
  if (!(r.satisfacao_estrelas >= 1 && r.satisfacao_estrelas <= 5)) return 'Avaliação de satisfação (estrelas) é obrigatória.';
  if (r.satisfacao_autoriza !== 'sim' && r.satisfacao_autoriza !== 'nao') return 'Responda se autoriza o uso do feedback.';
  if (!r.assinatura_cliente_nome || !r.assinatura_cliente_img) return 'Assinatura do cliente é obrigatória.';
  if (!r.assinatura_tecnico_nome || !r.assinatura_tecnico_img) return 'Assinatura do técnico é obrigatória.';
  if (!Array.isArray(r.emails_copia) || r.emails_copia.length === 0) return 'Informe ao menos um e-mail para envio do termo.';
  return null;
}

// ---------- Relatório Técnico (Relatório > Manual > Relatório Técnico) ----------
// mesma família do "Relatório Manual" (relatorios_manutencao) — igual ao "Completo", mas com o
// tipo de serviço podendo marcar mais de uma opção, o equipamento escolhido de uma lista (mesma
// EQUIPAMENTOS_PREVENTIVA do front) em vez de texto livre, período de reparo calculado
// automaticamente e um relatório fotográfico único (sem grupos), sem pesquisa de satisfação,
// assinatura ou envio por e-mail.
function validarRelatorioTecnico(r) {
  if (!r || typeof r !== 'object') return 'Dados do relatório são obrigatórios.';
  const camposTexto = ['empresa', 'contato', 'telefone', 'marca', 'equipamento', 'numero_serie',
    'defeito_informado', 'laudo_tecnico', 'servico_realizado'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!Array.isArray(r.tipo_servico) || r.tipo_servico.length === 0) return 'Selecione ao menos um tipo de serviço.';
  if (r.garantia !== 'sim' && r.garantia !== 'nao' && r.garantia !== 'outros') return 'Responda se o equipamento está na garantia.';
  if (r.garantia === 'outros' && !String(r.garantia_obs || '').trim()) return 'Especifique a garantia.';
  if (!Array.isArray(r.fotos) || !r.fotos.length) return 'Anexe ao menos uma foto no relatório fotográfico.';
  return null;
}

// ---------- Termo de Aceite da Entrega (Relatório > Manual > Termo de Aceite) ----------
// mesma família do "Relatório Manual", avulso — reaproveita o check-list (CHECKLIST_CORRETIVA),
// o aceite, a avaliação de desempenho e a assinatura do "Relatório técnico" ligado à O.S., mas
// como termo independente: identificação com O.S. e modelo de máquina escolhido de uma lista
// (mesma EQUIPAMENTOS_PREVENTIVA), sem fotos ou peças.
function validarRelatorioAceite(r) {
  if (!r || typeof r !== 'object') return 'Dados do termo são obrigatórios.';
  const camposTexto = ['os_uf', 'os_numero', 'os_ano', 'data_inicial', 'data_final', 'modelo_maquina', 'numero_serie',
    'servico', 'empresa', 'setor', 'endereco', 'numero', 'bairro', 'estado', 'cidade', 'cep', 'contato', 'observacoes'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!Array.isArray(r.checklist) || !r.checklist.length) return 'Adicione ao menos um item no check-list.';
  for (const item of r.checklist) {
    if (!item || !String(item.item || '').trim()) return 'Todo item do check-list precisa de um nome.';
    if (!item || !['sim', 'nao', 'na'].includes(item.resposta)) return 'Todo item do check-list precisa de uma resposta (Sim/Não/N/A).';
  }
  if (r.aceite !== 'aceito' && r.aceite !== 'nao_aceito') return 'É preciso registrar o aceite do cliente.';
  if (!(r.satisfacao_estrelas >= 1 && r.satisfacao_estrelas <= 5)) return 'Avaliação de desempenho (estrelas) é obrigatória.';
  if (r.satisfacao_duvidas !== 'sim' && r.satisfacao_duvidas !== 'nao') return 'Responda se as dúvidas foram sanadas.';
  if (r.satisfacao_apto !== 'sim' && r.satisfacao_apto !== 'nao') return 'Responda se o cliente se julga apto a operar o equipamento.';
  if (!r.assinatura_cliente_nome || !r.assinatura_cliente_img) return 'Assinatura do cliente é obrigatória.';
  if (!r.assinatura_tecnico_nome || !r.assinatura_tecnico_img) return 'Assinatura do técnico é obrigatória.';
  if (!Array.isArray(r.emails_copia) || r.emails_copia.length === 0) return 'Informe ao menos um e-mail para envio do termo.';
  return null;
}

// ---------- Briefing Pré-Visita "Promotor" (Relatório > Manual > Promotor) ----------
// preenchido pelo vendedor (administrador) ANTES da visita de demonstração técnica, pra dar
// contexto pro promotor (técnico) que vai fazer a demo — espelha o modelo em Excel que o time
// comercial já usa hoje (Briefing Pré-Visita | Vendedor -> Promotor), campo por campo. Pode ficar
// vinculado a uma O.S. de "Demonstração Técnica" (agenda_id) ou avulso, se a O.S. ainda nem existe.
function validarRelatorioPromotor(r) {
  if (!r || typeof r !== 'object') return 'Dados do briefing são obrigatórios.';
  const camposTexto = ['empresa', 'data_visita', 'promotor',
    'motivo_visita', 'processo_atual', 'necessidade_informada',
    'o_que_demonstrar', 'ponto_importante_demo',
    'duvidas_preocupacoes', 'concorrente', 'o_que_observar',
    'objetivo_visita', 'ponto_principal_observar'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  return null;
}

// ---------- Relatório Devolutivo (Relatório > Manual > Devolutivo) ----------
// preenchido pelo promotor (técnico) DEPOIS da visita, pra devolver ao líder de vendas o
// resultado da demonstração — principalmente quando a visita revela uma necessidade a mais do
// cliente (ex.: automação, retrofit) que pode virar uma venda de equipamento personalizado, com
// valor agregado, além do que já foi demonstrado.
function validarRelatorioDevolutivo(r) {
  if (!r || typeof r !== 'object') return 'Dados do relatório devolutivo são obrigatórios.';
  const camposTexto = ['empresa', 'data_visita', 'promotor', 'equipamento_demonstrado', 'feedback_cliente'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!['aprovado', 'aprovado_parcial', 'reprovado', 'em_analise'].includes(r.resultado_demonstracao)) {
    return 'Marque o resultado da demonstração.';
  }
  if (r.identificou_oportunidade_adicional !== true && r.identificou_oportunidade_adicional !== false) {
    return 'Responda se foi identificada uma necessidade adicional do cliente.';
  }
  if (r.identificou_oportunidade_adicional) {
    if (!Array.isArray(r.tipo_oportunidade) || !r.tipo_oportunidade.length) {
      return 'Selecione ao menos um tipo de oportunidade (automação, retrofit...).';
    }
    if (!String(r.descricao_oportunidade || '').trim()) return 'Descreva a necessidade adicional identificada.';
    if (!String(r.valor_agregado || '').trim()) return 'Descreva como isso pode virar uma venda de maior valor.';
  }
  return null;
}

// ---------- Levantamento Técnico (Relatório > Manual > Levantamento Técnico) ----------
// preenchido pelo técnico numa segunda visita, de engenharia, quando o Devolutivo já sinalizou
// uma oportunidade adicional (automação/retrofit) — entra no detalhe técnico que quem for orçar o
// projeto personalizado precisa: processo atual, infraestrutura existente, espaço disponível,
// escopo proposto. Pode ficar vinculado ao Devolutivo que originou a oportunidade
// (devolutivo_id) e/ou à O.S. (agenda_id), ou avulso.
function validarRelatorioLevantamentoTecnico(r) {
  if (!r || typeof r !== 'object') return 'Dados do levantamento são obrigatórios.';
  const camposTexto = ['empresa', 'data_levantamento', 'responsavel_tecnico',
    'tempo_ciclo_atual', 'volume_producao', 'material_peca',
    'automacao_existente', 'integracao_necessaria', 'espaco_disponivel',
    'escopo_proposto', 'proximos_passos'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!['viavel', 'viavel_com_ressalvas', 'inviavel', 'precisa_mais_dados'].includes(r.viabilidade_tecnica)) {
    return 'Marque a viabilidade técnica.';
  }
  return null;
}

// ---------- Entrega para Teste (Relatório > Manual > Entrega para Teste) ----------
// preenchido pelo técnico quando o cliente fica com o equipamento por um período (ex.: uma
// semana) pra testar antes de decidir a compra — comprovante simples de empréstimo, com a
// assinatura do cliente confirmando o recebimento e o prazo combinado de devolução.
function validarRelatorioEntregaTeste(r) {
  if (!r || typeof r !== 'object') return 'Dados do relatório são obrigatórios.';
  const camposTexto = ['empresa', 'contato', 'email', 'equipamento', 'data_entrega', 'data_prevista_devolucao'];
  for (const c of camposTexto) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email).trim())) return 'E-mail do cliente inválido.';
  if (!r.assinatura_cliente_nome || !String(r.assinatura_cliente_nome).trim()) return 'Informe o nome de quem está assinando pelo cliente.';
  if (!r.assinatura_cliente_img) return 'Colete a assinatura do cliente.';
  return null;
}

// formulário leve: treinamento online (pede nº de série) e demonstração técnica (não pede)
function validarRelatorioSimples(r, exigirSerie) {
  if (!r || typeof r !== 'object') return 'Dados do atendimento são obrigatórios.';
  const obrig = ['empresa', 'contato', 'telefone', 'equipamento_tipo', 'equipamento_modelo'];
  if (exigirSerie) obrig.push('numero_serie');
  for (const c of obrig) {
    if (!r[c] || !String(r[c]).trim()) return `Campo obrigatório faltando: ${c}`;
  }
  if (!r.observacoes || !String(r.observacoes).trim()) return 'Observações são obrigatórias.';
  return null;
}

// laudo técnico: usado em corretiva e preventiva (diagnóstico + serviço + peças + fotos, sem assinatura)
function validarLaudoTecnico(l) {
  if (!l || typeof l !== 'object') return 'Laudo técnico é obrigatório para este tipo de atendimento.';
  // garantia é preenchida pelo administrador na abertura da OS; se ele não preencheu, o técnico
  // não pode ficar bloqueado por isso — só validamos o valor quando ele existe.
  if (l.garantia && !['sim', 'nao', 'na'].includes(l.garantia)) return 'Valor de garantia inválido.';
  if (l.garantia === 'na' && !String(l.garantia_obs || '').trim()) return 'Especifique o motivo do "N/A" na garantia.';
  if (!l.data_conclusao) return 'Informe a data de conclusão.';
  if (!String(l.laudo_tecnico || '').trim()) return 'O laudo técnico (o que foi analisado e encontrado) é obrigatório.';
  if (!String(l.servico_realizado || '').trim()) return 'Descreva o serviço realizado.';
  if (!Array.isArray(l.fotos) || l.fotos.length === 0) return 'Anexe ao menos uma foto no relatório fotográfico.';
  return null;
}

// resolve e valida a cascata Componente→Modo de falha→Causa→Efeito escolhida no Laudo Técnico
// (RCM/FMEA Fase 1, passo 3) — 100% opcional: o técnico pode deixar os 4 em branco e preencher só
// o laudo em texto livre, exatamente como sempre funcionou (nada aqui bloqueia o fluxo de hoje).
// Quando algum nível vem preenchido, exige que os de cima também estejam (não dá pra pular
// Componente e já escolher Causa), que cada um pertença à empresa e ao pai certo, e que o
// Componente seja de fato de um modelo do catálogo deste equipamento (ver catalogo_id, passo 2).
// Devolve id E nome já resolvidos pra cada nível (denormalizado, mesmo padrão de agendaComDetalhes),
// assim a tela de detalhe e o PDF não precisam buscar o catálogo FMEA de novo pra exibir.
function resolverCascataFmea(data, empresaId, equipamentoCatalogoId, entrada) {
  const vazio = { componente_id: null, componente_nome: '', modo_falha_id: null, modo_falha_nome: '', causa_id: null, causa_nome: '', efeito_id: null, efeito_nome: '' };
  if (!entrada || (!entrada.componente_id && !entrada.modo_falha_id && !entrada.causa_id && !entrada.efeito_id)) {
    return { resultado: vazio };
  }
  let componente = null, modoFalha = null, causa = null, efeito = null;
  if (entrada.componente_id) {
    if (equipamentoCatalogoId == null) {
      return { erro: 'Este equipamento não está vinculado a um modelo do catálogo — associe o modelo em Equipamentos antes de classificar a falha.' };
    }
    componente = tenant.buscar(data, 'fmea_componentes', Number(entrada.componente_id), empresaId);
    if (!componente || componente.catalogo_id !== equipamentoCatalogoId) {
      return { erro: 'Componente FMEA não encontrado para o modelo deste equipamento.' };
    }
  }
  if (entrada.modo_falha_id) {
    if (!componente) return { erro: 'Escolha o componente antes do modo de falha.' };
    modoFalha = tenant.buscar(data, 'fmea_modos_falha', Number(entrada.modo_falha_id), empresaId);
    if (!modoFalha || modoFalha.componente_id !== componente.id) return { erro: 'Modo de falha não encontrado para este componente.' };
  }
  if (entrada.causa_id) {
    if (!modoFalha) return { erro: 'Escolha o modo de falha antes da causa.' };
    causa = tenant.buscar(data, 'fmea_causas', Number(entrada.causa_id), empresaId);
    if (!causa || causa.modo_falha_id !== modoFalha.id) return { erro: 'Causa não encontrada para este modo de falha.' };
  }
  if (entrada.efeito_id) {
    if (!causa) return { erro: 'Escolha a causa antes do efeito.' };
    efeito = tenant.buscar(data, 'fmea_efeitos', Number(entrada.efeito_id), empresaId);
    if (!efeito || efeito.causa_id !== causa.id) return { erro: 'Efeito não encontrado para esta causa.' };
  }
  return {
    resultado: {
      componente_id: componente ? componente.id : null, componente_nome: componente ? componente.nome : '',
      modo_falha_id: modoFalha ? modoFalha.id : null, modo_falha_nome: modoFalha ? modoFalha.nome : '',
      causa_id: causa ? causa.id : null, causa_nome: causa ? causa.nome : '',
      efeito_id: efeito ? efeito.id : null, efeito_nome: efeito ? efeito.nome : '',
    },
  };
}

function usuarioPublico(u) {
  const { salt, hash, convite_token, ...resto } = u;
  return resto;
}

// resumo da empresa exposto no login/GET /api/me — pra tela e PDF saberem, sem consulta à parte,
// de qual empresa é a sessão atual (super_admin não tem empresa, vem null).
async function empresaResumo(empresa) {
  if (!empresa) return null;
  const { id, nome, site, whatsapp, telefone, emails, cor_primaria, cor_secundaria, subdominio, logo_url, valor_bonus_viagem, limite_viagens_bonus_mes, perfil } = empresa;
  return {
    id, nome, site, whatsapp, telefone, emails, cor_primaria, cor_secundaria, subdominio,
    logo_url: await hidratarFotosProfundo(logo_url),
    valor_bonus_viagem: valorBonusViagem(empresa), limite_viagens_bonus_mes: limiteViagensBonusMes(empresa),
    // pedido do usuário: menu "Guia de Diagnóstico Rápido" só aparece pra empresa do perfil
    // "refrigeracao" (ver NAV/navDoUsuario em app.js) — precisa vir no login/GET /api/me,
    // não só no GET /api/empresa, senão montarSidebar() (chamada logo após o login, ver
    // entrarNoApp) roda antes do perfil real chegar e o menu não aparece no primeiro acesso.
    perfil: perfil || null,
  };
}

// valor do bônus de viagem (R$/diária) e limite de diárias/mês antes de exigir justificativa —
// Etapa 5/passo 4: configurável por empresa a partir de agora, com o valor fixo de sempre (200 e
// 7) como padrão pra quem não configurou nada (toda empresa já nasce com isso — ver
// sincronizarEmpresaPadrao em db.js — então essas constantes só entram em jogo se o registro da
// empresa, por algum motivo, não tiver o campo).
function valorBonusViagem(empresa) { return (empresa && empresa.valor_bonus_viagem) ?? VALOR_BONUS_VIAGEM; }
function limiteViagensBonusMes(empresa) { return (empresa && empresa.limite_viagens_bonus_mes) ?? LIMITE_VIAGENS_BONUS_MES; }

// Perfil/Segmento (Etapa 8): tipos_os_ativos/tipos_relatorio_ativos vazios ou ausentes = "todos" —
// nunca ler o campo bruto direto, sempre por aqui, pra garantir que nenhuma empresa (nova ou já
// migrada) perca opção que já tinha por um registro incompleto.
function tiposOsAtivos(empresa) {
  return (empresa && Array.isArray(empresa.tipos_os_ativos) && empresa.tipos_os_ativos.length) ? empresa.tipos_os_ativos : db.TIPOS_OS_DISPONIVEIS;
}
function tiposRelatorioAtivos(empresa) {
  return (empresa && Array.isArray(empresa.tipos_relatorio_ativos) && empresa.tipos_relatorio_ativos.length) ? empresa.tipos_relatorio_ativos : db.TIPOS_RELATORIO_DISPONIVEIS;
}
function escalaAtiva(empresa) { return !empresa || empresa.escala_ativa !== false; }

// extrai o 1º rótulo do host (ex.: "promarking" de "promarking.proconecta.app:3000") pra servir de
// candidato a subdomínio. Exige pelo menos 3 partes (sub.domínio.tld) — domínio "nu", localhost e IP
// nunca contam, pra nunca confundir a instalação raiz com um subdomínio de empresa.
function subdominioDoHost(host) {
  if (!host) return null;
  const semPorta = String(host).split(':')[0];
  const partes = semPorta.split('.');
  if (partes.length < 3) return null;
  if (/^\d+$/.test(partes[0])) return null;
  return partes[0].toLowerCase();
}

// identifica a empresa da requisição pelo subdomínio (ver CONFLITO #1 do diagnóstico: duas empresas
// podem ter usuário com o mesmo e-mail, então login/dados de marca precisam saber a empresa ANTES
// de olhar pro usuário). Sem subdomínio configurado nessa empresa ou host sem subdomínio → cai na
// empresa 1 (a instalação de origem), que é o comportamento de hoje — nada muda pra quem não
// configurou subdomínio nenhum.
function resolverEmpresaPorRequisicao(data, req) {
  const sub = subdominioDoHost(req.headers.host);
  if (sub) {
    const porSubdominio = data.empresas.find((e) => e.subdominio === sub);
    if (porSubdominio) return porSubdominio;
  }
  return data.empresas.find((e) => e.id === 1) || null;
}

// valida e normaliza o subdomínio digitado no painel do super admin (só letras minúsculas, números
// e hífen — o mesmo formato aceito num rótulo de host de verdade). Vazio/undefined = empresa sem
// subdomínio próprio (cai na empresa 1 — ver resolverEmpresaPorRequisicao).
const SUBDOMINIO_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function normalizarSubdominio(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  return String(valor).trim().toLowerCase();
}

function registroComAutor(data, r) {
  const autor = data.usuarios.find((u) => u.id === r.autor_id && u.empresa_id === r.empresa_id);
  return { ...r, autor_nome: autor ? autor.nome : null };
}

// ---------- fotos guardadas à parte (ver db.js) ----------
// extrairFotosProfundo percorre qualquer objeto/array e troca toda string grande (foto em
// base64, assinatura em base64 etc.) por uma referência pequena `{__foto_ref}`, guardando a foto
// de verdade na tabela separada — é isso que impede o bloco principal de crescer sem parar na
// memória. hidratarFotosProfundo faz o caminho inverso, só quando alguém realmente precisa ver a
// foto (nunca mexe no objeto original, sempre devolve uma cópia nova).
// só extrai string que realmente é uma imagem (sempre vem como "data:image/...;base64,..." —
// é assim que toda captura de foto/assinatura desse sistema gera o valor no navegador) — assim
// nunca corre o risco de confundir um texto comprido (laudo técnico, causa, solução) com foto.
// Tipo restrito aos formatos que o próprio sistema gera (jpeg/png, vindos da câmera/canvas de
// assinatura, já comprimidos no navegador antes do envio — ver comprimirImagemDataUrl) e tamanho
// limitado por arquivo: sem isso, qualquer "data:" URI passava, de qualquer tamanho (até o limite
// geral de 25MB da requisição inteira) — porta aberta pra abuso de armazenamento.
const TIPO_FOTO_REGEX = /^data:image\/(jpeg|jpg|png|webp);base64,/;
const TAMANHO_MAX_FOTO_BYTES = 8 * 1024 * 1024; // 8MB — bem acima do que a compressão no navegador produz
async function extrairFotosProfundo(valor, empresaId) {
  if (typeof valor === 'string') {
    // qualquer "data:" URI comprida é tratada como tentativa de anexar um arquivo (é assim que
    // toda foto/assinatura desse sistema chega) — rejeita explicitamente se não for uma imagem
    // dos tipos aceitos, ou se passar do limite de tamanho, em vez de deixar passar como texto
    // comum (isso faria exatamente o que essa função existe pra evitar: inchar o bloco principal).
    if (!valor.startsWith('data:') || valor.length < 100) return valor;
    if (!TIPO_FOTO_REGEX.test(valor)) {
      const erro = new Error('Tipo de arquivo não aceito — só imagens (JPEG, PNG ou WEBP).');
      erro.publico = true;
      throw erro;
    }
    const base64 = valor.slice(valor.indexOf(',') + 1);
    if (Buffer.byteLength(base64, 'base64') > TAMANHO_MAX_FOTO_BYTES) {
      const erro = new Error('Uma das fotos enviadas passa do limite de 8MB.');
      erro.publico = true;
      throw erro;
    }
    const id = await db.salvarFoto(valor, empresaId);
    return { __foto_ref: id };
  }
  if (Array.isArray(valor)) return Promise.all(valor.map((v) => extrairFotosProfundo(v, empresaId)));
  if (valor && typeof valor === 'object') {
    const entradas = await Promise.all(Object.entries(valor).map(async ([k, v]) => [k, await extrairFotosProfundo(v, empresaId)]));
    return Object.fromEntries(entradas);
  }
  return valor;
}

// variante de extrairFotosProfundo (acima) sem a restrição a imagem — pro laudo de qualidade do
// ar do PMOC (ver os_refrigeracao_pmoc_qualidade_ar), que é tipicamente um PDF. Mesma indireção
// de armazenamento (db.salvarFoto/__foto_ref), só sem o TIPO_FOTO_REGEX; hidratarFotosProfundo já
// lida com qualquer `__foto_ref` genérico, então não precisa de hidratação própria.
async function extrairAnexoGenerico(valor, empresaId) {
  if (typeof valor !== 'string' || !valor.startsWith('data:') || valor.length < 100) return valor;
  const base64 = valor.slice(valor.indexOf(',') + 1);
  if (Buffer.byteLength(base64, 'base64') > TAMANHO_MAX_FOTO_BYTES) {
    const erro = new Error('O arquivo passa do limite de 8MB.');
    erro.publico = true;
    throw erro;
  }
  const id = await db.salvarFoto(valor, empresaId);
  return { __foto_ref: id };
}

async function hidratarFotosProfundo(valor) {
  if (valor && typeof valor === 'object' && !Array.isArray(valor) && typeof valor.__foto_ref === 'string' && Object.keys(valor).length === 1) {
    return (await db.carregarFoto(valor.__foto_ref)) || null;
  }
  if (Array.isArray(valor)) return Promise.all(valor.map((v) => hidratarFotosProfundo(v)));
  if (valor && typeof valor === 'object') {
    const entradas = await Promise.all(Object.entries(valor).map(async ([k, v]) => [k, await hidratarFotosProfundo(v)]));
    return Object.fromEntries(entradas);
  }
  return valor;
}

// ---------- limite de tentativas de login (sem isso, um script tentava milhares de senhas por
// minuto contra /api/login) — contador em memória por IP, não é persistido nem é à prova de um
// atacante trocando de IP a cada tentativa, mas barra o caso comum (um script batendo sempre do
// mesmo lugar). Reseta sozinho: cada IP esquece a janela antiga assim que ela expira.
const JANELA_LOGIN_MS = 15 * 60 * 1000; // 15 minutos
const LIMITE_TENTATIVAS_LOGIN = 10;
const tentativasLogin = new Map(); // ip -> { contagem, desde }

function ipDaRequisicao(req) {
  const encaminhado = req.headers['x-forwarded-for'];
  if (encaminhado) return String(encaminhado).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}
function loginBloqueado(ip) {
  const registro = tentativasLogin.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > JANELA_LOGIN_MS) { tentativasLogin.delete(ip); return false; }
  return registro.contagem >= LIMITE_TENTATIVAS_LOGIN;
}
function registrarTentativaLoginFalha(ip) {
  const registro = tentativasLogin.get(ip);
  if (!registro || Date.now() - registro.desde > JANELA_LOGIN_MS) {
    tentativasLogin.set(ip, { contagem: 1, desde: Date.now() });
  } else {
    registro.contagem++;
  }
}
// varredura periódica só pra não deixar o Map crescer pra sempre com IPs que nunca mais voltam
// (sem isso, cada IP que tenta uma vez só e nunca mais aparece fica ocupando memória de graça)
setInterval(() => {
  const agora = Date.now();
  for (const [ip, registro] of tentativasLogin) {
    if (agora - registro.desde > JANELA_LOGIN_MS) tentativasLogin.delete(ip);
  }
}, 30 * 60 * 1000);

// ---------- rotas da API ----------

const rotas = [];
function rota(metodo, regex, handler) {
  rotas.push({ metodo, regex, handler, modulo: moduloDaRota(regex) });
}

// POST /api/login
rota('POST', /^\/api\/login$/, async (req, res) => {
  const ip = ipDaRequisicao(req);
  if (loginBloqueado(ip)) {
    return enviarJSON(res, 429, { erro: 'Muitas tentativas de login. Tente de novo em alguns minutos.' });
  }
  const { email: emailLogin, senha } = await lerCorpo(req);
  const data = db.load();
  // só restringe o login por empresa quando o host da requisição bate com um subdomínio
  // configurado de verdade — sem isso, mantém o comportamento de sempre (busca o e-mail em
  // qualquer empresa), pra não quebrar instalação nenhuma que ainda não configurou subdomínio.
  // super_admin nunca é restrito (não pertence a empresa nenhuma — empresa_id null).
  const subHost = subdominioDoHost(req.headers.host);
  const empresaPorSubdominio = subHost ? data.empresas.find((e) => e.subdominio === subHost) : null;
  const u = data.usuarios.find((x) => x.email === emailLogin
    && (!empresaPorSubdominio || x.papel === 'super_admin' || x.empresa_id === empresaPorSubdominio.id));
  if (!u || u.status !== 'ativo' || !conferirSenha(senha || '', u.salt, u.hash)) {
    registrarTentativaLoginFalha(ip);
    return enviarJSON(res, 401, { erro: 'E-mail ou senha inválidos.' });
  }
  tentativasLogin.delete(ip);
  const empresaDoUsuario = data.empresas.find((e) => e.id === u.empresa_id);
  // empresa suspensa (Etapa 7/passo 1): bloqueia login de qualquer usuário dela, exceto
  // super_admin (não pertence a empresa nenhuma — empresaDoUsuario fica undefined pra ele).
  if (empresaDoUsuario && empresaDoUsuario.status === 'suspensa') {
    return enviarJSON(res, 403, { erro: 'Esta empresa está suspensa. Fale com o suporte.', codigo: 'empresa_suspensa' });
  }
  if (empresaDoUsuario && verificarExpiracaoTeste(empresaDoUsuario, data)) {
    return enviarJSON(res, 403, { erro: 'Seu período de teste acabou — fale com o suporte pra continuar.', codigo: 'teste_expirado' });
  }
  // pedido do usuário: portal do cliente final do pacote PMOC (Fase 4) — paralelo ao `cliente_id`
  // núcleo (que aponta pra `clientes`), um usuário papel "cliente" pode em vez disso apontar pra
  // um registro de `os_refrigeracao_clientes` (perfil Refrigeração), pelas rotas /api/pmoc/portal/*
  // abaixo — precisa estar no token (igual cliente_id) pra usuarioAutenticado(req) devolver sem
  // precisar recarregar o usuário do banco a cada rota.
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id, os_refrigeracao_cliente_id: u.os_refrigeracao_cliente_id, empresa_id: u.empresa_id });
  enviarJSON(res, 200, { token, usuario: {
    ...usuarioPublico(u),
    empresa: await empresaResumo(empresaDoUsuario),
    modulos_ativos: (empresaDoUsuario && empresaDoUsuario.modulos_ativos) || [],
    terminologia: (empresaDoUsuario && empresaDoUsuario.terminologia) || {},
    tipos_os_ativos: tiposOsAtivos(empresaDoUsuario),
    tipos_relatorio_ativos: tiposRelatorioAtivos(empresaDoUsuario),
    escala_ativa: escalaAtiva(empresaDoUsuario),
  } });
});

// POST /api/cadastro — SaaS, passo 1: cadastro/trial self-service. Cria a empresa (sempre nasce
// status 'teste', criado_em agora) e o primeiro administrador numa chamada só, pra quem ainda não
// é cliente decidir sozinho experimentar o sistema, sem depender do Super Admin. Mesmo corpo de
// POST /api/plataforma/empresas, só que público e sem escolher versão/subdomínio/cores.
// pedido do usuário: "nosso sistema deve ser do mais simples ao completo... o gerador de
// orçamento é a base" — quem ainda nem é cliente começa no plano de entrada da cascata (menor
// "ordem", hoje "Autônomo": comercial+relatório, sem exigir O.S.), não direto em "Manutenção"
// (que já pressupõe O.S. completo). Dá pra trocar de plano depois (ver PUT /api/meu-plano).
rota('POST', /^\/api\/cadastro$/, async (req, res) => {
  const body = await lerCorpo(req);
  if (!body.nome_empresa || !String(body.nome_empresa).trim()) return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Seu nome é obrigatório.' });
  if (!body.email || !String(body.email).trim()) return enviarJSON(res, 400, { erro: 'E-mail é obrigatório.' });
  if (!body.senha || String(body.senha).length < 6) return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  const data = db.load();
  const email = String(body.email).trim();
  if (data.usuarios.some((u) => u.email === email)) return enviarJSON(res, 409, { erro: 'Já existe uma conta com este e-mail.' });
  const versao = [...data.versoes].sort((a, b) => (a.ordem || 0) - (b.ordem || 0))[0] || data.versoes[0] || null;
  const empresa = {
    id: nextId(data, 'empresas'),
    nome: String(body.nome_empresa).trim(),
    subdominio: null,
    site: '', whatsapp: '', telefone: '', emails: [],
    cor_primaria: '#0B2D4F', cor_secundaria: '#0891B2',
    versao_id: versao ? versao.id : null,
    modulos_ativos: versao ? [...versao.modulos] : [],
    terminologia: {},
    perfil: null, segmento: null,
    tipos_os_ativos: null, tipos_relatorio_ativos: null, escala_ativa: true,
    limite_tecnicos: versao && versao.limite_tecnicos != null ? versao.limite_tecnicos : null,
    limite_equipamentos: versao && versao.limite_equipamentos != null ? versao.limite_equipamentos : null,
    status: 'teste',
    criado_em: new Date().toISOString(),
    plano_valor_mensal: null,
    plano_dia_vencimento: null,
  };
  data.empresas.push(empresa);
  const { salt, hash } = hashSenha(body.senha);
  const admin = tenant.criar(data, 'usuarios', empresa.id, {
    nome: String(body.nome).trim(), email, papel: 'administrador',
    cargo: '', setor: '', celular: '', cliente_id: null,
    acesso_total: true, menus: [], departamento: null,
    status: 'ativo', convite_token: null, salt, hash,
  });
  db.save(data);
  const token = gerarToken({ id: admin.id, papel: admin.papel, nome: admin.nome, cliente_id: admin.cliente_id, os_refrigeracao_cliente_id: admin.os_refrigeracao_cliente_id, empresa_id: admin.empresa_id });
  enviarJSON(res, 201, { token, usuario: {
    ...usuarioPublico(admin),
    empresa: await empresaResumo(empresa),
    modulos_ativos: empresa.modulos_ativos,
    terminologia: empresa.terminologia,
    tipos_os_ativos: tiposOsAtivos(empresa),
    tipos_relatorio_ativos: tiposRelatorioAtivos(empresa),
    escala_ativa: escalaAtiva(empresa),
  } });
});

// dados de marca da empresa (nome, contato, cores, logo) — pública porque a tela de login também
// usa, antes de qualquer autenticação. Resolvida pelo subdomínio da requisição (ver
// resolverEmpresaPorRequisicao) — cai na empresa 1 se nenhum subdomínio bater.
rota('GET', /^\/api\/empresa$/, async (req, res) => {
  const data = db.load();
  const empresa = resolverEmpresaPorRequisicao(data, req);
  if (!empresa) return enviarJSON(res, 200, { empresa: null });
  enviarJSON(res, 200, { empresa: { ...empresa, logo_url: await hidratarFotosProfundo(empresa.logo_url) } });
});

// PUT /api/empresa — o próprio administrador edita a marca da sua empresa (nome, contato, cores,
// logo) e os valores padrão de bônus de viagem. Separado da rota do Super Admin
// (/api/plataforma/empresas/:id), que edita qualquer empresa — aqui só a própria, e sem tocar em
// versão/módulos/subdomínio/terminologia (isso continua só no painel da plataforma).
rota('PUT', /^\/api\/empresa$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita os dados da própria empresa.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === user.empresa_id);
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  Object.assign(empresa, {
    nome: String(body.nome).trim(),
    site: body.site || '', whatsapp: body.whatsapp || '', telefone: body.telefone || '',
    emails: Array.isArray(body.emails) ? body.emails : [],
    cor_primaria: body.cor_primaria || empresa.cor_primaria, cor_secundaria: body.cor_secundaria || empresa.cor_secundaria,
  });
  // logo: omitido no corpo = mantém a atual; null/"" = volta pra padrão; qualquer outra coisa já
  // chegou aqui transformada em {__foto_ref} por extrairFotosProfundo (ver acima).
  if (body.logo_url !== undefined) empresa.logo_url = body.logo_url || null;
  if (body.valor_bonus_viagem !== undefined) {
    const valor = Number(body.valor_bonus_viagem);
    if (!Number.isFinite(valor) || valor < 0) return enviarJSON(res, 400, { erro: 'Valor do bônus de viagem inválido.' });
    empresa.valor_bonus_viagem = valor;
  }
  if (body.limite_viagens_bonus_mes !== undefined) {
    const limite = Number(body.limite_viagens_bonus_mes);
    if (!Number.isInteger(limite) || limite < 0) return enviarJSON(res, 400, { erro: 'Limite de diárias por mês inválido.' });
    empresa.limite_viagens_bonus_mes = limite;
  }
  // versão Restaurantes/rede multiunidade (Fase 2 — Operação): prazo de SLA (em horas) por
  // criticidade — "baixo" não tem prazo fixo de propósito (ver SLA_PRAZOS_HORAS_PADRAO), então só
  // valida critico/alto/medio quando vierem no corpo.
  if (body.sla_prazos_horas !== undefined) {
    const prazos = body.sla_prazos_horas || {};
    const novoPrazos = {};
    for (const chave of ['critico', 'alto', 'medio']) {
      const valor = Number(prazos[chave]);
      if (!Number.isFinite(valor) || valor <= 0) return enviarJSON(res, 400, { erro: `Prazo de SLA "${chave}" inválido.` });
      novoPrazos[chave] = valor;
    }
    empresa.sla_prazos_horas = novoPrazos;
  }
  // versão Restaurantes/rede multiunidade (Fase 3 — Peças): valores-limite da cadeia de
  // autorização (seção 9 do pedido do usuário) — até o limite 1, gerente/coordenador aprova e
  // compra; acima dele, precisa do consultor; acima do limite 2, o consultor é OBRIGADO a
  // encaminhar à diretoria.
  if (body.limite_aprovacao_1 !== undefined || body.limite_aprovacao_2 !== undefined) {
    const l1 = body.limite_aprovacao_1 !== undefined ? Number(body.limite_aprovacao_1) : (empresa.limite_aprovacao_1 != null ? empresa.limite_aprovacao_1 : LIMITES_APROVACAO_PADRAO.limite1);
    const l2 = body.limite_aprovacao_2 !== undefined ? Number(body.limite_aprovacao_2) : (empresa.limite_aprovacao_2 != null ? empresa.limite_aprovacao_2 : LIMITES_APROVACAO_PADRAO.limite2);
    if (!Number.isFinite(l1) || l1 < 0) return enviarJSON(res, 400, { erro: 'Limite de aprovação 1 inválido.' });
    if (!Number.isFinite(l2) || l2 < l1) return enviarJSON(res, 400, { erro: 'Limite de aprovação 2 inválido (tem que ser maior ou igual ao limite 1).' });
    empresa.limite_aprovacao_1 = l1;
    empresa.limite_aprovacao_2 = l2;
  }
  db.save(data);
  enviarJSON(res, 200, { empresa: { ...empresa, logo_url: await hidratarFotosProfundo(empresa.logo_url) } });
});

// GET /api/meu-plano/versoes — SaaS, passo 3: catálogo de versões com preço, pra tela "Meu plano"
// dentro de "Minha Empresa". Diferente de GET /api/plataforma/versoes (exclusivo do Super Admin) —
// esta é a própria empresa vendo o que tem disponível pra trocar, sem acesso de plataforma.
// Namespace separado de /api/empresa de propósito: esse prefixo é público (ver PREFIXOS_PUBLICOS
// em rotas-modulo.js, usado por GET /api/empresa pra dados de marca antes do login) — se essas
// rotas nascessem sob /api/empresa, herdariam "publico" por prefixo e escapariam da checagem
// central de empresa suspensa/trial expirado (ver dispatcher, mais abaixo), o que anularia o
// próprio passo 2 bem na rota que troca de plano.
rota('GET', /^\/api\/meu-plano\/versoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê o plano da própria empresa.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === user.empresa_id);
  enviarJSON(res, 200, { versoes: data.versoes, versao_id_atual: empresa ? empresa.versao_id : null });
});

// PUT /api/meu-plano { versao_id } — SaaS, passo 3: a própria empresa troca de plano, aplicando
// módulos/cotas da versão escolhida na hora. Diferente de PUT /api/plataforma/empresas/:id
// (exclusivo do Super Admin, edita qualquer empresa) — aqui só a própria, e sem gateway de
// pagamento nenhum envolvido (terreno pronto, cobrar de verdade é uma etapa futura separada).
rota('PUT', /^\/api\/meu-plano$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador troca o plano da própria empresa.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === user.empresa_id);
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  const versao = data.versoes.find((v) => v.id === Number(body.versao_id));
  if (!versao) return enviarJSON(res, 400, { erro: 'Versão não encontrada.' });
  empresa.versao_id = versao.id;
  empresa.modulos_ativos = [...versao.modulos];
  empresa.limite_tecnicos = versao.limite_tecnicos != null ? versao.limite_tecnicos : null;
  empresa.limite_equipamentos = versao.limite_equipamentos != null ? versao.limite_equipamentos : null;
  db.save(data);
  enviarJSON(res, 200, { empresa: { ...empresa, logo_url: await hidratarFotosProfundo(empresa.logo_url) } });
});

// GET /api/me
rota('GET', /^\/api\/me$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const empresaDoUsuario = data.empresas.find((e) => e.id === user.empresa_id);
  // o token (ver gerarToken no login) só carrega id/papel/nome/cliente_id/empresa_id — busca o
  // registro completo pra devolver e-mail/cargo/setor/etc. também, igual ao login já devolve
  // (sem isso, um F5 na página perdia esses campos até a próxima vez que o usuário logasse de
  // novo). Pedido do usuário: "coloque opção de o próprio usuário alterar seu email e senha" —
  // a tela de perfil precisa saber o e-mail atual mesmo depois de recarregar a página.
  const registro = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  enviarJSON(res, 200, { usuario: {
    ...(registro ? usuarioPublico(registro) : user),
    empresa: await empresaResumo(empresaDoUsuario),
    modulos_ativos: (empresaDoUsuario && empresaDoUsuario.modulos_ativos) || [],
    terminologia: (empresaDoUsuario && empresaDoUsuario.terminologia) || {},
    tipos_os_ativos: tiposOsAtivos(empresaDoUsuario),
    tipos_relatorio_ativos: tiposRelatorioAtivos(empresaDoUsuario),
    escala_ativa: escalaAtiva(empresaDoUsuario),
  } });
});

// PUT /api/me — o próprio usuário logado troca o e-mail e/ou a senha da própria conta (pedido do
// usuário: "coloque opção de o próprio usuário alterar seu email e senha"). Pede a senha atual pra
// confirmar antes de qualquer mudança — diferente do reset de senha que o super admin faz em PUT
// /api/plataforma/administradores/:id (esse não pede senha atual porque é uma ação de suporte
// feita por outra pessoa; aqui é a própria pessoa trocando os próprios dados de acesso).
rota('PUT', /^\/api\/me$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  const novoEmail = body.email !== undefined && body.email !== null ? String(body.email).trim() : null;
  const novaSenha = body.senha_nova !== undefined && body.senha_nova !== null ? String(body.senha_nova) : null;
  if (!novoEmail && !novaSenha) return enviarJSON(res, 400, { erro: 'Informe um novo e-mail ou uma nova senha.' });
  if (!body.senha_atual) return enviarJSON(res, 400, { erro: 'Informe sua senha atual pra confirmar a alteração.' });

  const data = db.load();
  const registro = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (!conferirSenha(String(body.senha_atual), registro.salt, registro.hash)) {
    return enviarJSON(res, 401, { erro: 'Senha atual incorreta.' });
  }

  if (novoEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novoEmail)) return enviarJSON(res, 400, { erro: 'E-mail inválido.' });
    if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.id !== registro.id && u.email === novoEmail)) {
      return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
    }
    registro.email = novoEmail;
  }
  if (novaSenha) {
    if (novaSenha.length < 6) return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    const { salt, hash } = hashSenha(novaSenha);
    registro.salt = salt; registro.hash = hash;
  }
  db.save(data);
  enviarJSON(res, 200, { usuario: usuarioPublico(registro) });
});

// ---------- convite de primeiro acesso ----------

// GET /api/convite/:token — pública: a tela de ativação usa isso para mostrar nome/e-mail
rota('GET', /^\/api\/convite\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const u = data.usuarios.find((x) => x.convite_token === m[1] && x.status === 'convite_enviado');
  if (!u) return enviarJSON(res, 404, { erro: 'Convite inválido ou já utilizado.' });
  enviarJSON(res, 200, { nome: u.nome, email: u.email });
});

// POST /api/convite/:token/ativar { senha } — pública: define a senha e ativa a conta
rota('POST', /^\/api\/convite\/([a-f0-9]+)\/ativar$/, async (req, res, m) => {
  const body = await lerCorpo(req);
  if (!body.senha || body.senha.length < 6) {
    return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  const data = db.load();
  const u = data.usuarios.find((x) => x.convite_token === m[1] && x.status === 'convite_enviado');
  if (!u) return enviarJSON(res, 404, { erro: 'Convite inválido ou já utilizado.' });
  const { salt, hash } = hashSenha(body.senha);
  u.salt = salt; u.hash = hash;
  u.status = 'ativo';
  u.convite_token = null;
  db.save(data);
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id, os_refrigeracao_cliente_id: u.os_refrigeracao_cliente_id, empresa_id: u.empresa_id });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(u) });
});

// ---------- link público do relatório "Entrega para Teste" ----------
// o técnico às vezes não está mais presencialmente com o cliente pra colher a assinatura na hora
// — em vez de exigir login do cliente (que nem tem conta no sistema), o relatório carrega um
// token de acesso próprio (token_publico, gerado na criação, mesmo padrão do convite) que abre
// um link direto pro formulário, sem senha. Tanto o técnico (autenticado, rotas de
// /api/relatorios-manutencao normais) quanto o cliente (aqui, via token) podem salvar o que já
// preencheram a qualquer momento — cada lado continua de onde o outro parou, no mesmo registro.
function buscarEntregaTestePorToken(data, token) {
  return data.relatorios_manutencao.find((r) => r.tipo === 'entrega_teste' && r.token_publico === token) || null;
}
// só os campos que o formulário público precisa — nunca autor_id/tecnico_email/empresa_id etc.
// hidrata a assinatura (guardada à parte, ver extrairFotosProfundo) de volta pro base64 de
// verdade, senão o cliente só vê a referência `{__foto_ref}` no lugar da própria assinatura.
async function entregaTestePublica(r) {
  const { id, empresa, contato, email, equipamento, numero_serie, data_entrega, data_prevista_devolucao,
    observacoes, assinatura_cliente_nome, assinatura_cliente_img, status_preenchimento, tecnico_nome } = r;
  return {
    id, empresa, contato, email, equipamento, numero_serie, data_entrega, data_prevista_devolucao,
    observacoes, assinatura_cliente_nome, status_preenchimento, tecnico_nome,
    assinatura_cliente_img: await hidratarFotosProfundo(assinatura_cliente_img),
  };
}

// GET /api/entregas/:token — pública: carrega o que já foi preenchido até agora (por qualquer um
// dos dois lados) pra continuar de onde parou
rota('GET', /^\/api\/entregas\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const item = buscarEntregaTestePorToken(data, m[1]);
  if (!item) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  enviarJSON(res, 200, { relatorio: await entregaTestePublica(item) });
});

// PUT /api/entregas/:token — pública: salva o preenchimento parcial (sem exigir todos os campos
// nem a assinatura ainda) — tanto faz se é o cliente terminando o que o técnico começou, ou o
// contrário. Uma vez concluído (assinado), o link vira só-leitura pra não sobrescrever a assinatura.
rota('PUT', /^\/api\/entregas\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const item = buscarEntregaTestePorToken(data, m[1]);
  if (!item) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  if (item.status_preenchimento === 'concluido') return enviarJSON(res, 409, { erro: 'Este comprovante já foi assinado e concluído.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), item.empresa_id);
  Object.assign(item, {
    empresa: body.empresa || '', contato: body.contato || '', email: body.email || '',
    equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
    data_entrega: body.data_entrega || '', data_prevista_devolucao: body.data_prevista_devolucao || '',
    observacoes: body.observacoes || '',
    assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
  });
  db.save(data);
  enviarJSON(res, 200, { relatorio: await entregaTestePublica(item) });
});

// POST /api/entregas/:token/concluir — pública: envio final, com a mesma validação completa que
// o técnico teria que passar se preenchesse tudo sozinho (todos os campos + assinatura do
// cliente) — avisa o técnico responsável por push assim que o cliente concluir.
rota('POST', /^\/api\/entregas\/([a-f0-9]+)\/concluir$/, async (req, res, m) => {
  const data = db.load();
  const item = buscarEntregaTestePorToken(data, m[1]);
  if (!item) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  if (item.status_preenchimento === 'concluido') return enviarJSON(res, 409, { erro: 'Este comprovante já foi assinado e concluído.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), item.empresa_id);
  const erro = validarRelatorioEntregaTeste(body);
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(item, {
    empresa: body.empresa || '', contato: body.contato || '', email: body.email || '',
    equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
    data_entrega: body.data_entrega || '', data_prevista_devolucao: body.data_prevista_devolucao || '',
    observacoes: body.observacoes || '',
    assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
    status_preenchimento: 'concluido',
    concluido_em: new Date().toISOString(),
  });
  db.save(data);
  enviarPush(data, item.autor_id, {
    titulo: 'Cliente concluiu a Entrega para Teste',
    corpo: `${item.empresa || 'Cliente'} preencheu e assinou o comprovante de "${item.equipamento || 'equipamento'}".`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { relatorio: await entregaTestePublica(item) });
});

// GET /api/agenda?todas=1 — o técnico normalmente só vê a própria agenda ("Minha agenda"); o
// parâmetro "todas" libera pra ele ver as O.S. de todos os técnicos (usado no menu Calendário),
// só pra consulta — quem pode executar continua sendo decidido no front pelo tecnico_id.
rota('GET', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'agenda', user.empresa_id);
  if (user.papel === 'suporte' && query.todas !== '1') {
    lista = lista.filter((a) => a.tecnico_id === user.id);
  } else if (user.papel === 'cliente') {
    lista = lista.filter((a) => a.cliente_id === user.cliente_id);
  } else if (['gerente_loja', 'coordenador_tecnico', 'consultor_mercado'].includes(user.papel)) {
    // versão Restaurantes/rede multiunidade: só O.S. das filiais do próprio escopo (ver
    // escopo.js) — sem isso, esses papéis veriam a agenda inteira da empresa.
    const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
    lista = lista.filter((a) => a.filial_id !== null && filiaisIds.has(a.filial_id));
  }
  // administrador e supervisor veem tudo
  lista = lista.map((a) => agendaComDetalhes(data, a)).sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  enviarJSON(res, 200, { agenda: lista });
});

// GET /api/agenda/proximo-numero — sugestão de nº de O.S. pro formulário de criação
// (o administrador pode aceitar ou digitar outro número antes de salvar)
rota('GET', /^\/api\/agenda\/proximo-numero$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cria ordens de serviço.' });
  const data = db.load();
  enviarJSON(res, 200, { numero: `OS-${String(data._seq.agenda).padStart(6, '0')}` });
});

// GET /api/agenda/tecnico-da-vez?inicio=&fim=&excluir_id= — pro formulário de Nova O.S. sugerir
// quem é o próximo do rodízio de viagens (ver tecnicoDaVez) e avisar, sem bloquear nada, se esse
// técnico já tem outra O.S. marcada dentro do período informado (ver conflitoDeAgendaTecnico).
rota('GET', /^\/api\/agenda\/tecnico-da-vez$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cria ordens de serviço.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const excluirId = query.excluir_id ? Number(query.excluir_id) : null;
  const tecnico = tecnicoDaVez(data, user.empresa_id, excluirId);
  if (!tecnico) return enviarJSON(res, 200, { tecnico_da_vez_id: null, tecnico_da_vez_nome: null, conflito: null });
  const conflito = (query.inicio && query.fim) ? conflitoDeAgendaTecnico(data, user.empresa_id, tecnico.id, query.inicio, query.fim, excluirId) : null;
  enviarJSON(res, 200, { tecnico_da_vez_id: tecnico.id, tecnico_da_vez_nome: tecnico.nome, conflito });
});

// GET /api/agenda/escala-conflito?tecnico_id=&inicio=&fim= — pro formulário de Nova O.S. avisar
// em tempo real se o técnico escolhido está de férias/DSR/banco de horas no período (ver
// checarEscalaAntesDeSalvar) — o bloqueio/exigência de justificativa de verdade é sempre no
// POST/PUT, isso aqui é só pra mostrar o aviso antes de tentar salvar.
rota('GET', /^\/api\/agenda\/escala-conflito$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cria ordens de serviço.' });
  const { query } = url.parse(req.url, true);
  if (!query.tecnico_id || !query.inicio || !query.fim) return enviarJSON(res, 200, { bloqueado: false, motivo: null, tipo: null });
  const data = db.load();
  const resultado = checarEscalaAntesDeSalvar(data, user.empresa_id, Number(query.tecnico_id), query.inicio, query.fim);
  enviarJSON(res, 200, resultado);
});

// POST /api/agenda  (administrador cria atividade)
rota('POST', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador pode criar atividades.' });
  const body = await lerCorpo(req);
  // Demonstração Técnica é uma visita comercial a um prospect que ainda não é cliente oficial —
  // não faz sentido exigir cadastro prévio de cliente/equipamento (cadastro é decisão de quem já
  // fechou negócio). Nome da empresa e equipamento entram como texto livre nesse caso.
  const ehDemonstracao = body.tipo === 'demonstracao_tecnica';
  const obrig = ['tecnico_id', 'data_hora_inicio', 'data_hora_fim', 'tipo', 'contato', 'telefone', 'email'];
  obrig.push(...(ehDemonstracao ? ['cliente_nome_manual', 'equipamento_manual'] : ['cliente_id', 'equipamento_id']));
  // treinamento online não exige deslocamento até o cliente, então não pede endereço
  if (body.tipo !== 'treinamento_online') obrig.push('endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado');
  // corretiva/preventiva usam o Laudo Técnico, que depende da garantia do equipamento
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo)) obrig.push('garantia');
  for (const campo of obrig) {
    if (!body[campo] || !String(body[campo]).trim()) return enviarJSON(res, 400, { erro: `Campo obrigatório faltando: ${campo}` });
  }
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && body.garantia === 'na' && !String(body.garantia_obs || '').trim()) {
    return enviarJSON(res, 400, { erro: 'Especifique o motivo do "N/A" na garantia.' });
  }
  const data = db.load();
  const equipamentoEscolhido = ehDemonstracao ? null : tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  // contrato de manutenção preventiva (RCM/SAP PM, passo 11): campo opcional dedicado na
  // abertura da O.S. — só pega se o equipamento ainda não tiver essa informação (ver
  // aplicarContratoDoValor); se já tiver, o front trava e nem envia.
  aplicarContratoDoValor(equipamentoEscolhido, body.tem_contrato_manutencao);
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado && tenant.listar(data, 'agenda', user.empresa_id).some((a) => (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado)) {
    return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
  }
  const bonusViagem = !!body.bonus_viagem;
  let justificativaLimiteViagens = '';
  let viagemDiaInicio = '';
  let viagemDiaFimPrevisto = '';
  let diasNovaViagem = 0;
  let foraDeOrdemViagem = false;
  if (bonusViagem) {
    viagemDiaInicio = String(body.viagem_dia_inicio || '').trim();
    viagemDiaFimPrevisto = String(body.viagem_dia_fim_previsto || '').trim();
    if (!viagemDiaInicio || !viagemDiaFimPrevisto) {
      return enviarJSON(res, 400, { erro: 'Informe o dia de início do deslocamento e o dia previsto de retorno pra contar o bônus de viagem.' });
    }
    diasNovaViagem = diasBonusViagem(viagemDiaInicio, viagemDiaFimPrevisto);
    if (diasNovaViagem < 1) {
      return enviarJSON(res, 400, { erro: 'O dia previsto de retorno não pode ser antes do dia de início do deslocamento.' });
    }
    const { motivo, foraDeOrdem } = motivoExigeJustificativaViagem(data, user.empresa_id, Number(body.tecnico_id), body.data_hora_inicio, viagemDiaInicio, viagemDiaFimPrevisto, diasNovaViagem, null);
    foraDeOrdemViagem = foraDeOrdem;
    if (motivo) {
      justificativaLimiteViagens = String(body.justificativa_limite_viagens || '').trim();
      if (!justificativaLimiteViagens) {
        return enviarJSON(res, 400, { erro: motivo, precisa_justificativa: true });
      }
    }
  }
  // escala de folga: o técnico escolhido pode estar de férias/DSR/banco de horas nos dias da O.S.
  // (não só nas com bônus de viagem — qualquer O.S. checa a escala dele)
  const diaInicioOS = bonusViagem && viagemDiaInicio ? viagemDiaInicio : String(body.data_hora_inicio || '').slice(0, 10);
  const diaFimOS = bonusViagem && viagemDiaFimPrevisto ? viagemDiaFimPrevisto : String(body.data_hora_fim || body.data_hora_inicio || '').slice(0, 10);
  const escalaCheck = checarEscalaAntesDeSalvar(data, user.empresa_id, Number(body.tecnico_id), diaInicioOS, diaFimOS);
  let justificativaEscalaConflito = '';
  if (escalaCheck.bloqueado) {
    return enviarJSON(res, 400, { erro: escalaCheck.motivo });
  }
  if (escalaCheck.motivo) {
    justificativaEscalaConflito = String(body.justificativa_escala_conflito || '').trim();
    if (!justificativaEscalaConflito) {
      return enviarJSON(res, 400, { erro: escalaCheck.motivo, precisa_justificativa: true, motivo_escala: true });
    }
  }
  const item = tenant.criar(data, 'agenda', user.empresa_id, {
    numero_os: numeroOSDigitado || null, // preenchido logo abaixo, depois de saber o id gerado
    criado_por: user.id,
    tecnico_id: Number(body.tecnico_id),
    cliente_id: ehDemonstracao ? null : Number(body.cliente_id),
    equipamento_id: ehDemonstracao ? null : Number(body.equipamento_id),
    cliente_nome_manual: ehDemonstracao ? String(body.cliente_nome_manual || '').trim() : '',
    equipamento_manual: ehDemonstracao ? String(body.equipamento_manual || '').trim() : '',
    data_hora_inicio: body.data_hora_inicio,
    data_hora_fim: body.data_hora_fim,
    tipo: body.tipo, // preventiva | corretiva | treinamento
    categoria: categoriaDoTipo(body.tipo), // online | inloco
    problema: body.problema || '',
    // dados do atendimento definidos pelo administrador ao abrir a OS — o técnico só visualiza
    contato: body.contato, telefone: body.telefone, email: body.email, setor_cliente: body.setor_cliente || '',
    endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
    cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    // garantia definida pelo administrador na abertura da OS — o técnico só visualiza no Laudo Técnico
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
    // SLA: se esta O.S. nasce de uma Solicitação de Atendimento, o SLA já definido lá é copiado
    // automaticamente pra cá em finalizar-solicitacao (não passa por aqui). Numa O.S. aberta do
    // zero pelo administrador, ninguém mais vai responder esse questionário depois — por isso ele
    // pode (opcionalmente) preencher agora; se não preencher, fica null e o técnico/pós-venda
    // ainda pode defini-lo mais tarde ao encaminhar pro pós-venda.
    ...(slaDoBody(body, equipamentoEscolhido) || {
      sla_nivel: null, sla_pontuacao: null, sla_horas_atendimento: null,
      sla_dias_manutencao: null, sla_dias_visita_tecnica: null,
    }),
    status: 'pendente',
    valor_servico: body.valor_servico || null,
    retrabalho: false,
    criado_em: new Date().toISOString(),
    lida_tecnico: false,
    deslocamento_iniciado_em: null,
    chegada_confirmada_em: null,
    confirmado_cliente_em: null,
    feedback_cliente_em: null,
    orcamento_aprovado_em: null,
    orcamento_reprovado_em: null,
    retorno_pendente_tecnico: false,
    retorno_confirmado_cliente_em: null,
    retorno_deslocamento_iniciado_em: null,
    retorno_chegada_confirmada_em: null,
    viagem_volta_iniciada_em: null,
    viagem_volta_chegada_em: null,
    viagem_volta_destino_agenda_id: null,
    bonus_viagem: bonusViagem,
    viagem_dia_inicio: bonusViagem ? viagemDiaInicio : '',
    viagem_dia_fim_previsto: bonusViagem ? viagemDiaFimPrevisto : '',
    justificativa_limite_viagens: justificativaLimiteViagens,
    fora_de_ordem_viagem: bonusViagem ? foraDeOrdemViagem : false,
    escala_conflito_tipo: escalaCheck.tipo,
    justificativa_escala_conflito: justificativaEscalaConflito,
  });
  if (!item.numero_os) item.numero_os = `OS-${String(item.id).padStart(6, '0')}`;
  db.save(data);
  const clienteNovaOS = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Nova O.S. atribuída',
    corpo: `${clienteNovaOS ? clienteNovaOS.nome_empresa : (item.cliente_nome_manual || 'Novo atendimento')} — ${fmtDataHoraCurta(item.data_hora_inicio)}.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 201, { agenda: agendaComDetalhes(data, item) });
});

// PUT /api/agenda/:id — administrador edita uma O.S. já criada
rota('PUT', /^\/api\/agenda\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita ordens de serviço.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 403, { erro: 'Esta O.S. já foi finalizada e não pode mais ser alterada. Abra uma nova O.S. se for necessário um novo atendimento.' });
  const ehDemonstracao = body.tipo === 'demonstracao_tecnica';
  const obrig = ['tecnico_id', 'data_hora_inicio', 'data_hora_fim', 'tipo', 'contato', 'telefone', 'email'];
  obrig.push(...(ehDemonstracao ? ['cliente_nome_manual', 'equipamento_manual'] : ['cliente_id', 'equipamento_id']));
  if (body.tipo !== 'treinamento_online') obrig.push('endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado');
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo)) obrig.push('garantia');
  for (const campo of obrig) {
    if (!body[campo] || !String(body[campo]).trim()) return enviarJSON(res, 400, { erro: `Campo obrigatório faltando: ${campo}` });
  }
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && body.garantia === 'na' && !String(body.garantia_obs || '').trim()) {
    return enviarJSON(res, 400, { erro: 'Especifique o motivo do "N/A" na garantia.' });
  }
  const equipamentoEscolhido = ehDemonstracao ? null : tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  aplicarContratoDoValor(equipamentoEscolhido, body.tem_contrato_manutencao);
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado) {
    const jaExisteEmOutra = tenant.listar(data, 'agenda', user.empresa_id).some((a) => a.id !== item.id && (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado);
    if (jaExisteEmOutra) return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
  }
  const bonusViagem = !!body.bonus_viagem;
  let justificativaLimiteViagens = '';
  let viagemDiaInicio = '';
  let viagemDiaFimPrevisto = '';
  let diasNovaViagem = 0;
  let foraDeOrdemViagem = false;
  if (bonusViagem) {
    viagemDiaInicio = String(body.viagem_dia_inicio || '').trim();
    viagemDiaFimPrevisto = String(body.viagem_dia_fim_previsto || '').trim();
    if (!viagemDiaInicio || !viagemDiaFimPrevisto) {
      return enviarJSON(res, 400, { erro: 'Informe o dia de início do deslocamento e o dia previsto de retorno pra contar o bônus de viagem.' });
    }
    diasNovaViagem = diasBonusViagem(viagemDiaInicio, viagemDiaFimPrevisto);
    if (diasNovaViagem < 1) {
      return enviarJSON(res, 400, { erro: 'O dia previsto de retorno não pode ser antes do dia de início do deslocamento.' });
    }
    const { motivo, foraDeOrdem } = motivoExigeJustificativaViagem(data, user.empresa_id, Number(body.tecnico_id), body.data_hora_inicio, viagemDiaInicio, viagemDiaFimPrevisto, diasNovaViagem, item.id);
    foraDeOrdemViagem = foraDeOrdem;
    if (motivo) {
      justificativaLimiteViagens = String(body.justificativa_limite_viagens || item.justificativa_limite_viagens || '').trim();
      if (!justificativaLimiteViagens) {
        return enviarJSON(res, 400, { erro: motivo, precisa_justificativa: true });
      }
    }
  }
  // escala de folga: o técnico escolhido pode estar de férias/DSR/banco de horas nos dias da O.S.
  const diaInicioOS = bonusViagem && viagemDiaInicio ? viagemDiaInicio : String(body.data_hora_inicio || '').slice(0, 10);
  const diaFimOS = bonusViagem && viagemDiaFimPrevisto ? viagemDiaFimPrevisto : String(body.data_hora_fim || body.data_hora_inicio || '').slice(0, 10);
  const escalaCheck = checarEscalaAntesDeSalvar(data, user.empresa_id, Number(body.tecnico_id), diaInicioOS, diaFimOS);
  let justificativaEscalaConflito = '';
  if (escalaCheck.bloqueado) {
    return enviarJSON(res, 400, { erro: escalaCheck.motivo });
  }
  if (escalaCheck.motivo) {
    justificativaEscalaConflito = String(body.justificativa_escala_conflito || item.justificativa_escala_conflito || '').trim();
    if (!justificativaEscalaConflito) {
      return enviarJSON(res, 400, { erro: escalaCheck.motivo, precisa_justificativa: true, motivo_escala: true });
    }
  }
  // se o técnico designado mudou, ele ainda não viu essa atribuição — reabre a notificação
  const trocouTecnico = Number(body.tecnico_id) !== item.tecnico_id;
  Object.assign(item, {
    numero_os: numeroOSDigitado || item.numero_os || `OS-${String(item.id).padStart(6, '0')}`,
    tecnico_id: Number(body.tecnico_id),
    cliente_id: ehDemonstracao ? null : Number(body.cliente_id),
    equipamento_id: ehDemonstracao ? null : Number(body.equipamento_id),
    cliente_nome_manual: ehDemonstracao ? String(body.cliente_nome_manual || '').trim() : '',
    equipamento_manual: ehDemonstracao ? String(body.equipamento_manual || '').trim() : '',
    data_hora_inicio: body.data_hora_inicio,
    data_hora_fim: body.data_hora_fim,
    tipo: body.tipo,
    categoria: categoriaDoTipo(body.tipo),
    problema: body.problema || '',
    contato: body.contato, telefone: body.telefone, email: body.email, setor_cliente: body.setor_cliente || '',
    endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
    cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
    // SLA: se já foi definido (pelo técnico/pós-venda, ou pelo próprio administrador na criação),
    // fica preservado — não é reescrito por aqui. Só entra se a O.S. ainda não tinha SLA nenhum.
    ...(item.sla_nivel === null ? (slaDoBody(body, equipamentoEscolhido) || {}) : {}),
    bonus_viagem: bonusViagem,
    viagem_dia_inicio: bonusViagem ? viagemDiaInicio : '',
    viagem_dia_fim_previsto: bonusViagem ? viagemDiaFimPrevisto : '',
    justificativa_limite_viagens: bonusViagem ? justificativaLimiteViagens : '',
    fora_de_ordem_viagem: bonusViagem ? foraDeOrdemViagem : false,
    escala_conflito_tipo: escalaCheck.tipo,
    justificativa_escala_conflito: justificativaEscalaConflito,
  });
  if (trocouTecnico) item.lida_tecnico = false;
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// GET /api/tecnicos/viagens?mes=AAAA-MM — acompanhamento do bônus de viagem por técnico: quantas
// diárias cada um somou no mês (1 por dia corrido entre o início do deslocamento e a chegada de
// volta, ver diasBonusViagem), o valor total (R$200 por diária), quantas viagens (O.S. em-loco)
// não somaram bônus (nem toda região paga), e quantas precisaram de justificativa do
// administrador (com_justificativa — seja por passar do limite de diárias, seja por ser escolha
// fora da ordem do rodízio, ver motivoExigeJustificativaViagem; qualquer uma das duas já bloqueia
// a O.S. de ser salva sem justificativa, por isso as duas contam junto pro selo vermelho).
rota('GET', /^\/api\/tecnicos\/viagens$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'suporte', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const mes = query.mes || new Date().toISOString().slice(0, 7);
  const data = db.load();
  const empresaDoUsuario = data.empresas.find((e) => e.id === user.empresa_id);
  const valorBonus = valorBonusViagem(empresaDoUsuario);
  const limiteBonus = limiteViagensBonusMes(empresaDoUsuario);
  // o técnico só acompanha as próprias viagens — o administrador acompanha o time todo
  let tecnicos = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte' && u.status === 'ativo');
  if (user.papel === 'suporte') tecnicos = tecnicos.filter((u) => u.id === user.id);
  const agendaDaEmpresa = tenant.listar(data, 'agenda', user.empresa_id);
  const porTecnico = tecnicos.map((t) => {
    const doTecnicoNoMes = agendaDaEmpresa.filter((a) => a.tecnico_id === t.id && String(a.data_hora_inicio || '').slice(0, 7) === mes);
    const viagens = doTecnicoNoMes.filter((a) => a.bonus_viagem).sort((x, y) => (x.data_hora_inicio || '').localeCompare(y.data_hora_inicio || ''));
    const viagensComDias = viagens.map((a) => ({ item: a, dias: diasBonusViagem(a.viagem_dia_inicio, a.viagem_dia_fim_previsto) }));
    const diasTotal = viagensComDias.reduce((soma, v) => soma + v.dias, 0);
    // "viagem" que não somou bônus: O.S. em-loco (exige deslocamento) sem bônus marcado
    const quantidadeSemBonus = doTecnicoNoMes.filter((a) => a.categoria === 'inloco' && !a.bonus_viagem).length;
    return {
      tecnico_id: t.id,
      tecnico_nome: t.nome,
      quantidade: viagens.length,
      quantidade_sem_bonus: quantidadeSemBonus,
      dias_total: diasTotal,
      valor_total: diasTotal * valorBonus,
      passou_limite: diasTotal > limiteBonus,
      com_justificativa: viagens.filter((a) => a.justificativa_limite_viagens || a.escala_conflito_tipo).length,
      viagens: viagensComDias.map(({ item: a, dias }) => ({
        id: a.id, numero_os: a.numero_os || `OS-${String(a.id).padStart(6, '0')}`,
        cliente_nome: (data.clientes.find((c) => c.id === a.cliente_id && c.empresa_id === a.empresa_id) || {}).nome_empresa || a.cliente_nome_manual || '—',
        data_hora_inicio: a.data_hora_inicio,
        viagem_dia_inicio: a.viagem_dia_inicio || '',
        viagem_dia_fim_previsto: a.viagem_dia_fim_previsto || '',
        dias,
        fora_de_ordem_viagem: !!a.fora_de_ordem_viagem,
        justificativa_limite_viagens: a.justificativa_limite_viagens || '',
        escala_conflito_tipo: a.escala_conflito_tipo || null,
        justificativa_escala_conflito: a.justificativa_escala_conflito || '',
      })),
      // O.S. em-loco do mês que NÃO somaram bônus — mostradas junto na tela de detalhe do
      // técnico, separadas por cor da que soma bônus (ver quantidade_sem_bonus acima)
      viagens_sem_bonus: doTecnicoNoMes.filter((a) => a.categoria === 'inloco' && !a.bonus_viagem)
        .sort((x, y) => (x.data_hora_inicio || '').localeCompare(y.data_hora_inicio || ''))
        .map((a) => ({
          id: a.id, numero_os: a.numero_os || `OS-${String(a.id).padStart(6, '0')}`,
          cliente_nome: (data.clientes.find((c) => c.id === a.cliente_id && c.empresa_id === a.empresa_id) || {}).nome_empresa || a.cliente_nome_manual || '—',
          data_hora_inicio: a.data_hora_inicio,
        })),
    };
  }).sort((a, b) => b.dias_total - a.dias_total);
  enviarJSON(res, 200, { mes, limite: limiteBonus, valor_bonus: valorBonus, tecnicos: porTecnico });
});

// ---------- escala de folga (feriados + DSR, compensação de banco de horas, home office, férias) ----------
// diferente das solicitações de RH logo abaixo (um pedido do técnico, com aprovação): aqui é o
// administrador que marca direto no calendário de cada um da equipe (inclusive ele mesmo) — não
// tem fluxo de aprovação, é a escala de fato. Usado tanto pro mini calendário quanto pra checar
// conflito ao montar uma O.S. (ver conflitoEscalaTecnico, POST/PUT /api/agenda).
const TIPOS_ESCALA_FOLGA = ['dsr', 'banco_horas', 'home_office', 'ferias'];
const ABRANGENCIAS_FERIADO = ['nacional', 'estadual', 'municipal'];

// turno padrão da empresa (usado só pra calcular o débito de banco de horas quando o técnico
// pede pra entrar mais tarde ou sair mais cedo — ver horasBancoDaModalidade) — carga horária
// fixa em 8h, mesmo o turno indo das 8 às 17 (1h de intervalo não remunerado no meio).
const MODALIDADES_BANCO_HORAS = ['dia_inteiro', 'entrada_atrasada', 'saida_antecipada'];
const TURNO_ENTRADA_PADRAO = '08:00';
const TURNO_SAIDA_PADRAO = '17:00';
const CARGA_HORARIA_DIA_BANCO = 8;

function minutosDoHorario(horario) {
  const [h, m] = horario.split(':').map(Number);
  return h * 60 + m;
}

// quantas horas do banco a modalidade consome — dia inteiro usa a carga horária cheia; entrar
// mais tarde ou sair mais cedo usa só a diferença entre o horário escolhido e o limite do turno,
// pra não obrigar o técnico a calcular isso manualmente.
function horasBancoDaModalidade(modalidade, horario) {
  if (modalidade === 'dia_inteiro') return CARGA_HORARIA_DIA_BANCO;
  const minutos = minutosDoHorario(horario);
  const entrada = minutosDoHorario(TURNO_ENTRADA_PADRAO);
  const saida = minutosDoHorario(TURNO_SAIDA_PADRAO);
  if (modalidade === 'entrada_atrasada') return Math.round(((minutos - entrada) / 60) * 100) / 100;
  if (modalidade === 'saida_antecipada') return Math.round(((saida - minutos) / 60) * 100) / 100;
  return 0;
}

// AAAA-MM-DD (início) até AAAA-MM-DD (fim), inclusive — em UTC de propósito, pra nunca escorregar
// de dia por causa de fuso horário (essas datas não têm hora, só o dia importa).
function diasEntreISO(inicioISO, fimISO) {
  const [ai, mi, di] = inicioISO.split('-').map(Number);
  const [af, mf, df] = fimISO.split('-').map(Number);
  const fim = Date.UTC(af, mf - 1, df);
  const dias = [];
  for (let atual = Date.UTC(ai, mi - 1, di); atual <= fim; atual += 24 * 60 * 60 * 1000) {
    const d = new Date(atual);
    dias.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return dias;
}

// cria ou substitui a marcação de escala de um dia (mesma regra do POST /api/escala-folgas
// manual do administrador: uma marcação individual por pessoa por dia) — reaproveitada quando
// uma solicitação do técnico é aprovada (ver decidir), pra nunca ter duas marcações conflitantes.
function marcarEscalaFolgaDia(data, empresaId, { usuarioId, diaISO, tipo, modalidadeBanco, horario, definidoPor }) {
  const existente = data.escala_folgas.find((e) => e.usuario_id === usuarioId && e.data === diaISO && e.empresa_id === empresaId);
  if (existente) {
    existente.tipo = tipo;
    existente.modalidade_banco = modalidadeBanco || null;
    existente.horario = horario || null;
    existente.definido_por = definidoPor;
    existente.atualizado_em = new Date().toISOString();
    return existente;
  }
  return tenant.criar(data, 'escala_folgas', empresaId, {
    usuario_id: usuarioId, data: diaISO, tipo, modalidade_banco: modalidadeBanco || null, horario: horario || null,
    definido_por: definidoPor, criado_em: new Date().toISOString(), atualizado_em: null,
  });
}

// GET /api/feriados?ano=AAAA — feriados cadastrados (nacional/estadual/municipal); qualquer um
// da empresa pode ver (é só o pano de fundo do calendário), só o administrador cadastra/exclui.
// O sistema não vem com nenhum feriado pré-cadastrado — o administrador quem informa as datas
// certas (inclusive os feriados municipais de sua cidade), pra nunca arriscar uma data errada.
rota('GET', /^\/api\/feriados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'feriados', user.empresa_id);
  if (query.ano) lista = lista.filter((f) => String(f.data || '').slice(0, 4) === String(query.ano));
  lista = lista.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
  enviarJSON(res, 200, { feriados: lista });
});

// POST /api/feriados
rota('POST', /^\/api\/feriados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra feriados.' });
  const body = await lerCorpo(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data do feriado.' });
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do feriado.' });
  if (!ABRANGENCIAS_FERIADO.includes(body.abrangencia)) return enviarJSON(res, 400, { erro: 'Abrangência inválida.' });
  const data = db.load();
  if (tenant.listar(data, 'feriados', user.empresa_id).some((f) => f.data === body.data && f.abrangencia === body.abrangencia)) {
    return enviarJSON(res, 400, { erro: 'Já existe um feriado dessa abrangência cadastrado nessa data.' });
  }
  const item = tenant.criar(data, 'feriados', user.empresa_id, {
    data: body.data, nome: String(body.nome).trim(), abrangencia: body.abrangencia, criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { feriado: item });
});

// DELETE /api/feriados/:id
rota('DELETE', /^\/api\/feriados\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui feriados.' });
  const data = db.load();
  const item = tenant.buscar(data, 'feriados', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Feriado não encontrado.' });
  data.feriados = data.feriados.filter((f) => f.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/escala-folgas?mes=AAAA-MM — todas as marcações da equipe inteira nesse mês, de uma
// vez (a lista da esquerda usa isso pra mostrar o ícone de hoje de cada um; ao clicar num nome,
// o front filtra por usuario_id no que já veio, sem precisar de outra chamada). O técnico também
// lê essa rota (só leitura — marcar/limpar continua exclusivo do administrador, ver POST/DELETE
// abaixo) pro próprio Calendário mostrar a escala dele e a dos colegas.
rota('GET', /^\/api\/escala-folgas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'suporte', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const mes = query.mes || new Date().toISOString().slice(0, 7);
  const data = db.load();
  const lista = tenant.listar(data, 'escala_folgas', user.empresa_id)
    .filter((e) => String(e.data || '').slice(0, 7) === mes)
    .map((e) => ({ ...e, usuario_nome: e.usuario_id === null ? 'Geral (coletiva)' : ((data.usuarios.find((u) => u.id === e.usuario_id && u.empresa_id === user.empresa_id) || {}).nome || '—') }));
  enviarJSON(res, 200, { mes, escalas: lista });
});

// POST /api/escala-folgas — administrador marca um dia de alguém da equipe (substitui se já
// houver marcação nesse dia — um dia só tem um tipo por pessoa), ou marca uma folga coletiva
// (body.coletiva: true, sem usuario_id) que vale pra equipe inteira — ex.: DSR de fim de semana
// pra todo mundo de uma vez, sem precisar marcar pessoa por pessoa. Uma marcação individual no
// mesmo dia continua tendo prioridade sobre a coletiva pra essa pessoa (ver escalasEfetivasTecnico).
rota('POST', /^\/api\/escala-folgas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador define a escala de folga.' });
  const body = await lerCorpo(req);
  if (!TIPOS_ESCALA_FOLGA.includes(body.tipo)) return enviarJSON(res, 400, { erro: 'Tipo inválido.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data.' });
  // banco de horas marcado direto (sem passar por uma solicitação do técnico) também precisa saber
  // COMO vai ser a compensação — dia inteiro ou um horário parcial de entrada/saída — pro KPI de
  // Mão de Obra abater a quantidade certa do colchão do técnico (ver calcularMaoDeObra). Mesma
  // validação já usada em POST /api/solicitacoes-rh pro débito de banco de horas.
  let modalidadeBanco = null;
  let horarioBanco = null;
  if (body.tipo === 'banco_horas') {
    if (!MODALIDADES_BANCO_HORAS.includes(body.modalidade_banco)) {
      return enviarJSON(res, 400, { erro: 'Escolha como vai ser a compensação: dia inteiro, entrar mais tarde ou sair mais cedo.' });
    }
    modalidadeBanco = body.modalidade_banco;
    if (modalidadeBanco !== 'dia_inteiro') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.horario || '')) return enviarJSON(res, 400, { erro: 'Informe o horário.' });
      horarioBanco = body.horario;
    }
    if (!(horasBancoDaModalidade(modalidadeBanco, horarioBanco) > 0)) {
      return enviarJSON(res, 400, { erro: 'Horário fora do expediente (08:00–17:00).' });
    }
  }
  const data = db.load();
  let usuarioAlvoId = null;
  if (!body.coletiva) {
    const usuarioAlvo = tenant.buscar(data, 'usuarios', Number(body.usuario_id), user.empresa_id);
    if (!usuarioAlvo || !['suporte', 'administrador'].includes(usuarioAlvo.papel)) {
      return enviarJSON(res, 404, { erro: 'Usuário não encontrado na equipe.' });
    }
    usuarioAlvoId = usuarioAlvo.id;
  }
  const existente = data.escala_folgas.find((e) => e.usuario_id === usuarioAlvoId && e.data === body.data && e.empresa_id === user.empresa_id);
  if (existente) {
    existente.tipo = body.tipo;
    existente.modalidade_banco = modalidadeBanco;
    existente.horario = horarioBanco;
    existente.definido_por = user.id;
    existente.atualizado_em = new Date().toISOString();
    db.save(data);
    return enviarJSON(res, 200, { escala: existente });
  }
  const item = tenant.criar(data, 'escala_folgas', user.empresa_id, {
    usuario_id: usuarioAlvoId, data: body.data, tipo: body.tipo, modalidade_banco: modalidadeBanco, horario: horarioBanco,
    definido_por: user.id, criado_em: new Date().toISOString(), atualizado_em: null,
  });
  db.save(data);
  enviarJSON(res, 201, { escala: item });
});

// DELETE /api/escala-folgas/:id — limpa uma marcação
rota('DELETE', /^\/api\/escala-folgas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador altera a escala de folga.' });
  const data = db.load();
  const item = tenant.buscar(data, 'escala_folgas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Marcação não encontrada.' });
  data.escala_folgas = data.escala_folgas.filter((e) => e.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- atividades não programadas (dia ocioso) ----------

// GET /api/atividades-nao-programadas?mes=AAAA-MM — o próprio técnico vê o mês: cada dia com seu
// status (O.S., folga, justificado, pendente ou futuro) e, nos já justificados, as atividades
// preenchidas.
rota('GET', /^\/api\/atividades-nao-programadas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : new Date().toISOString().slice(0, 7);
  const data = db.load();
  const dias = diasDoMesTecnico(data, user.empresa_id, user.id, mes);
  enviarJSON(res, 200, { mes, dias });
});

// GET /api/atividades-nao-programadas/equipe?mes=AAAA-MM — resumo da equipe inteira pro
// administrador identificar quem está com muito ou pouco serviço no mês: quantos dias cada
// técnico teve com O.S., com folga, já justificados e ainda pendentes de preenchimento.
rota('GET', /^\/api\/atividades-nao-programadas\/equipe$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : new Date().toISOString().slice(0, 7);
  const data = db.load();
  const tecnicos = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte' && u.status === 'ativo');
  const resumo = tecnicos.map((t) => {
    const dias = diasDoMesTecnico(data, user.empresa_id, t.id, mes);
    const contagem = { os: 0, folga: 0, justificado: 0, pendente: 0 };
    for (const d of dias) if (contagem[d.status] !== undefined) contagem[d.status] += 1;
    return { id: t.id, nome: t.nome, dias_os: contagem.os, dias_folga: contagem.folga, dias_justificados: contagem.justificado, dias_pendentes: contagem.pendente };
  }).sort((a, b) => b.dias_pendentes - a.dias_pendentes || a.nome.localeCompare(b.nome));
  enviarJSON(res, 200, { mes, tecnicos: resumo });
});

// GET /api/atividades-nao-programadas/tecnico/:id?mes=AAAA-MM — drill-down do administrador: o
// mesmo detalhe dia a dia que o próprio técnico vê, mas pra um técnico específico da equipe.
rota('GET', /^\/api\/atividades-nao-programadas\/tecnico\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const tecnico = tenant.buscar(data, 'usuarios', Number(m[1]), user.empresa_id);
  if (!tecnico || tecnico.papel !== 'suporte') return enviarJSON(res, 404, { erro: 'Técnico não encontrado.' });
  const { query } = url.parse(req.url, true);
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : new Date().toISOString().slice(0, 7);
  const dias = diasDoMesTecnico(data, user.empresa_id, tecnico.id, mes);
  enviarJSON(res, 200, { mes, tecnico_nome: tecnico.nome, dias });
});

// POST /api/atividades-nao-programadas — o técnico preenche (ou corrige) a justificativa de um
// dia ocioso: uma ou mais atividades, cada uma com início, fim e descrição. Só aceita dias que
// realmente estão ociosos pra ele (sem O.S./atendimento e sem folga aprovada) e que já chegaram —
// substitui o preenchimento anterior se o técnico reenviar o mesmo dia.
rota('POST', /^\/api\/atividades-nao-programadas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico preenche suas próprias atividades.' });
  const body = await lerCorpo(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data.' });
  const data = db.load();
  const status = statusDiaTecnico(data, user.empresa_id, user.id, body.data, hojeBrasiliaISO());
  if (status === 'futuro') return enviarJSON(res, 400, { erro: 'Não é possível preencher um dia que ainda não chegou.' });
  if (status === 'os') return enviarJSON(res, 400, { erro: 'Esse dia já tem O.S./atendimento marcado — não é um dia ocioso.' });
  if (status === 'folga') return enviarJSON(res, 400, { erro: 'Esse dia já está marcado como folga — não é um dia ocioso.' });
  const validacao = validarAtividadesNaoProgramadas(body.atividades);
  if (validacao.erro) return enviarJSON(res, 400, { erro: validacao.erro });
  const existente = data.atividades_nao_programadas.find((a) => a.usuario_id === user.id && a.data === body.data && a.empresa_id === user.empresa_id);
  if (existente) {
    existente.atividades = validacao.atividades;
    existente.atualizado_em = new Date().toISOString();
    db.save(data);
    return enviarJSON(res, 200, { atividade: existente });
  }
  const item = tenant.criar(data, 'atividades_nao_programadas', user.empresa_id, {
    usuario_id: user.id, data: body.data, atividades: validacao.atividades,
    criado_em: new Date().toISOString(), atualizado_em: null,
  });
  db.save(data);
  enviarJSON(res, 201, { atividade: item });
});

// ---------- solicitações de RH do técnico (folga, banco de horas, férias, home office) ----------
// mesmo padrão de "solicitação -> aprovação" já usado em outras partes do sistema (ex.: solicitação
// de edição na biblioteca) — o técnico pede, o administrador aprova ou reprova com uma resposta.

const TIPOS_SOLICITACAO_RH = ['folga', 'banco_horas', 'ferias', 'home_office'];
const LABEL_SOLICITACAO_RH = { folga: 'folga', banco_horas: 'banco de horas', ferias: 'férias', home_office: 'home office' };
// pra qual tipo de escala_folgas cada solicitação aprovada vira (ver POST .../decidir) — "folga"
// pedida pelo técnico não é bem um DSR (que é escala da empresa, não pedido individual), mas do
// ponto de vista de quem lê o calendário é a mesma coisa: um dia em que essa pessoa não trabalha.
const MAPA_TIPO_SOLICITACAO_PARA_ESCALA = { folga: 'dsr', banco_horas: 'banco_horas', home_office: 'home_office', ferias: 'ferias' };

// POST /api/solicitacoes-rh — o técnico cria um pedido
rota('POST', /^\/api\/solicitacoes-rh$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico faz esse tipo de solicitação.' });
  const body = await lerCorpo(req);
  if (!TIPOS_SOLICITACAO_RH.includes(body.tipo)) return enviarJSON(res, 400, { erro: 'Tipo de solicitação inválido.' });
  if (!body.data_inicio) return enviarJSON(res, 400, { erro: 'Informe a data.' });

  // banco de horas: crédito é hora extra trabalhada (o técnico informa quantas, não tira ele do
  // expediente) — débito é hora que ele vai usar, então em vez de digitar um número solto, ele
  // escolhe COMO: o dia inteiro (carga cheia) ou um horário específico de entrada/saída, e o
  // sistema calcula as horas sozinho, sem risco de conta errada.
  let horasBanco = null;
  let modalidadeBanco = null;
  let horarioBanco = null;
  if (body.tipo === 'banco_horas') {
    if (!['credito', 'debito'].includes(body.operacao)) {
      return enviarJSON(res, 400, { erro: 'Informe se é crédito ou débito no banco de horas.' });
    }
    if (body.operacao === 'credito') {
      if (!body.horas || Number(body.horas) <= 0) return enviarJSON(res, 400, { erro: 'Informe as horas.' });
      horasBanco = Number(body.horas);
    } else {
      if (!MODALIDADES_BANCO_HORAS.includes(body.modalidade_banco)) {
        return enviarJSON(res, 400, { erro: 'Escolha como quer usar o banco de horas: dia inteiro, entrar mais tarde ou sair mais cedo.' });
      }
      modalidadeBanco = body.modalidade_banco;
      if (modalidadeBanco !== 'dia_inteiro') {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.horario || '')) return enviarJSON(res, 400, { erro: 'Informe o horário.' });
        horarioBanco = body.horario;
      }
      horasBanco = horasBancoDaModalidade(modalidadeBanco, horarioBanco);
      if (!(horasBanco > 0)) return enviarJSON(res, 400, { erro: 'Horário fora do expediente (08:00–17:00).' });
    }
  }

  if (!String(body.motivo || '').trim()) return enviarJSON(res, 400, { erro: 'Descreva o motivo do pedido.' });
  const data = db.load();
  const item = tenant.criar(data, 'solicitacoes_rh', user.empresa_id, {
    tecnico_id: user.id,
    tipo: body.tipo,
    data_inicio: body.data_inicio,
    data_fim: body.data_fim || body.data_inicio,
    horas: body.tipo === 'banco_horas' ? horasBanco : null,
    operacao: body.tipo === 'banco_horas' ? body.operacao : null,
    modalidade_banco: modalidadeBanco,
    horario: horarioBanco,
    motivo: String(body.motivo).trim(),
    status: 'pendente',
    resposta_admin: '',
    lida_tecnico: true,
    criado_em: new Date().toISOString(),
    resolvido_em: null,
    resolvido_por: null,
  });
  db.save(data);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  await Promise.all(admins.map((a) => enviarPush(data, a.id, {
    titulo: 'Nova solicitação de técnico',
    corpo: `${user.nome} pediu ${LABEL_SOLICITACAO_RH[body.tipo]}.`,
    url: '/',
  }).catch(() => {})));
  enviarJSON(res, 201, { solicitacao: item });
});

// GET /api/solicitacoes-rh — técnico vê só as dele; administrador vê de todo mundo (com filtros
// opcionais ?tipo= e ?status=)
rota('GET', /^\/api\/solicitacoes-rh$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const solicitacoesDaEmpresa = tenant.listar(data, 'solicitacoes_rh', user.empresa_id);
  let lista = user.papel === 'suporte' ? solicitacoesDaEmpresa.filter((s) => s.tecnico_id === user.id) : solicitacoesDaEmpresa.slice();
  if (query.tipo) lista = lista.filter((s) => s.tipo === query.tipo);
  if (query.status) lista = lista.filter((s) => s.status === query.status);
  lista = lista
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))
    .map((s) => ({ ...s, tecnico_nome: (data.usuarios.find((u) => u.id === s.tecnico_id && u.empresa_id === user.empresa_id) || {}).nome || '—' }));
  enviarJSON(res, 200, { solicitacoes: lista });
});

// POST /api/solicitacoes-rh/:id/decidir — administrador aprova ou reprova
rota('POST', /^\/api\/solicitacoes-rh\/(\d+)\/decidir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador decide solicitações.' });
  const body = await lerCorpo(req);
  if (!['aprovado', 'reprovado'].includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
  const data = db.load();
  const item = tenant.buscar(data, 'solicitacoes_rh', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Esta solicitação já foi decidida.' });
  item.status = body.status;
  item.resposta_admin = String(body.resposta_admin || '').trim();
  item.lida_tecnico = false;
  item.resolvido_em = new Date().toISOString();
  item.resolvido_por = user.id;

  // aprovado: reflete na Escala de Folga automaticamente, pra virar tag nos calendários (admin e
  // técnico) sem o administrador precisar marcar de novo à mão. Banco de horas em crédito fica de
  // fora — é hora extra trabalhada, não tira ninguém do expediente, então não bloqueia nenhum dia.
  if (body.status === 'aprovado' && MAPA_TIPO_SOLICITACAO_PARA_ESCALA[item.tipo] && !(item.tipo === 'banco_horas' && item.operacao !== 'debito')) {
    const tipoEscala = MAPA_TIPO_SOLICITACAO_PARA_ESCALA[item.tipo];
    diasEntreISO(item.data_inicio, item.data_fim).forEach((diaISO) => {
      marcarEscalaFolgaDia(data, user.empresa_id, {
        usuarioId: item.tecnico_id,
        diaISO,
        tipo: tipoEscala,
        modalidadeBanco: item.tipo === 'banco_horas' ? item.modalidade_banco : null,
        horario: item.tipo === 'banco_horas' ? item.horario : null,
        definidoPor: user.id,
      });
    });
  }

  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: `Solicitação ${body.status === 'aprovado' ? 'aprovada' : 'reprovada'}`,
    corpo: `Seu pedido de ${LABEL_SOLICITACAO_RH[item.tipo]} foi ${body.status === 'aprovado' ? 'aprovado' : 'reprovado'}${item.resposta_admin ? ': ' + item.resposta_admin : '.'}`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { solicitacao: item });
});

// POST /api/solicitacoes-rh/:id/marcar-lida — o técnico marcou a decisão como vista
rota('POST', /^\/api\/solicitacoes-rh\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const item = data.solicitacoes_rh.find((s) => s.id === Number(m[1]) && s.tecnico_id === user.id && s.empresa_id === user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  item.lida_tecnico = true;
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// DELETE /api/solicitacoes-rh/:id — o técnico desiste de um pedido ainda pendente
rota('DELETE', /^\/api\/solicitacoes-rh\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const solicitacaoExcluir = data.solicitacoes_rh.find((s) => s.id === Number(m[1]) && s.tecnico_id === user.id && s.empresa_id === user.empresa_id);
  if (!solicitacaoExcluir) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacaoExcluir.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Só é possível cancelar um pedido ainda pendente.' });
  data.solicitacoes_rh = data.solicitacoes_rh.filter((s) => s.id !== solicitacaoExcluir.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// checa se a O.S. já pode chegar na etapa de feedback do cliente: o relatório original
// precisa estar aprovado, o orçamento (se houve peças fornecidas) precisa estar aprovado, e
// não pode haver um retorno do técnico ainda pendente
function erroAntesDoFeedback(data, item) {
  const visita = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && (v.rodada || 1) === 1);
  if (!visita || visita.status_aprovacao !== 'aprovado') {
    return 'Só é possível avançar depois do relatório aprovado.';
  }
  if (visita.laudo && Array.isArray(visita.laudo.pecas) && visita.laudo.pecas.length > 0 && !item.orcamento_aprovado_em) {
    return 'Aprove o orçamento das peças fornecidas antes de avançar.';
  }
  if (item.retorno_pendente_tecnico) {
    return 'Aguarde o técnico enviar o relatório de retorno antes de avançar.';
  }
  return null;
}

// POST /api/agenda/:id/orcamento-aprovado — quando o relatório aprovado tem peças fornecidas,
// o administrador aprova o orçamento antes de seguir; se o técnico também marcou necessidade
// de retorno, libera pra ele enviar um segundo relatório (de retorno) antes do feedback.
rota('POST', /^\/api\/agenda\/(\d+)\/orcamento-aprovado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador aprova o orçamento.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const visita = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && (v.rodada || 1) === 1);
  if (!visita || visita.status_aprovacao !== 'aprovado') {
    return enviarJSON(res, 400, { erro: 'Só é possível aprovar o orçamento depois do relatório aprovado.' });
  }
  if (!visita.laudo || !Array.isArray(visita.laudo.pecas) || visita.laudo.pecas.length === 0) {
    return enviarJSON(res, 400, { erro: 'Este relatório não tem peças fornecidas.' });
  }
  if (item.orcamento_aprovado_em) return enviarJSON(res, 400, { erro: 'O orçamento já foi aprovado.' });
  item.orcamento_aprovado_em = new Date().toISOString();
  if (visita.laudo.necessidade_retorno) item.retorno_pendente_tecnico = true;
  db.save(data);
  if (item.retorno_pendente_tecnico) {
    enviarPush(data, item.tecnico_id, {
      titulo: 'Orçamento aprovado — retorno necessário',
      corpo: `O orçamento da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')} foi aprovado. Envie o relatório de retorno quando concluir.`,
      url: '/',
    }).catch(() => {});
  }
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/orcamento-reprovado — o cliente não aprovou o orçamento das peças
// fornecidas pelo técnico; não tem mais serviço a fazer, então a O.S. é finalizada direto (mesmo
// comportamento de quando o cliente reprova pelo caminho do pós-venda).
rota('POST', /^\/api\/agenda\/(\d+)\/orcamento-reprovado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador registra a decisão do orçamento.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const visita = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && (v.rodada || 1) === 1);
  if (!visita || visita.status_aprovacao !== 'aprovado') {
    return enviarJSON(res, 400, { erro: 'Só é possível decidir o orçamento depois do relatório aprovado.' });
  }
  if (!visita.laudo || !Array.isArray(visita.laudo.pecas) || visita.laudo.pecas.length === 0) {
    return enviarJSON(res, 400, { erro: 'Este relatório não tem peças fornecidas.' });
  }
  if (item.orcamento_aprovado_em) return enviarJSON(res, 400, { erro: 'O orçamento já foi aprovado.' });
  if (item.orcamento_reprovado_em) return enviarJSON(res, 400, { erro: 'O orçamento já foi reprovado.' });
  const agora = new Date().toISOString();
  item.orcamento_reprovado_em = agora;
  item.finalizada = true;
  item.finalizado_em = agora;
  await encerrarChamadoDaOS(data, item);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/registrar-feedback — administrador marca que o cliente aprovou o
// serviço ("Cliente OK"); é o passo anterior e obrigatório antes de poder finalizar a O.S.
rota('POST', /^\/api\/agenda\/(\d+)\/registrar-feedback$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador registra o feedback do cliente.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const erro = erroAntesDoFeedback(data, item);
  if (erro) return enviarJSON(res, 400, { erro });
  if (item.feedback_cliente_em) return enviarJSON(res, 400, { erro: 'O feedback do cliente já foi registrado.' });
  item.feedback_cliente_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/retrabalho — administrador registra que o cliente deu um feedback
// negativo e precisa de um retorno do técnico (ex.: novo treinamento). Só é permitido uma
// rodada extra por O.S. — se já existe um relatório de retorno, não libera de novo.
rota('POST', /^\/api\/agenda\/(\d+)\/retrabalho$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador registra o retrabalho.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const erro = erroAntesDoFeedback(data, item);
  if (erro) return enviarJSON(res, 400, { erro });
  if (item.feedback_cliente_em) return enviarJSON(res, 400, { erro: 'O feedback do cliente já foi registrado.' });
  if (item.retrabalho || data.visitas.some((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && v.rodada === 2)) {
    return enviarJSON(res, 400, { erro: 'Esta O.S. já passou por uma rodada de retrabalho.' });
  }
  item.retrabalho = true;
  item.retorno_pendente_tecnico = true;
  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Retorno necessário',
    corpo: `O cliente pediu um retorno na O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}. Envie um novo relatório quando concluir.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/finalizar — administrador confirma o fechamento da O.S. depois do
// feedback do cliente já registrado; a partir daqui a O.S. vira registro histórico, sem mais
// alterações (um novo atendimento pede uma O.S. nova). Só pode finalizar depois de aprovada,
// com o feedback já registrado, e com pelo menos 1 dia completo desde a aprovação — a menos
// que o administrador mande pular essas etapas (body.forcar), quando julgar necessário.
rota('POST', /^\/api\/agenda\/(\d+)\/finalizar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador finaliza ordens de serviço.' });
  const body = await lerCorpo(req);
  const forcar = !!body.forcar;
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já está finalizada.' });
  const visita = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && (v.rodada || 1) === 1);
  if (item.status !== 'concluida' || !visita || visita.status_aprovacao !== 'aprovado') {
    return enviarJSON(res, 400, { erro: 'Só é possível finalizar uma O.S. já concluída e aprovada.' });
  }
  const agora = new Date().toISOString();
  if (!forcar) {
    if (!item.feedback_cliente_em) {
      return enviarJSON(res, 400, { erro: 'Registre o feedback do cliente antes de finalizar esta O.S.' });
    }
    const visitaRetorno = data.visitas.find((v) => v.agenda_id === item.id && v.empresa_id === item.empresa_id && v.rodada === 2);
    const visitaBase = visitaRetorno || visita;
    const umDiaEmMs = 24 * 60 * 60 * 1000;
    if (!visitaBase.data_aprovacao || (Date.now() - new Date(visitaBase.data_aprovacao).getTime()) < umDiaEmMs) {
      return enviarJSON(res, 400, { erro: 'Aguarde pelo menos 1 dia após a conclusão para finalizar esta O.S.' });
    }
  } else {
    // pulando etapas: preenche os controles pendentes (orçamento, retorno, feedback) pra
    // manter a linha do tempo coerente, em vez de deixá-los soltos numa O.S. já finalizada
    if (!item.orcamento_aprovado_em && visita.laudo && Array.isArray(visita.laudo.pecas) && visita.laudo.pecas.length > 0) {
      item.orcamento_aprovado_em = agora;
    }
    item.retorno_pendente_tecnico = false;
    if (!item.feedback_cliente_em) item.feedback_cliente_em = agora;
  }
  item.finalizada = true;
  item.finalizado_em = agora;
  await encerrarChamadoDaOS(data, item);
  db.save(data);
  const clienteFinal = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Serviço confirmado pelo cliente',
    corpo: `${clienteFinal ? clienteFinal.nome_empresa : 'O atendimento'} confirmou e a O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')} foi finalizada.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// DELETE /api/agenda/:id — administrador exclui uma O.S. inteira (e a visita/registro de biblioteca
// vinculados, se houver — mesmo cascateamento do DELETE /api/visitas/:id)
rota('DELETE', /^\/api\/agenda\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui ordens de serviço.' });
  const data = db.load();
  const agendaItem = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!agendaItem) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  const visita = data.visitas.find((v) => v.agenda_id === agendaItem.id && v.empresa_id === agendaItem.empresa_id);
  if (visita) {
    data.registros = data.registros.filter((r) => !(r.origem === 'visita' && r.visita_id === visita.id));
    data.visitas = data.visitas.filter((v) => v.id !== visita.id);
  }
  data.agenda = data.agenda.filter((a) => a.id !== agendaItem.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/agenda/:id/marcar-lida — o técnico marcou a notificação de nova O.S. atribuída como vista
rota('POST', /^\/api\/agenda\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  item.lida_tecnico = true;
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/confirmar-cliente — administrador confirma que o cliente já aceitou o
// agendamento (2ª etapa da linha do tempo); libera o técnico pra iniciar o deslocamento e
// executar a O.S. — sem essa confirmação, essas próximas fases ficam bloqueadas.
rota('POST', /^\/api\/agenda\/(\d+)\/confirmar-cliente$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador confirma o cliente.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'O cliente já foi confirmado para esta O.S.' });
  item.confirmado_cliente_em = new Date().toISOString();
  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Cliente confirmado',
    corpo: `O cliente confirmou o atendimento da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')} — já pode iniciar o deslocamento quando for a hora.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/iniciar-deslocamento — o técnico avisa que já está a caminho do cliente;
// fica marcado na linha do tempo da O.S. e notifica o administrador. Se a O.S. estiver com um
// retorno pendente (peças que exigiram um segundo deslocamento, ou retrabalho), marca o
// deslocamento DO RETORNO em vez de mexer no deslocamento original, já concluído.
// se o técnico não registrou "Iniciar retorno" na O.S. anterior do mesmo dia (ex: almoçou no
// próprio cliente) e foi direto pra próxima O.S. já iniciando o deslocamento dela, o sistema
// entende que esse deslocamento É o retorno daquela O.S. anterior — evita ter que registrar a
// mesma viagem duas vezes, uma em cada O.S. Só liga quando ainda não existe nenhum retorno
// registrado na origem (se o técnico já tinha clicado "Iniciar retorno" antes, sem encadear,
// isso não é sobrescrito).
function ligarRetornoImplicito(data, destino) {
  const dia = (destino.data_hora_inicio || '').slice(0, 10);
  if (!dia) return null;
  const origem = tenant.listar(data, 'agenda', destino.empresa_id).find((o) =>
    o.id !== destino.id && o.tecnico_id === destino.tecnico_id && !o.finalizada &&
    o.status === 'concluida' && !o.viagem_volta_iniciada_em &&
    (o.data_hora_inicio || '').slice(0, 10) === dia
  );
  if (!origem) return null;
  origem.viagem_volta_iniciada_em = destino.deslocamento_iniciado_em;
  origem.viagem_volta_destino_agenda_id = destino.id;
  return origem;
}
// espelho do acima: quando a chegada da O.S. de destino é confirmada, fecha também a chegada do
// retorno da O.S. de origem que apontava pra ela (encadeamento explícito via "Iniciar retorno" ou
// implícito via ligarRetornoImplicito — os dois deixam a mesma marca, viagem_volta_destino_agenda_id).
function completarRetornoImplicito(data, destino) {
  const origem = tenant.listar(data, 'agenda', destino.empresa_id).find((o) =>
    o.viagem_volta_destino_agenda_id === destino.id && !o.viagem_volta_chegada_em
  );
  if (origem) origem.viagem_volta_chegada_em = destino.chegada_confirmada_em;
  return origem || null;
}

rota('POST', /^\/api\/agenda\/(\d+)\/iniciar-deslocamento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado inicia o deslocamento.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  let origemRetorno = null;
  if (item.retorno_pendente_tecnico) {
    if (!item.retorno_confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de iniciar o deslocamento do retorno.' });
    if (item.retorno_deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.retorno_deslocamento_iniciado_em = new Date().toISOString();
  } else {
    if (!item.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de iniciar o deslocamento.' });
    if (item.deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.deslocamento_iniciado_em = new Date().toISOString();
    origemRetorno = ligarRetornoImplicito(data, item);
  }
  db.save(data);
  const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico a caminho',
      corpo: `${user.nome} iniciou o deslocamento para ${cliente ? cliente.nome_empresa : 'o cliente'} (${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}).`,
      url: '/',
    }).catch(() => {});
  });
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item), origem_retorno: origemRetorno ? agendaComDetalhes(data, origemRetorno) : null });
});

// POST /api/agenda/:id/confirmar-chegada — o técnico avisa que já chegou no cliente (depois do
// deslocamento já iniciado); só a partir daqui ele consegue preencher o relatório da visita. Se
// a O.S. estiver com um retorno pendente, use /retorno/confirmar-chegada em vez desta.
rota('POST', /^\/api\/agenda\/(\d+)\/confirmar-chegada$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado registra a chegada.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (!item.deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Inicie o deslocamento antes de registrar a chegada.' });
  if (item.chegada_confirmada_em) return enviarJSON(res, 400, { erro: 'A chegada já foi registrada.' });
  item.chegada_confirmada_em = new Date().toISOString();
  const origemRetorno = completarRetornoImplicito(data, item);
  db.save(data);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico chegou',
      corpo: `${user.nome} chegou no cliente da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
      url: '/',
    }).catch(() => {});
  });
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item), origem_retorno: origemRetorno ? agendaComDetalhes(data, origemRetorno) : null });
});

// POST /api/agenda/:id/iniciar-viagem-volta — o técnico avisa que está saindo do cliente depois
// de já ter enviado o relatório da visita (status "concluida"). Serve de base pro futuro cálculo
// de tempo total em deslocamento (ida + volta) — por enquanto só registra o horário.
// Se vier junto o id de outra O.S. do mesmo técnico no mesmo dia (proxima_os_id), o técnico está
// seguindo direto pra ela em vez de voltar pra empresa/hotel: marca essa segunda O.S. como se o
// deslocamento dela já tivesse sido iniciado agora (evita ter que abrir o card dela e clicar de
// novo em "Iniciar deslocamento" — ver iniciarDeslocamento/abrirEscolhaNavegacao no front).
rota('POST', /^\/api\/agenda\/(\d+)\/iniciar-viagem-volta$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado registra a viagem de volta.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.status !== 'concluida') return enviarJSON(res, 400, { erro: 'Envie o relatório desta visita antes de iniciar a viagem de volta.' });
  if (item.viagem_volta_iniciada_em) return enviarJSON(res, 400, { erro: 'A viagem de volta já foi marcada como iniciada.' });
  let proximaOS = null;
  if (body.proxima_os_id) {
    proximaOS = tenant.buscar(data, 'agenda', Number(body.proxima_os_id), user.empresa_id);
    if (!proximaOS || proximaOS.tecnico_id !== user.id) return enviarJSON(res, 404, { erro: 'A próxima O.S. informada não é sua ou não existe.' });
    if (!proximaOS.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Essa O.S. ainda não tem a confirmação do cliente — não dá pra seguir direto pra ela.' });
    if (proximaOS.deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'O deslocamento dessa O.S. já tinha sido iniciado.' });
  }
  const agora = new Date().toISOString();
  item.viagem_volta_iniciada_em = agora;
  item.viagem_volta_destino_agenda_id = proximaOS ? proximaOS.id : null;
  if (proximaOS) proximaOS.deslocamento_iniciado_em = agora;
  db.save(data);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico iniciou o retorno',
      corpo: proximaOS
        ? `${user.nome} saiu de ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')} direto pra ${proximaOS.numero_os || 'OS-' + String(proximaOS.id).padStart(6, '0')}.`
        : `${user.nome} iniciou a viagem de volta da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
      url: '/',
    }).catch(() => {});
  });
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item), proxima_os: proximaOS ? agendaComDetalhes(data, proximaOS) : null });
});

// POST /api/agenda/:id/confirmar-chegada-volta — o técnico avisa que já chegou (na empresa, hotel
// etc.) depois da viagem de volta. Só registra o horário — não precisa de mais detalhe agora,
// serve de base pro futuro menu de cálculo de tempo em trânsito.
rota('POST', /^\/api\/agenda\/(\d+)\/confirmar-chegada-volta$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado registra a chegada.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (!item.viagem_volta_iniciada_em) return enviarJSON(res, 400, { erro: 'Inicie a viagem de volta antes de registrar a chegada.' });
  if (item.viagem_volta_chegada_em) return enviarJSON(res, 400, { erro: 'A chegada já foi registrada.' });
  item.viagem_volta_chegada_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/retorno/confirmar-cliente — administrador confirma que o cliente já
// aceitou o retorno do técnico (peças que exigiram um novo deslocamento, ou retrabalho por
// feedback negativo). Espelha /confirmar-cliente, mas pro retorno — sem isso o técnico não
// consegue iniciar o deslocamento do retorno.
rota('POST', /^\/api\/agenda\/(\d+)\/retorno\/confirmar-cliente$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador confirma o cliente.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (!item.retorno_pendente_tecnico) return enviarJSON(res, 400, { erro: 'Esta O.S. não tem retorno pendente.' });
  if (item.retorno_confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'O cliente já foi confirmado para o retorno.' });
  item.retorno_confirmado_cliente_em = new Date().toISOString();
  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Cliente confirmado (retorno)',
    corpo: `O cliente confirmou o retorno da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')} — já pode iniciar o deslocamento quando for a hora.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/retorno/confirmar-chegada — o técnico avisa que já chegou no cliente pro
// retorno (depois do deslocamento do retorno já iniciado); só a partir daqui ele consegue enviar
// o relatório do retorno.
rota('POST', /^\/api\/agenda\/(\d+)\/retorno\/confirmar-chegada$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado registra a chegada.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (!item.retorno_pendente_tecnico) return enviarJSON(res, 400, { erro: 'Esta O.S. não tem retorno pendente.' });
  if (!item.retorno_deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Inicie o deslocamento do retorno antes de registrar a chegada.' });
  if (item.retorno_chegada_confirmada_em) return enviarJSON(res, 400, { erro: 'A chegada já foi registrada.' });
  item.retorno_chegada_confirmada_em = new Date().toISOString();
  db.save(data);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico chegou (retorno)',
      corpo: `${user.nome} chegou pro retorno da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
      url: '/',
    }).catch(() => {});
  });
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/visitas  (técnico registra o diário técnico de uma atividade)
rota('POST', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico pode registrar uma visita.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const data = db.load();
  const agendaItem = tenant.buscar(data, 'agenda', Number(body.agenda_id), user.empresa_id);
  if (!agendaItem) return enviarJSON(res, 404, { erro: 'Atividade de agenda não encontrada.' });

  // atendimento (chat) virado O.S. de pós-venda/reparo: o setor de reparo preenche o relatório
  // (diagnóstico antes do orçamento, ou liberação depois do orçamento aprovado pelo cliente) —
  // mesmo formulário do laudo técnico, mas nasce já aprovado (sem fila do gestor) e não segue o
  // fluxo normal de deslocamento/orçamento/feedback do cliente — ver "pós-venda / setor reparo"
  if (agendaItem.tipo === 'atendimento' && ['em_diagnostico_reparo', 'executando_reparo'].includes(agendaItem.fase_atendimento)) {
    if (!exigirPapel(user, ['suporte', 'administrador']) || !temAcessoMenu(data, user, 'fila-reparo')) return enviarJSON(res, 403, { erro: 'Só o setor de reparo preenche este relatório.' });
    const laudoCompleto = { ...(body.laudo || {}), ...dadosAtendimentoBloqueados(data, agendaItem, user) };
    const erroLaudo = validarLaudoTecnico(laudoCompleto);
    if (erroLaudo) return enviarJSON(res, 400, { erro: erroLaudo });
    const equipamentoReparo = tenant.buscar(data, 'equipamentos', agendaItem.equipamento_id, agendaItem.empresa_id);
    const { erro: erroFmeaReparo, resultado: fmeaReparo } = resolverCascataFmea(data, agendaItem.empresa_id, equipamentoReparo ? equipamentoReparo.catalogo_id : null, body.laudo || {});
    if (erroFmeaReparo) return enviarJSON(res, 400, { erro: erroFmeaReparo });
    Object.assign(laudoCompleto, fmeaReparo);
    const rodada = data.visitas.filter((v) => v.agenda_id === agendaItem.id && v.empresa_id === agendaItem.empresa_id).length + 1;
    const agora = new Date().toISOString();
    const visitaReparo = tenant.criar(data, 'visitas', agendaItem.empresa_id, {
      agenda_id: agendaItem.id, tecnico_id: user.id, equipamento_id: agendaItem.equipamento_id,
      rodada, criado_em: agora,
      analise: body.analise || '', causa: body.causa || laudoCompleto.laudo_tecnico || '', correcao: body.correcao || laudoCompleto.servico_realizado || '',
      resultado: body.resultado || 'solucionado', relevante_biblioteca: !!body.relevante_biblioteca,
      relatorio: null, relatorio_simples: null, laudo: laudoCompleto,
      status_aprovacao: 'aprovado', aprovado_por: null, data_aprovacao: agora,
      solicitacao_reabertura: null, lida_tecnico: false,
    });
    agendaItem.tecnico_id = user.id;
    if (agendaItem.fase_atendimento === 'em_diagnostico_reparo') {
      agendaItem.fase_atendimento = 'aguardando_pos_venda';
      db.save(data);
      const posVendas = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'pos_venda');
      await Promise.all(posVendas.map((pv) => enviarPush(data, pv.id, {
        titulo: 'Diagnóstico pronto — enviar orçamento',
        corpo: `${agendaItem.numero_os || 'OS-' + String(agendaItem.id).padStart(6, '0')} está de volta pro pós-venda.`,
        url: '/',
      }).catch(() => {})));
    } else {
      // reparo liberou o equipamento — falta só o estoque confirmar a saída pra finalizar
      agendaItem.equipamento_liberado_reparo_em = agora;
      agendaItem.fase_atendimento = 'aguardando_saida_estoque';
      db.save(data);
      const estoques = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'estoque');
      await Promise.all(estoques.map((e) => enviarPush(data, e.id, {
        titulo: 'Equipamento liberado — confirmar saída',
        corpo: `${agendaItem.numero_os || 'OS-' + String(agendaItem.id).padStart(6, '0')} pronto pra devolução ao cliente.`,
        url: '/',
      }).catch(() => {})));
    }
    return enviarJSON(res, 201, { visita: visitaReparo });
  }

  if (agendaItem.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta atividade não é sua.' });
  if (!agendaItem.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de executar esta O.S.' });
  if (agendaItem.retorno_pendente_tecnico && !agendaItem.retorno_deslocamento_iniciado_em) {
    return enviarJSON(res, 400, { erro: 'Inicie o deslocamento antes de enviar o relatório de retorno.' });
  }

  // dados do atendimento (cliente, contato, endereço, equipamento, datas, técnico) são sempre os que o
  // administrador definiu na agenda — o que vier do técnico para esses campos é ignorado
  const bloqueados = dadosAtendimentoBloqueados(data, agendaItem, user);

  let relatorio = null;
  let relatorioSimples = null;
  let laudo = null;
  if (TIPOS_LAUDO_TECNICO.includes(agendaItem.tipo)) {
    const laudoCompleto = { ...(body.laudo || {}), ...bloqueados };
    const erro = validarLaudoTecnico(laudoCompleto);
    if (erro) return enviarJSON(res, 400, { erro });
    const equipamentoDaOS = tenant.buscar(data, 'equipamentos', agendaItem.equipamento_id, agendaItem.empresa_id);
    const { erro: erroFmea, resultado: fmea } = resolverCascataFmea(data, agendaItem.empresa_id, equipamentoDaOS ? equipamentoDaOS.catalogo_id : null, body.laudo || {});
    if (erroFmea) return enviarJSON(res, 400, { erro: erroFmea });
    laudo = { ...laudoCompleto, ...fmea };
  } else if (TIPOS_TERMO_ACEITE.includes(agendaItem.tipo)) {
    const relatorioCompleto = { ...(body.relatorio || {}), ...bloqueados };
    const erro = validarRelatorio(relatorioCompleto);
    if (erro) return enviarJSON(res, 400, { erro });
    relatorio = relatorioCompleto;
  } else if (agendaItem.tipo === 'treinamento_online' || agendaItem.tipo === 'demonstracao_tecnica') {
    const relatorioSimplesCompleto = {
      ...(body.relatorio_simples || {}),
      empresa: bloqueados.empresa,
      contato: bloqueados.contato,
      telefone: bloqueados.telefone,
      tecnico_nome: bloqueados.tecnico_nome,
      equipamento_tipo: bloqueados.equipamento_tipo,
      equipamento_modelo: bloqueados.modelo_maquina,
      numero_serie: bloqueados.numero_serie,
    };
    const erro = validarRelatorioSimples(relatorioSimplesCompleto, agendaItem.tipo === 'treinamento_online');
    if (erro) return enviarJSON(res, 400, { erro });
    relatorioSimples = relatorioSimplesCompleto;
  }

  const camposVisita = {
    analise: body.analise || '',
    causa: body.causa || (laudo ? laudo.laudo_tecnico : '') || (relatorio ? relatorio.servico : '') || (relatorioSimples ? `${relatorioSimples.equipamento_tipo} ${relatorioSimples.equipamento_modelo}`.trim() : ''),
    correcao: body.correcao || (laudo ? laudo.servico_realizado : '') || (relatorio ? relatorio.observacoes : '') || (relatorioSimples ? relatorioSimples.observacoes : ''),
    resultado: body.resultado || 'solucionado', // solucionado | parcial | nao_solucionado | aguardando_peca
    relevante_biblioteca: !!body.relevante_biblioteca,
    relatorio,
    relatorio_simples: relatorioSimples,
    laudo,
    status_aprovacao: 'pendente',
    aprovado_por: null,
    data_aprovacao: null,
    solicitacao_reabertura: null,
    lida_tecnico: false,
  };

  // retorno do técnico (depois de orçamento aprovado com necessidade de retorno, ou de um
  // retrabalho por feedback negativo do cliente): gera um SEGUNDO relatório, separado do
  // original, e já entra aprovado — sem passar de novo pela fila do gestor
  if (agendaItem.retorno_pendente_tecnico) {
    const visitaRetorno = tenant.criar(data, 'visitas', agendaItem.empresa_id, { agenda_id: agendaItem.id, tecnico_id: user.id, equipamento_id: agendaItem.equipamento_id, rodada: 2, criado_em: new Date().toISOString(), ...camposVisita });
    visitaRetorno.status_aprovacao = 'aprovado';
    visitaRetorno.aprovado_por = null;
    visitaRetorno.data_aprovacao = new Date().toISOString();
    agendaItem.retorno_pendente_tecnico = false;
    db.save(data);
    const adminsRetorno = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
    adminsRetorno.forEach((admin) => {
      enviarPush(data, admin.id, {
        titulo: 'Relatório de retorno enviado',
        corpo: `${user.nome} enviou o relatório de retorno da O.S. ${agendaItem.numero_os || 'OS-' + String(agendaItem.id).padStart(6, '0')}.`,
        url: '/',
      }).catch(() => {});
    });
    return enviarJSON(res, 201, { visita: visitaRetorno });
  }

  // se a atividade já tinha uma visita (reaberta pelo administrador), edita a mesma em vez de duplicar
  let visita = data.visitas.find((v) => v.agenda_id === agendaItem.id && v.empresa_id === agendaItem.empresa_id && (v.rodada || 1) === 1);
  if (visita) {
    Object.assign(visita, camposVisita, { atualizado_em: new Date().toISOString() });
  } else {
    visita = tenant.criar(data, 'visitas', agendaItem.empresa_id, { agenda_id: agendaItem.id, tecnico_id: user.id, equipamento_id: agendaItem.equipamento_id, criado_em: new Date().toISOString(), ...camposVisita });
  }
  agendaItem.status = 'concluida';
  agendaItem.concluida_em = new Date().toISOString();

  // marcado como relevante: entra na fila de aprovação da Biblioteca de Defeitos/Falhas assim que o
  // técnico envia o relatório — o administrador vê na tela de Biblioteca > Aprovação e no sino, sem
  // depender de já ter aprovado a O.S. em si
  const registroExistente = data.registros.find((r) => r.origem === 'visita' && r.visita_id === visita.id && r.empresa_id === visita.empresa_id);
  if (camposVisita.relevante_biblioteca) {
    const eq = data.equipamentos.find((e) => e.id === visita.equipamento_id && e.empresa_id === visita.empresa_id);
    const titulo = agendaItem.problema || 'Caso técnico';
    const campos = {
      titulo,
      equipamento_tipo: eq ? eq.tipo : 'Equipamento',
      equipamento_modelo: eq ? eq.modelo : '',
      numero_serie: eq ? eq.numero_serie : '',
      sintoma: titulo,
      causa: camposVisita.causa,
      solucao: camposVisita.correcao,
      resultado: camposVisita.resultado,
      fotos: (camposVisita.laudo && Array.isArray(camposVisita.laudo.fotos)) ? camposVisita.laudo.fotos : [],
    };
    if (registroExistente) {
      Object.assign(registroExistente, campos);
    } else {
      tenant.criar(data, 'registros', visita.empresa_id, {
        tipo: 'defeito',
        origem: 'visita',
        visita_id: visita.id,
        autor_id: user.id,
        ...campos,
        status: 'em_analise',
        comentario_admin: null,
        lida: true,
        aprovado_por: null,
        data_aprovacao: null,
        criado_em: new Date().toISOString(),
      });
    }
  } else if (registroExistente && registroExistente.status === 'em_analise') {
    // o técnico desmarcou "relevante" antes de qualquer decisão do administrador — sai da fila
    data.registros = data.registros.filter((r) => r !== registroExistente);
  }

  db.save(data);
  enviarJSON(res, 201, { visita });
});

// GET /api/visitas/:id
rota('GET', /^\/api\/visitas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (user.papel === 'suporte' && visita.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  enviarJSON(res, 200, { visita: await hidratarFotosProfundo(visita) });
});

// POST /api/visitas/:id/enviar-relatorio  (envia o PDF do relatório corretivo por e-mail)
rota('POST', /^\/api\/visitas\/(\d+)\/enviar-relatorio$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico envia o relatório.' });
  const body = await lerCorpo(req);
  if (!body.pdf_base64 || !Array.isArray(body.emails) || body.emails.length === 0) {
    return enviarJSON(res, 400, { erro: 'PDF e ao menos um e-mail são obrigatórios.' });
  }
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (visita.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  const nomeArquivo = `relatorio-tecnico-${visita.id}.pdf`;
  const nomeEmpresa = (data.empresas.find((e) => e.id === user.empresa_id) || {}).nome;
  const resultado = await email.enviarRelatorio({ emails: body.emails, pdfBase64: body.pdf_base64, nomeArquivo, nomeEmpresa });
  enviarJSON(res, 200, { envio: resultado });
});

// GET /api/visitas?status=pendente
rota('GET', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'visitas', user.empresa_id);
  if (user.papel === 'suporte' && query.todas !== '1') lista = lista.filter((v) => v.tecnico_id === user.id);
  if (query.status) lista = lista.filter((v) => v.status_aprovacao === query.status);
  lista = lista.map((v) => {
    const eq = data.equipamentos.find((e) => e.id === v.equipamento_id && e.empresa_id === v.empresa_id);
    const tec = data.usuarios.find((u) => u.id === v.tecnico_id && u.empresa_id === v.empresa_id);
    return { ...v, equipamento_tipo: eq ? eq.tipo : null, tecnico_nome: tec ? tec.nome : null };
  });
  enviarJSON(res, 200, { visitas: lista });
});

// POST /api/visitas/:id/aprovar — body.incluir_biblioteca (opcional) também aprova de uma vez
// o registro de biblioteca vinculado (quando o técnico marcou o atendimento como relevante)
rota('POST', /^\/api\/visitas\/(\d+)\/aprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador aprova.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  visita.status_aprovacao = 'aprovado';
  visita.aprovado_por = user.id;
  visita.data_aprovacao = new Date().toISOString();
  visita.lida_tecnico = false;
  // o caso na Biblioteca de Defeitos/Falhas (quando marcado como relevante) já foi criado no
  // momento em que o técnico enviou o relatório — ver POST /api/visitas — e por padrão segue seu
  // próprio fluxo de aprovação em Biblioteca > Aprovação, independente da aprovação da O.S. em si;
  // "incluir_biblioteca" deixa o administrador aprovar os dois de uma vez só.
  if (body.incluir_biblioteca) {
    const registro = data.registros.find((r) => r.origem === 'visita' && r.visita_id === visita.id && r.empresa_id === visita.empresa_id);
    if (registro) {
      registro.status = 'aprovado';
      registro.comentario_admin = null;
      registro.aprovado_por = user.id;
      registro.data_aprovacao = new Date().toISOString();
    }
  }
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/reprovar
rota('POST', /^\/api\/visitas\/(\d+)\/reprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador reprova.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  visita.status_aprovacao = 'reprovado';
  visita.comentario_reprovacao = body.comentario || '';
  visita.aprovado_por = user.id;
  visita.data_aprovacao = new Date().toISOString();
  visita.lida_tecnico = false;
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/sugerir-edicao — administrador pede correção com comentário obrigatório;
// a O.S. volta a ficar "pendente" pro técnico refazer e reenviar o relatório
rota('POST', /^\/api\/visitas\/(\d+)\/sugerir-edicao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador sugere edições.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !body.comentario.trim()) return enviarJSON(res, 400, { erro: 'O comentário é obrigatório ao sugerir uma edição.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  visita.status_aprovacao = 'alteracao_sugerida';
  visita.comentario_edicao = body.comentario;
  visita.aprovado_por = user.id;
  visita.data_aprovacao = new Date().toISOString();
  visita.lida_tecnico = false;
  const agendaItem = tenant.buscar(data, 'agenda', visita.agenda_id, visita.empresa_id);
  if (agendaItem) agendaItem.status = 'pendente';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/marcar-lida — o técnico marcou a notificação de aprovação como vista
rota('POST', /^\/api\/visitas\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (visita.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  visita.lida_tecnico = true;
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// DELETE /api/visitas/:id — administrador exclui um relatório (e o caso de biblioteca vinculado, se houver)
rota('DELETE', /^\/api\/visitas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui relatórios.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  data.registros = data.registros.filter((r) => !(r.origem === 'visita' && r.visita_id === visita.id));
  data.visitas = data.visitas.filter((v) => v.id !== visita.id);
  const agendaItem = tenant.buscar(data, 'agenda', visita.agenda_id, visita.empresa_id);
  if (agendaItem) agendaItem.status = 'pendente';
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/visitas/:id/reabrir — administrador reabre um relatório já concluído (aprova qualquer solicitação pendente do técnico)
rota('POST', /^\/api\/visitas\/(\d+)\/reabrir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador reabre relatórios.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const agendaItem = tenant.buscar(data, 'agenda', visita.agenda_id, visita.empresa_id);
  if (agendaItem && agendaItem.finalizada) return enviarJSON(res, 403, { erro: 'Esta O.S. já foi finalizada e não pode mais ser reaberta.' });
  visita.status_aprovacao = 'pendente';
  visita.aprovado_por = null;
  visita.data_aprovacao = null;
  if (visita.solicitacao_reabertura) visita.solicitacao_reabertura.status = 'aprovada';
  if (agendaItem) agendaItem.status = 'pendente';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/solicitar-reabertura — técnico pede para reabrir um relatório concluído
rota('POST', /^\/api\/visitas\/(\d+)\/solicitar-reabertura$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico solicita reabertura.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (visita.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  visita.solicitacao_reabertura = { motivo: body.motivo || '', solicitado_em: new Date().toISOString(), status: 'pendente' };
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/recusar-reabertura — administrador recusa o pedido sem reabrir
rota('POST', /^\/api\/visitas\/(\d+)\/recusar-reabertura$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador decide sobre a reabertura.' });
  const data = db.load();
  const visita = tenant.buscar(data, 'visitas', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (!visita.solicitacao_reabertura) return enviarJSON(res, 400, { erro: 'Não há solicitação de reabertura para esta visita.' });
  visita.solicitacao_reabertura.status = 'recusada';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// ---------- biblioteca técnica: Defeitos/Falhas e Manual de Procedimentos ----------

const CAMPOS_DEFEITO = ['titulo', 'equipamento_tipo', 'equipamento_modelo', 'numero_serie', 'sintoma', 'causa', 'solucao'];
const CAMPOS_PROCEDIMENTO = ['titulo', 'equipamento_tipo', 'equipamento_modelo', 'periodicidade', 'precaucoes', 'ferramentas', 'passos', 'foto_destaque'];

function validarRegistro(body) {
  if (body.tipo !== 'defeito' && body.tipo !== 'procedimento') return 'Tipo inválido (use "defeito" ou "procedimento").';
  if (!body.titulo || !body.equipamento_tipo) return 'Título e equipamento são obrigatórios.';
  if (body.tipo === 'procedimento') {
    if (!Array.isArray(body.passos) || body.passos.length === 0) return 'Adicione ao menos um passo no procedimento.';
    for (const p of body.passos) {
      if (!p || !p.texto || !p.texto.trim()) return 'Todo passo precisa de uma descrição.';
    }
  } else {
    if (!body.sintoma || !body.causa || !body.solucao) return 'Sintoma, causa e solução são obrigatórios.';
  }
  return null;
}

function montarCamposRegistro(body) {
  const campos = body.tipo === 'procedimento' ? CAMPOS_PROCEDIMENTO : CAMPOS_DEFEITO;
  const out = {};
  for (const c of campos) out[c] = body[c] !== undefined ? body[c] : (c === 'passos' ? [] : '');
  return out;
}

// a lista de busca da biblioteca só mostra título/equipamento/nº de série numa tabela — as fotos
// nunca aparecem ali, só quando o caso é aberto (rota /api/registros/:id abaixo). Por isso a
// lista nem carrega as fotos: economiza banda (que no Render é limitada) a cada busca, já que
// cada resultado pode ter vários MB de fotos em base64.
function semFotosRegistro(r) {
  const { fotos, foto_destaque, ...resto } = r;
  if (Array.isArray(resto.passos)) {
    resto.passos = resto.passos.map((p) => { const { fotos: _fotosPasso, ...restoPasso } = p; return restoPasso; });
  }
  return resto;
}

// GET /api/registros?tipo=defeito|procedimento&q=&equipamento=&serie=  — biblioteca aprovada (qualquer usuário logado)
rota('GET', /^\/api\/registros$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'registros', user.empresa_id).filter((r) => r.status === 'aprovado');
  if (query.tipo) lista = lista.filter((r) => r.tipo === query.tipo);
  if (query.equipamento) {
    const eq = query.equipamento.toLowerCase();
    lista = lista.filter((r) => (r.equipamento_tipo || '').toLowerCase().includes(eq) || (r.equipamento_modelo || '').toLowerCase().includes(eq));
  }
  if (query.serie) {
    const s = query.serie.toLowerCase();
    lista = lista.filter((r) => (r.numero_serie || '').toLowerCase().includes(s));
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    lista = lista.filter((r) => [r.titulo, r.sintoma, r.causa, r.solucao].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  lista = lista.map((r) => semFotosRegistro(registroComAutor(data, r))).sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { registros: lista });
});

// GET /api/registros/:id — registro completo, COM fotos — usado só quando o caso é realmente
// aberto (a lista acima nunca traz fotos, por economia de banda)
rota('GET', /^\/api\/registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  enviarJSON(res, 200, { registro: await hidratarFotosProfundo(registroComAutor(data, registro)) });
});

// GET /api/registros/meus — o próprio autor vê todos os status dos registros que enviou
rota('GET', /^\/api\/registros\/meus$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const lista = tenant.listar(data, 'registros', user.empresa_id)
    .filter((r) => r.autor_id === user.id)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { registros: await hidratarFotosProfundo(lista) });
});

// GET /api/registros/ranking — ranking de técnicos que mais contribuíram com a biblioteca aprovada
rota('GET', /^\/api\/registros\/ranking$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const contagem = new Map();
  for (const r of tenant.listar(data, 'registros', user.empresa_id)) {
    if (r.status !== 'aprovado') continue;
    const atual = contagem.get(r.autor_id) || { total: 0, defeitos: 0, procedimentos: 0 };
    atual.total += 1;
    if (r.tipo === 'defeito') atual.defeitos += 1; else atual.procedimentos += 1;
    contagem.set(r.autor_id, atual);
  }
  const ranking = [...contagem.entries()].map(([autor_id, c]) => {
    const autor = data.usuarios.find((u) => u.id === autor_id && u.empresa_id === user.empresa_id);
    return { autor_id, autor_nome: autor ? autor.nome : 'Ex-usuário', ...c };
  }).sort((a, b) => b.total - a.total);
  enviarJSON(res, 200, { ranking });
});

// GET /api/registros/fila — administrador: fila de aprovação (status em_analise)
rota('GET', /^\/api\/registros\/fila$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador acessa a fila de aprovação.' });
  const data = db.load();
  const lista = tenant.listar(data, 'registros', user.empresa_id)
    .filter((r) => r.status === 'em_analise')
    .map((r) => registroComAutor(data, r))
    .sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  enviarJSON(res, 200, { registros: await hidratarFotosProfundo(lista) });
});

// POST /api/registros — técnico ou administrador envia um novo registro
rota('POST', /^\/api\/registros$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só técnico, produção ou administrador podem enviar registros.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const erro = validarRegistro(body);
  if (erro) return enviarJSON(res, 400, { erro });
  const data = db.load();
  const item = tenant.criar(data, 'registros', user.empresa_id, {
    tipo: body.tipo,
    origem: 'manual',
    autor_id: user.id,
    ...montarCamposRegistro(body),
    status: 'em_analise',
    comentario_admin: null,
    lida: true,
    aprovado_por: null,
    data_aprovacao: null,
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { registro: item });
});

// POST /api/registros/:id/reenviar — o autor edita e reenvia após uma alteração sugerida
rota('POST', /^\/api\/registros\/(\d+)\/reenviar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  if (registro.autor_id !== user.id) return enviarJSON(res, 403, { erro: 'Este registro não é seu.' });
  if (registro.status !== 'alteracao_sugerida') return enviarJSON(res, 400, { erro: 'Só é possível reenviar um registro com alteração sugerida.' });
  const erro = validarRegistro({ ...registro, ...body, tipo: registro.tipo });
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(registro, montarCamposRegistro({ ...registro, ...body, tipo: registro.tipo }));
  registro.status = 'em_analise';
  db.save(data);
  enviarJSON(res, 200, { registro });
});

// POST /api/registros/:id/aprovar — administrador
rota('POST', /^\/api\/registros\/(\d+)\/aprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador aprova.' });
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  registro.status = 'aprovado';
  registro.comentario_admin = null;
  registro.aprovado_por = user.id;
  registro.data_aprovacao = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { registro: await hidratarFotosProfundo(registro) });
});

// POST /api/registros/:id/sugerir-alteracao — administrador, comentário obrigatório
rota('POST', /^\/api\/registros\/(\d+)\/sugerir-alteracao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador sugere alterações.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !body.comentario.trim()) return enviarJSON(res, 400, { erro: 'O comentário é obrigatório ao sugerir uma alteração.' });
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  registro.status = 'alteracao_sugerida';
  registro.comentario_admin = body.comentario;
  registro.lida = false;
  db.save(data);
  enviarJSON(res, 200, { registro });
});

// PUT /api/registros/:id — administrador edita um registro (inclusive já aprovado) diretamente,
// sem passar pelo fluxo de reenvio/aprovação — registra quem e quando foi a última atualização.
rota('PUT', /^\/api\/registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita diretamente.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  const erro = validarRegistro({ ...registro, ...body, tipo: registro.tipo });
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(registro, montarCamposRegistro({ ...registro, ...body, tipo: registro.tipo }));
  registro.atualizado_em = new Date().toISOString();
  registro.atualizado_por_nome = user.nome;
  registro.solicitacao_edicao = null;
  db.save(data);
  enviarJSON(res, 200, { registro: await hidratarFotosProfundo(registroComAutor(data, registro)) });
});

// POST /api/registros/:id/solicitar-edicao — técnico pede ao administrador uma correção num
// caso já publicado na biblioteca (não é dono do registro, por isso não pode editar direto)
rota('POST', /^\/api\/registros\/(\d+)\/solicitar-edicao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico solicita edição.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !body.comentario.trim()) return enviarJSON(res, 400, { erro: 'Descreva o que precisa ser corrigido.' });
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  registro.solicitacao_edicao = { comentario: body.comentario, solicitante_id: user.id, solicitante_nome: user.nome, criado_em: new Date().toISOString() };
  db.save(data);
  enviarJSON(res, 200, { registro: await hidratarFotosProfundo(registroComAutor(data, registro)) });
});

// GET /api/registros/solicitacoes-edicao — administrador: casos publicados com pedido de correção pendente
rota('GET', /^\/api\/registros\/solicitacoes-edicao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê as solicitações de edição.' });
  const data = db.load();
  const lista = tenant.listar(data, 'registros', user.empresa_id)
    .filter((r) => r.solicitacao_edicao)
    .map((r) => registroComAutor(data, r))
    .sort((a, b) => (b.solicitacao_edicao.criado_em || '').localeCompare(a.solicitacao_edicao.criado_em || ''));
  enviarJSON(res, 200, { registros: await hidratarFotosProfundo(lista) });
});

// DELETE /api/registros/:id — administrador exclui um registro de biblioteca (pendente ou já aprovado)
rota('DELETE', /^\/api\/registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui registros.' });
  const data = db.load();
  const registroExcluir = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registroExcluir) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  data.registros = data.registros.filter((r) => r.id !== registroExcluir.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/registros/:id/marcar-lida — o autor marcou a notificação de alteração como vista
rota('POST', /^\/api\/registros\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const registro = tenant.buscar(data, 'registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  if (registro.autor_id !== user.id) return enviarJSON(res, 403, { erro: 'Este registro não é seu.' });
  registro.lida = true;
  db.save(data);
  enviarJSON(res, 200, { registro });
});

// ---------- notificação push (inscrição do dispositivo) ----------

// GET /api/push/chave-publica — chave VAPID pública, usada no navegador pra inscrever o
// dispositivo (pushManager.subscribe). Não precisa de login: é uma chave pública mesmo.
rota('GET', /^\/api\/push\/chave-publica$/, async (req, res) => {
  const data = db.load();
  enviarJSON(res, 200, { chave: data.vapid.publicKey });
});

// POST /api/push/inscrever — guarda a inscrição (endpoint + chaves) desse dispositivo pro
// usuário logado, pra poder mandar notificação push pra ele depois
rota('POST', /^\/api\/push\/inscrever$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  if (!body.endpoint || !body.keys || !body.keys.p256dh || !body.keys.auth) {
    return enviarJSON(res, 400, { erro: 'Inscrição de notificação inválida.' });
  }
  const data = db.load();
  data.push_subscriptions = data.push_subscriptions.filter((s) => s.endpoint !== body.endpoint);
  data.push_subscriptions.push({
    usuario_id: user.id,
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/push/desinscrever — remove a inscrição desse dispositivo (usuário desativou nas
// configurações do navegador, ou trocou de conta)
rota('POST', /^\/api\/push\/desinscrever$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  const data = db.load();
  data.push_subscriptions = data.push_subscriptions.filter((s) => !(s.usuario_id === user.id && s.endpoint === body.endpoint));
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- notificações ----------

// GET /api/notificacoes
rota('GET', /^\/api\/notificacoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let notificacoes = [];
  if (user.papel === 'suporte' || user.papel === 'producao') {
    notificacoes = tenant.listar(data, 'registros', user.empresa_id)
      .filter((r) => r.autor_id === user.id && r.status === 'alteracao_sugerida' && !r.lida)
      .map((r) => ({ id: r.id, tipo: 'alteracao_sugerida', texto: `Alteração sugerida em "${r.titulo}"`, registro_id: r.id }));
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'visitas', user.empresa_id)
        .filter((v) => v.tecnico_id === user.id && !v.lida_tecnico && ['aprovado', 'reprovado', 'alteracao_sugerida'].includes(v.status_aprovacao))
        .map((v) => {
          if (v.status_aprovacao === 'aprovado') {
            return { id: v.id, tipo: 'os_aprovada', texto: 'Relatório aprovado pelo administrador — gere o PDF na O.S.', registro_id: v.id };
          }
          if (v.status_aprovacao === 'reprovado') {
            return { id: v.id, tipo: 'os_reprovada', texto: `Relatório reprovado pelo administrador${v.comentario_reprovacao ? ': ' + v.comentario_reprovacao : ''}`, registro_id: v.id };
          }
          return { id: v.id, tipo: 'os_edicao_sugerida', texto: `Administrador pediu uma correção no relatório: ${v.comentario_edicao}`, registro_id: v.id };
        })
    );
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'agenda', user.empresa_id)
        .filter((a) => a.tecnico_id === user.id && !a.lida_tecnico)
        .map((a) => {
          // versão Restaurantes/rede multiunidade: O.S. de loja usa o mesmo sinalizador
          // (lida_tecnico) mas tem tela própria (Minha loja), não a Agenda de cliente externo.
          if (a.filial_id != null) {
            const filial = data.filiais.find((f) => f.id === a.filial_id && f.empresa_id === a.empresa_id);
            return { id: a.id, tipo: 'os_filial_atribuida', texto: `Nova O.S. — ${filial ? filial.nome : 'sua loja'}: ${a.problema || ''}`, registro_id: a.id };
          }
          const cliente = data.clientes.find((c) => c.id === a.cliente_id && c.empresa_id === a.empresa_id);
          return { id: a.id, tipo: 'os_atribuida', texto: `Nova Ordem de Serviço atribuída a você${cliente ? ' — ' + cliente.nome_empresa : ''}`, registro_id: a.id };
        })
    );
    if (user.papel === 'suporte') {
      notificacoes = notificacoes.concat(
        tenant.listar(data, 'chamados', user.empresa_id)
          .filter((c) => c.status === 'aguardando_tecnico' && !c.tecnico_id)
          .map((c) => {
            const cliente = data.clientes.find((cl) => cl.id === c.cliente_id && cl.empresa_id === c.empresa_id);
            return { id: c.id, tipo: 'chamado_fila', texto: `Atendimento aguardando técnico${cliente ? ' — ' + cliente.nome_empresa : ''}`, registro_id: c.id };
          })
      );
      notificacoes = notificacoes.concat(
        tenant.listar(data, 'chamados', user.empresa_id)
          .filter((c) => c.tecnico_id === user.id && !c.lida_tecnico)
          .map((c) => {
            const cliente = data.clientes.find((cl) => cl.id === c.cliente_id && cl.empresa_id === c.empresa_id);
            return { id: c.id, tipo: 'chamado_mensagem', texto: `Nova mensagem no atendimento${cliente ? ' — ' + cliente.nome_empresa : ''}`, registro_id: c.id };
          })
      );
    }
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'solicitacoes_rh', user.empresa_id)
        .filter((s) => s.tecnico_id === user.id && s.status !== 'pendente' && !s.lida_tecnico)
        .map((s) => ({ id: s.id, tipo: 'solicitacao_rh_decidida', texto: `Seu pedido de ${LABEL_SOLICITACAO_RH[s.tipo]} foi ${s.status}${s.resposta_admin ? ': ' + s.resposta_admin : '.'}`, registro_id: s.id }))
    );
  } else if (user.papel === 'cliente') {
    notificacoes = tenant.listar(data, 'chamados', user.empresa_id)
      .filter((c) => c.cliente_id === user.cliente_id && !c.lida_cliente)
      .map((c) => ({ id: c.id, tipo: 'chamado_mensagem_cliente', texto: 'Nova mensagem no seu atendimento', registro_id: c.id }));
  } else if (user.papel === 'administrador') {
    notificacoes = tenant.listar(data, 'registros', user.empresa_id)
      .filter((r) => r.status === 'em_analise')
      .map((r) => ({ id: r.id, tipo: 'aprovacao_pendente', texto: `"${r.titulo}" aguardando aprovação`, registro_id: r.id }));
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'visitas', user.empresa_id)
        .filter((v) => v.status_aprovacao === 'pendente')
        .map((v) => {
          const tecnico = data.usuarios.find((u) => u.id === v.tecnico_id && u.empresa_id === v.empresa_id);
          return { id: v.id, tipo: 'relatorio_pendente', texto: `Relatório de ${tecnico ? tecnico.nome : 'um técnico'} aguardando aprovação`, registro_id: v.id };
        })
    );
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'registros', user.empresa_id)
        .filter((r) => r.solicitacao_edicao)
        .map((r) => ({ id: r.id, tipo: 'edicao_solicitada_biblioteca', texto: `${r.solicitacao_edicao.solicitante_nome} pediu uma edição no caso "${r.titulo}" da biblioteca`, registro_id: r.id }))
    );
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'solicitacoes_rh', user.empresa_id)
        .filter((s) => s.status === 'pendente')
        .map((s) => {
          const tecnico = data.usuarios.find((u) => u.id === s.tecnico_id && u.empresa_id === user.empresa_id);
          return { id: s.id, tipo: 'solicitacao_rh_pendente', texto: `${tecnico ? tecnico.nome : 'Um técnico'} pediu ${LABEL_SOLICITACAO_RH[s.tipo]}`, registro_id: s.id };
        })
    );
    // versão Restaurantes/rede multiunidade (Fase 5 — Gestão e comunicação): administrador é a
    // "diretoria" que decide a última etapa de autorização de compra de peça.
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'solicitacoes_peca', user.empresa_id)
        .filter((s) => s.status === 'aguardando_diretoria')
        .map((s) => ({ id: s.id, tipo: 'peca_aguardando_diretoria', texto: `Autorização de compra pendente: ${s.descricao}`, registro_id: s.id }))
    );
    // pedido do usuário: pacote "Climatização / PMOC" — "atividades atrasadas ou não conformes
    // geram notificação no sininho". Só pra empresa do perfil Refrigeração com o módulo pmoc
    // contratado; só o administrador (quem designa técnico e acompanha os locais) recebe.
    if (empresaPerfilRefrigeracao(data, user.empresa_id) && db.moduloAtivo(data, user.empresa_id, 'pmoc')) {
      const hojeServidor = new Date().toISOString().slice(0, 10);
      const visitasAtrasadas = tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id)
        .filter((a) => a.pmoc_plano_id && a.data < hojeServidor && !['concluido', 'cancelado'].includes(a.status));
      notificacoes = notificacoes.concat(
        visitasAtrasadas.map((a) => ({ id: a.id, tipo: 'pmoc_preventiva_atrasada', texto: `Preventiva PMOC atrasada — ${a.cliente_nome} (${a.data.split('-').reverse().join('/')})`, registro_id: a.id }))
      );
      notificacoes = notificacoes.concat(
        tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id)
          .filter((a) => a.pmoc_plano_id && a.status === 'concluido' && (a.pmoc_itens || []).some((i) => i.resposta === 'nao_conforme' && !i.os_corretiva_id))
          .map((a) => ({ id: a.id, tipo: 'pmoc_nao_conformidade', texto: `Não conformidade sem O.S. corretiva — ${a.cliente_nome}`, registro_id: a.id }))
      );
      // Fase 5, item 7 — mais 3 tipos de alerta: plano perto do vencimento (30 dias antes),
      // ART/TRT vencida ou ausente, e qualidade do ar desatualizada (limiar configurável).
      const limiteVencimento30d = somarDiasIsoAgendaRefServer(hojeServidor, 30);
      const planosAtivos = tenant.listar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id).filter((p) => p.status === 'ativo');
      const planosVencendo = [];
      const planosArtProblema = [];
      for (const plano of planosAtivos) {
        const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === plano.local_id && l.empresa_id === user.empresa_id);
        const nomeLocal = local ? local.nome : `local #${plano.local_id}`;
        const dataFim = calcularDataFimPlanoPmoc(plano.data_inicio, plano.vigencia_meses);
        if (dataFim >= hojeServidor && dataFim <= limiteVencimento30d) planosVencendo.push({ plano, nomeLocal, dataFim });
        const artAusente = !plano.art_trt_numero;
        const artVencida = plano.art_trt_validade && plano.art_trt_validade < hojeServidor;
        if (artAusente || artVencida) planosArtProblema.push({ plano, nomeLocal, artAusente, artVencida });
      }
      notificacoes = notificacoes.concat(
        planosVencendo.map(({ plano, nomeLocal, dataFim }) => ({ id: plano.id, tipo: 'pmoc_plano_vencendo', texto: `Plano PMOC vence em breve — ${nomeLocal} (${dataFim.split('-').reverse().join('/')})`, registro_id: plano.id }))
      );
      notificacoes = notificacoes.concat(
        planosArtProblema.map(({ plano, nomeLocal, artAusente }) => ({ id: plano.id, tipo: 'pmoc_art_trt_problema', texto: `ART/TRT ${artAusente ? 'ausente' : 'vencida'} — ${nomeLocal}`, registro_id: plano.id }))
      );
      const [config, configCriada] = garantirConfigPmoc(data, user.empresa_id);
      const limiteQualidadeAr = dataMenosMesesPmoc(hojeServidor, config.qualidade_ar_meses_alerta);
      const locaisQualidadeArDesatualizada = [];
      for (const local of tenant.listar(data, 'os_refrigeracao_pmoc_locais', user.empresa_id)) {
        const ultima = data.os_refrigeracao_pmoc_qualidade_ar.filter((q) => q.local_id === local.id && q.empresa_id === user.empresa_id).sort((a, b) => b.data.localeCompare(a.data))[0];
        if (!ultima || ultima.data < limiteQualidadeAr) locaisQualidadeArDesatualizada.push({ local, ultima });
      }
      notificacoes = notificacoes.concat(
        locaisQualidadeArDesatualizada.map(({ local, ultima }) => ({ id: local.id, tipo: 'pmoc_qualidade_ar_desatualizada', texto: `Qualidade do ar sem análise recente — ${local.nome}${ultima ? ` (última em ${ultima.data.split('-').reverse().join('/')})` : ' (nunca registrada)'}`, registro_id: local.id }))
      );
      // "sininho + e-mail" (item 7): dispara pros administradores da empresa, uma vez só por
      // ocorrência (os campos alerta_*_email_enviado_em fazem o dedup e só são limpos quando a
      // situação muda de fato — ver as edições de plano/qualidade do ar acima) — sem
      // infraestrutura de cron (mesmo motivo de gerarVisitasPmocPlano), aproveita a própria
      // consulta que o sininho do administrador já faz com frequência.
      // IMPORTANTE (varredura de desempenho): essa consulta é a mais chamada do sistema (o
      // sininho pergunta sem parar) — NUNCA espera o e-mail de verdade sair (rede/SMTP pode
      // demorar segundos ou travar), senão toda consulta de notificações do administrador
      // ficaria lenta à toa na primeira vez que uma ocorrência nova aparece. O dedup já era
      // "otimista" antes disso (marca enviado mesmo sem confirmar entrega), então só tirar o
      // `await` (deixar o envio rodando em paralelo, sem bloquear a resposta) não muda esse
      // comportamento — só para de travar a resposta por causa dele.
      let precisaSalvarAlertas = configCriada;
      const emailsAdmins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador' && u.email).map((u) => u.email);
      // Fase C (análise de concorrentes): "alertas automáticos também por WhatsApp" — reaproveita
      // a mesma integração com a API do WhatsApp Business já usada no atendimento (whatsapp.js),
      // só que sem depender do webhook/IA ligados (ver envioAtivo lá). Igual ao e-mail: se a
      // empresa não tiver configurado WHATSAPP_TOKEN/WHATSAPP_PHONE_ID, simplesmente não envia —
      // nunca quebra o sininho por causa disso. IMPORTANTE: mensagem avulsa (tipo "text") só é
      // entregue de verdade dentro de uma janela de conversa ativa de 24h com o número comercial;
      // fora disso a Meta exige um template pré-aprovado — por enquanto é "melhor esforço", igual
      // ao e-mail sem provedor configurado (nunca falha o sininho por isso).
      const telefonesAdmins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador' && u.celular).map((u) => u.celular);
      const nomeEmpresaAlerta = (data.empresas.find((e) => e.id === user.empresa_id) || {}).nome;
      const dispararAlertaPmoc = (assunto, corpoHtml, textoWhatsApp) => {
        if (emailsAdmins.length) email.enviarAlerta({ emails: emailsAdmins, assunto, corpoHtml, nomeEmpresa: nomeEmpresaAlerta }).catch((e) => console.error('[pmoc] falha ao enviar alerta por e-mail:', e.message));
        if (whatsapp.envioAtivo() && telefonesAdmins.length) {
          for (const tel of telefonesAdmins) whatsapp.enviarMensagemWhatsApp(tel, textoWhatsApp).catch((e) => console.error('[pmoc] falha ao enviar alerta por WhatsApp:', e.message));
        }
      };
      for (const a of visitasAtrasadas) {
        if (a.alerta_atraso_email_enviado_em) continue;
        dispararAlertaPmoc('PMOC: preventiva atrasada', `<p>A preventiva PMOC de <b>${a.cliente_nome}</b> marcada para ${a.data.split('-').reverse().join('/')} ainda não foi concluída.</p>`, `⚠️ PMOC: a preventiva de ${a.cliente_nome} marcada para ${a.data.split('-').reverse().join('/')} ainda não foi concluída.`);
        a.alerta_atraso_email_enviado_em = new Date().toISOString();
        precisaSalvarAlertas = true;
      }
      for (const { plano, nomeLocal, dataFim } of planosVencendo) {
        if (plano.alerta_vencimento_email_enviado_em) continue;
        dispararAlertaPmoc('PMOC: plano perto do vencimento', `<p>O plano PMOC de <b>${nomeLocal}</b> vence em ${dataFim.split('-').reverse().join('/')}.</p>`, `📅 PMOC: o plano de ${nomeLocal} vence em ${dataFim.split('-').reverse().join('/')}.`);
        plano.alerta_vencimento_email_enviado_em = new Date().toISOString();
        precisaSalvarAlertas = true;
      }
      for (const { plano, nomeLocal, artAusente } of planosArtProblema) {
        if (plano.alerta_art_email_enviado_em) continue;
        dispararAlertaPmoc('PMOC: ART/TRT pendente', `<p>A ART/TRT do plano PMOC de <b>${nomeLocal}</b> está ${artAusente ? 'ausente' : 'vencida'}.</p>`, `📋 PMOC: a ART/TRT de ${nomeLocal} está ${artAusente ? 'ausente' : 'vencida'}.`);
        plano.alerta_art_email_enviado_em = new Date().toISOString();
        precisaSalvarAlertas = true;
      }
      for (const { local, ultima } of locaisQualidadeArDesatualizada) {
        if (local.alerta_qualidade_ar_email_enviado_em) continue;
        dispararAlertaPmoc('PMOC: qualidade do ar desatualizada', `<p>O local <b>${local.nome}</b> está sem análise de qualidade do ar recente${ultima ? ` (última em ${ultima.data.split('-').reverse().join('/')})` : ''}.</p>`, `🌬️ PMOC: o local ${local.nome} está sem análise de qualidade do ar recente.`);
        local.alerta_qualidade_ar_email_enviado_em = new Date().toISOString();
        precisaSalvarAlertas = true;
      }
      if (precisaSalvarAlertas) db.save(data);
    }
  } else if (user.papel === 'gerente_loja' || user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') {
    // versão Restaurantes/rede multiunidade (Fase 5): os 3 papéis novos não tinham sininho
    // nenhum até aqui (caíam no "nenhum bloco corresponde" = lista sempre vazia) — cada um só
    // vê o que precisa de AÇÃO dele agora, dentro do próprio escopo (ver escopo.js).
    const completo = usuarioCompleto(data, user);
    const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, completo).map((f) => f.id));
    const solicitacoesEscopo = tenant.listar(data, 'solicitacoes_peca', user.empresa_id).filter((s) => filiaisIds.has(s.filial_id));
    if (user.papel === 'gerente_loja' || user.papel === 'coordenador_tecnico') {
      const campoCiente = user.papel === 'gerente_loja' ? 'ciente_gerente_id' : 'ciente_coordenador_id';
      notificacoes = notificacoes.concat(
        solicitacoesEscopo.filter((s) => s.status === 'pendente' && !s[campoCiente])
          .map((s) => ({ id: s.id, tipo: 'peca_ciente_pendente', texto: `Nova solicitação de peça: ${s.descricao}`, registro_id: s.id }))
      );
      notificacoes = notificacoes.concat(
        tenant.listar(data, 'agenda', user.empresa_id).filter((a) => filiaisIds.has(a.filial_id) && a.etapa === 'concluida')
          .map((a) => ({ id: a.id, tipo: 'os_filial_aguardando_validacao', texto: `O.S. ${a.numero_os} concluída — validar`, registro_id: a.id }))
      );
    }
    if (user.papel === 'consultor_mercado') {
      notificacoes = notificacoes.concat(
        solicitacoesEscopo.filter((s) => s.status === 'aguardando_consultor')
          .map((s) => ({ id: s.id, tipo: 'peca_aguardando_consultor', texto: `Autorização de compra pendente: ${s.descricao}`, registro_id: s.id }))
      );
    }
    if (user.papel === 'coordenador_tecnico') {
      notificacoes = notificacoes.concat(
        tenant.listar(data, 'apoios', user.empresa_id).filter((a) => a.status === 'pedido' && a.setor_destino_id === completo.setor_id)
          .map((a) => ({ id: a.id, tipo: 'apoio_pedido_pendente', texto: `Pedido de apoio técnico — ${a.motivo || 'sem motivo informado'}`, registro_id: a.id }))
      );
    }
    notificacoes = notificacoes.concat(
      tenant.listar(data, 'transferencias', user.empresa_id).filter((t) => (
        (filiaisIds.has(t.destino_filial_id) && t.status === 'enviada')
        || (t.origem_tipo === 'filial' && filiaisIds.has(t.origem_filial_id) && t.status === 'pedida')
      )).map((t) => ({
        id: t.id,
        tipo: t.status === 'enviada' ? 'transferencia_aguardando_recebimento' : 'transferencia_pedida',
        texto: t.status === 'enviada' ? `Peça a caminho: ${t.descricao} — confirme o recebimento` : `Pedido de transferência: ${t.descricao}`,
        registro_id: t.id,
      }))
    );
  }
  enviarJSON(res, 200, { notificacoes, contador: notificacoes.length });
});

// ---------- chat interno (mensagens diretas entre a equipe — cliente não participa) ----------
// bem mais simples que o atendimento por chat (chamados): é só uma lista achatada de mensagens
// remetente->destinatário, e a "conversa" entre duas pessoas é filtrada na hora, sem thread própria.

// GET /api/chat-interno/contatos — todo mundo que não é cliente, com prévia da última mensagem e
// contagem de não lidas, ordenado como o WhatsApp (quem conversou mais recente primeiro).
rota('GET', /^\/api\/chat-interno\/contatos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_CHAT_INTERNO)) return enviarJSON(res, 403, { erro: 'Só a equipe interna usa o chat interno.' });
  const data = db.load();
  const outros = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel !== 'cliente' && u.id !== user.id);
  const contatos = await Promise.all(outros.map(async (u) => {
    const resumo = await db.resumoContatoInterno(user.id, u.id);
    return { id: u.id, nome: u.nome, papel: u.papel, departamento: u.departamento || null, ...resumo };
  }));
  contatos.sort((a, b) => (b.ultima_mensagem_em || '').localeCompare(a.ultima_mensagem_em || '') || a.nome.localeCompare(b.nome));
  enviarJSON(res, 200, { contatos });
});

// GET /api/chat-interno/:outroId/mensagens — abre a conversa e marca as mensagens dele pra mim
// como lidas (igual abrir uma conversa no WhatsApp).
rota('GET', /^\/api\/chat-interno\/(\d+)\/mensagens$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_CHAT_INTERNO)) return enviarJSON(res, 403, { erro: 'Só a equipe interna usa o chat interno.' });
  const outroId = Number(m[1]);
  const data = db.load();
  const outro = data.usuarios.find((u) => u.id === outroId && u.empresa_id === user.empresa_id);
  if (!outro || outro.papel === 'cliente') return enviarJSON(res, 404, { erro: 'Contato não encontrado.' });
  const mensagens = await db.carregarMensagensInternas(user.id, outroId);
  await db.marcarMensagensInternasLidas(user.id, outroId);
  enviarJSON(res, 200, { mensagens, contato: { id: outro.id, nome: outro.nome, papel: outro.papel } });
});

// POST /api/chat-interno/:outroId/mensagens — manda uma mensagem e avisa o destinatário por push
rota('POST', /^\/api\/chat-interno\/(\d+)\/mensagens$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_CHAT_INTERNO)) return enviarJSON(res, 403, { erro: 'Só a equipe interna usa o chat interno.' });
  const outroId = Number(m[1]);
  if (outroId === user.id) return enviarJSON(res, 400, { erro: 'Você não pode mandar mensagem pra si mesmo.' });
  const body = await lerCorpo(req);
  const texto = (body.texto || '').trim();
  if (!texto) return enviarJSON(res, 400, { erro: 'Escreva uma mensagem.' });
  const data = db.load();
  const outro = data.usuarios.find((u) => u.id === outroId && u.empresa_id === user.empresa_id);
  if (!outro || outro.papel === 'cliente') return enviarJSON(res, 404, { erro: 'Contato não encontrado.' });
  const remetente = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  const mensagem = await db.salvarMensagemInterna({ remetente_id: user.id, destinatario_id: outroId, texto });
  await enviarPush(data, outroId, {
    titulo: `Mensagem de ${remetente ? remetente.nome : 'alguém'}`,
    corpo: texto.length > 120 ? texto.slice(0, 117) + '...' : texto,
    url: '/',
    tipo: 'chat_interno',
    remetente_id: user.id,
  }).catch(() => {});
  enviarJSON(res, 201, { mensagem });
});

// ---------- relatórios de manutenção interna (avulsos, sem vínculo com O.S./agenda) ----------
// menu "Criar Relatório" do técnico — usado pra registrar um atendimento de manutenção interna
// (ex.: análise de amostra recebida na oficina) que não passa pelo fluxo normal de O.S./aprovação.

// GET /api/relatorios-manutencao/meus — o técnico só vê os relatórios que ele mesmo criou.
// Não manda as fotos aqui: essa lista só mostra data/empresa/equipamento, mas cada relatório
// pode ter várias fotos em base64, e mandar tudo de uma vez deixava essa tela cada vez mais
// lenta conforme o histórico crescia. As fotos são buscadas sob demanda (rota abaixo) quando
// o técnico realmente abre o PDF/Word/fotos de um relatório específico.
rota('GET', /^\/api\/relatorios-manutencao\/meus$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  // administrador entra aqui só pra ver os briefings "Promotor" que ele mesmo criou — o filtro
  // por autor_id logo abaixo já garante que ele não vê relatório de outra pessoa. Com ?todas=1 o
  // administrador vê os relatórios de todo mundo (mesmo uso do ?todas=1 de /api/agenda), pra
  // telas como a linha do tempo da O.S. conseguirem mostrar o relatório de qualquer técnico.
  if (!exigirPapel(user, ['suporte', 'administrador', 'supervisor', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'relatorios_manutencao', user.empresa_id);
  // pedido do usuário: "os relatórios são compartilhados entre o comercial... coloque um filtro
  // meus relatórios e todos" — "Todos" pro comercial mostra só os relatórios de QUEM TAMBÉM É
  // comercial (o time de vendas compartilha entre si), não o relatório técnico de manutenção de
  // suporte/administrador — diferente do ?todas=1 do administrador/supervisor, que já era (e
  // continua sendo) a empresa inteira.
  if (user.papel === 'comercial' && query.todas === '1') {
    const idsComercial = new Set(tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'comercial').map((u) => u.id));
    lista = lista.filter((r) => idsComercial.has(r.autor_id));
  } else if (!(['administrador', 'supervisor'].includes(user.papel) && query.todas === '1')) {
    lista = lista.filter((r) => r.autor_id === user.id);
  }
  const agendaDaEmpresa = tenant.listar(data, 'agenda', user.empresa_id);
  lista = lista
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))
    .map((r) => {
      const { fotos, ...resto } = r;
      if (r.agenda_id) {
        const os = agendaDaEmpresa.find((a) => a.id === r.agenda_id);
        if (os) resto.numero_os = os.numero_os || `OS-${String(os.id).padStart(6, '0')}`;
      }
      return resto;
    });
  enviarJSON(res, 200, { relatorios: lista });
});

// GET /api/relatorios-manutencao/:id — reabrir um relatório já criado (pra gerar o PDF de novo)
rota('GET', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'supervisor', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const data = db.load();
  // administrador (e supervisor, só leitura) vê/reabre o relatório de qualquer técnico (tela
  // "Relatório" com filtro por todo mundo); o técnico continua só vendo os que ele mesmo criou.
  // comercial também reabre o relatório de outro comercial (ver filtro "Todos" em GET /meus
  // acima) — precisa pra gerar o PDF/Encaminhar de um relatório que não é o dele.
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.empresa_id === user.empresa_id && (
    r.autor_id === user.id
    || ['administrador', 'supervisor'].includes(user.papel)
    || (user.papel === 'comercial' && (data.usuarios.find((u) => u.id === r.autor_id) || {}).papel === 'comercial')
  ));
  if (!item) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  enviarJSON(res, 200, { relatorio: await hidratarFotosProfundo(item) });
});

// GET /api/relatorios-manutencao/sugestoes-equipamento — pedido do usuário: "não é só em um
// relatório e sim para todos... cada relatório que é preenchido o sistema salva empresa
// equipamento, que começa a aparecer em um menu suspenso, mas editável. E nos itens no tempo de
// aceite... usar os mesmos itens colocado no relatório anterior" — alimenta o campo de
// equipamento (sugestão em <datalist>, nunca trava o texto) e o check-list inicial do Termo de
// Aceite com o que esta empresa já usou. Sem tabela nova: só lê o histórico que ela já tem em
// relatorios_manutencao (já isolado por empresa_id via tenant.listar).
rota('GET', /^\/api\/relatorios-manutencao\/sugestoes-equipamento$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'supervisor', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const data = db.load();
  const lista = tenant.listar(data, 'relatorios_manutencao', user.empresa_id)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  const vistos = new Set();
  const equipamentos = [];
  for (const r of lista) {
    // "modelo_maquina" é o campo usado em preventiva/preventiva2/corretiva/aceite_entrega;
    // "equipamento" no relatório técnico (ver POST /api/relatorios-manutencao acima).
    const valor = String((r.tipo === 'relatorio_tecnico' ? r.equipamento : r.modelo_maquina) || '').trim();
    if (!valor || vistos.has(valor.toLowerCase())) continue;
    vistos.add(valor.toLowerCase());
    equipamentos.push(valor);
    if (equipamentos.length >= 30) break;
  }
  const ultimoAceite = lista.find((r) => r.tipo === 'aceite_entrega' && Array.isArray(r.checklist) && r.checklist.length);
  const checklist_anterior = ultimoAceite ? ultimoAceite.checklist.map((c) => String((c && c.item) || '').trim()).filter(Boolean) : [];
  enviarJSON(res, 200, { equipamentos, checklist_anterior });
});

// POST /api/relatorios-manutencao/:id/enviar-email — botão "Encaminhar" da tela Relatório: manda
// o PDF (já gerado no navegador, igual ao botão "PDF") por e-mail em anexo. O envio por WhatsApp
// não passa por aqui — é feito só no navegador (wa.me / Web Share), sem nada pra guardar no servidor.
rota('POST', /^\/api\/relatorios-manutencao\/(\d+)\/enviar-email$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const body = await lerCorpo(req);
  if (!body.pdf_base64 || !Array.isArray(body.emails) || body.emails.length === 0) {
    return enviarJSON(res, 400, { erro: 'PDF e ao menos um e-mail são obrigatórios.' });
  }
  const data = db.load();
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.empresa_id === user.empresa_id && (r.autor_id === user.id || user.papel === 'administrador'));
  if (!item) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  const nomeArquivo = `relatorio-${item.id}.pdf`;
  const nomeEmpresa = (data.empresas.find((e) => e.id === user.empresa_id) || {}).nome;
  const resultado = await email.enviarRelatorio({ emails: body.emails, pdfBase64: body.pdf_base64, nomeArquivo, nomeEmpresa });
  enviarJSON(res, 200, { envio: resultado });
});

// POST /api/relatorios-manutencao/ler-etiqueta — recebe a foto da etiqueta/placa do equipamento,
// manda pra IA extrair marca/equipamento/nº série/data de fabricação e devolve pra pré-preencher
// o formulário no front (não salva nada aqui — só a leitura). Exige a IA configurada.
rota('POST', /^\/api\/relatorios-manutencao\/ler-etiqueta$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  if (!ia.ativa()) return enviarJSON(res, 400, { erro: 'A leitura automática por IA não está configurada neste sistema.' });
  const body = await lerCorpo(req);
  if (!body.foto) return enviarJSON(res, 400, { erro: 'Envie uma foto da etiqueta.' });
  try {
    const extraido = await ia.lerEtiqueta(body.foto);
    enviarJSON(res, 200, { extraido });
  } catch (e) {
    enviarJSON(res, 502, { erro: e.message });
  }
});

// POST /api/ia/assistente-relatorio — chat com a IA pra ajudar a escrever a parte técnica de um
// relatório (pedido do usuário: descreve a atividade, a IA organiza em termos técnicos nos campos
// certos, pergunta se confirma, e só preenche depois do "ok" do técnico — ver ia.assistenteRelatorio).
// Sem persistência no servidor: o histórico da conversa vive só no front (descartável, ao
// contrário do chat de atendimento, que fica salvo em chamado.mensagens).
rota('POST', /^\/api\/ia\/assistente-relatorio$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só quem cria relatório usa o assistente de IA.' });
  if (!ia.ativa()) return enviarJSON(res, 400, { erro: 'O assistente de IA não está configurado neste sistema.' });
  const body = await lerCorpo(req);
  const tipo = String(body.tipo || '').trim();
  const campos = (Array.isArray(body.campos) ? body.campos : [])
    .filter((c) => c && String(c.chave || '').trim() && String(c.rotulo || '').trim())
    .map((c) => ({ chave: String(c.chave).trim(), rotulo: String(c.rotulo).trim() }));
  const mensagens = (Array.isArray(body.mensagens) ? body.mensagens : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.texto || '').trim())
    .map((m) => ({ role: m.role, texto: String(m.texto).trim() }));
  const confirmar = body.confirmar === true;
  if (!tipo || !campos.length) return enviarJSON(res, 400, { erro: 'Tipo de relatório e campos são obrigatórios.' });
  if (!mensagens.length) return enviarJSON(res, 400, { erro: 'Descreva o que você fez pra a IA ajudar.' });
  try {
    const { texto, preenchimento } = await ia.assistenteRelatorio({ tipo, mensagens, campos, confirmar });
    enviarJSON(res, 200, { texto, preenchimento });
  } catch (e) {
    enviarJSON(res, 502, { erro: e.message });
  }
});

// normaliza a lista de campos de uma "ficha de equipamento" (o que a IA leu da etiqueta, com
// possíveis ajustes do técnico) — tira linhas totalmente vazias, garante string em tudo.
function sanitizarCamposFicha(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((c) => ({ campo: String((c && c.campo) || '').trim(), valor: String((c && c.valor) || '').trim() }))
    .filter((c) => c.campo || c.valor);
}

// normaliza os ciclos do Ensaio de Ciclagem — tira linhas totalmente vazias, garante número nas
// quantidades. O percentual de desvio de cada ciclo é calculado na hora de exibir (PDF/Word/tela),
// não fica salvo, pra nunca ficar desatualizado se o técnico editar uma quantidade depois.
function sanitizarCiclos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((c) => ({
      tipo_amostra: String((c && c.tipo_amostra) || '').trim(),
      quantidade: String((c && c.quantidade) || '').trim(),
      hora_inicial: String((c && c.hora_inicial) || '').trim(),
      hora_final: String((c && c.hora_final) || '').trim(),
      qtd_ok: Math.max(0, Number(c && c.qtd_ok) || 0),
      qtd_desvio: Math.max(0, Number(c && c.qtd_desvio) || 0),
      descricao_desvio: String((c && c.descricao_desvio) || '').trim(),
    }))
    .filter((c) => c.tipo_amostra || c.quantidade || c.hora_inicial || c.hora_final || c.qtd_ok || c.qtd_desvio || c.descricao_desvio);
}

// todo relatório manual traz o nome da empresa visitada (mesmo quando ainda não é um cliente
// cadastrado — ex.: Demonstração Técnica a um prospect, ficha de um equipamento levantado em
// campo) — usa isso pra ir alimentando a lista de Clientes sozinha, sem o administrador precisar
// digitar tudo de novo: empresa nova vira cliente novo; empresa que já existe só tem os campos
// que ainda estavam vazios completados (nunca sobrescreve o que o administrador já preencheu com
// cuidado). O mesmo vale pro equipamento, casado pelo número de série — identificador natural de
// uma unidade física, do jeito que /api/equipamentos/buscar-por-serie já assume.
function sincronizarClienteDoRelatorio(data, empresaId, body) {
  const nomeEmpresa = String(body.empresa || '').trim();
  if (!nomeEmpresa) return;
  const clientesDaEmpresa = tenant.listar(data, 'clientes', empresaId);
  let cliente = clientesDaEmpresa.find((c) => String(c.nome_empresa || '').trim().toLowerCase() === nomeEmpresa.toLowerCase());
  if (cliente) {
    const preencheSeVazio = (campo, valor) => { if (!cliente[campo] && valor) cliente[campo] = valor; };
    preencheSeVazio('contato', body.contato);
    preencheSeVazio('telefone', body.telefone);
    preencheSeVazio('endereco', body.endereco);
    preencheSeVazio('numero', body.numero);
    preencheSeVazio('bairro', body.bairro);
    preencheSeVazio('cep', body.cep);
    preencheSeVazio('cidade', body.cidade);
    preencheSeVazio('estado', body.estado);
  } else {
    cliente = tenant.criar(data, 'clientes', empresaId, {
      nome_empresa: nomeEmpresa,
      contato: body.contato || '', telefone: body.telefone || '', email: '',
      nivel_acesso: 'completo', setor: '',
      endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    });
  }

  const numeroSerie = String(body.numero_serie || '').trim();
  if (!numeroSerie) return;
  const equipamentosDaEmpresa = tenant.listar(data, 'equipamentos', empresaId);
  const existente = equipamentosDaEmpresa.find((e) => String(e.numero_serie || '').trim().toLowerCase() === numeroSerie.toLowerCase());
  if (!existente) {
    // "modelo_maquina" é o campo usado nos relatórios de preventiva/corretiva/aceite de entrega;
    // "equipamento" nos mais simples (ficha, ciclagem); "equipamento_demonstrado" no Promotor —
    // tenta os três, nessa ordem, pra pegar a descrição em qualquer um dos formatos.
    const descricao = String(body.modelo_maquina || body.equipamento || body.equipamento_demonstrado || '').trim();
    tenant.criar(data, 'equipamentos', empresaId, {
      cliente_id: cliente.id,
      tipo: descricao || 'Equipamento',
      modelo: String(body.marca || '').trim(),
      numero_serie: numeroSerie,
      data_fabricacao: body.data_fabricacao || '',
      localizacao: '',
    });
  } else if (existente.cliente_id === null) {
    // já existia no catálogo (cadastrado sem cliente ainda) — agora apareceu de verdade num
    // relatório, então atrela ao cliente
    existente.cliente_id = cliente.id;
  }
}

// POST /api/relatorios-manutencao — cria um relatório avulso; salva na hora, sem aprovação do admin.
// Três formatos possíveis, diferenciados por body.tipo: "completo" (formulário manual de sempre),
// "ficha" (só os dados que a etiqueta do equipamento tem, vindo do Lev. Estoque Etiqueta) ou
// "ciclagem" (Ensaio de Ciclagem — ciclos de teste com amostras OK/com desvio).
rota('POST', /^\/api\/relatorios-manutencao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador criam este relatório.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const tipo = body.tipo === 'ficha' ? 'ficha' : body.tipo === 'ciclagem' ? 'ciclagem' : body.tipo === 'preventiva' ? 'preventiva' : body.tipo === 'preventiva2' ? 'preventiva2' : body.tipo === 'corretiva' ? 'corretiva' : body.tipo === 'relatorio_tecnico' ? 'relatorio_tecnico' : body.tipo === 'aceite_entrega' ? 'aceite_entrega' : body.tipo === 'promotor' ? 'promotor' : body.tipo === 'devolutivo' ? 'devolutivo' : body.tipo === 'levantamento_tecnico' ? 'levantamento_tecnico' : body.tipo === 'entrega_teste' ? 'entrega_teste' : 'completo';
  const fotos = Array.isArray(body.fotos) ? body.fotos : [];
  const ciclos = sanitizarCiclos(body.ciclos);
  if (tipo === 'ficha') {
    if (body.condicao !== 'novo' && body.condicao !== 'usado') return enviarJSON(res, 400, { erro: 'Marque se o equipamento é Novo ou Usado.' });
    if (!fotos.length) return enviarJSON(res, 400, { erro: 'Adicione ao menos uma foto (da etiqueta ou do equipamento).' });
  } else if (tipo === 'ciclagem') {
    if (!String(body.empresa || '').trim() || !String(body.equipamento || '').trim()) {
      return enviarJSON(res, 400, { erro: 'Cliente e equipamento são obrigatórios.' });
    }
    if (body.resultado_ensaio !== 'aprovado' && body.resultado_ensaio !== 'reprovado') {
      return enviarJSON(res, 400, { erro: 'Marque o resultado do ensaio (Aprovado ou Reprovado).' });
    }
    if (!ciclos.length) return enviarJSON(res, 400, { erro: 'Adicione ao menos um ciclo.' });
  } else if (tipo === 'preventiva') {
    const erroPreventiva = validarRelatorioPreventiva(body);
    if (erroPreventiva) return enviarJSON(res, 400, { erro: erroPreventiva });
  } else if (tipo === 'preventiva2') {
    // pedido do usuário: "duplique o atual e renomeie como preventiva 2" — mesmo formato de dados
    // do termo "preventiva" original (só o PDF/formulário têm um visual diferente), por isso
    // reaproveita a mesma validação.
    const erroPreventiva2 = validarRelatorioPreventiva(body);
    if (erroPreventiva2) return enviarJSON(res, 400, { erro: erroPreventiva2 });
  } else if (tipo === 'corretiva') {
    const erroCorretiva = validarRelatorioCorretiva(body);
    if (erroCorretiva) return enviarJSON(res, 400, { erro: erroCorretiva });
  } else if (tipo === 'relatorio_tecnico') {
    const erroTecnico = validarRelatorioTecnico(body);
    if (erroTecnico) return enviarJSON(res, 400, { erro: erroTecnico });
  } else if (tipo === 'aceite_entrega') {
    const erroAceite = validarRelatorioAceite(body);
    if (erroAceite) return enviarJSON(res, 400, { erro: erroAceite });
  } else if (tipo === 'promotor') {
    const erroPromotor = validarRelatorioPromotor(body);
    if (erroPromotor) return enviarJSON(res, 400, { erro: erroPromotor });
  } else if (tipo === 'devolutivo') {
    const erroDevolutivo = validarRelatorioDevolutivo(body);
    if (erroDevolutivo) return enviarJSON(res, 400, { erro: erroDevolutivo });
  } else if (tipo === 'levantamento_tecnico') {
    const erroLevantamento = validarRelatorioLevantamentoTecnico(body);
    if (erroLevantamento) return enviarJSON(res, 400, { erro: erroLevantamento });
  } else if (tipo === 'entrega_teste') {
    // rascunho: o técnico quer só salvar o que já tem e gerar o link pro cliente continuar —
    // a validação completa (todos os campos + assinatura) só roda no envio final, seja pelo
    // próprio técnico (aqui, sem rascunho) ou pelo cliente via link público (ver /api/entregas).
    if (!body.rascunho) {
      const erroEntregaTeste = validarRelatorioEntregaTeste(body);
      if (erroEntregaTeste) return enviarJSON(res, 400, { erro: erroEntregaTeste });
    }
  } else if (!String(body.empresa || '').trim() || !String(body.equipamento || '').trim()) {
    return enviarJSON(res, 400, { erro: 'Empresa e equipamento são obrigatórios.' });
  }
  const data = db.load();
  // o token de login só carrega id/papel/nome — busca o cadastro completo pra pegar e-mail/cargo/setor
  const autor = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  const item = tenant.criar(data, 'relatorios_manutencao', user.empresa_id, {
    tipo,
    autor_id: user.id,
    autor_nome: user.nome,
    empresa: body.empresa || '', contato: body.contato || '', telefone: body.telefone || '',
    tipo_servico: body.tipo_servico || '', tipo_servico_outros: body.tipo_servico_outros || '',
    marca: body.marca || '', equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
    condicao: (body.condicao === 'novo' || body.condicao === 'usado') ? body.condicao : '',
    campos: tipo === 'ficha' ? sanitizarCamposFicha(body.campos) : [],
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
    data_fabricacao: body.data_fabricacao || '',
    acessorios: body.acessorios || '', defeito_informado: body.defeito_informado || '',
    tecnico_nome: user.nome, tecnico_email: (autor && autor.email) || '',
    tecnico_cargo: (autor && autor.cargo) || '', tecnico_setor: (autor && autor.setor) || '',
    data_entrada: body.data_entrada || '', data_conclusao: body.data_conclusao || '',
    laudo_tecnico: body.laudo_tecnico || '', servico_realizado: body.servico_realizado || '',
    pecas: Array.isArray(body.pecas) ? body.pecas : [],
    mtbf_encontrado: tipo === 'ciclagem' ? (body.mtbf_encontrado || '') : '',
    resultado_ensaio: tipo === 'ciclagem' && (body.resultado_ensaio === 'aprovado' || body.resultado_ensaio === 'reprovado') ? body.resultado_ensaio : '',
    ciclos: tipo === 'ciclagem' ? ciclos : [],
    conclusao_ensaio: tipo === 'ciclagem' ? (body.conclusao_ensaio || '') : '',
    fotos,
    criado_em: new Date().toISOString(),
    ...(tipo === 'preventiva' ? {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes_checklist: body.observacoes_checklist || '',
      servico_feito: body.servico_feito || '',
      observacoes_servico: body.observacoes_servico || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
    } : {}),
    ...(tipo === 'preventiva2' ? {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes_checklist: body.observacoes_checklist || '',
      servico_feito: body.servico_feito || '',
      observacoes_servico: body.observacoes_servico || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
    } : {}),
    ...(tipo === 'corretiva' ? {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      defeito_informado: body.defeito_informado || '',
      acoes_executadas: body.acoes_executadas || '',
      observacoes: body.observacoes || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
    } : {}),
    ...(tipo === 'relatorio_tecnico' ? {
      tipo_servico: Array.isArray(body.tipo_servico) ? body.tipo_servico : [],
      observacoes: body.observacoes || '',
    } : {}),
    ...(tipo === 'aceite_entrega' ? {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico: body.servico || '',
      setor: body.setor || '', endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes: body.observacoes || '',
      aceite: body.aceite || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_duvidas: body.satisfacao_duvidas || '',
      satisfacao_apto: body.satisfacao_apto || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
    } : {}),
    ...(tipo === 'promotor' ? {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      data_visita: body.data_visita || '',
      vendedor: body.vendedor || '', promotor: body.promotor || '',
      motivo_visita: body.motivo_visita || '', processo_atual: body.processo_atual || '',
      necessidade_informada: body.necessidade_informada || '',
      o_que_demonstrar: body.o_que_demonstrar || '', ponto_importante_demo: body.ponto_importante_demo || '',
      duvidas_preocupacoes: body.duvidas_preocupacoes || '', concorrente: body.concorrente || '',
      o_que_observar: body.o_que_observar || '',
      objetivo_visita: body.objetivo_visita || '', ponto_principal_observar: body.ponto_principal_observar || '',
    } : {}),
    ...(tipo === 'devolutivo' ? {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      data_visita: body.data_visita || '',
      promotor: body.promotor || '',
      equipamento_demonstrado: body.equipamento_demonstrado || '',
      resultado_demonstracao: ['aprovado', 'aprovado_parcial', 'reprovado', 'em_analise'].includes(body.resultado_demonstracao) ? body.resultado_demonstracao : '',
      feedback_cliente: body.feedback_cliente || '',
      pontos_positivos: body.pontos_positivos || '', pontos_ajuste: body.pontos_ajuste || '',
      identificou_oportunidade_adicional: body.identificou_oportunidade_adicional === true,
      tipo_oportunidade: Array.isArray(body.tipo_oportunidade) ? body.tipo_oportunidade : [],
      tipo_oportunidade_outro: body.tipo_oportunidade_outro || '',
      descricao_oportunidade: body.descricao_oportunidade || '',
      valor_agregado: body.valor_agregado || '',
      proximos_passos: body.proximos_passos || '',
      observacoes_finais: body.observacoes_finais || '',
    } : {}),
    ...(tipo === 'levantamento_tecnico' ? {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      devolutivo_id: body.devolutivo_id ? Number(body.devolutivo_id) : null,
      data_levantamento: body.data_levantamento || '', responsavel_tecnico: body.responsavel_tecnico || '',
      tempo_ciclo_atual: body.tempo_ciclo_atual || '', volume_producao: body.volume_producao || '',
      material_peca: body.material_peca || '', tolerancias_qualidade: body.tolerancias_qualidade || '',
      automacao_existente: body.automacao_existente || '', integracao_necessaria: body.integracao_necessaria || '',
      espaco_disponivel: body.espaco_disponivel || '', alimentacao_eletrica: body.alimentacao_eletrica || '',
      requisitos_seguranca: body.requisitos_seguranca || '',
      escopo_proposto: body.escopo_proposto || '', prazo_decisao: body.prazo_decisao || '',
      responsavel_decisao: body.responsavel_decisao || '', orcamento_sinalizado: body.orcamento_sinalizado || '',
      viabilidade_tecnica: ['viavel', 'viavel_com_ressalvas', 'inviavel', 'precisa_mais_dados'].includes(body.viabilidade_tecnica) ? body.viabilidade_tecnica : '',
      observacoes_tecnicas: body.observacoes_tecnicas || '', proximos_passos: body.proximos_passos || '',
    } : {}),
    ...(tipo === 'entrega_teste' ? {
      email: body.email || '',
      data_entrega: body.data_entrega || '', data_prevista_devolucao: body.data_prevista_devolucao || '',
      observacoes: body.observacoes || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      // token que abre o link público (sem login) — o cliente usa pra preencher/continuar/
      // assinar de longe, de qualquer dispositivo (ver rotas /api/entregas/:token mais abaixo)
      token_publico: gerarTokenConvite(),
      status_preenchimento: body.rascunho ? 'aguardando' : 'concluido',
      concluido_em: body.rascunho ? null : new Date().toISOString(),
    } : {}),
  });
  // Devolutivo é o relatório pós-visita da Demonstração Técnica (ver abrirDiario no front) — marca
  // a O.S. como concluída igual o envio de visita marca pras demais (corretiva/preventiva/
  // atendimento/treinamento_online), pra "Iniciar retorno" (viagem de volta) poder aparecer.
  if (tipo === 'devolutivo' && item.agenda_id) {
    const agendaVinculada = tenant.buscar(data, 'agenda', item.agenda_id, user.empresa_id);
    if (agendaVinculada && !agendaVinculada.finalizada) {
      agendaVinculada.status = 'concluida';
      agendaVinculada.concluida_em = new Date().toISOString();
    }
  }
  sincronizarClienteDoRelatorio(data, user.empresa_id, body);
  // CRM nativo, passo 2: Devolutivo que identificou uma necessidade adicional do cliente nasce
  // Oportunidade automaticamente no funil, em vez de ficar presa só dentro do relatório (antes só
  // alimentava um <select> pro Levantamento Técnico — ver devolutivosComOportunidade no front).
  if (tipo === 'devolutivo' && item.identificou_oportunidade_adicional) {
    const nomeEmpresa = String(body.empresa || '').trim().toLowerCase();
    const clienteDaOportunidade = nomeEmpresa
      ? tenant.listar(data, 'clientes', user.empresa_id).find((c) => String(c.nome_empresa || '').trim().toLowerCase() === nomeEmpresa)
      : null;
    tenant.criar(data, 'oportunidades', user.empresa_id, {
      titulo: `${item.tipo_oportunidade.join(', ') || 'Oportunidade'} — ${body.empresa || 'cliente não identificado'}`,
      cliente_id: clienteDaOportunidade ? clienteDaOportunidade.id : null,
      lead_id: null,
      estagio: 'novo',
      valor_estimado: item.valor_agregado || '',
      descricao: item.descricao_oportunidade || '',
      observacoes: '',
      origem: 'devolutivo',
      devolutivo_id: item.id,
      criado_em: new Date().toISOString(),
    });
  }
  db.save(data);
  enviarJSON(res, 201, { relatorio: item });
});

// PUT /api/relatorios-manutencao/:id — o próprio autor pode editar um relatório que criou; o
// administrador também edita o de qualquer técnico (tela "Relatório" com filtro por todo mundo).
// O tipo (completo/ficha/ciclagem) é fixo desde a criação — só os campos daquele tipo são atualizados.
rota('PUT', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const data = db.load();
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.empresa_id === user.empresa_id && (r.autor_id === user.id || user.papel === 'administrador'));
  if (!item) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  const fotos = Array.isArray(body.fotos) ? body.fotos : [];
  if (item.tipo === 'ficha') {
    if (body.condicao !== 'novo' && body.condicao !== 'usado') return enviarJSON(res, 400, { erro: 'Marque se o equipamento é Novo ou Usado.' });
    if (!fotos.length) return enviarJSON(res, 400, { erro: 'Adicione ao menos uma foto (da etiqueta ou do equipamento).' });
    Object.assign(item, {
      condicao: (body.condicao === 'novo' || body.condicao === 'usado') ? body.condicao : '',
      campos: sanitizarCamposFicha(body.campos),
      fotos,
    });
  } else if (item.tipo === 'ciclagem') {
    if (!String(body.empresa || '').trim() || !String(body.equipamento || '').trim()) {
      return enviarJSON(res, 400, { erro: 'Cliente e equipamento são obrigatórios.' });
    }
    if (body.resultado_ensaio !== 'aprovado' && body.resultado_ensaio !== 'reprovado') {
      return enviarJSON(res, 400, { erro: 'Marque o resultado do ensaio (Aprovado ou Reprovado).' });
    }
    const ciclos = sanitizarCiclos(body.ciclos);
    if (!ciclos.length) return enviarJSON(res, 400, { erro: 'Adicione ao menos um ciclo.' });
    Object.assign(item, {
      empresa: body.empresa || '', equipamento: body.equipamento || '',
      data_conclusao: body.data_conclusao || '',
      mtbf_encontrado: body.mtbf_encontrado || '',
      resultado_ensaio: body.resultado_ensaio,
      ciclos,
      conclusao_ensaio: body.conclusao_ensaio || '',
    });
  } else if (item.tipo === 'preventiva') {
    const erroPreventiva = validarRelatorioPreventiva(body);
    if (erroPreventiva) return enviarJSON(res, 400, { erro: erroPreventiva });
    Object.assign(item, {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      empresa: body.empresa || '', endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes_checklist: body.observacoes_checklist || '',
      servico_feito: body.servico_feito || '',
      observacoes_servico: body.observacoes_servico || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
      fotos,
    });
  } else if (item.tipo === 'preventiva2') {
    const erroPreventiva2 = validarRelatorioPreventiva(body);
    if (erroPreventiva2) return enviarJSON(res, 400, { erro: erroPreventiva2 });
    Object.assign(item, {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      empresa: body.empresa || '', endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes_checklist: body.observacoes_checklist || '',
      servico_feito: body.servico_feito || '',
      observacoes_servico: body.observacoes_servico || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
      fotos,
    });
  } else if (item.tipo === 'corretiva') {
    const erroCorretiva = validarRelatorioCorretiva(body);
    if (erroCorretiva) return enviarJSON(res, 400, { erro: erroCorretiva });
    Object.assign(item, {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico_realizado: body.servico_realizado || '',
      empresa: body.empresa || '', endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      setor_maquina: body.setor_maquina || '',
      defeito_informado: body.defeito_informado || '',
      acoes_executadas: body.acoes_executadas || '',
      observacoes: body.observacoes || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_comentario: body.satisfacao_comentario || '',
      satisfacao_autoriza: body.satisfacao_autoriza || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
      fotos,
    });
  } else if (item.tipo === 'relatorio_tecnico') {
    const erroTecnico = validarRelatorioTecnico(body);
    if (erroTecnico) return enviarJSON(res, 400, { erro: erroTecnico });
    Object.assign(item, {
      empresa: body.empresa || '', contato: body.contato || '', telefone: body.telefone || '',
      tipo_servico: Array.isArray(body.tipo_servico) ? body.tipo_servico : [], tipo_servico_outros: body.tipo_servico_outros || '',
      marca: body.marca || '', equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
      garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
      data_fabricacao: body.data_fabricacao || '',
      acessorios: body.acessorios || '', defeito_informado: body.defeito_informado || '',
      data_entrada: body.data_entrada || '', data_conclusao: body.data_conclusao || '',
      laudo_tecnico: body.laudo_tecnico || '', servico_realizado: body.servico_realizado || '',
      pecas: Array.isArray(body.pecas) ? body.pecas : [],
      observacoes: body.observacoes || '',
      fotos,
    });
  } else if (item.tipo === 'aceite_entrega') {
    const erroAceite = validarRelatorioAceite(body);
    if (erroAceite) return enviarJSON(res, 400, { erro: erroAceite });
    Object.assign(item, {
      os_uf: body.os_uf || '', os_numero: body.os_numero || '', os_ano: body.os_ano || '',
      data_inicial: body.data_inicial || '', data_final: body.data_final || '',
      modelo_maquina: body.modelo_maquina || '', numero_serie: body.numero_serie || '',
      servico: body.servico || '',
      empresa: body.empresa || '', contato: body.contato || '',
      setor: body.setor || '', endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
      estado: body.estado || '', cidade: body.cidade || '', cep: body.cep || '',
      checklist: Array.isArray(body.checklist) ? body.checklist : [],
      observacoes: body.observacoes || '',
      aceite: body.aceite || '',
      satisfacao_estrelas: Number(body.satisfacao_estrelas) || 0,
      satisfacao_duvidas: body.satisfacao_duvidas || '',
      satisfacao_apto: body.satisfacao_apto || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      assinatura_tecnico_nome: body.assinatura_tecnico_nome || '', assinatura_tecnico_img: body.assinatura_tecnico_img || null,
      emails_copia: Array.isArray(body.emails_copia) ? body.emails_copia : [],
    });
  } else if (item.tipo === 'promotor') {
    const erroPromotor = validarRelatorioPromotor(body);
    if (erroPromotor) return enviarJSON(res, 400, { erro: erroPromotor });
    Object.assign(item, {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      empresa: body.empresa || '', contato: body.contato || '',
      data_visita: body.data_visita || '',
      vendedor: body.vendedor || '', promotor: body.promotor || '',
      motivo_visita: body.motivo_visita || '', processo_atual: body.processo_atual || '',
      necessidade_informada: body.necessidade_informada || '',
      o_que_demonstrar: body.o_que_demonstrar || '', ponto_importante_demo: body.ponto_importante_demo || '',
      duvidas_preocupacoes: body.duvidas_preocupacoes || '', concorrente: body.concorrente || '',
      o_que_observar: body.o_que_observar || '',
      objetivo_visita: body.objetivo_visita || '', ponto_principal_observar: body.ponto_principal_observar || '',
    });
  } else if (item.tipo === 'devolutivo') {
    const erroDevolutivo = validarRelatorioDevolutivo(body);
    if (erroDevolutivo) return enviarJSON(res, 400, { erro: erroDevolutivo });
    Object.assign(item, {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      empresa: body.empresa || '', contato: body.contato || '',
      data_visita: body.data_visita || '',
      promotor: body.promotor || '',
      equipamento_demonstrado: body.equipamento_demonstrado || '',
      resultado_demonstracao: ['aprovado', 'aprovado_parcial', 'reprovado', 'em_analise'].includes(body.resultado_demonstracao) ? body.resultado_demonstracao : '',
      feedback_cliente: body.feedback_cliente || '',
      pontos_positivos: body.pontos_positivos || '', pontos_ajuste: body.pontos_ajuste || '',
      identificou_oportunidade_adicional: body.identificou_oportunidade_adicional === true,
      tipo_oportunidade: Array.isArray(body.tipo_oportunidade) ? body.tipo_oportunidade : [],
      tipo_oportunidade_outro: body.tipo_oportunidade_outro || '',
      descricao_oportunidade: body.descricao_oportunidade || '',
      valor_agregado: body.valor_agregado || '',
      proximos_passos: body.proximos_passos || '',
      observacoes_finais: body.observacoes_finais || '',
    });
  } else if (item.tipo === 'levantamento_tecnico') {
    const erroLevantamento = validarRelatorioLevantamentoTecnico(body);
    if (erroLevantamento) return enviarJSON(res, 400, { erro: erroLevantamento });
    Object.assign(item, {
      agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
      devolutivo_id: body.devolutivo_id ? Number(body.devolutivo_id) : null,
      empresa: body.empresa || '', contato: body.contato || '',
      data_levantamento: body.data_levantamento || '', responsavel_tecnico: body.responsavel_tecnico || '',
      tempo_ciclo_atual: body.tempo_ciclo_atual || '', volume_producao: body.volume_producao || '',
      material_peca: body.material_peca || '', tolerancias_qualidade: body.tolerancias_qualidade || '',
      automacao_existente: body.automacao_existente || '', integracao_necessaria: body.integracao_necessaria || '',
      espaco_disponivel: body.espaco_disponivel || '', alimentacao_eletrica: body.alimentacao_eletrica || '',
      requisitos_seguranca: body.requisitos_seguranca || '',
      escopo_proposto: body.escopo_proposto || '', prazo_decisao: body.prazo_decisao || '',
      responsavel_decisao: body.responsavel_decisao || '', orcamento_sinalizado: body.orcamento_sinalizado || '',
      viabilidade_tecnica: ['viavel', 'viavel_com_ressalvas', 'inviavel', 'precisa_mais_dados'].includes(body.viabilidade_tecnica) ? body.viabilidade_tecnica : '',
      observacoes_tecnicas: body.observacoes_tecnicas || '', proximos_passos: body.proximos_passos || '',
    });
  } else if (item.tipo === 'entrega_teste') {
    if (!body.rascunho) {
      const erroEntregaTeste = validarRelatorioEntregaTeste(body);
      if (erroEntregaTeste) return enviarJSON(res, 400, { erro: erroEntregaTeste });
    }
    if (!item.token_publico) item.token_publico = gerarTokenConvite();
    Object.assign(item, {
      empresa: body.empresa || '', contato: body.contato || '', email: body.email || '',
      equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
      data_entrega: body.data_entrega || '', data_prevista_devolucao: body.data_prevista_devolucao || '',
      observacoes: body.observacoes || '',
      assinatura_cliente_nome: body.assinatura_cliente_nome || '', assinatura_cliente_img: body.assinatura_cliente_img || null,
      status_preenchimento: body.rascunho ? 'aguardando' : 'concluido',
      concluido_em: body.rascunho ? item.concluido_em : new Date().toISOString(),
    });
  } else {
    if (!String(body.empresa || '').trim() || !String(body.equipamento || '').trim()) {
      return enviarJSON(res, 400, { erro: 'Empresa e equipamento são obrigatórios.' });
    }
    Object.assign(item, {
      empresa: body.empresa || '', contato: body.contato || '', telefone: body.telefone || '',
      tipo_servico: body.tipo_servico || '', tipo_servico_outros: body.tipo_servico_outros || '',
      marca: body.marca || '', equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
      condicao: (body.condicao === 'novo' || body.condicao === 'usado') ? body.condicao : '',
      garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
      data_fabricacao: body.data_fabricacao || '',
      acessorios: body.acessorios || '', defeito_informado: body.defeito_informado || '',
      data_entrada: body.data_entrada || '', data_conclusao: body.data_conclusao || '',
      laudo_tecnico: body.laudo_tecnico || '', servico_realizado: body.servico_realizado || '',
      pecas: Array.isArray(body.pecas) ? body.pecas : [],
      fotos,
    });
  }
  sincronizarClienteDoRelatorio(data, user.empresa_id, body);
  db.save(data);
  enviarJSON(res, 200, { relatorio: item });
});

// DELETE /api/relatorios-manutencao/:id — o próprio autor pode apagar um relatório que criou;
// o administrador também apaga o de qualquer técnico.
rota('DELETE', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador usam este relatório.' });
  const data = db.load();
  const relatorioExcluir = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.empresa_id === user.empresa_id && (r.autor_id === user.id || user.papel === 'administrador'));
  if (!relatorioExcluir) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  data.relatorios_manutencao = data.relatorios_manutencao.filter((r) => r.id !== relatorioExcluir.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/clientes — administrador: lista de empresas-cliente (para vincular usuário/chamado)
rota('GET', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  // "comercial" precisa listar clientes pra resolver nome na tela de Leads/Funil/Orçamentos (ver
  // renderOportunidades/renderOrcamentosGeral, app.js) — sem isso, essas telas ficam travadas em
  // "Carregando..." pra qualquer empresa com um vendedor dedicado (ver papelExigeDepartamentalizacao).
  // "suporte" precisa pro seletor de cliente do Registro de Atividades (ver renderAtividadesDiarias)
  // — o técnico já vê nome de cliente o dia inteiro via Agenda/Equipamentos, nada novo exposto aqui.
  if (!exigirPapel(user, ['administrador', 'producao', 'supervisor', 'comercial', 'suporte'])) return enviarJSON(res, 403, { erro: 'Sem acesso a clientes.' });
  const data = db.load();
  enviarJSON(res, 200, { clientes: tenant.listar(data, 'clientes', user.empresa_id) });
});

// POST /api/clientes — administrador cadastra uma nova empresa-cliente
// valor do contrato mensal (opcional) — só referência pro PDF de Registro de Atividades (ver
// POST /api/atividades-diarias/relatorio abaixo); null/vazio = cliente sem contrato de valor fixo.
function valorContratoMensalDoBody(body) {
  if (body.valor_contrato_mensal === undefined || body.valor_contrato_mensal === null || body.valor_contrato_mensal === '') return null;
  const n = Number(body.valor_contrato_mensal);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
rota('POST', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção cadastram clientes.' });
  const body = await lerCorpo(req);
  if (!body.nome_empresa || !String(body.nome_empresa).trim()) {
    return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  }
  const data = db.load();
  const item = tenant.criar(data, 'clientes', user.empresa_id, {
    nome_empresa: body.nome_empresa.trim(),
    contato: body.contato || '',
    telefone: body.telefone || '',
    email: body.email || '',
    nivel_acesso: 'completo',
    setor: body.setor || '',
    endereco: body.endereco || '',
    numero: body.numero || '',
    bairro: body.bairro || '',
    cep: body.cep || '',
    cidade: body.cidade || '',
    estado: body.estado || '',
    valor_contrato_mensal: valorContratoMensalDoBody(body),
  });
  db.save(data);
  enviarJSON(res, 201, { cliente: item });
});

// PUT /api/clientes/:id — administrador edita um cliente
rota('PUT', /^\/api\/clientes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita clientes.' });
  const body = await lerCorpo(req);
  if (!body.nome_empresa || !String(body.nome_empresa).trim()) {
    return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  }
  const data = db.load();
  const cliente = tenant.buscar(data, 'clientes', Number(m[1]), user.empresa_id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  Object.assign(cliente, {
    nome_empresa: body.nome_empresa.trim(),
    contato: body.contato || '', telefone: body.telefone || '', email: body.email || '',
    setor: body.setor || '', endereco: body.endereco || '', numero: body.numero || '',
    bairro: body.bairro || '', cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    valor_contrato_mensal: valorContratoMensalDoBody(body),
  });
  db.save(data);
  enviarJSON(res, 200, { cliente });
});

// DELETE /api/clientes/:id — bloqueado se houver usuários, O.S. ou equipamentos vinculados a este cliente
rota('DELETE', /^\/api\/clientes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui clientes.' });
  const data = db.load();
  const id = Number(m[1]);
  const cliente = tenant.buscar(data, 'clientes', id, user.empresa_id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem usuários vinculados a este cliente. Remova ou reatribua-os antes de excluir.' });
  if (tenant.listar(data, 'agenda', user.empresa_id).some((a) => a.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem ordens de serviço vinculadas a este cliente. Exclua-as antes.' });
  if (tenant.listar(data, 'equipamentos', user.empresa_id).some((e) => e.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem equipamentos atrelados a este cliente. Remova-os antes.' });
  if (tenant.listar(data, 'atividades_diarias', user.empresa_id).some((a) => a.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem atividades registradas para este cliente. Exclua-as antes.' });
  data.clientes = data.clientes.filter((c) => c.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- registro de atividades diárias (pedido do usuário, empresa JBPA) ----------
// cliente com contrato mensal: a empresa registra TUDO que é feito (data, descrição do serviço,
// valor), pra depois comparar com o que o cliente paga e mostrar que o contrato vale a pena — o
// PDF em si é gerado no navegador (mesmo padrão jsPDF de todo o resto do sistema, ver
// gerarPdfAtividadesDiarias em app.js); aqui só entram listagem e CRUD dos lançamentos.
const PAPEIS_ATIVIDADE_DIARIA = ['administrador', 'suporte'];
function atividadeDiariaComDetalhes(data, a) {
  const cliente = data.clientes.find((c) => c.id === a.cliente_id && c.empresa_id === a.empresa_id);
  const autor = data.usuarios.find((u) => u.id === a.autor_id && u.empresa_id === a.empresa_id);
  return { ...a, cliente_nome: cliente ? cliente.nome_empresa : null, autor_nome: autor ? autor.nome : null };
}
// só quem registrou (ou o administrador) edita/exclui — mesma regra de outras telas de lançamento
// pessoal (ex.: despesas justificadas).
function podeEditarAtividadeDiaria(user, atividade) {
  return user.papel === 'administrador' || atividade.autor_id === user.id;
}
// GET /api/atividades-diarias?cliente_id=&periodo_inicio=&periodo_fim=
rota('GET', /^\/api\/atividades-diarias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_ATIVIDADE_DIARIA)) return enviarJSON(res, 403, { erro: 'Sem acesso ao registro de atividades.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'atividades_diarias', user.empresa_id);
  if (query.cliente_id) lista = lista.filter((a) => a.cliente_id === Number(query.cliente_id));
  if (query.periodo_inicio) lista = lista.filter((a) => a.data >= query.periodo_inicio);
  if (query.periodo_fim) lista = lista.filter((a) => a.data <= query.periodo_fim);
  lista = lista.map((a) => atividadeDiariaComDetalhes(data, a)).sort((a, b) => b.data.localeCompare(a.data) || b.id - a.id);
  enviarJSON(res, 200, { atividades: lista });
});
// POST /api/atividades-diarias { cliente_id, data, descricao, valor }
rota('POST', /^\/api\/atividades-diarias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_ATIVIDADE_DIARIA)) return enviarJSON(res, 403, { erro: 'Sem acesso ao registro de atividades.' });
  const data = db.load();
  const body = await lerCorpo(req);
  const cliente = tenant.buscar(data, 'clientes', Number(body.cliente_id), user.empresa_id);
  if (!cliente) return enviarJSON(res, 400, { erro: 'Escolha um cliente.' });
  if (!body.data) return enviarJSON(res, 400, { erro: 'Informe a data da atividade.' });
  if (!body.descricao || !String(body.descricao).trim()) return enviarJSON(res, 400, { erro: 'Descreva o serviço realizado.' });
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor < 0) return enviarJSON(res, 400, { erro: 'Informe um valor válido.' });
  const atividade = tenant.criar(data, 'atividades_diarias', user.empresa_id, {
    cliente_id: cliente.id, data: body.data, descricao: String(body.descricao).trim(), valor,
    autor_id: user.id, criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { atividade: atividadeDiariaComDetalhes(data, atividade) });
});
// PUT /api/atividades-diarias/:id — só quem registrou ou o administrador
rota('PUT', /^\/api\/atividades-diarias\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_ATIVIDADE_DIARIA)) return enviarJSON(res, 403, { erro: 'Sem acesso ao registro de atividades.' });
  const data = db.load();
  const atividade = tenant.buscar(data, 'atividades_diarias', Number(m[1]), user.empresa_id);
  if (!atividade) return enviarJSON(res, 404, { erro: 'Atividade não encontrada.' });
  if (!podeEditarAtividadeDiaria(user, atividade)) return enviarJSON(res, 403, { erro: 'Só quem registrou (ou o administrador) edita esta atividade.' });
  const body = await lerCorpo(req);
  const cliente = tenant.buscar(data, 'clientes', Number(body.cliente_id), user.empresa_id);
  if (!cliente) return enviarJSON(res, 400, { erro: 'Escolha um cliente.' });
  if (!body.data) return enviarJSON(res, 400, { erro: 'Informe a data da atividade.' });
  if (!body.descricao || !String(body.descricao).trim()) return enviarJSON(res, 400, { erro: 'Descreva o serviço realizado.' });
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor < 0) return enviarJSON(res, 400, { erro: 'Informe um valor válido.' });
  atividade.cliente_id = cliente.id; atividade.data = body.data;
  atividade.descricao = String(body.descricao).trim(); atividade.valor = valor;
  db.save(data);
  enviarJSON(res, 200, { atividade: atividadeDiariaComDetalhes(data, atividade) });
});
// DELETE /api/atividades-diarias/:id — só quem registrou ou o administrador
rota('DELETE', /^\/api\/atividades-diarias\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_ATIVIDADE_DIARIA)) return enviarJSON(res, 403, { erro: 'Sem acesso ao registro de atividades.' });
  const data = db.load();
  const atividade = tenant.buscar(data, 'atividades_diarias', Number(m[1]), user.empresa_id);
  if (!atividade) return enviarJSON(res, 404, { erro: 'Atividade não encontrada.' });
  if (!podeEditarAtividadeDiaria(user, atividade)) return enviarJSON(res, 403, { erro: 'Só quem registrou (ou o administrador) exclui esta atividade.' });
  data.atividades_diarias = data.atividades_diarias.filter((a) => a.id !== atividade.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- Ordens de Serviço — perfil "Refrigeração e Climatização" ----------
// pedido do usuário: menu construído do zero, específico desse perfil (ver PERFIS_DISPONIVEIS em
// db.js e perfilAtivoNoMenu em app.js) — cadastro de cliente próprio (os_refrigeracao_clientes,
// separado da coleção `clientes` genérica: os outros menus desse perfil ainda vão ser construídos
// um a um, "Criar versões novas e específicas" foi o pedido explícito do usuário), fluxo em
// etapas (cliente -> equipamento -> serviço e materiais -> finalizar com assinatura do técnico) e
// um link público com token (mesmo padrão de /api/entregas, ver gerarTokenConvite) pra o cliente
// assinar a O.S. de qualquer aparelho, sem precisar de login.
const PAPEIS_OS_REFRIGERACAO = ['administrador', 'suporte'];
function empresaPerfilRefrigeracao(data, empresaId) {
  const empresa = data.empresas.find((e) => e.id === empresaId);
  return !!(empresa && empresa.perfil === 'refrigeracao');
}
// não existe módulo de plano pra isso (rotas-modulo.js cai em "núcleo" por omissão pro prefixo
// /api/os-refrigeracao) — o acesso é por Perfil da empresa, checado aqui dentro, mesmo padrão de
// outras sub-checagens já feitas "dentro da rota" no sistema (ex.: módulo "filiais" em sub-rotas
// de /api/agenda). Devolve false (e já respondeu o erro) quando o chamador deve parar ali.
function exigirPerfilRefrigeracao(res, user, data) {
  if (!exigirPapel(user, PAPEIS_OS_REFRIGERACAO)) { enviarJSON(res, 403, { erro: 'Sem acesso a Ordens de Serviço.' }); return false; }
  if (!empresaPerfilRefrigeracao(data, user.empresa_id)) { enviarJSON(res, 403, { erro: 'Ordens de Serviço (Refrigeração) é exclusivo de empresas com o perfil Refrigeração e Climatização.' }); return false; }
  return true;
}

function totaisOsRefrigeracao(os) {
  const totalMateriais = (os.materiais || []).reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
  const totalServicos = (os.servicos || []).reduce((s, sv) => s + (Number(sv.valor) || 0), 0);
  const subtotal = totalMateriais + totalServicos + (Number(os.mao_de_obra) || 0);
  const descontoBruto = os.desconto_tipo === 'percentual' ? subtotal * ((Number(os.desconto_valor) || 0) / 100) : (Number(os.desconto_valor) || 0);
  const descontoAplicado = Math.max(0, Math.min(descontoBruto, subtotal));
  return { total_materiais: totalMateriais, total_servicos: totalServicos, subtotal, desconto_aplicado: descontoAplicado, total: subtotal - descontoAplicado };
}

async function osRefrigeracaoComDetalhes(data, os) {
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === os.cliente_id && c.empresa_id === os.empresa_id);
  return {
    ...os,
    fotos: await hidratarFotosProfundo(os.fotos),
    assinatura_tecnico_img: await hidratarFotosProfundo(os.assinatura_tecnico_img),
    assinatura_cliente_img: await hidratarFotosProfundo(os.assinatura_cliente_img),
    cliente_nome: cliente ? cliente.nome : null,
    ...totaisOsRefrigeracao(os),
  };
}
// a versão pública (link de assinatura) nunca devolve token_assinatura/empresa_id/tecnico_id/
// autor_id pro cliente — só o necessário pra conferir o serviço e assinar.
async function osRefrigeracaoResumoPublico(data, os) {
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === os.cliente_id && c.empresa_id === os.empresa_id);
  return {
    id: os.id, cliente_nome: cliente ? cliente.nome : null, criado_em: os.criado_em,
    equipamento: os.equipamento, servicos: os.servicos, materiais: os.materiais,
    mao_de_obra: os.mao_de_obra, desconto_tipo: os.desconto_tipo, desconto_valor: os.desconto_valor,
    assinatura_cliente_img: await hidratarFotosProfundo(os.assinatura_cliente_img),
    ...totaisOsRefrigeracao(os),
  };
}

// ---- onboarding do administrador (perfil Refrigeração) ----
// pedido do usuário (referência: app concorrente iClima) — só o administrador que acabou de
// cadastrar a empresa passa por isso, uma vez, na primeira vez que entra: especialidades, anos de
// experiência, foto de perfil, aceite dos Termos de Uso. Nasce pendente (ver backfill de
// `termos_aceitos_em` em db.js) e nunca mais aparece depois de concluído — não tem "salvar
// parcial", só conclusão (a última etapa do assistente, ver concluirOnboardingRefrigeracao em
// app.js), porque não faz sentido meio-aceito os Termos de Uso.
const ESPECIALIDADES_REFRIGERACAO_VALIDAS = ['instalacao', 'manutencao_preventiva', 'manutencao_corretiva', 'higienizacao', 'desinstalacao', 'infraestrutura', 'camara_fria', 'automacao'];
rota('POST', /^\/api\/me\/onboarding-refrigeracao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Esse onboarding é só pro administrador.' });
  if (!empresaPerfilRefrigeracao(data, user.empresa_id)) return enviarJSON(res, 403, { erro: 'Exclusivo de empresas com o perfil Refrigeração e Climatização.' });
  const alvo = tenant.buscar(data, 'usuarios', user.id, user.empresa_id);
  if (!alvo) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const body = await lerCorpo(req);
  if (!body.termos_aceito) return enviarJSON(res, 400, { erro: 'É preciso aceitar os Termos de Uso e a Política de Privacidade.' });
  const especialidades = Array.isArray(body.especialidades) ? body.especialidades.filter((e) => ESPECIALIDADES_REFRIGERACAO_VALIDAS.includes(e)) : [];
  const anos = Number(body.anos_experiencia);
  // foto_perfil segue o mesmo padrão do resto do sistema pra esse campo (ver PUT /api/usuarios/:id
  // acima): guardado direto como data: URI no registro, sem passar por extrairFotosProfundo.
  Object.assign(alvo, {
    especialidades, anos_experiencia: Number.isFinite(anos) && body.anos_experiencia !== '' ? anos : null,
    foto_perfil: body.foto_perfil !== undefined ? (body.foto_perfil || '') : (alvo.foto_perfil || ''),
    termos_aceitos_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 200, { usuario: usuarioPublico(alvo) });
});

// ---- clientes (self-contained a este menu, ver comentário acima) ----
// GET /api/os-refrigeracao-clientes?q=
rota('GET', /^\/api\/os-refrigeracao-clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_clientes', user.empresa_id);
  if (query.q) {
    const q = String(query.q).trim().toLowerCase();
    lista = lista.filter((c) => c.nome.toLowerCase().includes(q));
  }
  lista = [...lista].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  enviarJSON(res, 200, { clientes: lista });
});

// POST /api/os-refrigeracao-clientes { nome, telefone, email, cpf_cnpj, endereco }
rota('POST', /^\/api\/os-refrigeracao-clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome do cliente é obrigatório.' });
  const cliente = tenant.criar(data, 'os_refrigeracao_clientes', user.empresa_id, {
    nome: String(body.nome).trim(), telefone: body.telefone || '', email: body.email || '',
    cpf_cnpj: body.cpf_cnpj || '', endereco: body.endereco || '',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { cliente });
});

// ---- ordens de serviço ----
function camposOsRefrigeracao(body) {
  return {
    cliente_id: Number(body.cliente_id) || null,
    equipamento: {
      tipo: (body.equipamento && body.equipamento.tipo) || '',
      marca: (body.equipamento && body.equipamento.marca) || '',
      modelo: (body.equipamento && body.equipamento.modelo) || '',
      btu: (body.equipamento && body.equipamento.btu) || '',
    },
    problema_relatado: body.problema_relatado || '',
    diagnostico: body.diagnostico || '',
    servicos: Array.isArray(body.servicos) ? body.servicos.map((s) => ({ descricao: String(s.descricao || ''), valor: Number(s.valor) || 0 })) : [],
    materiais: Array.isArray(body.materiais) ? body.materiais.map((mt) => ({ nome: String(mt.nome || ''), quantidade: Number(mt.quantidade) || 1, valor_unitario: Number(mt.valor_unitario) || 0 })) : [],
    mao_de_obra: Number(body.mao_de_obra) || 0,
    desconto_tipo: body.desconto_tipo === 'percentual' ? 'percentual' : 'valor',
    desconto_valor: Number(body.desconto_valor) || 0,
    observacoes_servico: body.observacoes_servico || '',
    endereco_servico: body.endereco_servico || '',
    garantia_dias: Number.isFinite(Number(body.garantia_dias)) ? Number(body.garantia_dias) : 90,
    observacoes: body.observacoes || '',
  };
}
const MAX_FOTOS_OS_REFRIGERACAO = 10;
function validarOsRefrigeracao(data, user, campos, fotos) {
  if (!campos.cliente_id || !tenant.buscar(data, 'os_refrigeracao_clientes', campos.cliente_id, user.empresa_id)) return 'Escolha um cliente.';
  if (!campos.equipamento.tipo) return 'Informe o tipo de equipamento.';
  if (Array.isArray(fotos) && fotos.length > MAX_FOTOS_OS_REFRIGERACAO) return `No máximo ${MAX_FOTOS_OS_REFRIGERACAO} fotos.`;
  return null;
}

// GET /api/os-refrigeracao?q=&status=assinada|pendente_assinatura
rota('GET', /^\/api\/os-refrigeracao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao', user.empresa_id);
  if (query.status === 'assinada') lista = lista.filter((o) => !!o.assinatura_cliente_img);
  if (query.status === 'pendente_assinatura') lista = lista.filter((o) => !o.assinatura_cliente_img);
  lista = [...lista].sort((a, b) => b.id - a.id);
  let comDetalhes = await Promise.all(lista.map((o) => osRefrigeracaoComDetalhes(data, o)));
  if (query.q) {
    const q = String(query.q).trim().toLowerCase();
    comDetalhes = comDetalhes.filter((o) => String(o.id).includes(q) || (o.cliente_nome || '').toLowerCase().includes(q));
  }
  enviarJSON(res, 200, { ordens: comDetalhes });
});

// GET /api/os-refrigeracao/:id
rota('GET', /^\/api\/os-refrigeracao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const os = tenant.buscar(data, 'os_refrigeracao', Number(m[1]), user.empresa_id);
  if (!os) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  enviarJSON(res, 200, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// POST /api/os-refrigeracao — cria já com a assinatura do técnico (etapa final do assistente, ver
// renderOsRefrigeracaoNova em app.js) e gera o token do link público de assinatura do cliente.
rota('POST', /^\/api\/os-refrigeracao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const campos = camposOsRefrigeracao(body);
  const erro = validarOsRefrigeracao(data, user, campos, body.fotos);
  if (erro) return enviarJSON(res, 400, { erro });
  if (!body.assinatura_tecnico_img) return enviarJSON(res, 400, { erro: 'Colete a assinatura do técnico antes de criar a O.S.' });
  const os = tenant.criar(data, 'os_refrigeracao', user.empresa_id, {
    ...campos,
    fotos: Array.isArray(body.fotos) ? body.fotos.slice(0, MAX_FOTOS_OS_REFRIGERACAO) : [],
    assinatura_tecnico_img: body.assinatura_tecnico_img,
    assinatura_cliente_img: null, assinado_cliente_em: null,
    tecnico_id: user.id, tecnico_nome: user.nome, autor_id: user.id,
    token_assinatura: gerarTokenConvite(),
    // pedido do usuário: status da O.S. (Concluída/Pendente/Cancelada — ver menu "⋮" no detalhe,
    // PUT .../status abaixo). Nasce "concluida": o técnico já terminou o serviço e assinou na
    // hora de criar — "Pendente"/"Cancelada" são mudanças manuais feitas depois.
    status: 'concluida',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// PUT /api/os-refrigeracao/:id — edita tudo, exceto a assinatura do cliente (só o link público
// grava isso, ver POST /api/os-refrigeracao-assinar/:token abaixo). Reassinar pelo técnico é
// opcional: se não vier `assinatura_tecnico_img` no corpo, mantém a que já existia.
rota('PUT', /^\/api\/os-refrigeracao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const os = tenant.buscar(data, 'os_refrigeracao', Number(m[1]), user.empresa_id);
  if (!os) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const campos = camposOsRefrigeracao(body);
  const erro = validarOsRefrigeracao(data, user, campos, body.fotos);
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(os, campos, {
    fotos: Array.isArray(body.fotos) ? body.fotos.slice(0, MAX_FOTOS_OS_REFRIGERACAO) : os.fotos,
    assinatura_tecnico_img: body.assinatura_tecnico_img || os.assinatura_tecnico_img,
  });
  db.save(data);
  enviarJSON(res, 200, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// PUT /api/os-refrigeracao/:id/status — pedido do usuário: menu "⋮" no detalhe da O.S.
// (Pendente/Cancelada), separado da edição completa (PUT /:id acima) pra não exigir reenviar
// todos os campos só pra mudar o status.
const OS_REFRIGERACAO_STATUS_VALIDOS = ['concluida', 'pendente', 'cancelada'];
rota('PUT', /^\/api\/os-refrigeracao\/(\d+)\/status$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const os = tenant.buscar(data, 'os_refrigeracao', Number(m[1]), user.empresa_id);
  if (!os) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  const body = await lerCorpo(req);
  if (!OS_REFRIGERACAO_STATUS_VALIDOS.includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
  os.status = body.status;
  db.save(data);
  enviarJSON(res, 200, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// DELETE /api/os-refrigeracao/:id
rota('DELETE', /^\/api\/os-refrigeracao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const os = tenant.buscar(data, 'os_refrigeracao', Number(m[1]), user.empresa_id);
  if (!os) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  data.os_refrigeracao = data.os_refrigeracao.filter((o) => o.id !== os.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- link público de assinatura do cliente (sem login, token próprio — mesmo padrão de /api/entregas) ----
function buscarOsRefrigeracaoPorToken(data, token) {
  return data.os_refrigeracao.find((o) => o.token_assinatura === token) || null;
}
// GET /api/os-refrigeracao-assinar/:token — pública
rota('GET', /^\/api\/os-refrigeracao-assinar\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const os = buscarOsRefrigeracaoPorToken(data, m[1]);
  if (!os) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  enviarJSON(res, 200, { os: await osRefrigeracaoResumoPublico(data, os) });
});
// POST /api/os-refrigeracao-assinar/:token — pública: grava a assinatura do cliente (uma vez só —
// o link vira só-leitura depois, igual à Entrega para Teste) e avisa o técnico por push.
rota('POST', /^\/api\/os-refrigeracao-assinar\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const os = buscarOsRefrigeracaoPorToken(data, m[1]);
  if (!os) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  if (os.assinatura_cliente_img) return enviarJSON(res, 409, { erro: 'Esta O.S. já foi assinada pelo cliente.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), os.empresa_id);
  if (!body.assinatura_cliente_img) return enviarJSON(res, 400, { erro: 'Desenhe a assinatura antes de confirmar.' });
  os.assinatura_cliente_img = body.assinatura_cliente_img;
  os.assinado_cliente_em = new Date().toISOString();
  db.save(data);
  enviarPush(data, os.autor_id, {
    titulo: 'Cliente assinou a O.S. #' + os.id,
    corpo: `A assinatura do cliente da O.S. #${os.id} foi registrada.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { os: await osRefrigeracaoResumoPublico(data, os) });
});

// ---------- Orçamentos — perfil "Refrigeração e Climatização" ----------
// pedido do usuário (atalho #3 dos 6 do menu iClima): reaproveita o cadastro de clientes de
// os_refrigeracao_clientes (mesma base da O.S.), mas coleção própria (os_refrigeracao_orcamentos)
// porque o fluxo diverge da O.S. em dois pontos: (1) a assinatura do TÉCNICO é opcional e
// posterior — não é exigida na criação, só quando ele usa "Assinar agora" na tela de detalhe
// (ver POST .../assinar-tecnico abaixo); (2) o status vira "aprovado" automaticamente quando o
// CLIENTE assina pelo link público, não quando o técnico cria. ATENÇÃO (pedido explícito do
// usuário): no app de referência (iClima), o PDF e o link público do orçamento mostram só o
// total, escondendo do cliente o detalhamento do que está sendo cobrado — isso é um defeito da
// referência, não um comportamento a copiar. orcamentoRefrigeracaoResumoPublico abaixo SEMPRE
// devolve o detalhamento completo (serviços, materiais, mão de obra, desconto, condições de
// pagamento), nunca só o total.
function totaisOrcamentoRefrigeracao(orc) { return totaisOsRefrigeracao(orc); }

async function orcamentoRefrigeracaoComDetalhes(data, orc) {
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === orc.cliente_id && c.empresa_id === orc.empresa_id);
  return {
    ...orc,
    assinatura_tecnico_img: await hidratarFotosProfundo(orc.assinatura_tecnico_img),
    assinatura_cliente_img: await hidratarFotosProfundo(orc.assinatura_cliente_img),
    cliente_nome: cliente ? cliente.nome : null,
    ...totaisOrcamentoRefrigeracao(orc),
  };
}
// a versão pública (link de assinatura) nunca devolve token_assinatura/empresa_id/tecnico_id/
// autor_id pro cliente — mas leva o detalhamento completo (serviços/materiais/desconto/condições
// de pagamento), nunca só o total (ver comentário acima).
async function orcamentoRefrigeracaoResumoPublico(data, orc) {
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === orc.cliente_id && c.empresa_id === orc.empresa_id);
  return {
    id: orc.id, cliente_nome: cliente ? cliente.nome : null, criado_em: orc.criado_em, status: orc.status,
    titulo: orc.titulo, descricao_cliente: orc.descricao_cliente, diagnostico_tecnico: orc.diagnostico_tecnico,
    descricao_geral: orc.descricao_geral, servicos: orc.servicos, materiais: orc.materiais,
    mao_de_obra: orc.mao_de_obra, desconto_tipo: orc.desconto_tipo, desconto_valor: orc.desconto_valor,
    condicoes_pagamento: orc.condicoes_pagamento, validade_dias: orc.validade_dias,
    assinatura_tecnico_img: await hidratarFotosProfundo(orc.assinatura_tecnico_img),
    assinatura_cliente_img: await hidratarFotosProfundo(orc.assinatura_cliente_img),
    ...totaisOrcamentoRefrigeracao(orc),
  };
}

function camposOrcamentoRefrigeracao(body) {
  return {
    cliente_id: Number(body.cliente_id) || null,
    titulo: body.titulo || '',
    descricao_cliente: body.descricao_cliente || '',
    diagnostico_tecnico: body.diagnostico_tecnico || '',
    descricao_geral: body.descricao_geral || '',
    servicos: Array.isArray(body.servicos) ? body.servicos.map((s) => ({ descricao: String(s.descricao || ''), valor: Number(s.valor) || 0 })) : [],
    materiais: Array.isArray(body.materiais) ? body.materiais.map((mt) => ({ nome: String(mt.nome || ''), quantidade: Number(mt.quantidade) || 1, valor_unitario: Number(mt.valor_unitario) || 0 })) : [],
    mao_de_obra: Number(body.mao_de_obra) || 0,
    desconto_tipo: body.desconto_tipo === 'percentual' ? 'percentual' : 'valor',
    desconto_valor: Number(body.desconto_valor) || 0,
    condicoes_pagamento: body.condicoes_pagamento || '',
    validade_dias: Number.isFinite(Number(body.validade_dias)) && body.validade_dias !== '' ? Number(body.validade_dias) : 15,
    observacoes: body.observacoes || '',
  };
}
function validarOrcamentoRefrigeracao(data, user, campos) {
  if (!campos.cliente_id || !tenant.buscar(data, 'os_refrigeracao_clientes', campos.cliente_id, user.empresa_id)) return 'Escolha um cliente.';
  if (!String(campos.titulo).trim()) return 'Informe um título pro orçamento.';
  if (!campos.servicos.length && !campos.materiais.length) return 'Adicione ao menos um serviço ou material.';
  return null;
}

// GET /api/os-refrigeracao-orcamentos?q=&status=rascunho|aprovado|cancelado
rota('GET', /^\/api\/os-refrigeracao-orcamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_orcamentos', user.empresa_id);
  if (query.status) lista = lista.filter((o) => o.status === query.status);
  lista = [...lista].sort((a, b) => b.id - a.id);
  let comDetalhes = await Promise.all(lista.map((o) => orcamentoRefrigeracaoComDetalhes(data, o)));
  if (query.q) {
    const q = String(query.q).trim().toLowerCase();
    comDetalhes = comDetalhes.filter((o) => String(o.id).includes(q) || (o.cliente_nome || '').toLowerCase().includes(q) || (o.titulo || '').toLowerCase().includes(q));
  }
  enviarJSON(res, 200, { orcamentos: comDetalhes });
});

// GET /api/os-refrigeracao-orcamentos/:id
rota('GET', /^\/api\/os-refrigeracao-orcamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const orc = tenant.buscar(data, 'os_refrigeracao_orcamentos', Number(m[1]), user.empresa_id);
  if (!orc) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoComDetalhes(data, orc) });
});

// POST /api/os-refrigeracao-orcamentos — cria em Rascunho; diferente da O.S., NÃO exige
// assinatura do técnico na criação (ela é opcional/posterior, ver "Assinar agora" na tela de
// detalhe, POST .../assinar-tecnico abaixo) — já nasce com o link público pronto porque o
// técnico pode querer enviar pro cliente antes mesmo de assinar.
rota('POST', /^\/api\/os-refrigeracao-orcamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const campos = camposOrcamentoRefrigeracao(body);
  const erro = validarOrcamentoRefrigeracao(data, user, campos);
  if (erro) return enviarJSON(res, 400, { erro });
  const orc = tenant.criar(data, 'os_refrigeracao_orcamentos', user.empresa_id, {
    ...campos,
    assinatura_tecnico_img: null, assinado_tecnico_em: null,
    assinatura_cliente_img: null, assinado_cliente_em: null,
    tecnico_id: user.id, tecnico_nome: user.nome, autor_id: user.id,
    token_assinatura: gerarTokenConvite(),
    status: 'rascunho',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { orcamento: await orcamentoRefrigeracaoComDetalhes(data, orc) });
});

// PUT /api/os-refrigeracao-orcamentos/:id — edita o conteúdo; não toca em status nem nas
// assinaturas (ver rotas dedicadas abaixo).
rota('PUT', /^\/api\/os-refrigeracao-orcamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const orc = tenant.buscar(data, 'os_refrigeracao_orcamentos', Number(m[1]), user.empresa_id);
  if (!orc) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  const body = await lerCorpo(req);
  const campos = camposOrcamentoRefrigeracao(body);
  const erro = validarOrcamentoRefrigeracao(data, user, campos);
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(orc, campos);
  db.save(data);
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoComDetalhes(data, orc) });
});

// POST /api/os-refrigeracao-orcamentos/:id/assinar-tecnico — pedido do usuário: "Assinar agora"
// na tela de detalhe (diferente da O.S., aqui a assinatura do técnico não é exigida na criação).
rota('POST', /^\/api\/os-refrigeracao-orcamentos\/(\d+)\/assinar-tecnico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const orc = tenant.buscar(data, 'os_refrigeracao_orcamentos', Number(m[1]), user.empresa_id);
  if (!orc) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.assinatura_tecnico_img) return enviarJSON(res, 400, { erro: 'Desenhe a assinatura antes de confirmar.' });
  orc.assinatura_tecnico_img = body.assinatura_tecnico_img;
  orc.assinado_tecnico_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoComDetalhes(data, orc) });
});

// PUT /api/os-refrigeracao-orcamentos/:id/status — menu "⋮" no detalhe: só Rascunho/Cancelado
// (manual) — "Aprovado" só é gravado automaticamente quando o cliente assina pelo link público
// (ver POST .../assinar abaixo), nunca por aqui.
const OS_REFRIGERACAO_ORCAMENTO_STATUS_VALIDOS = ['rascunho', 'cancelado'];
rota('PUT', /^\/api\/os-refrigeracao-orcamentos\/(\d+)\/status$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const orc = tenant.buscar(data, 'os_refrigeracao_orcamentos', Number(m[1]), user.empresa_id);
  if (!orc) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  const body = await lerCorpo(req);
  if (!OS_REFRIGERACAO_ORCAMENTO_STATUS_VALIDOS.includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
  orc.status = body.status;
  db.save(data);
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoComDetalhes(data, orc) });
});

// DELETE /api/os-refrigeracao-orcamentos/:id
rota('DELETE', /^\/api\/os-refrigeracao-orcamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const orc = tenant.buscar(data, 'os_refrigeracao_orcamentos', Number(m[1]), user.empresa_id);
  if (!orc) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  data.os_refrigeracao_orcamentos = data.os_refrigeracao_orcamentos.filter((o) => o.id !== orc.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- link público de assinatura do cliente (sem login, token próprio — mesmo padrão da O.S.) ----
function buscarOrcamentoRefrigeracaoPorToken(data, token) {
  return data.os_refrigeracao_orcamentos.find((o) => o.token_assinatura === token) || null;
}
// GET /api/os-refrigeracao-orcamentos-assinar/:token — pública. Resumo SEMPRE com o
// detalhamento completo (ver orcamentoRefrigeracaoResumoPublico) — nunca só o total.
rota('GET', /^\/api\/os-refrigeracao-orcamentos-assinar\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const orc = buscarOrcamentoRefrigeracaoPorToken(data, m[1]);
  if (!orc) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoResumoPublico(data, orc) });
});
// POST /api/os-refrigeracao-orcamentos-assinar/:token — pública: grava a assinatura do cliente
// (uma vez só) e já aprova o orçamento (status vira "aprovado" automaticamente), avisando o
// técnico por push.
rota('POST', /^\/api\/os-refrigeracao-orcamentos-assinar\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const orc = buscarOrcamentoRefrigeracaoPorToken(data, m[1]);
  if (!orc) return enviarJSON(res, 404, { erro: 'Link inválido ou expirado.' });
  if (orc.assinatura_cliente_img) return enviarJSON(res, 409, { erro: 'Este orçamento já foi assinado pelo cliente.' });
  if (orc.status === 'cancelado') return enviarJSON(res, 409, { erro: 'Este orçamento foi cancelado.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), orc.empresa_id);
  if (!body.assinatura_cliente_img) return enviarJSON(res, 400, { erro: 'Desenhe a assinatura antes de confirmar.' });
  orc.assinatura_cliente_img = body.assinatura_cliente_img;
  orc.assinado_cliente_em = new Date().toISOString();
  orc.status = 'aprovado';
  db.save(data);
  enviarPush(data, orc.autor_id, {
    titulo: 'Orçamento aprovado — #' + orc.id,
    corpo: `O cliente assinou e aprovou o orçamento #${orc.id}.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { orcamento: await orcamentoRefrigeracaoResumoPublico(data, orc) });
});

// ---------- Agenda — perfil "Refrigeração e Climatização" ----------
// pedido do usuário (referência: app concorrente iClima, 4º atalho): uma configuração de
// disponibilidade POR TÉCNICO (dias de atendimento, horário de trabalho, pausa, duração do
// atendimento, máx. por dia, datas bloqueadas) gera a "grade" de horários do dia; o agendamento
// manual só pode ser criado num horário que a grade devolve como disponível. Diferente da
// O.S./Orçamento, não usa o cadastro os_refrigeracao_clientes — o agendamento guarda nome/
// telefone/endereço direto (mesmo padrão do "Novo Agendamento Manual" do app de referência).
// Técnico (suporte) só mexe na própria agenda; administrador vê/agenda em nome de qualquer
// técnico da empresa (rótulo "Agenda geral" no menu).
const AGENDA_REF_DIAS_VALIDOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const AGENDA_REF_DURACOES_VALIDAS = [30, 45, 60, 90, 120, 180];
function diaSemanaChaveAgendaRef(dataIso) {
  // meio-dia fixo evita o fuso horário local empurrar a data pro dia anterior/seguinte e bater o
  // dia da semana errado perto da meia-noite.
  return AGENDA_REF_DIAS_VALIDOS[new Date(dataIso + 'T12:00:00').getDay()];
}
function paraMinutosAgendaRef(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function paraHorarioAgendaRef(minutos) {
  const h = Math.floor(minutos / 60), m = minutos % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
// grade "crua" do dia (todo slot gerado pela duração, do início ao fim, marcando os que caem
// dentro da pausa) — espelha o "Preview do dia" da tela de configuração, que mostra a grade
// inteira (inclusive o slot da pausa, só marcado) independente do máx. por dia.
function gerarGradeAgendaRefrigeracao(config, dataIso) {
  if (!config) return [];
  if (!Array.isArray(config.dias_semana) || !config.dias_semana.includes(diaSemanaChaveAgendaRef(dataIso))) return [];
  if (Array.isArray(config.datas_bloqueadas) && config.datas_bloqueadas.includes(dataIso)) return [];
  const duracao = AGENDA_REF_DURACOES_VALIDAS.includes(Number(config.duracao_min)) ? Number(config.duracao_min) : 60;
  const inicio = paraMinutosAgendaRef(config.hora_inicio), fim = paraMinutosAgendaRef(config.hora_fim);
  const pausaInicio = config.pausa_ativa ? paraMinutosAgendaRef(config.pausa_inicio) : null;
  const pausaFim = config.pausa_ativa ? paraMinutosAgendaRef(config.pausa_fim) : null;
  const grade = [];
  for (let cursor = inicio; cursor + duracao <= fim; cursor += duracao) {
    const pausa = pausaInicio !== null && cursor < pausaFim && cursor + duracao > pausaInicio;
    grade.push({ hora: paraHorarioAgendaRef(cursor), pausa });
  }
  return grade;
}
// grade "real" de agendamento: aplica o máx. por dia (só nos slots que não são pausa, na ordem) e
// marca os que já têm agendamento (status != cancelado) — é o que a tela de Novo Agendamento usa
// pra oferecer só horário de verdade disponível.
function slotsAgendaRefrigeracao(data, tecnicoId, empresaId, dataIso) {
  const config = data.os_refrigeracao_agenda_config.find((c) => c.tecnico_id === tecnicoId && c.empresa_id === empresaId);
  if (!config) return { config_existe: false, slots: [] };
  const grade = gerarGradeAgendaRefrigeracao(config, dataIso);
  const maxPorDia = Number(config.max_por_dia) > 0 ? Number(config.max_por_dia) : grade.length;
  const ocupados = new Set(
    data.os_refrigeracao_agendamentos
      .filter((a) => a.tecnico_id === tecnicoId && a.empresa_id === empresaId && a.data === dataIso && a.status !== 'cancelado')
      .map((a) => a.hora)
  );
  let contador = 0;
  const slots = grade.map((s) => {
    if (s.pausa) return { hora: s.hora, pausa: true, ocupado: false, disponivel: false };
    contador += 1;
    const ocupado = ocupados.has(s.hora);
    return { hora: s.hora, pausa: false, ocupado, disponivel: !ocupado && contador <= maxPorDia };
  });
  return { config_existe: true, slots };
}

function validarConfigAgendaRefrigeracao(body) {
  if (!Array.isArray(body.dias_semana) || !body.dias_semana.some((d) => AGENDA_REF_DIAS_VALIDOS.includes(d))) return 'Escolha ao menos um dia de atendimento.';
  if (!/^\d{2}:\d{2}$/.test(body.hora_inicio || '') || !/^\d{2}:\d{2}$/.test(body.hora_fim || '')) return 'Informe o horário de início e fim.';
  if (paraMinutosAgendaRef(body.hora_inicio) >= paraMinutosAgendaRef(body.hora_fim)) return 'O horário de início precisa ser antes do horário de fim.';
  if (!AGENDA_REF_DURACOES_VALIDAS.includes(Number(body.duracao_min))) return 'Escolha uma duração de atendimento válida.';
  if (body.pausa_ativa && (!/^\d{2}:\d{2}$/.test(body.pausa_inicio || '') || !/^\d{2}:\d{2}$/.test(body.pausa_fim || ''))) return 'Informe o início e o fim da pausa.';
  return null;
}
// resolve de quem é a agenda sendo pedida/editada: o próprio usuário por padrão, ou — só pro
// administrador — outro técnico da empresa via `tecnico_id`. Devolve null (e já respondeu o
// erro) quando o chamador deve parar ali.
function resolverTecnicoIdAgendaRef(res, user, data, tecnicoIdPedido) {
  if (!tecnicoIdPedido) return user.id;
  const id = Number(tecnicoIdPedido);
  if (id === user.id) return id;
  if (!exigirPapel(user, ['administrador'])) { enviarJSON(res, 403, { erro: 'Só o administrador mexe na agenda de outro técnico.' }); return null; }
  if (!tenant.buscar(data, 'usuarios', id, user.empresa_id)) { enviarJSON(res, 404, { erro: 'Técnico não encontrado.' }); return null; }
  return id;
}

// GET /api/os-refrigeracao-agenda/config?tecnico_id=
rota('GET', /^\/api\/os-refrigeracao-agenda\/config$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  const tecnicoId = resolverTecnicoIdAgendaRef(res, user, data, query.tecnico_id);
  if (tecnicoId === null) return;
  const config = data.os_refrigeracao_agenda_config.find((c) => c.tecnico_id === tecnicoId && c.empresa_id === user.empresa_id) || null;
  enviarJSON(res, 200, { config });
});

// PUT /api/os-refrigeracao-agenda/config — cria ou atualiza (upsert), uma por técnico
rota('PUT', /^\/api\/os-refrigeracao-agenda\/config$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const tecnicoId = resolverTecnicoIdAgendaRef(res, user, data, body.tecnico_id);
  if (tecnicoId === null) return;
  const erro = validarConfigAgendaRefrigeracao(body);
  if (erro) return enviarJSON(res, 400, { erro });
  const camposConfig = {
    dias_semana: body.dias_semana.filter((d) => AGENDA_REF_DIAS_VALIDOS.includes(d)),
    hora_inicio: body.hora_inicio, hora_fim: body.hora_fim,
    pausa_ativa: !!body.pausa_ativa,
    pausa_inicio: body.pausa_inicio || '12:00', pausa_fim: body.pausa_fim || '13:00',
    duracao_min: Number(body.duracao_min),
    max_por_dia: Number(body.max_por_dia) > 0 ? Number(body.max_por_dia) : 8,
    datas_bloqueadas: Array.isArray(body.datas_bloqueadas) ? body.datas_bloqueadas.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
  };
  let config = data.os_refrigeracao_agenda_config.find((c) => c.tecnico_id === tecnicoId && c.empresa_id === user.empresa_id);
  if (config) Object.assign(config, camposConfig);
  else config = tenant.criar(data, 'os_refrigeracao_agenda_config', user.empresa_id, { tecnico_id: tecnicoId, ...camposConfig });
  db.save(data);
  enviarJSON(res, 200, { config });
});

// GET /api/os-refrigeracao-agenda/slots?data=YYYY-MM-DD&tecnico_id= — grade de horários do dia
rota('GET', /^\/api\/os-refrigeracao-agenda\/slots$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data (AAAA-MM-DD).' });
  const tecnicoId = resolverTecnicoIdAgendaRef(res, user, data, query.tecnico_id);
  if (tecnicoId === null) return;
  enviarJSON(res, 200, slotsAgendaRefrigeracao(data, tecnicoId, user.empresa_id, query.data));
});

// total de horários OFERECÍVEIS num dia (fora da pausa, respeitando o máx. por dia) — mesma conta
// de slotsAgendaRefrigeracao, mas sem olhar quem já está ocupado (é usado só pro resumo do mês,
// "X/Y atendimentos", onde Y é a capacidade do dia, não quanto já foi preenchido).
function totalOferecivelDoDiaAgendaRef(config, dataIso) {
  const grade = gerarGradeAgendaRefrigeracao(config, dataIso);
  if (!grade.length) return 0;
  const maxPorDia = Number(config.max_por_dia) > 0 ? Number(config.max_por_dia) : grade.length;
  return Math.min(grade.filter((s) => !s.pausa).length, maxPorDia);
}
// GET /api/os-refrigeracao-agenda/resumo-mes?mes=YYYY-MM&tecnico_id= — pedido do usuário
// (referência: app concorrente iClima) — calendário do mês mostrando "X/Y" (agendados/capacidade)
// em cada dia, pra abrir o dia e ver a grade de horários de verdade. Um dia some do mapa `dias`
// quando a config não oferece nenhum horário ali (fora dos dias de atendimento ou data bloqueada).
rota('GET', /^\/api\/os-refrigeracao-agenda\/resumo-mes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}$/.test(query.mes || '')) return enviarJSON(res, 400, { erro: 'Informe o mês (AAAA-MM).' });
  const tecnicoId = resolverTecnicoIdAgendaRef(res, user, data, query.tecnico_id);
  if (tecnicoId === null) return;
  const config = data.os_refrigeracao_agenda_config.find((c) => c.tecnico_id === tecnicoId && c.empresa_id === user.empresa_id) || null;
  const [ano, mes] = query.mes.split('-').map(Number);
  const dias = {};
  if (config) {
    const diasNoMes = new Date(ano, mes, 0).getDate();
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const dataIso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      const total = totalOferecivelDoDiaAgendaRef(config, dataIso);
      if (total > 0) {
        const agendados = data.os_refrigeracao_agendamentos.filter((a) => a.tecnico_id === tecnicoId && a.empresa_id === user.empresa_id && a.data === dataIso && a.status !== 'cancelado').length;
        dias[dataIso] = { total, agendados };
      }
    }
  }
  enviarJSON(res, 200, { config_existe: !!config, dias });
});

// ---- agendamentos ----
const AGENDA_REF_TIPOS_SERVICO_VALIDOS = ['instalacao', 'manutencao_preventiva', 'manutencao_corretiva', 'higienizacao', 'desinstalacao', 'visita_tecnica', 'orcamento', 'outro'];
const AGENDA_REF_STATUS_VALIDOS = ['agendado', 'concluido', 'cancelado'];
function camposAgendamentoRefrigeracao(body) {
  return {
    cliente_nome: String(body.cliente_nome || '').trim(),
    telefone: String(body.telefone || '').trim(),
    endereco: body.endereco || '',
    tipo_servico: AGENDA_REF_TIPOS_SERVICO_VALIDOS.includes(body.tipo_servico) ? body.tipo_servico : 'outro',
    data: body.data || '', hora: body.hora || '',
    valor_servico: Number(body.valor_servico) || 0,
    observacoes: body.observacoes || '',
  };
}
function validarAgendamentoRefrigeracao(campos) {
  if (!campos.cliente_nome) return 'Informe o nome do cliente.';
  if (!campos.telefone) return 'Informe o telefone do cliente.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campos.data)) return 'Informe uma data válida.';
  if (!/^\d{2}:\d{2}$/.test(campos.hora)) return 'Escolha um horário.';
  return null;
}

// GET /api/os-refrigeracao-agendamentos?data=&tecnico_id=&status=
rota('GET', /^\/api\/os-refrigeracao-agendamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id);
  // suporte só vê os próprios agendamentos; administrador vê de todos (e pode filtrar por técnico).
  if (!exigirPapel(user, ['administrador'])) lista = lista.filter((a) => a.tecnico_id === user.id);
  else if (query.tecnico_id) lista = lista.filter((a) => a.tecnico_id === Number(query.tecnico_id));
  if (query.data) lista = lista.filter((a) => a.data === query.data);
  if (query.status) lista = lista.filter((a) => a.status === query.status);
  lista = [...lista].sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
  enviarJSON(res, 200, { agendamentos: lista });
});

// POST /api/os-refrigeracao-agendamentos — só cria num horário que a grade (ver slotsAgendaRefrigeracao
// acima) devolve como disponível: dentro do dia/horário configurado, fora da pausa, dentro do
// máx. por dia e ainda não ocupado.
rota('POST', /^\/api\/os-refrigeracao-agendamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const tecnicoId = resolverTecnicoIdAgendaRef(res, user, data, body.tecnico_id);
  if (tecnicoId === null) return;
  const tecnico = tenant.buscar(data, 'usuarios', tecnicoId, user.empresa_id);
  const campos = camposAgendamentoRefrigeracao(body);
  const erro = validarAgendamentoRefrigeracao(campos);
  if (erro) return enviarJSON(res, 400, { erro });
  const { config_existe, slots } = slotsAgendaRefrigeracao(data, tecnicoId, user.empresa_id, campos.data);
  if (!config_existe) return enviarJSON(res, 400, { erro: 'Configure a disponibilidade do técnico antes de agendar.' });
  const slotEscolhido = slots.find((s) => s.hora === campos.hora);
  if (!slotEscolhido || !slotEscolhido.disponivel) return enviarJSON(res, 400, { erro: 'Esse horário não está disponível.' });
  const agendamento = tenant.criar(data, 'os_refrigeracao_agendamentos', user.empresa_id, {
    ...campos, tecnico_id: tecnicoId, tecnico_nome: tecnico ? tecnico.nome : '',
    autor_id: user.id, status: 'agendado', criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { agendamento });
});

// PUT /api/os-refrigeracao-agendamentos/:id/status — menu "⋮" (Concluído/Cancelado)
rota('PUT', /^\/api\/os-refrigeracao-agendamentos\/(\d+)\/status$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const agendamento = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!agendamento) return enviarJSON(res, 404, { erro: 'Agendamento não encontrado.' });
  if (agendamento.tecnico_id !== user.id && !exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso a este agendamento.' });
  const body = await lerCorpo(req);
  if (!AGENDA_REF_STATUS_VALIDOS.includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
  agendamento.status = body.status;
  db.save(data);
  enviarJSON(res, 200, { agendamento });
});

// DELETE /api/os-refrigeracao-agendamentos/:id
rota('DELETE', /^\/api\/os-refrigeracao-agendamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const agendamento = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!agendamento) return enviarJSON(res, 404, { erro: 'Agendamento não encontrado.' });
  if (agendamento.tecnico_id !== user.id && !exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso a este agendamento.' });
  data.os_refrigeracao_agendamentos = data.os_refrigeracao_agendamentos.filter((a) => a.id !== agendamento.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- Pacote "Climatização / PMOC" — perfil "Refrigeração e Climatização" ----------
// pedido do usuário: pacote PMOC (Lei 13.589/2018), Fase 1 — Cadastro: local do cliente final
// (estabelecimento, um cliente pode ter vários), ambientes de cada local, aparelhos de
// climatização de cada ambiente, e o responsável técnico (CREA/CFT) da própria empresa de
// Refrigeração. Pendurado em os_refrigeracao_clientes (mesma base de O.S./Orçamento/Agenda desse
// perfil) — nunca na coleção `clientes`/`equipamentos` núcleo (ver comentário em
// os_refrigeracao_clientes, db.js). Além do gate de `perfil` (exigirPerfilRefrigeracao abaixo),
// estas rotas também exigem o módulo `pmoc` ativo pra empresa — checagem automática central (ver
// prefixo '/api/pmoc' em rotas-modulo.js), não precisa repetir isso rota a rota.

// ---- locais (estabelecimento do cliente final) ----
function pmocLocalComDetalhes(data, local) {
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === local.cliente_id && c.empresa_id === local.empresa_id);
  const ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === local.id);
  const aparelhos = data.os_refrigeracao_pmoc_aparelhos.filter((p) => ambientes.some((a) => a.id === p.ambiente_id));
  return { ...local, cliente_nome: cliente ? cliente.nome : null, total_ambientes: ambientes.length, total_aparelhos: aparelhos.length };
}
// pedido do usuário: "não codificar regras legais fixas... deixar configurável" — tipo de
// atividade é só um rótulo pra ajudar o técnico a identificar o estabelecimento (igual
// OS_REF_TIPOS_EQUIPAMENTO no app.js), não trava regra nenhuma de BTU/periodicidade.
const PMOC_TIPOS_ATIVIDADE_VALIDOS = ['loja', 'clinica', 'escritorio', 'escola', 'orgao_publico', 'outro'];
function camposPmocLocal(body) {
  return {
    cliente_id: Number(body.cliente_id) || null,
    nome: String(body.nome || '').trim(),
    endereco: body.endereco || '',
    tipo_atividade: PMOC_TIPOS_ATIVIDADE_VALIDOS.includes(body.tipo_atividade) ? body.tipo_atividade : 'outro',
    area_climatizada_m2: Number(body.area_climatizada_m2) || null,
    ocupantes_fixos: Number.isFinite(Number(body.ocupantes_fixos)) ? Number(body.ocupantes_fixos) : null,
    ocupantes_flutuantes: Number.isFinite(Number(body.ocupantes_flutuantes)) ? Number(body.ocupantes_flutuantes) : null,
    responsavel_nome: body.responsavel_nome || '',
    responsavel_telefone: body.responsavel_telefone || '',
    responsavel_email: body.responsavel_email || '',
  };
}

// GET /api/pmoc/locais?cliente_id=&q=
rota('GET', /^\/api\/pmoc\/locais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_pmoc_locais', user.empresa_id);
  if (query.cliente_id) lista = lista.filter((l) => l.cliente_id === Number(query.cliente_id));
  let comDetalhes = lista.map((l) => pmocLocalComDetalhes(data, l));
  if (query.q) {
    const q = String(query.q).trim().toLowerCase();
    comDetalhes = comDetalhes.filter((l) => l.nome.toLowerCase().includes(q) || (l.cliente_nome || '').toLowerCase().includes(q));
  }
  comDetalhes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  enviarJSON(res, 200, { locais: comDetalhes });
});

// POST /api/pmoc/locais
rota('POST', /^\/api\/pmoc\/locais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const campos = camposPmocLocal(await lerCorpo(req));
  if (!campos.cliente_id || !tenant.buscar(data, 'os_refrigeracao_clientes', campos.cliente_id, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Escolha um cliente.' });
  if (!campos.nome) return enviarJSON(res, 400, { erro: 'Nome do local é obrigatório.' });
  const local = tenant.criar(data, 'os_refrigeracao_pmoc_locais', user.empresa_id, { ...campos, criado_em: new Date().toISOString() });
  db.save(data);
  enviarJSON(res, 201, { local: pmocLocalComDetalhes(data, local) });
});

// GET /api/pmoc/locais/:id — vem com ambientes (e os aparelhos de cada ambiente) já aninhados,
// pra tela de detalhe não precisar de mais 2 requisições em cascata.
rota('GET', /^\/api\/pmoc\/locais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === local.id)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map((a) => ({ ...a, aparelhos: data.os_refrigeracao_pmoc_aparelhos.filter((p) => p.ambiente_id === a.id).sort((x, y) => x.id - y.id) }));
  enviarJSON(res, 200, { local: pmocLocalComDetalhes(data, local), ambientes });
});

// PUT /api/pmoc/locais/:id
rota('PUT', /^\/api\/pmoc\/locais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const campos = camposPmocLocal(await lerCorpo(req));
  if (!campos.cliente_id || !tenant.buscar(data, 'os_refrigeracao_clientes', campos.cliente_id, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Escolha um cliente.' });
  if (!campos.nome) return enviarJSON(res, 400, { erro: 'Nome do local é obrigatório.' });
  Object.assign(local, campos);
  db.save(data);
  enviarJSON(res, 200, { local: pmocLocalComDetalhes(data, local) });
});

// DELETE /api/pmoc/locais/:id — cascade: remove os ambientes e aparelhos daquele local junto (o
// plano PMOC ainda não existe nesta fase, então não há mais nada pendurado nele pra arrastar).
rota('DELETE', /^\/api\/pmoc\/locais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const idsAmbientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === local.id).map((a) => a.id);
  data.os_refrigeracao_pmoc_aparelhos = data.os_refrigeracao_pmoc_aparelhos.filter((p) => !idsAmbientes.includes(p.ambiente_id));
  data.os_refrigeracao_pmoc_ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id !== local.id);
  data.os_refrigeracao_pmoc_locais = data.os_refrigeracao_pmoc_locais.filter((l) => l.id !== local.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- ambientes (de um local) ----
function camposPmocAmbiente(body) {
  return {
    nome: String(body.nome || '').trim(),
    andar: body.andar || '',
    area_m2: Number(body.area_m2) || null,
    ocupantes: Number.isFinite(Number(body.ocupantes)) ? Number(body.ocupantes) : null,
  };
}

// GET /api/pmoc/ambientes?local_id=
rota('GET', /^\/api\/pmoc\/ambientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_pmoc_ambientes', user.empresa_id);
  if (query.local_id) lista = lista.filter((a) => a.local_id === Number(query.local_id));
  enviarJSON(res, 200, { ambientes: [...lista].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')) });
});

// POST /api/pmoc/ambientes { local_id, nome, andar, area_m2, ocupantes }
rota('POST', /^\/api\/pmoc\/ambientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const localId = Number(body.local_id) || null;
  if (!localId || !tenant.buscar(data, 'os_refrigeracao_pmoc_locais', localId, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Local inválido.' });
  const campos = camposPmocAmbiente(body);
  if (!campos.nome) return enviarJSON(res, 400, { erro: 'Nome do ambiente é obrigatório.' });
  const ambiente = tenant.criar(data, 'os_refrigeracao_pmoc_ambientes', user.empresa_id, { ...campos, local_id: localId, criado_em: new Date().toISOString() });
  db.save(data);
  enviarJSON(res, 201, { ambiente });
});

// PUT /api/pmoc/ambientes/:id
rota('PUT', /^\/api\/pmoc\/ambientes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const ambiente = tenant.buscar(data, 'os_refrigeracao_pmoc_ambientes', Number(m[1]), user.empresa_id);
  if (!ambiente) return enviarJSON(res, 404, { erro: 'Ambiente não encontrado.' });
  const campos = camposPmocAmbiente(await lerCorpo(req));
  if (!campos.nome) return enviarJSON(res, 400, { erro: 'Nome do ambiente é obrigatório.' });
  Object.assign(ambiente, campos);
  db.save(data);
  enviarJSON(res, 200, { ambiente });
});

// DELETE /api/pmoc/ambientes/:id — cascade: remove os aparelhos daquele ambiente junto.
rota('DELETE', /^\/api\/pmoc\/ambientes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const ambiente = tenant.buscar(data, 'os_refrigeracao_pmoc_ambientes', Number(m[1]), user.empresa_id);
  if (!ambiente) return enviarJSON(res, 404, { erro: 'Ambiente não encontrado.' });
  data.os_refrigeracao_pmoc_aparelhos = data.os_refrigeracao_pmoc_aparelhos.filter((p) => p.ambiente_id !== ambiente.id);
  data.os_refrigeracao_pmoc_ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.id !== ambiente.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- aparelhos de climatização (de um ambiente) ----
const PMOC_STATUS_APARELHO_VALIDOS = ['ativo', 'parado', 'aguardando_peca', 'desativado'];
function camposPmocAparelho(body) {
  return {
    tipo: String(body.tipo || '').trim(),
    marca: body.marca || '',
    modelo: body.modelo || '',
    numero_serie: body.numero_serie || '',
    capacidade_btu: body.capacidade_btu || '',
    fluido_refrigerante: body.fluido_refrigerante || '',
    tensao: body.tensao || '',
    data_instalacao: body.data_instalacao || '',
    garantia_ate: body.garantia_ate || '',
    codigo_patrimonio: body.codigo_patrimonio || '',
  };
}

// GET /api/pmoc/aparelhos?ambiente_id=&local_id=
rota('GET', /^\/api\/pmoc\/aparelhos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  let lista = tenant.listar(data, 'os_refrigeracao_pmoc_aparelhos', user.empresa_id);
  if (query.ambiente_id) lista = lista.filter((p) => p.ambiente_id === Number(query.ambiente_id));
  if (query.local_id) {
    const idsAmbientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === Number(query.local_id)).map((a) => a.id);
    lista = lista.filter((p) => idsAmbientes.includes(p.ambiente_id));
  }
  enviarJSON(res, 200, { aparelhos: [...lista].sort((a, b) => a.id - b.id) });
});

// POST /api/pmoc/aparelhos — nasce com QR próprio (mesmo gerador já usado em "Redes e Filiais",
// ver db.gerarQrToken), pra fase 5 (etiquetas/scan) não precisar de migração nenhuma depois.
rota('POST', /^\/api\/pmoc\/aparelhos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const ambienteId = Number(body.ambiente_id) || null;
  if (!ambienteId || !tenant.buscar(data, 'os_refrigeracao_pmoc_ambientes', ambienteId, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Ambiente inválido.' });
  const campos = camposPmocAparelho(body);
  if (!campos.tipo) return enviarJSON(res, 400, { erro: 'Informe o tipo do aparelho.' });
  const aparelho = tenant.criar(data, 'os_refrigeracao_pmoc_aparelhos', user.empresa_id, {
    ...campos, ambiente_id: ambienteId, status: 'ativo', qr_token: db.gerarQrToken(), criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { aparelho });
});

// PUT /api/pmoc/aparelhos/:id
rota('PUT', /^\/api\/pmoc\/aparelhos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  const campos = camposPmocAparelho(await lerCorpo(req));
  if (!campos.tipo) return enviarJSON(res, 400, { erro: 'Informe o tipo do aparelho.' });
  Object.assign(aparelho, campos);
  db.save(data);
  enviarJSON(res, 200, { aparelho });
});

// PUT /api/pmoc/aparelhos/:id/status — mesmo padrão de PUT /api/os-refrigeracao/:id/status acima:
// troca rápida de status sem reenviar o cadastro inteiro.
rota('PUT', /^\/api\/pmoc\/aparelhos\/(\d+)\/status$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  const body = await lerCorpo(req);
  if (!PMOC_STATUS_APARELHO_VALIDOS.includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
  aparelho.status = body.status;
  db.save(data);
  enviarJSON(res, 200, { aparelho });
});

// DELETE /api/pmoc/aparelhos/:id
rota('DELETE', /^\/api\/pmoc\/aparelhos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  data.os_refrigeracao_pmoc_aparelhos = data.os_refrigeracao_pmoc_aparelhos.filter((p) => p.id !== aparelho.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- responsáveis técnicos (CREA/CFT, cadastrados pela própria empresa de Refrigeração) ----
rota('GET', /^\/api\/pmoc\/responsaveis-tecnicos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const lista = tenant.listar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', user.empresa_id);
  const comFoto = await Promise.all(lista.map(async (r) => ({ ...r, assinatura_img: await hidratarFotosProfundo(r.assinatura_img) })));
  comFoto.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  enviarJSON(res, 200, { responsaveis: comFoto });
});

// POST /api/pmoc/responsaveis-tecnicos { nome, formacao, registro_profissional, email, telefone, assinatura_img }
rota('POST', /^\/api\/pmoc\/responsaveis-tecnicos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const nome = String(body.nome || '').trim();
  if (!nome) return enviarJSON(res, 400, { erro: 'Nome é obrigatório.' });
  const responsavel = tenant.criar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', user.empresa_id, {
    nome, formacao: body.formacao || '', registro_profissional: body.registro_profissional || '',
    email: body.email || '', telefone: body.telefone || '', assinatura_img: body.assinatura_img || null,
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { responsavel: { ...responsavel, assinatura_img: await hidratarFotosProfundo(responsavel.assinatura_img) } });
});

// PUT /api/pmoc/responsaveis-tecnicos/:id
rota('PUT', /^\/api\/pmoc\/responsaveis-tecnicos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const responsavel = tenant.buscar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', Number(m[1]), user.empresa_id);
  if (!responsavel) return enviarJSON(res, 404, { erro: 'Responsável técnico não encontrado.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const nome = String(body.nome || '').trim();
  if (!nome) return enviarJSON(res, 400, { erro: 'Nome é obrigatório.' });
  Object.assign(responsavel, {
    nome, formacao: body.formacao || '', registro_profissional: body.registro_profissional || '',
    email: body.email || '', telefone: body.telefone || '',
    assinatura_img: body.assinatura_img || responsavel.assinatura_img,
  });
  db.save(data);
  enviarJSON(res, 200, { responsavel: { ...responsavel, assinatura_img: await hidratarFotosProfundo(responsavel.assinatura_img) } });
});

// DELETE /api/pmoc/responsaveis-tecnicos/:id
rota('DELETE', /^\/api\/pmoc\/responsaveis-tecnicos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const responsavel = tenant.buscar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', Number(m[1]), user.empresa_id);
  if (!responsavel) return enviarJSON(res, 404, { erro: 'Responsável técnico não encontrado.' });
  data.os_refrigeracao_pmoc_responsaveis_tecnicos = data.os_refrigeracao_pmoc_responsaveis_tecnicos.filter((r) => r.id !== responsavel.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- Pacote "Climatização / PMOC" — Fase 2: Plano e preventivas ----------
// pedido do usuário: Modelo de Checklist (editável por empresa) + Plano PMOC (por local, status
// rascunho/ativo/vencido) + geração automática das visitas de preventiva, sempre os PRÓXIMOS 3
// MESES, "mantida em rotina diária". O projeto não tem infraestrutura de cron (processo Node
// único, sem fila de jobs) — a geração roda de forma preguiçosa e idempotente (confere se o mês já
// foi gerado antes de criar) a cada consulta que naturalmente passa por ali (listar planos, ver o
// detalhe de um, ou abrir a lista de visitas pendentes de técnico), mesmo padrão já usado pra
// expirar trial (ver STATUS_EMPRESA_VALIDOS/checagem central) — sem precisar de um processo
// separado rodando em segundo plano. As rotas que precisam de "hoje" recebem via query string
// (?hoje=AAAA-MM-DD, nunca `new Date()` direto no servidor) — mesmo padrão de
// GET /api/os-refrigeracao-home/resumo, pra dar pra testar com datas fixas.

// ---- modelo de checklist (por empresa, item 1.6 do pedido) ----
function ordenarItensChecklistPmoc(itens) {
  const ordem = db.CHAVES_PMOC_PERIODICIDADES;
  return [...itens].sort((a, b) => ordem.indexOf(a.periodicidade) - ordem.indexOf(b.periodicidade) || a.descricao.localeCompare(b.descricao, 'pt-BR'));
}
function camposItemChecklistPmoc(body) {
  return {
    descricao: String((body && body.descricao) || '').trim(),
    periodicidade: db.CHAVES_PMOC_PERIODICIDADES.includes(body && body.periodicidade) ? body.periodicidade : 'mensal',
    tipos_aparelho: Array.isArray(body && body.tipos_aparelho) ? body.tipos_aparelho.filter((t) => typeof t === 'string') : [],
  };
}
// popula o Modelo de Checklist da empresa com os itens sugeridos da Lei (ver PMOC_CHECKLIST_PADRAO
// em db.js) na primeira vez que ela é acessada (lista ainda vazia) — dali em diante 100% editável,
// nunca mais mexido por código (pedido do usuário: "modelo padrão editável pela empresa").
// devolve os itens já prontos pra usar — quem só precisa da lista (POST /api/pmoc/planos, que já
// salva por outro motivo) ignora o 2º valor; o GET abaixo usa pra não escrever o arquivo inteiro
// no disco numa simples leitura (varredura de desempenho).
function garantirModeloChecklistPmoc(data, empresaId) {
  let itens = tenant.listar(data, 'os_refrigeracao_pmoc_modelo_checklist', empresaId);
  if (itens.length) return [itens, false];
  for (const padrao of db.PMOC_CHECKLIST_PADRAO) {
    tenant.criar(data, 'os_refrigeracao_pmoc_modelo_checklist', empresaId, { ...padrao, criado_em: new Date().toISOString() });
  }
  return [tenant.listar(data, 'os_refrigeracao_pmoc_modelo_checklist', empresaId), true];
}

// GET /api/pmoc/modelo-checklist
rota('GET', /^\/api\/pmoc\/modelo-checklist$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const [itens, criado] = garantirModeloChecklistPmoc(data, user.empresa_id);
  if (criado) db.save(data);
  enviarJSON(res, 200, { itens: ordenarItensChecklistPmoc(itens) });
});

// POST /api/pmoc/modelo-checklist { descricao, periodicidade, tipos_aparelho }
rota('POST', /^\/api\/pmoc\/modelo-checklist$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const campos = camposItemChecklistPmoc(await lerCorpo(req));
  if (!campos.descricao) return enviarJSON(res, 400, { erro: 'Descrição é obrigatória.' });
  const item = tenant.criar(data, 'os_refrigeracao_pmoc_modelo_checklist', user.empresa_id, { ...campos, criado_em: new Date().toISOString() });
  db.save(data);
  enviarJSON(res, 201, { item });
});

// PUT /api/pmoc/modelo-checklist/:id
rota('PUT', /^\/api\/pmoc\/modelo-checklist\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const item = tenant.buscar(data, 'os_refrigeracao_pmoc_modelo_checklist', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Item não encontrado.' });
  const campos = camposItemChecklistPmoc(await lerCorpo(req));
  if (!campos.descricao) return enviarJSON(res, 400, { erro: 'Descrição é obrigatória.' });
  Object.assign(item, campos);
  db.save(data);
  enviarJSON(res, 200, { item });
});

// DELETE /api/pmoc/modelo-checklist/:id
rota('DELETE', /^\/api\/pmoc\/modelo-checklist\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const item = tenant.buscar(data, 'os_refrigeracao_pmoc_modelo_checklist', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Item não encontrado.' });
  data.os_refrigeracao_pmoc_modelo_checklist = data.os_refrigeracao_pmoc_modelo_checklist.filter((i) => i.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- plano PMOC (1 por local, item 1.5 do pedido) ----
function camposItemPlanoPmoc(item) { return camposItemChecklistPmoc(item); }
function calcularDataFimPlanoPmoc(dataInicioIso, vigenciaMeses) {
  const d = new Date(dataInicioIso + 'T12:00:00');
  d.setMonth(d.getMonth() + (Number(vigenciaMeses) || 12));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// lazy-check (mesmo padrão do trial expirado): plano "ativo" cuja vigência já passou vira
// "vencido" na primeira consulta depois da data de fim — nunca mexe num plano "rascunho".
function atualizarStatusVencidoPlanoPmoc(plano, hojeIso) {
  if (plano.status === 'ativo' && hojeIso > calcularDataFimPlanoPmoc(plano.data_inicio, plano.vigencia_meses)) plano.status = 'vencido';
}
function pmocPlanoComDetalhes(data, plano) {
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === plano.local_id && l.empresa_id === plano.empresa_id);
  const cliente = local ? data.os_refrigeracao_clientes.find((c) => c.id === local.cliente_id && c.empresa_id === plano.empresa_id) : null;
  const responsavel = data.os_refrigeracao_pmoc_responsaveis_tecnicos.find((r) => r.id === plano.responsavel_tecnico_id && r.empresa_id === plano.empresa_id);
  return {
    ...plano,
    local_nome: local ? local.nome : null,
    cliente_nome: cliente ? cliente.nome : null,
    responsavel_tecnico_nome: responsavel ? responsavel.nome : null,
    data_fim: calcularDataFimPlanoPmoc(plano.data_inicio, plano.vigencia_meses),
  };
}

// ---- geração automática de preventivas (item 2 do pedido) ----
// diferença em meses entre (anoA,mesA) e (anoB,mesB) — positiva se B é depois de A.
function diferencaMesesPmoc(anoA, mesA, anoB, mesB) { return (anoB - anoA) * 12 + (mesB - mesA); }
function itemDevidoNoMesPmoc(item, dataInicioIso, ano, mes) {
  const periodo = db.PMOC_PERIODICIDADES.find((p) => p.chave === item.periodicidade);
  const intervalo = periodo ? periodo.meses : 1;
  const [anoInicio, mesInicio] = dataInicioIso.split('-').map(Number);
  const diff = diferencaMesesPmoc(anoInicio, mesInicio, ano, mes);
  return diff >= 0 && diff % intervalo === 0;
}
// dia da visita naquele mês = o dia da data de início do plano, "clampado" pro tamanho do mês
// (plano começado dia 31 vira dia 28/30 num mês mais curto, nunca estoura pro mês seguinte).
function diaVisitaNoMesPmoc(dataInicioIso, ano, mes) {
  const diaInicio = Number(dataInicioIso.split('-')[2]);
  const diasNoMes = new Date(ano, mes, 0).getDate();
  return Math.min(diaInicio, diasNoMes);
}
function aparelhosDoLocalPmoc(data, localId, empresaId) {
  const idsAmbientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === localId && a.empresa_id === empresaId).map((a) => a.id);
  return data.os_refrigeracao_pmoc_aparelhos.filter((p) => idsAmbientes.includes(p.ambiente_id) && p.empresa_id === empresaId && p.status !== 'desativado');
}
// pedido do usuário: "gerar O.S. de preventiva pra cada aparelho conforme a periodicidade,
// agrupando por visita (uma O.S. por local por data, contendo todos os aparelhos e itens daquele
// mês)" — por isso NÃO nasce uma coleção própria de "O.S. PMOC": cada visita vira um registro em
// os_refrigeracao_agendamentos (a Agenda do atalho #4, já construída), com tecnico_id null e
// status 'pendente_designacao' ("entram na agenda geral sem técnico definido") até o administrador
// designar alguém (ver PUT .../designar-tecnico abaixo). Idempotente: confere se já existe visita
// pra aquele mês antes de criar, então pode ser chamada a vontade (ver comentário no topo da seção
// sobre a "rotina diária" sem cron de verdade). Devolve true se criou alguma visita nova.
function gerarVisitasPmocPlano(data, plano, hojeIso) {
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === plano.local_id && l.empresa_id === plano.empresa_id);
  if (!local) return false;
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === local.cliente_id && c.empresa_id === plano.empresa_id);
  const aparelhos = aparelhosDoLocalPmoc(data, local.id, plano.empresa_id);
  const [anoHoje, mesHoje] = hojeIso.split('-').map(Number);
  const [anoInicio, mesInicio] = plano.data_inicio.split('-').map(Number);
  let criouAlgo = false;
  for (let offset = 0; offset < 3; offset++) {
    const cursor = new Date(anoHoje, mesHoje - 1 + offset, 1);
    const ano = cursor.getFullYear(), mes = cursor.getMonth() + 1;
    if (diferencaMesesPmoc(anoInicio, mesInicio, ano, mes) < 0) continue; // plano ainda não começou nesse mês
    const mesChave = `${ano}-${String(mes).padStart(2, '0')}`;
    const jaExiste = data.os_refrigeracao_agendamentos.some((a) => a.pmoc_plano_id === plano.id && a.empresa_id === plano.empresa_id && a.data.startsWith(mesChave));
    if (jaExiste) continue;
    const itensDevidos = plano.itens.filter((item) => itemDevidoNoMesPmoc(item, plano.data_inicio, ano, mes));
    if (!itensDevidos.length) continue;
    const pmocItens = [];
    for (const item of itensDevidos) {
      const aplicaveis = item.tipos_aparelho && item.tipos_aparelho.length ? aparelhos.filter((ap) => item.tipos_aparelho.includes(ap.tipo)) : aparelhos;
      for (const ap of aplicaveis) {
        pmocItens.push({ aparelho_id: ap.id, aparelho_tipo: ap.tipo, aparelho_identificacao: [ap.marca, ap.modelo].filter(Boolean).join(' '), item_descricao: item.descricao, periodicidade: item.periodicidade });
      }
    }
    if (!pmocItens.length) continue; // item venceu, mas nenhum aparelho do local é do tipo que ele se aplica
    const dia = diaVisitaNoMesPmoc(plano.data_inicio, ano, mes);
    const dataVisita = `${mesChave}-${String(dia).padStart(2, '0')}`;
    tenant.criar(data, 'os_refrigeracao_agendamentos', plano.empresa_id, {
      cliente_nome: `${cliente ? cliente.nome : '—'} — ${local.nome}`,
      telefone: local.responsavel_telefone || (cliente ? cliente.telefone : '') || '',
      endereco: local.endereco || '',
      tipo_servico: 'manutencao_preventiva', data: dataVisita, hora: '', valor_servico: 0,
      observacoes: `Visita PMOC gerada automaticamente — ${pmocItens.length} item(ns) de manutenção em ${new Set(pmocItens.map((i) => i.aparelho_id)).size} aparelho(s).`,
      tecnico_id: null, tecnico_nome: '', autor_id: null, status: 'pendente_designacao', criado_em: new Date().toISOString(),
      pmoc_plano_id: plano.id, pmoc_local_id: local.id, pmoc_itens: pmocItens,
      // Fase B (análise de concorrentes) — pesquisa de satisfação pública pós-visita (ver
      // POST /api/pmoc/visitas/:id/enviar-relatorio e GET/POST /api/pmoc/pesquisa/:token).
      token_pesquisa: db.gerarQrToken(), pesquisa_satisfacao: null,
    });
    criouAlgo = true;
  }
  return criouAlgo;
}
// ---- Fase B (análise de concorrentes) — faturamento do contrato recorrente do Plano PMOC ----
// mesmo espírito de gerarVisitasPmocPlano: lazy, idempotente, 3 meses rolantes, sem precisar de
// cron de verdade. Só gera fatura se o plano tiver valor_mensal configurado (planos sem cobrança
// recorrente — ex.: contrato avulso cobrado por fora — simplesmente nunca geram fatura nenhuma).
function diaVencimentoNoMesPmoc(diaVencimento, ano, mes) {
  const diasNoMes = new Date(ano, mes, 0).getDate();
  return Math.min(diaVencimento, diasNoMes);
}
function gerarFaturasPmocPlano(data, plano, hojeIso) {
  if (!plano.valor_mensal || !plano.dia_vencimento) return false;
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === plano.local_id && l.empresa_id === plano.empresa_id);
  if (!local) return false;
  const [anoHoje, mesHoje] = hojeIso.split('-').map(Number);
  const [anoInicio, mesInicio] = plano.data_inicio.split('-').map(Number);
  let criouAlgo = false;
  for (let offset = 0; offset < 3; offset++) {
    const cursor = new Date(anoHoje, mesHoje - 1 + offset, 1);
    const ano = cursor.getFullYear(), mes = cursor.getMonth() + 1;
    if (diferencaMesesPmoc(anoInicio, mesInicio, ano, mes) < 0) continue; // plano ainda não começou nesse mês
    const mesChave = `${ano}-${String(mes).padStart(2, '0')}`;
    const jaExiste = data.os_refrigeracao_pmoc_faturas.some((f) => f.plano_id === plano.id && f.empresa_id === plano.empresa_id && f.mes === mesChave);
    if (jaExiste) continue;
    const dia = diaVencimentoNoMesPmoc(plano.dia_vencimento, ano, mes);
    tenant.criar(data, 'os_refrigeracao_pmoc_faturas', plano.empresa_id, {
      plano_id: plano.id, local_id: local.id, cliente_id: local.cliente_id, mes: mesChave,
      valor: plano.valor_mensal, vencimento: `${mesChave}-${String(dia).padStart(2, '0')}`,
      status: 'pendente', pago_em: null, criado_em: new Date().toISOString(),
    });
    criouAlgo = true;
  }
  return criouAlgo;
}
// lazy-check igual atualizarStatusVencidoPlanoPmoc: fatura "pendente" cuja data de vencimento já
// passou vira "atrasada" na primeira consulta depois disso — nunca mexe numa fatura já "paga".
function atualizarStatusAtrasadaFaturaPmoc(fatura, hojeIso) {
  if (fatura.status === 'pendente' && hojeIso > fatura.vencimento) fatura.status = 'atrasada';
}

// "Se o plano for alterado, recalcular apenas as O.S. futuras ainda não iniciadas" — apaga as
// visitas geradas por este plano que ainda não começaram (pendente de técnico, ou já agendada mas
// numa data futura) e gera de novo a partir dos itens/datas atualizados; nunca mexe numa visita já
// concluída/cancelada nem numa data já passada (é histórico real do que aconteceu).
function recalcularVisitasFuturasPlanoPmoc(data, plano, hojeIso) {
  data.os_refrigeracao_agendamentos = data.os_refrigeracao_agendamentos.filter((a) => {
    if (a.pmoc_plano_id !== plano.id || a.empresa_id !== plano.empresa_id) return true;
    const aindaNaoIniciada = a.status === 'pendente_designacao' || (a.status === 'agendado' && a.data >= hojeIso);
    return !aindaNaoIniciada;
  });
  gerarVisitasPmocPlano(data, plano, hojeIso);
}

// GET /api/pmoc/planos?hoje=AAAA-MM-DD
rota('GET', /^\/api\/pmoc\/planos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  const planos = tenant.listar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id);
  // varredura de desempenho: essa é a tela de lista do PMOC (provavelmente a mais aberta pelo
  // administrador) — gerarVisitasPmocPlano já é idempotente (não cria de novo o que já existe) e
  // já devolve se criou algo; só grava o arquivo inteiro quando essa consulta de fato mudou algo
  // (status virou vencido, ou nasceu visita nova), nunca à toa numa simples listagem.
  let precisaSalvar = false;
  for (const plano of planos) {
    const statusAntes = plano.status;
    atualizarStatusVencidoPlanoPmoc(plano, query.hoje);
    if (plano.status !== statusAntes) precisaSalvar = true;
    if (plano.status === 'ativo' && gerarVisitasPmocPlano(data, plano, query.hoje)) precisaSalvar = true;
    if (plano.status === 'ativo' && gerarFaturasPmocPlano(data, plano, query.hoje)) precisaSalvar = true;
  }
  if (precisaSalvar) db.save(data);
  const comDetalhes = planos.map((p) => pmocPlanoComDetalhes(data, p)).sort((a, b) => (a.local_nome || '').localeCompare(b.local_nome || '', 'pt-BR'));
  enviarJSON(res, 200, { planos: comDetalhes });
});

// POST /api/pmoc/planos { local_id, responsavel_tecnico_id, data_inicio, vigencia_meses, itens? }
// — sem `itens`, copia o Modelo de Checklist da empresa (ver garantirModeloChecklistPmoc acima);
// nasce sempre em "rascunho" (ativação é ação separada, ver PUT .../ativar).
rota('POST', /^\/api\/pmoc\/planos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const localId = Number(body.local_id) || null;
  const local = localId ? tenant.buscar(data, 'os_refrigeracao_pmoc_locais', localId, user.empresa_id) : null;
  if (!local) return enviarJSON(res, 400, { erro: 'Local inválido.' });
  if (data.os_refrigeracao_pmoc_planos.some((p) => p.local_id === localId && p.empresa_id === user.empresa_id)) {
    return enviarJSON(res, 409, { erro: 'Esse local já tem um plano PMOC — edite o plano existente em vez de criar outro.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data_inicio || '')) return enviarJSON(res, 400, { erro: 'Informe a data de início do plano.' });
  const responsavelId = body.responsavel_tecnico_id ? Number(body.responsavel_tecnico_id) : null;
  if (responsavelId && !tenant.buscar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', responsavelId, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Responsável técnico inválido.' });
  const itensBase = Array.isArray(body.itens) && body.itens.length ? body.itens : garantirModeloChecklistPmoc(data, user.empresa_id)[0];
  const itens = itensBase.map(camposItemPlanoPmoc).filter((i) => i.descricao);
  // pedido do usuário (item 1.4): "Número da ART/TRT por contrato/local" — por isso mora no plano
  // (1 por local), não no cadastro do responsável técnico (que pode assinar vários contratos).
  const laudoArtTrt = body.art_trt_anexo ? await extrairAnexoGenerico(body.art_trt_anexo, user.empresa_id) : null;
  const plano = tenant.criar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id, {
    local_id: localId, responsavel_tecnico_id: responsavelId, data_inicio: body.data_inicio,
    vigencia_meses: Number(body.vigencia_meses) > 0 ? Number(body.vigencia_meses) : 12,
    art_trt_numero: body.art_trt_numero || '', art_trt_anexo: laudoArtTrt,
    // Fase 5, item 7: "ART/TRT vencida ou ausente: alerta" — validade é opcional (nem toda ART
    // tem data definida), configurada por quem cadastra, nunca uma regra fixa no código.
    art_trt_validade: /^\d{4}-\d{2}-\d{2}$/.test(body.art_trt_validade || '') ? body.art_trt_validade : null,
    // Fase B (análise de concorrentes): contrato recorrente — opcional (nem todo plano é cobrado
    // por fora de uma O.S./Orçamento avulso). Sem valor_mensal, nunca gera fatura nenhuma.
    valor_mensal: Number(body.valor_mensal) > 0 ? Number(body.valor_mensal) : null,
    dia_vencimento: Number(body.dia_vencimento) >= 1 && Number(body.dia_vencimento) <= 31 ? Number(body.dia_vencimento) : null,
    status: 'rascunho', itens, criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { plano: pmocPlanoComDetalhes(data, plano) });
});

// GET /api/pmoc/planos/:id?hoje= — vem com as visitas já geradas (ver os_refrigeracao_agendamentos)
rota('GET', /^\/api\/pmoc\/planos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  const plano = tenant.buscar(data, 'os_refrigeracao_pmoc_planos', Number(m[1]), user.empresa_id);
  if (!plano) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  // varredura de desempenho: esse é o fetch do plano feito TODA VEZ que o administrador abre o
  // detalhe de um local (a tela mais usada do pacote) — só grava o arquivo quando algo de fato
  // mudou (mesmo raciocínio de GET /api/pmoc/planos, ver comentário lá).
  const statusAntesDetalhe = plano.status;
  atualizarStatusVencidoPlanoPmoc(plano, query.hoje);
  const criouVisitaNova = plano.status === 'ativo' && gerarVisitasPmocPlano(data, plano, query.hoje);
  const criouFaturaNova = plano.status === 'ativo' && gerarFaturasPmocPlano(data, plano, query.hoje);
  if (plano.status !== statusAntesDetalhe || criouVisitaNova || criouFaturaNova) db.save(data);
  const visitas = data.os_refrigeracao_agendamentos.filter((a) => a.pmoc_plano_id === plano.id && a.empresa_id === user.empresa_id).sort((a, b) => a.data.localeCompare(b.data));
  enviarJSON(res, 200, { plano: pmocPlanoComDetalhes(data, plano), visitas });
});

// PUT /api/pmoc/planos/:id — edita itens/responsável/data de início/vigência; se o plano estiver
// ativo, recalcula as visitas futuras ainda não iniciadas (exige ?hoje= só nesse caso).
rota('PUT', /^\/api\/pmoc\/planos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const plano = tenant.buscar(data, 'os_refrigeracao_pmoc_planos', Number(m[1]), user.empresa_id);
  if (!plano) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  const body = await lerCorpo(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data_inicio || '')) return enviarJSON(res, 400, { erro: 'Informe a data de início do plano.' });
  const responsavelId = body.responsavel_tecnico_id ? Number(body.responsavel_tecnico_id) : null;
  if (responsavelId && !tenant.buscar(data, 'os_refrigeracao_pmoc_responsaveis_tecnicos', responsavelId, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Responsável técnico inválido.' });
  const itens = Array.isArray(body.itens) ? body.itens.map(camposItemPlanoPmoc).filter((i) => i.descricao) : plano.itens;
  if (body.art_trt_anexo !== undefined) plano.art_trt_anexo = body.art_trt_anexo ? await extrairAnexoGenerico(body.art_trt_anexo, user.empresa_id) : null;
  Object.assign(plano, {
    responsavel_tecnico_id: responsavelId, data_inicio: body.data_inicio,
    vigencia_meses: Number(body.vigencia_meses) > 0 ? Number(body.vigencia_meses) : plano.vigencia_meses,
    art_trt_numero: body.art_trt_numero !== undefined ? body.art_trt_numero : (plano.art_trt_numero || ''),
    art_trt_validade: body.art_trt_validade !== undefined
      ? (/^\d{4}-\d{2}-\d{2}$/.test(body.art_trt_validade || '') ? body.art_trt_validade : null)
      : (plano.art_trt_validade || null),
    valor_mensal: body.valor_mensal !== undefined
      ? (Number(body.valor_mensal) > 0 ? Number(body.valor_mensal) : null)
      : (plano.valor_mensal || null),
    dia_vencimento: body.dia_vencimento !== undefined
      ? (Number(body.dia_vencimento) >= 1 && Number(body.dia_vencimento) <= 31 ? Number(body.dia_vencimento) : null)
      : (plano.dia_vencimento || null),
    itens,
  });
  // os alertas de ART/TRT e de vencimento do plano (ver GET /api/notificacoes) só reavisam por
  // e-mail de novo depois que a situação muda — editar o plano é exatamente quando ela muda.
  plano.alerta_art_email_enviado_em = null;
  plano.alerta_vencimento_email_enviado_em = null;
  if (plano.status === 'ativo') {
    const { query } = url.parse(req.url, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD) pra recalcular as preventivas.' });
    recalcularVisitasFuturasPlanoPmoc(data, plano, query.hoje);
  }
  db.save(data);
  enviarJSON(res, 200, { plano: pmocPlanoComDetalhes(data, plano) });
});

// PUT /api/pmoc/planos/:id/ativar?hoje= — gera de cara as visitas dos próximos 3 meses.
rota('PUT', /^\/api\/pmoc\/planos\/(\d+)\/ativar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const plano = tenant.buscar(data, 'os_refrigeracao_pmoc_planos', Number(m[1]), user.empresa_id);
  if (!plano) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  if (plano.status !== 'rascunho') return enviarJSON(res, 400, { erro: 'Só um plano em rascunho pode ser ativado.' });
  if (!plano.itens.length) return enviarJSON(res, 400, { erro: 'O plano precisa ter pelo menos um item de manutenção antes de ser ativado.' });
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  plano.status = 'ativo';
  gerarVisitasPmocPlano(data, plano, query.hoje);
  gerarFaturasPmocPlano(data, plano, query.hoje);
  db.save(data);
  enviarJSON(res, 200, { plano: pmocPlanoComDetalhes(data, plano) });
});

// ---- Fase B (análise de concorrentes) — Faturamento (item 3 do roadmap: "o negócio de PMOC é
// tipicamente por contrato mensal") — visão gerencial, só administrador, mesmo padrão do
// Relatório Mensal/Painel PMOC. ----
function pmocFaturaComDetalhes(data, fatura) {
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === fatura.local_id && l.empresa_id === fatura.empresa_id);
  const cliente = data.os_refrigeracao_clientes.find((c) => c.id === fatura.cliente_id && c.empresa_id === fatura.empresa_id);
  return { ...fatura, local_nome: local ? local.nome : '—', cliente_nome: cliente ? cliente.nome : '—' };
}
// GET /api/pmoc/faturas?hoje=AAAA-MM-DD — gera lazy (todo plano ativo com valor_mensal) e
// atualiza o status "atrasada" antes de listar, mesmo raciocínio das visitas/planos.
rota('GET', /^\/api\/pmoc\/faturas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Faturamento é exclusivo do administrador.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  let precisaSalvar = false;
  for (const plano of tenant.listar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id).filter((p) => p.status === 'ativo')) {
    if (gerarFaturasPmocPlano(data, plano, query.hoje)) precisaSalvar = true;
  }
  for (const fatura of tenant.listar(data, 'os_refrigeracao_pmoc_faturas', user.empresa_id)) {
    const statusAntes = fatura.status;
    atualizarStatusAtrasadaFaturaPmoc(fatura, query.hoje);
    if (fatura.status !== statusAntes) precisaSalvar = true;
  }
  if (precisaSalvar) db.save(data);
  let faturas = tenant.listar(data, 'os_refrigeracao_pmoc_faturas', user.empresa_id);
  if (query.status) faturas = faturas.filter((f) => f.status === query.status);
  faturas = faturas.map((f) => pmocFaturaComDetalhes(data, f)).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  enviarJSON(res, 200, { faturas });
});
// PUT /api/pmoc/faturas/:id/marcar-paga
rota('PUT', /^\/api\/pmoc\/faturas\/(\d+)\/marcar-paga$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Faturamento é exclusivo do administrador.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const fatura = tenant.buscar(data, 'os_refrigeracao_pmoc_faturas', Number(m[1]), user.empresa_id);
  if (!fatura) return enviarJSON(res, 404, { erro: 'Fatura não encontrada.' });
  fatura.status = 'paga';
  fatura.pago_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { fatura: pmocFaturaComDetalhes(data, fatura) });
});
// PUT /api/pmoc/faturas/:id/marcar-pendente — desfaz um "marcar paga" por engano.
rota('PUT', /^\/api\/pmoc\/faturas\/(\d+)\/marcar-pendente$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Faturamento é exclusivo do administrador.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const fatura = tenant.buscar(data, 'os_refrigeracao_pmoc_faturas', Number(m[1]), user.empresa_id);
  if (!fatura) return enviarJSON(res, 404, { erro: 'Fatura não encontrada.' });
  fatura.status = 'pendente';
  fatura.pago_em = null;
  db.save(data);
  enviarJSON(res, 200, { fatura: pmocFaturaComDetalhes(data, fatura) });
});

// DELETE /api/pmoc/planos/:id — só em rascunho (ativo/vencido ficam como histórico).
rota('DELETE', /^\/api\/pmoc\/planos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const plano = tenant.buscar(data, 'os_refrigeracao_pmoc_planos', Number(m[1]), user.empresa_id);
  if (!plano) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  if (plano.status !== 'rascunho') return enviarJSON(res, 400, { erro: 'Só um plano em rascunho pode ser excluído.' });
  data.os_refrigeracao_pmoc_planos = data.os_refrigeracao_pmoc_planos.filter((p) => p.id !== plano.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- visitas pendentes de designação de técnico (geradas pelo PMOC) ----
// pedido do usuário: "o administrador designa o técnico" — só administrador vê/mexe nessa fila.
// GET /api/pmoc/visitas-pendentes?hoje=
rota('GET', /^\/api\/pmoc\/visitas-pendentes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador designa técnico nas preventivas.' });
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  const planosAtivos = tenant.listar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id).filter((p) => p.status === 'ativo');
  // varredura de desempenho: mesmo raciocínio das outras rotas de "listar" do PMOC — só grava
  // quando gerarVisitasPmocPlano de fato criou uma visita nova.
  let precisaSalvarPendentes = false;
  for (const plano of planosAtivos) { if (gerarVisitasPmocPlano(data, plano, query.hoje)) precisaSalvarPendentes = true; }
  if (precisaSalvarPendentes) db.save(data);
  const pendentes = tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id)
    .filter((a) => a.status === 'pendente_designacao')
    .sort((a, b) => a.data.localeCompare(b.data));
  enviarJSON(res, 200, { visitas: pendentes });
});

// PUT /api/pmoc/visitas-pendentes/:id/designar-tecnico { tecnico_id, hora } — mesma validação de
// grade/cota do técnico (ver slotsAgendaRefrigeracao) usada no agendamento manual.
rota('PUT', /^\/api\/pmoc\/visitas-pendentes\/(\d+)\/designar-tecnico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador designa técnico nas preventivas.' });
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (visita.status !== 'pendente_designacao') return enviarJSON(res, 400, { erro: 'Essa visita já tem técnico designado.' });
  const body = await lerCorpo(req);
  const tecnicoId = Number(body.tecnico_id) || null;
  const tecnico = tecnicoId ? tenant.buscar(data, 'usuarios', tecnicoId, user.empresa_id) : null;
  if (!tecnico) return enviarJSON(res, 400, { erro: 'Escolha um técnico.' });
  const { config_existe, slots } = slotsAgendaRefrigeracao(data, tecnicoId, user.empresa_id, visita.data);
  if (!config_existe) return enviarJSON(res, 400, { erro: 'Configure a disponibilidade desse técnico antes de designar.' });
  const slotEscolhido = slots.find((s) => s.hora === body.hora);
  if (!slotEscolhido || !slotEscolhido.disponivel) return enviarJSON(res, 400, { erro: 'Esse horário não está disponível pra esse técnico nesse dia.' });
  visita.tecnico_id = tecnicoId;
  visita.tecnico_nome = tecnico.nome;
  visita.hora = body.hora;
  visita.status = 'agendado';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// ---------- Pacote "Climatização / PMOC" — Fase 3: Execução e relatórios ----------
// pedido do usuário: o técnico executa a preventiva pelo celular (checklist por aparelho —
// Conforme/Não conforme/N.A. + observação + fotos antes/depois), um item "Não conforme" pode virar
// O.S. corretiva na hora, e ao concluir (com assinatura do responsável no local) o relatório em
// PDF é enviado por e-mail pro cliente e pro administrador — aqui SIM com envio de e-mail de
// verdade (ver email.enviarRelatorio, já usado pelos relatórios núcleo), diferente do mailto:
// usado em outras telas deste perfil (lá o PDF não tem como ser anexado automaticamente; aqui o
// servidor manda o anexo de verdade, "o cliente recebe o PDF por e-mail").
const PMOC_RESPOSTAS_VALIDAS = ['conforme', 'nao_conforme', 'na'];
// só o próprio técnico designado ou o administrador mexem na execução de uma visita.
function exigirAcessoVisitaPmoc(res, user, visita) {
  if (visita.tecnico_id === user.id) return true;
  if (exigirPapel(user, ['administrador'])) return true;
  enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  return false;
}

// GET /api/pmoc/visitas/:id
rota('GET', /^\/api\/pmoc\/visitas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_plano_id) return enviarJSON(res, 404, { erro: 'Visita PMOC não encontrada.' });
  if (!exigirAcessoVisitaPmoc(res, user, visita)) return;
  const itens = await Promise.all((visita.pmoc_itens || []).map(async (i) => ({ ...i, foto_antes: await hidratarFotosProfundo(i.foto_antes), foto_depois: await hidratarFotosProfundo(i.foto_depois) })));
  const assinatura_responsavel_img = await hidratarFotosProfundo(visita.assinatura_responsavel_img);
  enviarJSON(res, 200, { visita: { ...visita, pmoc_itens: itens, assinatura_responsavel_img } });
});

function aplicarItensExecucaoPmoc(itensAtuais, itensNovos) {
  return itensAtuais.map((item, i) => {
    const novo = itensNovos[i] || {};
    return {
      ...item,
      resposta: PMOC_RESPOSTAS_VALIDAS.includes(novo.resposta) ? novo.resposta : (item.resposta || null),
      observacao: novo.observacao !== undefined ? novo.observacao : (item.observacao || ''),
      foto_antes: novo.foto_antes !== undefined ? novo.foto_antes : (item.foto_antes || null),
      foto_depois: novo.foto_depois !== undefined ? novo.foto_depois : (item.foto_depois || null),
    };
  });
}

// Fase C (análise de concorrentes) — geolocalização pontual do técnico "no momento da visita"
// (decisão do usuário: nunca rastreamento contínuo). Só aceita um objeto {lat, lng, precisao}
// com números válidos; qualquer coisa fora disso (permissão negada no navegador, GPS
// indisponível, campo ausente) é ignorada em silêncio — a geolocalização é sempre opcional e
// nunca pode bloquear o técnico de salvar progresso ou concluir a visita.
function validarLocalizacaoPmoc(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const lat = Number(bruto.lat), lng = Number(bruto.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const precisao = Number(bruto.precisao);
  return { lat, lng, precisao: Number.isFinite(precisao) ? precisao : null, capturado_em: new Date().toISOString() };
}

// PUT /api/pmoc/visitas/:id/progresso { itens, localizacao? } — salva rascunho (resposta/
// observação/fotos), não muda o status; o técnico pode ir e voltar nessa tela à vontade antes de
// concluir. Na primeira chamada (chegada ao local) registra a localização, se o técnico permitiu
// e o navegador conseguiu captar — chamadas seguintes não sobrescrevem (é "chegada", um só ponto).
rota('PUT', /^\/api\/pmoc\/visitas\/(\d+)\/progresso$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_plano_id) return enviarJSON(res, 404, { erro: 'Visita PMOC não encontrada.' });
  if (!exigirAcessoVisitaPmoc(res, user, visita)) return;
  if (visita.status === 'concluido' || visita.status === 'cancelado') return enviarJSON(res, 400, { erro: 'Essa visita já foi encerrada.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!Array.isArray(body.itens) || body.itens.length !== (visita.pmoc_itens || []).length) return enviarJSON(res, 400, { erro: 'Lista de itens inválida.' });
  visita.pmoc_itens = aplicarItensExecucaoPmoc(visita.pmoc_itens, body.itens);
  if (!visita.localizacao_chegada) {
    const localizacao = validarLocalizacaoPmoc(body.localizacao);
    if (localizacao) visita.localizacao_chegada = localizacao;
  }
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// PUT /api/pmoc/visitas/:id/concluir { itens, assinatura_responsavel_img, assinatura_responsavel_nome, localizacao? }
rota('PUT', /^\/api\/pmoc\/visitas\/(\d+)\/concluir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_plano_id) return enviarJSON(res, 404, { erro: 'Visita PMOC não encontrada.' });
  if (!exigirAcessoVisitaPmoc(res, user, visita)) return;
  if (visita.status !== 'agendado') return enviarJSON(res, 400, { erro: 'Só uma visita agendada (com técnico) pode ser concluída.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!Array.isArray(body.itens) || body.itens.length !== (visita.pmoc_itens || []).length) return enviarJSON(res, 400, { erro: 'Lista de itens inválida.' });
  const itensAtualizados = aplicarItensExecucaoPmoc(visita.pmoc_itens, body.itens);
  if (itensAtualizados.some((i) => !PMOC_RESPOSTAS_VALIDAS.includes(i.resposta))) return enviarJSON(res, 400, { erro: 'Responda todos os itens do checklist (Conforme, Não conforme ou N.A.) antes de concluir.' });
  if (!body.assinatura_responsavel_img) return enviarJSON(res, 400, { erro: 'Colete a assinatura do responsável no local antes de concluir.' });
  visita.pmoc_itens = itensAtualizados;
  visita.assinatura_responsavel_img = body.assinatura_responsavel_img;
  visita.assinatura_responsavel_nome = body.assinatura_responsavel_nome || '';
  visita.status = 'concluido';
  visita.concluido_em = new Date().toISOString();
  const localizacaoConclusao = validarLocalizacaoPmoc(body.localizacao);
  if (localizacaoConclusao) visita.localizacao_conclusao = localizacaoConclusao;
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/pmoc/visitas/:id/itens/:indice/gerar-corretiva — pedido do usuário: "um item 'Não
// conforme' permite gerar na hora uma O.S. corretiva vinculada ao aparelho". Nasce "pendente" (o
// serviço ainda não foi feito, diferente da O.S. criada pelo fluxo normal — que já nasce
// "concluída" porque é registrada DEPOIS do serviço pronto e assinado) e sem assinatura do técnico
// ainda — isso acontece quando essa O.S. corretiva for executada de verdade, depois, pelo fluxo
// normal de O.S. (ver PUT /api/os-refrigeracao/:id).
rota('POST', /^\/api\/pmoc\/visitas\/(\d+)\/itens\/(\d+)\/gerar-corretiva$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_plano_id) return enviarJSON(res, 404, { erro: 'Visita PMOC não encontrada.' });
  if (!exigirAcessoVisitaPmoc(res, user, visita)) return;
  const item = (visita.pmoc_itens || [])[Number(m[2])];
  if (!item) return enviarJSON(res, 404, { erro: 'Item não encontrado.' });
  if (item.resposta !== 'nao_conforme') return enviarJSON(res, 400, { erro: 'Só dá pra gerar O.S. corretiva de um item marcado "Não conforme".' });
  if (item.os_corretiva_id) return enviarJSON(res, 400, { erro: 'Esse item já tem uma O.S. corretiva gerada.' });
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === visita.pmoc_local_id && l.empresa_id === user.empresa_id);
  const aparelho = data.os_refrigeracao_pmoc_aparelhos.find((a) => a.id === item.aparelho_id && a.empresa_id === user.empresa_id);
  if (!local || !aparelho) return enviarJSON(res, 400, { erro: 'Local ou aparelho não encontrado.' });
  const os = tenant.criar(data, 'os_refrigeracao', user.empresa_id, {
    cliente_id: local.cliente_id,
    equipamento: { tipo: aparelho.tipo, marca: aparelho.marca, modelo: aparelho.modelo, btu: aparelho.capacidade_btu },
    problema_relatado: `Não conformidade encontrada na preventiva PMOC — ${item.item_descricao}`,
    diagnostico: '', servicos: [], materiais: [], mao_de_obra: 0, desconto_tipo: 'valor', desconto_valor: 0,
    observacoes_servico: item.observacao || '', endereco_servico: local.endereco || '',
    garantia_dias: 90, observacoes: '', fotos: [item.foto_antes].filter(Boolean),
    assinatura_tecnico_img: null, assinatura_cliente_img: null, assinado_cliente_em: null,
    tecnico_id: user.id, tecnico_nome: user.nome, autor_id: user.id,
    token_assinatura: gerarTokenConvite(), status: 'pendente', criado_em: new Date().toISOString(),
    pmoc_origem: { visita_id: visita.id, aparelho_id: aparelho.id, local_id: local.id },
  });
  item.os_corretiva_id = os.id;
  db.save(data);
  enviarJSON(res, 201, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// POST /api/pmoc/visitas/:id/enviar-relatorio { pdf_base64, emails }
rota('POST', /^\/api\/pmoc\/visitas\/(\d+)\/enviar-relatorio$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_plano_id) return enviarJSON(res, 404, { erro: 'Visita PMOC não encontrada.' });
  if (!exigirAcessoVisitaPmoc(res, user, visita)) return;
  const body = await lerCorpo(req);
  if (!body.pdf_base64 || !Array.isArray(body.emails) || !body.emails.length) return enviarJSON(res, 400, { erro: 'PDF e ao menos um e-mail são obrigatórios.' });
  const empresa = data.empresas.find((e) => e.id === user.empresa_id);
  // Fase B (análise de concorrentes) — pesquisa de satisfação automática: entra no mesmo e-mail
  // do relatório, sem precisar de um disparo separado; só se a visita ainda não tiver token
  // (visitas antigas, geradas antes dessa fase, simplesmente não ganham o convite retroativo).
  const linkPesquisa = visita.token_pesquisa ? `${APP_URL}/pmoc-pesquisa.html?token=${visita.token_pesquisa}` : undefined;
  const resultado = await email.enviarRelatorio({ emails: body.emails, pdfBase64: body.pdf_base64, nomeArquivo: `visita-pmoc-${visita.id}.pdf`, nomeEmpresa: empresa ? empresa.nome : undefined, linkPesquisa });
  enviarJSON(res, 200, { envio: resultado });
});
// GET /api/pmoc/pesquisa/:token — PÚBLICA (ver PREFIXOS_PUBLICOS em rotas-modulo.js), sem login.
// Devolve o mínimo pra montar a tela (empresa, cliente/local, data) e se já foi respondida.
rota('GET', /^\/api\/pmoc\/pesquisa\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const visita = data.os_refrigeracao_agendamentos.find((a) => a.token_pesquisa === m[1]);
  if (!visita) return enviarJSON(res, 404, { erro: 'Pesquisa não encontrada.' });
  const empresa = data.empresas.find((e) => e.id === visita.empresa_id);
  enviarJSON(res, 200, {
    cliente_nome: visita.cliente_nome, data: visita.data, empresa_nome: empresa ? empresa.nome : '',
    respondida: !!visita.pesquisa_satisfacao,
  });
});
// POST /api/pmoc/pesquisa/:token { nota, comentario } — PÚBLICA, idempotente (só responde uma vez).
rota('POST', /^\/api\/pmoc\/pesquisa\/([a-f0-9]+)$/, async (req, res, m) => {
  const data = db.load();
  const visita = data.os_refrigeracao_agendamentos.find((a) => a.token_pesquisa === m[1]);
  if (!visita) return enviarJSON(res, 404, { erro: 'Pesquisa não encontrada.' });
  if (visita.pesquisa_satisfacao) return enviarJSON(res, 400, { erro: 'Esta pesquisa já foi respondida.' });
  const body = await lerCorpo(req);
  const nota = Number(body.nota);
  if (!(nota >= 1 && nota <= 5)) return enviarJSON(res, 400, { erro: 'Informe uma nota de 1 a 5.' });
  visita.pesquisa_satisfacao = { nota, comentario: body.comentario || '', respondido_em: new Date().toISOString() };
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- Pacote "Climatização / PMOC" — Fase 4: Documento PMOC e portal do cliente ----------

// ---- qualidade do ar (por local, item 1.6 do pedido) ----
// pedido do usuário (análise de concorrentes/conformidade legal): a RE nº 9/2003 da ANVISA
// (referência original destes campos) foi revogada em 25/07/2024 pela RDC nº 886/2024 e
// substituída pela ABNT NBR 17037:2023, que também avalia material particulado (PM10/PM2,5) e
// velocidade do ar — por isso os 2 campos novos. Mesma filosofia dos campos já existentes: só
// registra o valor medido, nunca compara contra um limite fixo no código.
function camposQualidadeArPmoc(body) {
  return {
    data: /^\d{4}-\d{2}-\d{2}$/.test(body.data || '') ? body.data : '',
    laboratorio: body.laboratorio || '',
    temperatura: body.temperatura || '', umidade: body.umidade || '', co2: body.co2 || '',
    pm10: body.pm10 || '', pm25: body.pm25 || '', velocidade_ar: body.velocidade_ar || '',
    observacoes: body.observacoes || '',
  };
}
// GET /api/pmoc/locais/:localId/qualidade-ar
rota('GET', /^\/api\/pmoc\/locais\/(\d+)\/qualidade-ar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const lista = await Promise.all(
    data.os_refrigeracao_pmoc_qualidade_ar.filter((q) => q.local_id === local.id && q.empresa_id === user.empresa_id)
      .map(async (q) => ({ ...q, laudo_pdf: await hidratarFotosProfundo(q.laudo_pdf) }))
  );
  lista.sort((a, b) => b.data.localeCompare(a.data));
  enviarJSON(res, 200, { analises: lista });
});
// POST /api/pmoc/qualidade-ar { local_id, data, laboratorio, laudo_pdf, temperatura, umidade, co2, observacoes }
rota('POST', /^\/api\/pmoc\/qualidade-ar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const localId = Number(body.local_id) || null;
  const local = localId ? tenant.buscar(data, 'os_refrigeracao_pmoc_locais', localId, user.empresa_id) : null;
  if (!local) return enviarJSON(res, 400, { erro: 'Local inválido.' });
  const campos = camposQualidadeArPmoc(body);
  if (!campos.data) return enviarJSON(res, 400, { erro: 'Informe a data da análise.' });
  const laudo_pdf = body.laudo_pdf ? await extrairAnexoGenerico(body.laudo_pdf, user.empresa_id) : null;
  const analise = tenant.criar(data, 'os_refrigeracao_pmoc_qualidade_ar', user.empresa_id, { ...campos, local_id: localId, laudo_pdf, criado_em: new Date().toISOString() });
  // o alerta de qualidade do ar desatualizada (ver GET /api/notificacoes) só reavisa por e-mail
  // de novo depois de um período sem análise nova — registrar uma agora é exatamente isso.
  local.alerta_qualidade_ar_email_enviado_em = null;
  db.save(data);
  enviarJSON(res, 201, { analise: { ...analise, laudo_pdf: await hidratarFotosProfundo(analise.laudo_pdf) } });
});
// PUT /api/pmoc/qualidade-ar/:id
rota('PUT', /^\/api\/pmoc\/qualidade-ar\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const analise = tenant.buscar(data, 'os_refrigeracao_pmoc_qualidade_ar', Number(m[1]), user.empresa_id);
  if (!analise) return enviarJSON(res, 404, { erro: 'Análise não encontrada.' });
  const body = await lerCorpo(req);
  const campos = camposQualidadeArPmoc(body);
  if (!campos.data) return enviarJSON(res, 400, { erro: 'Informe a data da análise.' });
  if (body.laudo_pdf !== undefined) analise.laudo_pdf = body.laudo_pdf ? await extrairAnexoGenerico(body.laudo_pdf, user.empresa_id) : null;
  Object.assign(analise, campos);
  db.save(data);
  enviarJSON(res, 200, { analise: { ...analise, laudo_pdf: await hidratarFotosProfundo(analise.laudo_pdf) } });
});
// DELETE /api/pmoc/qualidade-ar/:id
rota('DELETE', /^\/api\/pmoc\/qualidade-ar\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const analise = tenant.buscar(data, 'os_refrigeracao_pmoc_qualidade_ar', Number(m[1]), user.empresa_id);
  if (!analise) return enviarJSON(res, 404, { erro: 'Análise não encontrada.' });
  data.os_refrigeracao_pmoc_qualidade_ar = data.os_refrigeracao_pmoc_qualidade_ar.filter((q) => q.id !== analise.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- Fase A (análise de concorrentes/conformidade legal) — controle de gás refrigerante por
// aparelho. O Brasil aderiu ao Protocolo de Montreal (Decreto 99.280/1990); o IBAMA exige
// cadastro no CTF e o recolhimento correto do gás (liberar na atmosfera é crime ambiental, Lei
// 9.605/1998). Cada registro é um evento (carga ou recolhimento) de uma quantidade de um fluido
// específico, numa data — a soma desses eventos por fluido/ano é a base de uma eventual
// prestação de contas ao IBAMA, além de servir como controle de estoque pra própria empresa.
const PMOC_TIPOS_OPERACAO_GAS = ['carga', 'recolhimento'];
function camposGasRegistroPmoc(body) {
  return {
    tipo_operacao: PMOC_TIPOS_OPERACAO_GAS.includes(body.tipo_operacao) ? body.tipo_operacao : '',
    fluido: String(body.fluido || '').trim(),
    quantidade_kg: Number(body.quantidade_kg) > 0 ? Number(body.quantidade_kg) : null,
    data: /^\d{4}-\d{2}-\d{2}$/.test(body.data || '') ? body.data : '',
    observacoes: body.observacoes || '',
  };
}
function validarGasRegistroPmoc(campos) {
  if (!campos.tipo_operacao) return 'Informe se é carga ou recolhimento de gás.';
  if (!campos.fluido) return 'Informe o tipo de fluido refrigerante.';
  if (!campos.quantidade_kg) return 'Informe a quantidade (em kg), maior que zero.';
  if (!campos.data) return 'Informe a data do evento.';
  return null;
}
// GET /api/pmoc/aparelhos/:id/gas
rota('GET', /^\/api\/pmoc\/aparelhos\/(\d+)\/gas$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  const registros = data.os_refrigeracao_pmoc_gas_registros
    .filter((g) => g.aparelho_id === aparelho.id && g.empresa_id === user.empresa_id)
    .sort((a, b) => b.data.localeCompare(a.data));
  enviarJSON(res, 200, { registros });
});
// POST /api/pmoc/gas-registros { aparelho_id, tipo_operacao, fluido, quantidade_kg, data, observacoes }
rota('POST', /^\/api\/pmoc\/gas-registros$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const body = await lerCorpo(req);
  const aparelhoId = Number(body.aparelho_id) || null;
  if (!aparelhoId || !tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', aparelhoId, user.empresa_id)) return enviarJSON(res, 400, { erro: 'Aparelho inválido.' });
  const campos = camposGasRegistroPmoc(body);
  const erro = validarGasRegistroPmoc(campos);
  if (erro) return enviarJSON(res, 400, { erro });
  const registro = tenant.criar(data, 'os_refrigeracao_pmoc_gas_registros', user.empresa_id, { ...campos, aparelho_id: aparelhoId, criado_em: new Date().toISOString() });
  db.save(data);
  enviarJSON(res, 201, { registro });
});
// PUT /api/pmoc/gas-registros/:id
rota('PUT', /^\/api\/pmoc\/gas-registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const registro = tenant.buscar(data, 'os_refrigeracao_pmoc_gas_registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  const body = await lerCorpo(req);
  const campos = camposGasRegistroPmoc(body);
  const erro = validarGasRegistroPmoc(campos);
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(registro, campos);
  db.save(data);
  enviarJSON(res, 200, { registro });
});
// DELETE /api/pmoc/gas-registros/:id
rota('DELETE', /^\/api\/pmoc\/gas-registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const registro = tenant.buscar(data, 'os_refrigeracao_pmoc_gas_registros', Number(m[1]), user.empresa_id);
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  data.os_refrigeracao_pmoc_gas_registros = data.os_refrigeracao_pmoc_gas_registros.filter((g) => g.id !== registro.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});
// GET /api/pmoc/relatorio-anual-gas?ano=AAAA — consolidado da empresa inteira, só administrador
// (visão gerencial, mesmo padrão do Relatório Mensal e do Painel PMOC).
rota('GET', /^\/api\/pmoc\/relatorio-anual-gas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Relatório anual de gás é exclusivo do administrador.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}$/.test(query.ano || '')) return enviarJSON(res, 400, { erro: 'Informe o ano (AAAA).' });
  const registrosDoAno = tenant.listar(data, 'os_refrigeracao_pmoc_gas_registros', user.empresa_id)
    .filter((g) => g.data.startsWith(query.ano));
  const porFluido = new Map();
  for (const g of registrosDoAno) {
    const totais = porFluido.get(g.fluido) || { fluido: g.fluido, carga_kg: 0, recolhimento_kg: 0 };
    if (g.tipo_operacao === 'carga') totais.carga_kg += g.quantidade_kg;
    else totais.recolhimento_kg += g.quantidade_kg;
    porFluido.set(g.fluido, totais);
  }
  const registrosComDetalhes = registrosDoAno
    .map((g) => {
      const aparelho = data.os_refrigeracao_pmoc_aparelhos.find((a) => a.id === g.aparelho_id && a.empresa_id === user.empresa_id);
      const ambiente = aparelho ? data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === user.empresa_id) : null;
      const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === user.empresa_id) : null;
      return { ...g, aparelho_tipo: aparelho ? aparelho.tipo : '(removido)', local_nome: local ? local.nome : '—' };
    })
    .sort((a, b) => b.data.localeCompare(a.data));
  enviarJSON(res, 200, { ano: query.ano, por_fluido: [...porFluido.values()], registros: registrosComDetalhes });
});

// ---- Documento PMOC do local (item 4.1 do pedido) — dados completos pras 8 seções do PDF,
// montado no cliente (jsPDF), igual todo documento desse perfil. "Gerado a qualquer momento a
// partir do plano" — funciona mesmo sem plano ainda (seções 4/5/6 saem vazias nesse caso).
// extraída pra função própria porque o portal do cliente (ver /api/pmoc/portal/locais/:id/documento
// mais abaixo) monta exatamente o mesmo documento, só com uma checagem de acesso diferente.
async function montarDocumentoPmocLocal(data, local, empresaId) {
  const ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === local.id)
    .map((a) => ({ ...a, aparelhos: data.os_refrigeracao_pmoc_aparelhos.filter((p) => p.ambiente_id === a.id) }));
  const plano = data.os_refrigeracao_pmoc_planos.find((p) => p.local_id === local.id && p.empresa_id === empresaId) || null;
  let responsavel = null;
  const cronograma = [];
  if (plano) {
    responsavel = data.os_refrigeracao_pmoc_responsaveis_tecnicos.find((r) => r.id === plano.responsavel_tecnico_id && r.empresa_id === empresaId) || null;
    const [anoInicio, mesInicio] = plano.data_inicio.split('-').map(Number);
    for (let i = 0; i < 12; i++) {
      const cursor = new Date(anoInicio, mesInicio - 1 + i, 1);
      const ano = cursor.getFullYear(), mes = cursor.getMonth() + 1;
      cronograma.push({ ano, mes, itens: plano.itens.filter((item) => itemDevidoNoMesPmoc(item, plano.data_inicio, ano, mes)).map((item) => item.descricao) });
    }
  }
  const execucoes = data.os_refrigeracao_agendamentos
    .filter((a) => plano && a.pmoc_plano_id === plano.id && a.empresa_id === empresaId)
    .map((a) => ({ data: a.data, tecnico_nome: a.tecnico_nome || '', status: a.status }))
    .sort((a, b) => a.data.localeCompare(b.data));
  const qualidadeAr = await Promise.all(
    data.os_refrigeracao_pmoc_qualidade_ar.filter((q) => q.local_id === local.id && q.empresa_id === empresaId)
      .sort((a, b) => b.data.localeCompare(a.data)).slice(0, 5)
      .map(async (q) => ({ ...q, laudo_pdf: await hidratarFotosProfundo(q.laudo_pdf) }))
  );
  return {
    local: pmocLocalComDetalhes(data, local),
    ambientes,
    plano: plano ? { ...plano, art_trt_anexo: await hidratarFotosProfundo(plano.art_trt_anexo), data_fim: calcularDataFimPlanoPmoc(plano.data_inicio, plano.vigencia_meses) } : null,
    responsavel_tecnico: responsavel ? { ...responsavel, assinatura_img: await hidratarFotosProfundo(responsavel.assinatura_img) } : null,
    cronograma, execucoes, qualidade_ar: qualidadeAr,
  };
}
rota('GET', /^\/api\/pmoc\/locais\/(\d+)\/documento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  enviarJSON(res, 200, await montarDocumentoPmocLocal(data, local, user.empresa_id));
});

// ---- Relatório mensal consolidado (item 4.3 do pedido) — por CLIENTE, agregando todos os
// locais dele: visitas realizadas no mês, pendências, não conformidades abertas e % no prazo.
rota('GET', /^\/api\/pmoc\/clientes\/(\d+)\/relatorio-mensal$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const cliente = tenant.buscar(data, 'os_refrigeracao_clientes', Number(m[1]), user.empresa_id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}$/.test(query.mes || '')) return enviarJSON(res, 400, { erro: 'Informe o mês (AAAA-MM).' });
  const locaisIds = data.os_refrigeracao_pmoc_locais.filter((l) => l.cliente_id === cliente.id && l.empresa_id === user.empresa_id).map((l) => l.id);
  const visitasDoMes = data.os_refrigeracao_agendamentos.filter((a) => a.pmoc_local_id && locaisIds.includes(a.pmoc_local_id) && a.empresa_id === user.empresa_id && a.data.startsWith(query.mes));
  const concluidas = visitasDoMes.filter((v) => v.status === 'concluido');
  const pendentes = visitasDoMes.filter((v) => v.status === 'pendente_designacao' || v.status === 'agendado');
  const canceladas = visitasDoMes.filter((v) => v.status === 'cancelado');
  // "no prazo": concluída até o fim do próprio mês planejado pra visita (toda visita já nasce com
  // a data certa — ver geração automática — então só fica fora do prazo quem concluiu depois).
  const fimMes = new Date(Number(query.mes.slice(0, 4)), Number(query.mes.slice(5, 7)), 0).toISOString().slice(0, 10);
  const noPrazo = concluidas.filter((v) => !v.concluido_em || v.concluido_em.slice(0, 10) <= fimMes);
  const naoConformidadesAbertas = visitasDoMes.flatMap((v) => (v.pmoc_itens || []).filter((i) => i.resposta === 'nao_conforme' && !i.os_corretiva_id));
  enviarJSON(res, 200, {
    cliente: { nome: cliente.nome }, mes: query.mes,
    total_visitas: visitasDoMes.length, concluidas: concluidas.length, pendentes: pendentes.length, canceladas: canceladas.length,
    percentual_no_prazo: visitasDoMes.length ? Math.round((noPrazo.length / visitasDoMes.length) * 100) : null,
    nao_conformidades_abertas: naoConformidadesAbertas.length,
    visitas: [...visitasDoMes].sort((a, b) => a.data.localeCompare(b.data)).map((v) => ({ id: v.id, data: v.data, status: v.status, cliente_nome: v.cliente_nome, tecnico_nome: v.tecnico_nome || '' })),
  });
});

// ---- portal do cliente final (item 5 do pedido) — acesso de quem loga como papel "cliente" com
// os_refrigeracao_cliente_id setado (ver POST /api/login e o form de usuários em app.js). Só
// enxerga os próprios locais/ambientes/aparelhos/visitas — nunca os de outro cliente da mesma
// empresa, e a empresa em si precisa continuar com o perfil + módulo pmoc ativos.
function exigirClientePortalPmoc(res, user, data) {
  if (!user || user.papel !== 'cliente' || !user.os_refrigeracao_cliente_id) {
    enviarJSON(res, 403, { erro: 'Portal exclusivo de clientes do pacote PMOC.' });
    return null;
  }
  if (!empresaPerfilRefrigeracao(data, user.empresa_id) || !db.moduloAtivo(data, user.empresa_id, 'pmoc')) {
    enviarJSON(res, 403, { erro: 'Portal exclusivo de empresas com o perfil Refrigeração e o pacote PMOC contratado.' });
    return null;
  }
  const cliente = tenant.buscar(data, 'os_refrigeracao_clientes', user.os_refrigeracao_cliente_id, user.empresa_id);
  if (!cliente) { enviarJSON(res, 404, { erro: 'Cliente não encontrado.' }); return null; }
  return cliente;
}

// GET /api/pmoc/portal/locais
rota('GET', /^\/api\/pmoc\/portal\/locais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const locais = data.os_refrigeracao_pmoc_locais.filter((l) => l.cliente_id === cliente.id && l.empresa_id === user.empresa_id).map((l) => pmocLocalComDetalhes(data, l));
  enviarJSON(res, 200, { locais });
});
// GET /api/pmoc/portal/locais/:id — ambientes + aparelhos com status
rota('GET', /^\/api\/pmoc\/portal\/locais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local || local.cliente_id !== cliente.id) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const ambientes = data.os_refrigeracao_pmoc_ambientes.filter((a) => a.local_id === local.id)
    .map((a) => ({ ...a, aparelhos: data.os_refrigeracao_pmoc_aparelhos.filter((p) => p.ambiente_id === a.id) }));
  enviarJSON(res, 200, { local: pmocLocalComDetalhes(data, local), ambientes });
});
// GET /api/pmoc/portal/locais/:id/documento — "Baixar PMOC" (documento sempre atualizado)
rota('GET', /^\/api\/pmoc\/portal\/locais\/(\d+)\/documento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local || local.cliente_id !== cliente.id) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  enviarJSON(res, 200, await montarDocumentoPmocLocal(data, local, user.empresa_id));
});
// GET /api/pmoc/portal/locais/:id/qualidade-ar
rota('GET', /^\/api\/pmoc\/portal\/locais\/(\d+)\/qualidade-ar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const local = tenant.buscar(data, 'os_refrigeracao_pmoc_locais', Number(m[1]), user.empresa_id);
  if (!local || local.cliente_id !== cliente.id) return enviarJSON(res, 404, { erro: 'Local não encontrado.' });
  const lista = await Promise.all(
    data.os_refrigeracao_pmoc_qualidade_ar.filter((q) => q.local_id === local.id && q.empresa_id === user.empresa_id)
      .map(async (q) => ({ ...q, laudo_pdf: await hidratarFotosProfundo(q.laudo_pdf) }))
  );
  lista.sort((a, b) => b.data.localeCompare(a.data));
  enviarJSON(res, 200, { analises: lista });
});
// GET /api/pmoc/portal/visitas — histórico (todas) + próximas preventivas agendadas, de todos os
// locais do cliente — mais recente primeiro.
rota('GET', /^\/api\/pmoc\/portal\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const locaisIds = data.os_refrigeracao_pmoc_locais.filter((l) => l.cliente_id === cliente.id && l.empresa_id === user.empresa_id).map((l) => l.id);
  const visitas = data.os_refrigeracao_agendamentos
    .filter((a) => a.pmoc_local_id && locaisIds.includes(a.pmoc_local_id) && a.empresa_id === user.empresa_id)
    .map((a) => ({ id: a.id, data: a.data, hora: a.hora, status: a.status, cliente_nome: a.cliente_nome, tecnico_nome: a.tecnico_nome || '', total_itens: (a.pmoc_itens || []).length }))
    .sort((a, b) => b.data.localeCompare(a.data));
  enviarJSON(res, 200, { visitas });
});
// GET /api/pmoc/portal/visitas/:id — detalhe hidratado, pro cliente ver/baixar o relatório daquela visita.
rota('GET', /^\/api\/pmoc\/portal\/visitas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const visita = tenant.buscar(data, 'os_refrigeracao_agendamentos', Number(m[1]), user.empresa_id);
  if (!visita || !visita.pmoc_local_id) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === visita.pmoc_local_id && l.empresa_id === user.empresa_id);
  if (!local || local.cliente_id !== cliente.id) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const itens = await Promise.all((visita.pmoc_itens || []).map(async (i) => ({ ...i, foto_antes: await hidratarFotosProfundo(i.foto_antes), foto_depois: await hidratarFotosProfundo(i.foto_depois) })));
  const assinatura_responsavel_img = await hidratarFotosProfundo(visita.assinatura_responsavel_img);
  enviarJSON(res, 200, { visita: { ...visita, pmoc_itens: itens, assinatura_responsavel_img } });
});
// POST /api/pmoc/portal/aparelhos/:id/chamado { descricao } — pedido do usuário: "abrir chamado
// (corretiva) pra um aparelho específico". Nasce "pendente", sem técnico (o administrador designa
// depois — mesmo espírito da preventiva automática, só que essa aqui é avulsa e pedida pelo cliente).
rota('POST', /^\/api\/pmoc\/portal\/aparelhos\/(\d+)\/chamado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const cliente = exigirClientePortalPmoc(res, user, data);
  if (!cliente) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  const ambiente = data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === user.empresa_id);
  const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === user.empresa_id) : null;
  if (!local || local.cliente_id !== cliente.id) return enviarJSON(res, 403, { erro: 'Esse aparelho não é de um local seu.' });
  const body = await lerCorpo(req);
  const descricao = String(body.descricao || '').trim();
  if (!descricao) return enviarJSON(res, 400, { erro: 'Descreva o problema.' });
  const os = tenant.criar(data, 'os_refrigeracao', user.empresa_id, {
    cliente_id: cliente.id,
    equipamento: { tipo: aparelho.tipo, marca: aparelho.marca, modelo: aparelho.modelo, btu: aparelho.capacidade_btu },
    problema_relatado: descricao, diagnostico: '', servicos: [], materiais: [], mao_de_obra: 0,
    desconto_tipo: 'valor', desconto_valor: 0, observacoes_servico: '', endereco_servico: local.endereco || '',
    garantia_dias: 90, observacoes: '', fotos: [],
    assinatura_tecnico_img: null, assinatura_cliente_img: null, assinado_cliente_em: null,
    tecnico_id: null, tecnico_nome: '', autor_id: user.id,
    token_assinatura: gerarTokenConvite(), status: 'pendente', criado_em: new Date().toISOString(),
    pmoc_origem: { aparelho_id: aparelho.id, local_id: local.id, aberto_pelo_cliente: true },
  });
  db.save(data);
  enviarJSON(res, 201, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// ---------- Pacote "Climatização / PMOC" — Fase 5: QR, alertas e painel ----------

// ---- config do pacote (por empresa, item 7 — "configurável") ----
// usado pelo alerta de qualidade do ar desatualizada (ver GET /api/notificacoes, mais acima no
// arquivo — funções soltas no mesmo módulo são "hoisted", não precisa estar definida antes).
function dataMenosMesesPmoc(dataIso, meses) {
  const d = new Date(dataIso + 'T12:00:00');
  d.setMonth(d.getMonth() - (Number(meses) || 6));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// devolve [config, criadoAgora] — "criadoAgora" deixa quem chamou decidir se precisa salvar
// (ver varredura de desempenho: um GET de leitura não deve gravar o arquivo inteiro no disco
// toda vez só porque passou por aqui — só na primeira vez que a config de verdade nasce).
function garantirConfigPmoc(data, empresaId) {
  let config = tenant.listar(data, 'os_refrigeracao_pmoc_config', empresaId)[0];
  if (config) return [config, false];
  config = tenant.criar(data, 'os_refrigeracao_pmoc_config', empresaId, { qualidade_ar_meses_alerta: 6, qr_publico_ativo: true });
  return [config, true];
}
rota('GET', /^\/api\/pmoc\/config$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const [config, criado] = garantirConfigPmoc(data, user.empresa_id);
  if (criado) db.save(data);
  enviarJSON(res, 200, { config });
});
rota('PUT', /^\/api\/pmoc\/config$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador altera a configuração do pacote PMOC.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const [config] = garantirConfigPmoc(data, user.empresa_id);
  const body = await lerCorpo(req);
  const meses = Number(body.qualidade_ar_meses_alerta);
  if (!(meses > 0)) return enviarJSON(res, 400, { erro: 'Informe um número de meses válido.' });
  config.qualidade_ar_meses_alerta = meses;
  config.qr_publico_ativo = !!body.qr_publico_ativo;
  db.save(data);
  enviarJSON(res, 200, { config });
});

// ---- QR por aparelho (item 6 do pedido) ----
// monta o histórico desse aparelho específico olhando os checklists das visitas já concluídas do
// local dele — não existe uma coleção própria de "histórico do aparelho", os itens já ficam
// guardados dentro de cada visita (ver pmoc_itens) com o aparelho_id de quem foi checado.
function historicoAparelhoPmoc(data, local, aparelhoId, limite) {
  const visitasConcluidas = data.os_refrigeracao_agendamentos
    .filter((a) => a.pmoc_local_id === local.id && a.empresa_id === local.empresa_id && a.status === 'concluido')
    .sort((a, b) => b.data.localeCompare(a.data));
  const historico = [];
  for (const v of visitasConcluidas) {
    for (const item of v.pmoc_itens || []) {
      if (item.aparelho_id === aparelhoId) historico.push({ data: v.data, item_descricao: item.item_descricao, resposta: item.resposta, observacao: item.observacao });
    }
    if (historico.length >= (limite || 20)) break;
  }
  return historico.slice(0, limite || 20);
}
// GET /api/pmoc/aparelhos/por-qr/:token — exige login; devolve dados diferentes conforme o papel
// (ver item 6: "técnico logado" vê histórico + ação de executar/corretiva, "cliente logado" vê
// histórico + abrir chamado). Outros papéis (ex.: supervisor de outro módulo) não tem acesso.
rota('GET', /^\/api\/pmoc\/aparelhos\/por-qr\/([a-f0-9]+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const aparelho = tenant.listar(data, 'os_refrigeracao_pmoc_aparelhos', user.empresa_id).find((a) => a.qr_token === m[1]);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado (QR inválido ou de outra empresa).' });
  const ambiente = data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === user.empresa_id);
  const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === user.empresa_id) : null;
  if (!ambiente || !local) return enviarJSON(res, 404, { erro: 'Aparelho sem ambiente/local — cadastro incompleto.' });
  if (user.papel === 'cliente') {
    const cliente = exigirClientePortalPmoc(res, user, data);
    if (!cliente) return;
    if (local.cliente_id !== cliente.id) return enviarJSON(res, 403, { erro: 'Esse aparelho não é de um local seu.' });
    return enviarJSON(res, 200, {
      modo: 'cliente', aparelho, ambiente, local: pmocLocalComDetalhes(data, local),
      historico: historicoAparelhoPmoc(data, local, aparelho.id, 20),
    });
  }
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  // próxima visita do local ainda não concluída — só oferece "executar preventiva" se for do
  // próprio técnico (mesma regra de exigirAcessoVisitaPmoc), administrador vê qualquer uma.
  const proximaVisita = data.os_refrigeracao_agendamentos
    .filter((a) => a.pmoc_local_id === local.id && a.empresa_id === user.empresa_id && !['concluido', 'cancelado'].includes(a.status))
    .filter((a) => user.papel === 'administrador' || a.tecnico_id === user.id)
    .sort((a, b) => a.data.localeCompare(b.data))[0] || null;
  enviarJSON(res, 200, {
    modo: 'tecnico', aparelho, ambiente, local: pmocLocalComDetalhes(data, local),
    historico: historicoAparelhoPmoc(data, local, aparelho.id, 20),
    visita_pendente: proximaVisita ? { id: proximaVisita.id, data: proximaVisita.data, status: proximaVisita.status } : null,
  });
});
// GET /api/pmoc/qr/:token/publico — PÚBLICA (ver PREFIXOS_PUBLICOS em rotas-modulo.js), sem
// login nenhum. Devolve só o mínimo que o pedido permite ("data da última manutenção e o nome da
// empresa de climatização") e respeita o toggle configurável de ligar/desligar essa página.
rota('GET', /^\/api\/pmoc\/qr\/([a-f0-9]+)\/publico$/, async (req, res, m) => {
  const data = db.load();
  // qr_token é um valor único de verdade (32 hex aleatórios, ver db.gerarQrToken) — acha o
  // aparelho numa única varredura, sem precisar iterar empresa por empresa (varredura de
  // desempenho: essa rota é pública e pode ser escaneada em campo com frequência).
  const aparelho = data.os_refrigeracao_pmoc_aparelhos.find((a) => a.qr_token === m[1]);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'QR inválido.' });
  const empresaId = aparelho.empresa_id;
  const [config, criado] = garantirConfigPmoc(data, empresaId);
  if (criado) db.save(data);
  if (!config.qr_publico_ativo) return enviarJSON(res, 200, { exibir: false });
  const ambiente = data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === empresaId);
  const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === empresaId) : null;
  const ultimaVisita = local ? data.os_refrigeracao_agendamentos
    .filter((a) => a.pmoc_local_id === local.id && a.empresa_id === empresaId && a.status === 'concluido')
    .sort((a, b) => b.data.localeCompare(a.data))[0] : null;
  const empresa = data.empresas.find((e) => e.id === empresaId);
  enviarJSON(res, 200, { exibir: true, empresa_nome: empresa ? empresa.nome : '', ultima_manutencao: ultimaVisita ? ultimaVisita.data : null });
});
// POST /api/pmoc/aparelhos/:id/abrir-corretiva { descricao } — mesma ideia do chamado do portal
// do cliente (ver POST /api/pmoc/portal/aparelhos/:id/chamado), só que do lado do
// técnico/administrador: ao escanear o QR em campo, abrir direto uma corretiva sem precisar estar
// dentro de uma visita de preventiva em andamento. Nasce com o próprio técnico já designado (ele
// está ali, na frente do aparelho — mesmo padrão de POST .../gerar-corretiva).
rota('POST', /^\/api\/pmoc\/aparelhos\/(\d+)\/abrir-corretiva$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const aparelho = tenant.buscar(data, 'os_refrigeracao_pmoc_aparelhos', Number(m[1]), user.empresa_id);
  if (!aparelho) return enviarJSON(res, 404, { erro: 'Aparelho não encontrado.' });
  const ambiente = data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === user.empresa_id);
  const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === user.empresa_id) : null;
  if (!local) return enviarJSON(res, 400, { erro: 'Aparelho sem local — cadastro incompleto.' });
  const body = await lerCorpo(req);
  const descricao = String(body.descricao || '').trim();
  if (!descricao) return enviarJSON(res, 400, { erro: 'Descreva o problema.' });
  const os = tenant.criar(data, 'os_refrigeracao', user.empresa_id, {
    cliente_id: local.cliente_id,
    equipamento: { tipo: aparelho.tipo, marca: aparelho.marca, modelo: aparelho.modelo, btu: aparelho.capacidade_btu },
    problema_relatado: descricao, diagnostico: '', servicos: [], materiais: [], mao_de_obra: 0,
    desconto_tipo: 'valor', desconto_valor: 0, observacoes_servico: '', endereco_servico: local.endereco || '',
    garantia_dias: 90, observacoes: '', fotos: [],
    assinatura_tecnico_img: null, assinatura_cliente_img: null, assinado_cliente_em: null,
    tecnico_id: user.id, tecnico_nome: user.nome, autor_id: user.id,
    token_assinatura: gerarTokenConvite(), status: 'pendente', criado_em: new Date().toISOString(),
    pmoc_origem: { aparelho_id: aparelho.id, local_id: local.id, aberto_via_qr: true },
  });
  db.save(data);
  enviarJSON(res, 201, { os: await osRefrigeracaoComDetalhes(data, os) });
});

// ---- painel/dashboard do pacote (item 8 do pedido) ----
// % de preventivas no prazo de um mês, pra TODA a empresa (mesma fórmula de
// GET /api/pmoc/clientes/:id/relatorio-mensal, só que sem filtrar por cliente).
function percentualNoPrazoPmocMes(data, empresaId, mes) {
  const visitasDoMes = data.os_refrigeracao_agendamentos.filter((a) => a.pmoc_plano_id && a.empresa_id === empresaId && a.data.startsWith(mes));
  if (!visitasDoMes.length) return null;
  const fimMes = new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).toISOString().slice(0, 10);
  const noPrazo = visitasDoMes.filter((v) => v.status === 'concluido' && (!v.concluido_em || v.concluido_em.slice(0, 10) <= fimMes));
  return Math.round((noPrazo.length / visitasDoMes.length) * 100);
}
function seisMesesAtePmoc(hojeIso) {
  const [ano, mes] = hojeIso.slice(0, 7).split('-').map(Number);
  const lista = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ano, mes - 1 - i, 1);
    lista.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return lista;
}
// GET /api/pmoc/painel?hoje=AAAA-MM-DD — só administrador (visão gerencial do pacote inteiro).
rota('GET', /^\/api\/pmoc\/painel$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Painel PMOC é exclusivo do administrador.' });
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  const hoje = query.hoje;
  const mesAtual = hoje.slice(0, 7);
  const percentualNoPrazo = {
    mes_atual: percentualNoPrazoPmocMes(data, user.empresa_id, mesAtual),
    ultimos_6_meses: seisMesesAtePmoc(hoje).map((mes) => ({ mes, percentual: percentualNoPrazoPmocMes(data, user.empresa_id, mes) })),
  };
  const visitasAtrasadas = tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id)
    .filter((a) => a.pmoc_plano_id && a.data < hoje && !['concluido', 'cancelado'].includes(a.status));
  const contarPor = (lista, campo) => {
    const mapa = new Map();
    for (const item of lista) {
      const chave = item[campo] || '—';
      mapa.set(chave, (mapa.get(chave) || 0) + 1);
    }
    return [...mapa.entries()].map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd);
  };
  const atrasadasPorTecnico = contarPor(visitasAtrasadas, 'tecnico_nome');
  const atrasadasPorCliente = contarPor(visitasAtrasadas, 'cliente_nome');
  const naoConformidadesAbertas = tenant.listar(data, 'os_refrigeracao_agendamentos', user.empresa_id)
    .filter((a) => a.pmoc_plano_id && a.status === 'concluido')
    .flatMap((a) => (a.pmoc_itens || []).filter((i) => i.resposta === 'nao_conforme' && !i.os_corretiva_id)).length;
  // top 10 aparelhos com mais corretivas: toda O.S. corretiva nasceu com pmoc_origem.aparelho_id
  // (ver .../gerar-corretiva, .../abrir-corretiva e o chamado do portal do cliente).
  const corretivasPorAparelho = new Map();
  for (const os of tenant.listar(data, 'os_refrigeracao', user.empresa_id)) {
    const aparelhoId = os.pmoc_origem && os.pmoc_origem.aparelho_id;
    if (!aparelhoId) continue;
    corretivasPorAparelho.set(aparelhoId, (corretivasPorAparelho.get(aparelhoId) || 0) + 1);
  }
  const aparelhosMaisCorretivas = [...corretivasPorAparelho.entries()]
    .map(([aparelhoId, qtd]) => {
      const aparelho = data.os_refrigeracao_pmoc_aparelhos.find((a) => a.id === aparelhoId && a.empresa_id === user.empresa_id);
      const ambiente = aparelho ? data.os_refrigeracao_pmoc_ambientes.find((a) => a.id === aparelho.ambiente_id && a.empresa_id === user.empresa_id) : null;
      const local = ambiente ? data.os_refrigeracao_pmoc_locais.find((l) => l.id === ambiente.local_id && l.empresa_id === user.empresa_id) : null;
      return { aparelho_id: aparelhoId, aparelho_tipo: aparelho ? aparelho.tipo : '(removido)', local_nome: local ? local.nome : '—', qtd };
    })
    .sort((a, b) => b.qtd - a.qtd).slice(0, 10);
  // clientes com plano PMOC vencido ou sem ART (ausente/vencida) — qualquer local do cliente.
  const clientesProblema = new Map();
  let precisaSalvarPainel = false; // só grava o arquivo se algum plano realmente virou "vencido" agora.
  for (const plano of tenant.listar(data, 'os_refrigeracao_pmoc_planos', user.empresa_id)) {
    const local = data.os_refrigeracao_pmoc_locais.find((l) => l.id === plano.local_id && l.empresa_id === user.empresa_id);
    if (!local) continue;
    const cliente = data.os_refrigeracao_clientes.find((c) => c.id === local.cliente_id && c.empresa_id === user.empresa_id);
    if (!cliente) continue;
    const statusAntes = plano.status;
    atualizarStatusVencidoPlanoPmoc(plano, hoje);
    if (plano.status !== statusAntes) precisaSalvarPainel = true;
    const vencido = plano.status === 'vencido';
    const semArt = plano.status !== 'rascunho' && (!plano.art_trt_numero || (plano.art_trt_validade && plano.art_trt_validade < hoje));
    if (!vencido && !semArt) continue;
    const motivos = clientesProblema.get(cliente.id) || { cliente_id: cliente.id, cliente_nome: cliente.nome, plano_vencido: false, sem_art: false };
    motivos.plano_vencido = motivos.plano_vencido || vencido;
    motivos.sem_art = motivos.sem_art || semArt;
    clientesProblema.set(cliente.id, motivos);
  }
  if (precisaSalvarPainel) db.save(data); // só grava o arquivo inteiro quando algo de fato mudou.
  // Fase B (análise de concorrentes): "controle financeiro" — a receber no mês atual (pendente +
  // atrasada) e o total já atrasado, pra dar visibilidade sem precisar abrir a tela de Faturamento.
  const faturasEmpresa = tenant.listar(data, 'os_refrigeracao_pmoc_faturas', user.empresa_id);
  const faturamento = {
    a_receber_mes_atual: faturasEmpresa.filter((f) => f.mes === mesAtual && f.status !== 'paga').reduce((s, f) => s + f.valor, 0),
    atrasado: faturasEmpresa.filter((f) => f.status === 'atrasada').reduce((s, f) => s + f.valor, 0),
    qtd_atrasadas: faturasEmpresa.filter((f) => f.status === 'atrasada').length,
  };
  enviarJSON(res, 200, {
    percentual_no_prazo: percentualNoPrazo,
    atrasadas_por_tecnico: atrasadasPorTecnico,
    atrasadas_por_cliente: atrasadasPorCliente,
    nao_conformidades_abertas: naoConformidadesAbertas,
    aparelhos_mais_corretivas: aparelhosMaisCorretivas,
    clientes_problema: [...clientesProblema.values()],
    faturamento,
  });
});

// ---------- Início (Home) — perfil "Refrigeração e Climatização" ----------
// pedido do usuário (referência: app concorrente iClima): painel de controle no topo do menu, com
// os números do PRÓPRIO usuário logado — hoje/semana/ocupação do mês vêm da Agenda já construída
// (mesmo default "a própria agenda" que ela já usa, ver resolverTecnicoIdAgendaRef) — e
// solicitações pendentes da empresa inteira (orçamentos ainda em rascunho, aguardando ação; não é
// por técnico porque Orçamento não pertence a um técnico específico, qualquer um da empresa edita).
// `hoje` vem do cliente (não do relógio do servidor) pelo mesmo motivo de `data`/`mes` nas rotas de
// Agenda acima: "hoje" é o dia local de quem está vendo a tela, não o fuso do servidor.
function inicioSemanaIsoAgendaRef(dataIso) {
  const d = new Date(dataIso + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function somarDiasIsoAgendaRefServer(dataIso, dias) {
  const d = new Date(dataIso + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// GET /api/os-refrigeracao-home/resumo?hoje=YYYY-MM-DD
rota('GET', /^\/api\/os-refrigeracao-home\/resumo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPerfilRefrigeracao(res, user, data)) return;
  const { query } = url.parse(req.url, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.hoje || '')) return enviarJSON(res, 400, { erro: 'Informe a data de hoje (AAAA-MM-DD).' });
  const hojeIso = query.hoje;
  const tecnicoId = user.id;

  const agendamentosHoje = data.os_refrigeracao_agendamentos
    .filter((a) => a.tecnico_id === tecnicoId && a.empresa_id === user.empresa_id && a.data === hojeIso && a.status !== 'cancelado')
    .sort((a, b) => a.hora.localeCompare(b.hora));
  const proximo = agendamentosHoje[0] ? { hora: agendamentosHoje[0].hora, cliente_nome: agendamentosHoje[0].cliente_nome } : null;

  const inicioSemana = inicioSemanaIsoAgendaRef(hojeIso);
  const fimSemana = somarDiasIsoAgendaRefServer(inicioSemana, 6);
  const agendamentosSemana = data.os_refrigeracao_agendamentos.filter((a) => a.tecnico_id === tecnicoId && a.empresa_id === user.empresa_id && a.data >= inicioSemana && a.data <= fimSemana && a.status !== 'cancelado');
  const valorSemana = agendamentosSemana.reduce((s, a) => s + (Number(a.valor_servico) || 0), 0);

  const solicitacoes = data.os_refrigeracao_orcamentos.filter((o) => o.empresa_id === user.empresa_id && o.status === 'rascunho').length;

  const config = data.os_refrigeracao_agenda_config.find((c) => c.tecnico_id === tecnicoId && c.empresa_id === user.empresa_id) || null;
  let ocupacao = 0;
  if (config) {
    const [ano, mes] = hojeIso.split('-').map(Number);
    const diasNoMes = new Date(ano, mes, 0).getDate();
    let totalMes = 0, agendadosMes = 0;
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const dataIso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      const total = totalOferecivelDoDiaAgendaRef(config, dataIso);
      if (total > 0) {
        totalMes += total;
        agendadosMes += data.os_refrigeracao_agendamentos.filter((a) => a.tecnico_id === tecnicoId && a.empresa_id === user.empresa_id && a.data === dataIso && a.status !== 'cancelado').length;
      }
    }
    ocupacao = totalMes > 0 ? Math.round((agendadosMes / totalMes) * 100) : 0;
  }

  enviarJSON(res, 200, {
    hoje: { total: agendamentosHoje.length, proximo },
    semana: { total: agendamentosSemana.length, valor_total: valorSemana },
    solicitacoes: { total: solicitacoes },
    ocupacao: { percentual: ocupacao },
  });
});

// GET /api/clientes/:id/historico — Histórico Unificado (CRM nativo, passo 4): agrega tudo que já
// existe espalhado (agenda, relatórios, chamados, equipamentos, oportunidades, propostas) numa
// timeline só, na própria tela de Clientes. relatorios_manutencao não tem cliente_id nenhum — só
// o texto livre `empresa` — então o match é por agenda_id quando existe, senão por nome igual
// sincronizarClienteDoRelatorio já faz; não dá pra fingir que é um JOIN limpo por FK.
rota('GET', /^\/api\/clientes\/(\d+)\/historico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção veem o histórico do cliente.' });
  const data = db.load();
  const clienteId = Number(m[1]);
  const cliente = tenant.buscar(data, 'clientes', clienteId, user.empresa_id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  const nomeCliente = String(cliente.nome_empresa || '').trim().toLowerCase();

  const agenda = tenant.listar(data, 'agenda', user.empresa_id).filter((a) => a.cliente_id === clienteId);
  const agendaIds = new Set(agenda.map((a) => a.id));
  const relatorios = tenant.listar(data, 'relatorios_manutencao', user.empresa_id).filter((r) => (
    r.agenda_id ? agendaIds.has(r.agenda_id) : String(r.empresa || '').trim().toLowerCase() === nomeCliente
  ));
  const chamados = tenant.listar(data, 'chamados', user.empresa_id).filter((c) => c.cliente_id === clienteId);
  const equipamentos = tenant.listar(data, 'equipamentos', user.empresa_id).filter((e) => e.cliente_id === clienteId);
  const oportunidades = tenant.listar(data, 'oportunidades', user.empresa_id).filter((o) => o.cliente_id === clienteId);
  const oportunidadeIds = new Set(oportunidades.map((o) => o.id));
  const propostas = tenant.listar(data, 'propostas', user.empresa_id).filter((p) => oportunidadeIds.has(p.oportunidade_id));

  enviarJSON(res, 200, { agenda, relatorios, chamados, equipamentos, oportunidades, propostas });
});

// ---------- SETORES / FILIAIS / ÁREAS (versão Restaurantes/rede multiunidade, Fase 1 — Base) ----------
// Hierarquia nova, abaixo da empresa: setores -> filiais -> áreas (ver seed() em db.js e o módulo
// "filiais" em MODULOS_DISPONIVEIS). Só administrador cadastra/edita a estrutura em si — os papéis
// novos (coordenador_tecnico/consultor_mercado/gerente_loja) só a consultam, dentro do próprio
// escopo (ver escopo.js).
const PAPEIS_VEEM_ESTRUTURA_FILIAIS = ['administrador', 'supervisor', 'coordenador_tecnico', 'consultor_mercado', 'gerente_loja', 'suporte'];

// GET /api/setores
rota('GET', /^\/api\/setores$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_VEEM_ESTRUTURA_FILIAIS)) return enviarJSON(res, 403, { erro: 'Sem acesso a setores.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let setores = tenant.listar(data, 'setores', user.empresa_id);
  // coordenador/consultor só veem o próprio setor por padrão; os demais papéis desta lista veem
  // todos (gerente_loja/suporte precisam ver o nome do setor da própria filial/loja base).
  // ?todos=1 é a exceção: o coordenador precisa ver os OUTROS setores pra poder pedir apoio a
  // eles (seção 7 do pedido do usuário) — só nome/id, o suficiente pra escolher o destino.
  if ((user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') && query.todos !== '1') {
    const completo = usuarioCompleto(data, user);
    setores = setores.filter((s) => s.id === completo.setor_id);
  } else if (query.todos === '1') {
    setores = setores.map((s) => ({ id: s.id, nome: s.nome }));
  }
  enviarJSON(res, 200, { setores });
});

// POST /api/setores { nome, coordenador_id?, consultor_id? }
rota('POST', /^\/api\/setores$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra setores.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome do setor é obrigatório.' });
  const data = db.load();
  const refs = resolverCoordenadorConsultor(data, user.empresa_id, body);
  if (refs.erro) return enviarJSON(res, 400, { erro: refs.erro });
  const setor = tenant.criar(data, 'setores', user.empresa_id, {
    nome: body.nome.trim(), coordenador_id: refs.coordenador_id, consultor_id: refs.consultor_id,
  });
  // atribuir aqui já marca o escopo do usuário — evita um segundo passo em "Usuários" pra cada setor novo.
  if (refs.coordenador) refs.coordenador.setor_id = setor.id;
  if (refs.consultor) refs.consultor.setor_id = setor.id;
  db.save(data);
  enviarJSON(res, 201, { setor });
});

function resolverCoordenadorConsultor(data, empresaId, body) {
  let coordenador = null, consultor = null;
  if (body.coordenador_id) {
    coordenador = tenant.buscar(data, 'usuarios', Number(body.coordenador_id), empresaId);
    if (!coordenador || coordenador.papel !== 'coordenador_tecnico') return { erro: 'Coordenador técnico inválido.' };
  }
  if (body.consultor_id) {
    consultor = tenant.buscar(data, 'usuarios', Number(body.consultor_id), empresaId);
    if (!consultor || consultor.papel !== 'consultor_mercado') return { erro: 'Consultor de mercado inválido.' };
  }
  return { coordenador, consultor, coordenador_id: coordenador ? coordenador.id : null, consultor_id: consultor ? consultor.id : null };
}

// PUT /api/setores/:id
rota('PUT', /^\/api\/setores\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita setores.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome do setor é obrigatório.' });
  const data = db.load();
  const setor = tenant.buscar(data, 'setores', Number(m[1]), user.empresa_id);
  if (!setor) return enviarJSON(res, 404, { erro: 'Setor não encontrado.' });
  const refs = resolverCoordenadorConsultor(data, user.empresa_id, body);
  if (refs.erro) return enviarJSON(res, 400, { erro: refs.erro });
  setor.nome = body.nome.trim();
  setor.coordenador_id = refs.coordenador_id;
  setor.consultor_id = refs.consultor_id;
  if (refs.coordenador) refs.coordenador.setor_id = setor.id;
  if (refs.consultor) refs.consultor.setor_id = setor.id;
  db.save(data);
  enviarJSON(res, 200, { setor });
});

// DELETE /api/setores/:id — bloqueado se houver filial vinculada
rota('DELETE', /^\/api\/setores\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui setores.' });
  const data = db.load();
  const id = Number(m[1]);
  const setor = tenant.buscar(data, 'setores', id, user.empresa_id);
  if (!setor) return enviarJSON(res, 404, { erro: 'Setor não encontrado.' });
  if (tenant.listar(data, 'filiais', user.empresa_id).some((f) => f.setor_id === id)) {
    return enviarJSON(res, 400, { erro: 'Existem filiais vinculadas a este setor. Remova-as ou mude o setor delas antes.' });
  }
  data.setores = data.setores.filter((s) => s.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/setores/:id/tecnicos — versão Restaurantes/rede multiunidade (Fase 2 — Operação):
// técnicos (papel suporte) de qualquer filial deste setor, pra montar o seletor de "aceitar
// apoio"/"redesignar técnico" sem depender de GET /api/usuarios (que coordenador_tecnico não
// acessa — é restrito a administrador/supervisor).
rota('GET', /^\/api\/setores\/(\d+)\/tecnicos$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const setor = tenant.buscar(data, 'setores', Number(m[1]), user.empresa_id);
  if (!setor) return enviarJSON(res, 404, { erro: 'Setor não encontrado.' });
  if (user.papel === 'coordenador_tecnico' && usuarioCompleto(data, user).setor_id !== setor.id) {
    return enviarJSON(res, 403, { erro: 'Este setor não é o seu.' });
  }
  const filiaisIds = new Set(tenant.listar(data, 'filiais', user.empresa_id).filter((f) => f.setor_id === setor.id).map((f) => f.id));
  const tecnicos = tenant.listar(data, 'usuarios', user.empresa_id)
    .filter((u) => u.papel === 'suporte' && filiaisIds.has(u.filial_id))
    .map((u) => ({ id: u.id, nome: u.nome, filial_id: u.filial_id }));
  enviarJSON(res, 200, { tecnicos });
});

// GET /api/filiais — cada papel vê só o que seu escopo permite (ver escopo.js)
rota('GET', /^\/api\/filiais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_VEEM_ESTRUTURA_FILIAIS)) return enviarJSON(res, 403, { erro: 'Sem acesso a filiais.' });
  const data = db.load();
  enviarJSON(res, 200, { filiais: escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)) });
});

// POST /api/filiais { nome, setor_id, endereco?, tecnico_id?, gerente_id? }
rota('POST', /^\/api\/filiais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra filiais.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da filial é obrigatório.' });
  const data = db.load();
  if (!body.setor_id) return enviarJSON(res, 400, { erro: 'Informe o setor desta filial.' });
  const setor = tenant.buscar(data, 'setores', Number(body.setor_id), user.empresa_id);
  if (!setor) return enviarJSON(res, 400, { erro: 'Setor não encontrado.' });
  const refs = resolverTecnicoGerente(data, user.empresa_id, body);
  if (refs.erro) return enviarJSON(res, 400, { erro: refs.erro });
  const filial = tenant.criar(data, 'filiais', user.empresa_id, {
    nome: body.nome.trim(), setor_id: setor.id, endereco: body.endereco || '',
    tecnico_id: refs.tecnico_id, gerente_id: refs.gerente_id,
  });
  if (refs.tecnico) refs.tecnico.filial_id = filial.id;
  if (refs.gerente) refs.gerente.filial_id = filial.id;
  // áreas padrão (editáveis depois) — pedido do usuário: "Balcão, Cozinha, Fundo, Salão, Área
  // externa, Conservação".
  for (const nome of AREAS_PADRAO) tenant.criar(data, 'areas', user.empresa_id, { filial_id: filial.id, nome });
  db.save(data);
  enviarJSON(res, 201, { filial });
});
const AREAS_PADRAO = ['Balcão', 'Cozinha', 'Fundo', 'Salão', 'Área externa', 'Conservação'];

function resolverTecnicoGerente(data, empresaId, body) {
  let tecnico = null, gerente = null;
  if (body.tecnico_id) {
    tecnico = tenant.buscar(data, 'usuarios', Number(body.tecnico_id), empresaId);
    if (!tecnico || tecnico.papel !== 'suporte') return { erro: 'Técnico inválido.' };
  }
  if (body.gerente_id) {
    gerente = tenant.buscar(data, 'usuarios', Number(body.gerente_id), empresaId);
    if (!gerente || gerente.papel !== 'gerente_loja') return { erro: 'Gerente de loja inválido.' };
  }
  return { tecnico, gerente, tecnico_id: tecnico ? tecnico.id : null, gerente_id: gerente ? gerente.id : null };
}

// PUT /api/filiais/:id
rota('PUT', /^\/api\/filiais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita filiais.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da filial é obrigatório.' });
  const data = db.load();
  const filial = tenant.buscar(data, 'filiais', Number(m[1]), user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  if (!body.setor_id) return enviarJSON(res, 400, { erro: 'Informe o setor desta filial.' });
  const setor = tenant.buscar(data, 'setores', Number(body.setor_id), user.empresa_id);
  if (!setor) return enviarJSON(res, 400, { erro: 'Setor não encontrado.' });
  const refs = resolverTecnicoGerente(data, user.empresa_id, body);
  if (refs.erro) return enviarJSON(res, 400, { erro: refs.erro });
  filial.nome = body.nome.trim();
  filial.setor_id = setor.id;
  filial.endereco = body.endereco || '';
  filial.tecnico_id = refs.tecnico_id;
  filial.gerente_id = refs.gerente_id;
  if (refs.tecnico) refs.tecnico.filial_id = filial.id;
  if (refs.gerente) refs.gerente.filial_id = filial.id;
  db.save(data);
  enviarJSON(res, 200, { filial });
});

// DELETE /api/filiais/:id — bloqueado se houver área/equipamento/usuário vinculado
rota('DELETE', /^\/api\/filiais\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui filiais.' });
  const data = db.load();
  const id = Number(m[1]);
  const filial = tenant.buscar(data, 'filiais', id, user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  if (tenant.listar(data, 'equipamentos', user.empresa_id).some((e) => e.filial_id === id)) {
    return enviarJSON(res, 400, { erro: 'Existem equipamentos nesta filial. Transfira-os antes de excluir.' });
  }
  if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.filial_id === id)) {
    return enviarJSON(res, 400, { erro: 'Existem usuários vinculados a esta filial. Reatribua-os antes de excluir.' });
  }
  data.filiais = data.filiais.filter((f) => f.id !== id);
  data.areas = data.areas.filter((a) => a.filial_id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/areas?filial_id=123
rota('GET', /^\/api\/areas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_VEEM_ESTRUTURA_FILIAIS)) return enviarJSON(res, 403, { erro: 'Sem acesso a áreas.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let areas = tenant.listar(data, 'areas', user.empresa_id);
  if (['gerente_loja', 'coordenador_tecnico', 'consultor_mercado'].includes(user.papel)) {
    const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
    areas = areas.filter((a) => filiaisIds.has(a.filial_id));
  }
  if (query.filial_id) areas = areas.filter((a) => a.filial_id === Number(query.filial_id));
  enviarJSON(res, 200, { areas });
});

// POST /api/areas { filial_id, nome }
rota('POST', /^\/api\/areas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra áreas.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da área é obrigatório.' });
  const data = db.load();
  const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), user.empresa_id);
  if (!filial) return enviarJSON(res, 400, { erro: 'Filial não encontrada.' });
  const area = tenant.criar(data, 'areas', user.empresa_id, { filial_id: filial.id, nome: body.nome.trim() });
  db.save(data);
  enviarJSON(res, 201, { area });
});

// PUT /api/areas/:id — só o nome muda de filial (área não "muda de loja"); pra isso, exclua e recrie.
rota('PUT', /^\/api\/areas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita áreas.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da área é obrigatório.' });
  const data = db.load();
  const area = tenant.buscar(data, 'areas', Number(m[1]), user.empresa_id);
  if (!area) return enviarJSON(res, 404, { erro: 'Área não encontrada.' });
  area.nome = body.nome.trim();
  db.save(data);
  enviarJSON(res, 200, { area });
});

// DELETE /api/areas/:id — bloqueado se houver equipamento vinculado
rota('DELETE', /^\/api\/areas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui áreas.' });
  const data = db.load();
  const id = Number(m[1]);
  const area = tenant.buscar(data, 'areas', id, user.empresa_id);
  if (!area) return enviarJSON(res, 404, { erro: 'Área não encontrada.' });
  if (tenant.listar(data, 'equipamentos', user.empresa_id).some((e) => e.area_id === id)) {
    return enviarJSON(res, 400, { erro: 'Existem equipamentos nesta área. Mova-os antes de excluir.' });
  }
  data.areas = data.areas.filter((a) => a.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

const ESTAGIOS_LEAD_VALIDOS = ['novo', 'contatado', 'desqualificado'];

// GET /api/leads — menu Comercial: prospects que ainda não são clientes oficiais
rota('GET', /^\/api\/leads$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial veem leads.' });
  const data = db.load();
  enviarJSON(res, 200, { leads: tenant.listar(data, 'leads', user.empresa_id) });
});

// POST /api/leads — cadastra um novo lead/contato
rota('POST', /^\/api\/leads$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial cadastram leads.' });
  const body = await lerCorpo(req);
  if (!body.nome_empresa || !String(body.nome_empresa).trim()) {
    return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  }
  const data = db.load();
  const item = tenant.criar(data, 'leads', user.empresa_id, {
    nome_empresa: body.nome_empresa.trim(),
    contato: body.contato || '',
    telefone: body.telefone || '',
    email: body.email || '',
    origem: body.origem || '',
    estagio: ESTAGIOS_LEAD_VALIDOS.includes(body.estagio) ? body.estagio : 'novo',
    observacoes: body.observacoes || '',
    convertido_cliente_id: null,
  });
  db.save(data);
  enviarJSON(res, 201, { lead: item });
});

// PUT /api/leads/:id — edita um lead (dados ou estágio)
rota('PUT', /^\/api\/leads\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial editam leads.' });
  const body = await lerCorpo(req);
  if (!body.nome_empresa || !String(body.nome_empresa).trim()) {
    return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  }
  const data = db.load();
  const lead = tenant.buscar(data, 'leads', Number(m[1]), user.empresa_id);
  if (!lead) return enviarJSON(res, 404, { erro: 'Lead não encontrado.' });
  Object.assign(lead, {
    nome_empresa: body.nome_empresa.trim(),
    contato: body.contato || '', telefone: body.telefone || '', email: body.email || '',
    origem: body.origem || '',
    estagio: ESTAGIOS_LEAD_VALIDOS.includes(body.estagio) ? body.estagio : lead.estagio,
    observacoes: body.observacoes || '',
  });
  db.save(data);
  enviarJSON(res, 200, { lead });
});

// POST /api/leads/:id/converter — cria um cliente de verdade a partir do lead (igual
// sincronizarClienteDoRelatorio já faz a partir de um relatório) e marca convertido_cliente_id
rota('POST', /^\/api\/leads\/(\d+)\/converter$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial convertem leads.' });
  const data = db.load();
  const lead = tenant.buscar(data, 'leads', Number(m[1]), user.empresa_id);
  if (!lead) return enviarJSON(res, 404, { erro: 'Lead não encontrado.' });
  if (lead.convertido_cliente_id) return enviarJSON(res, 400, { erro: 'Este lead já foi convertido em cliente.' });
  const cliente = tenant.criar(data, 'clientes', user.empresa_id, {
    nome_empresa: lead.nome_empresa,
    contato: lead.contato || '', telefone: lead.telefone || '', email: lead.email || '',
    nivel_acesso: 'completo', setor: '',
    endereco: '', numero: '', bairro: '', cep: '', cidade: '', estado: '',
  });
  lead.convertido_cliente_id = cliente.id;
  db.save(data);
  enviarJSON(res, 200, { lead, cliente });
});

const ESTAGIOS_OPORTUNIDADE_VALIDOS = ['novo', 'contato', 'proposta', 'negociacao', 'ganho', 'perdido'];

// GET /api/oportunidades — funil comercial (menu Comercial), por estágio
rota('GET', /^\/api\/oportunidades$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial veem oportunidades.' });
  const data = db.load();
  enviarJSON(res, 200, { oportunidades: tenant.listar(data, 'oportunidades', user.empresa_id) });
});

// POST /api/oportunidades — cadastro manual (a automática nasce no POST /api/relatorios-manutencao
// do Devolutivo, ver mais abaixo)
rota('POST', /^\/api\/oportunidades$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial cadastram oportunidades.' });
  const body = await lerCorpo(req);
  if (!body.titulo || !String(body.titulo).trim()) {
    return enviarJSON(res, 400, { erro: 'Título é obrigatório.' });
  }
  const data = db.load();
  const clienteId = body.cliente_id ? Number(body.cliente_id) : null;
  if (clienteId && !tenant.buscar(data, 'clientes', clienteId, user.empresa_id)) {
    return enviarJSON(res, 400, { erro: 'Cliente não encontrado.' });
  }
  const leadId = body.lead_id ? Number(body.lead_id) : null;
  if (leadId && !tenant.buscar(data, 'leads', leadId, user.empresa_id)) {
    return enviarJSON(res, 400, { erro: 'Lead não encontrado.' });
  }
  const item = tenant.criar(data, 'oportunidades', user.empresa_id, {
    titulo: body.titulo.trim(),
    cliente_id: clienteId,
    lead_id: leadId,
    estagio: 'novo',
    valor_estimado: body.valor_estimado || '',
    descricao: body.descricao || '',
    observacoes: body.observacoes || '',
    origem: 'manual',
    devolutivo_id: null,
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { oportunidade: item });
});

// PUT /api/oportunidades/:id — edita dados ou move de estágio ("Mover para →" no funil)
rota('PUT', /^\/api\/oportunidades\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial editam oportunidades.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'oportunidades', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Oportunidade não encontrada.' });
  if (body.titulo !== undefined && !String(body.titulo).trim()) {
    return enviarJSON(res, 400, { erro: 'Título é obrigatório.' });
  }
  if (body.titulo !== undefined) item.titulo = body.titulo.trim();
  if (body.estagio !== undefined) {
    if (!ESTAGIOS_OPORTUNIDADE_VALIDOS.includes(body.estagio)) return enviarJSON(res, 400, { erro: 'Estágio inválido.' });
    item.estagio = body.estagio;
  }
  if (body.valor_estimado !== undefined) item.valor_estimado = body.valor_estimado || '';
  if (body.descricao !== undefined) item.descricao = body.descricao || '';
  if (body.observacoes !== undefined) item.observacoes = body.observacoes || '';
  db.save(data);
  enviarJSON(res, 200, { oportunidade: item });
});

const STATUS_PROPOSTA_VALIDOS = ['rascunho', 'enviada', 'aceita', 'recusada'];

function sanitizarItensProposta(itens) {
  if (!Array.isArray(itens)) return null;
  const limpos = [];
  for (const i of itens) {
    const descricao = String((i && i.descricao) || '').trim();
    const quantidade = Number(i && i.quantidade);
    const valorUnitario = Number(i && i.valor_unitario);
    if (!descricao || !Number.isFinite(quantidade) || quantidade <= 0 || !Number.isFinite(valorUnitario) || valorUnitario < 0) return null;
    limpos.push({ descricao, quantidade, valor_unitario: valorUnitario });
  }
  return limpos.length ? limpos : null;
}

function valorTotalProposta(itens) {
  return itens.reduce((soma, i) => soma + i.quantidade * i.valor_unitario, 0);
}

// GET /api/propostas?oportunidade_id= — propostas de uma oportunidade (tela abre a partir dela)
rota('GET', /^\/api\/propostas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial veem orçamentos.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'propostas', user.empresa_id);
  if (query.oportunidade_id) lista = lista.filter((p) => p.oportunidade_id === Number(query.oportunidade_id));
  enviarJSON(res, 200, { propostas: lista });
});

// POST /api/propostas — aberta a partir da tela da Oportunidade
rota('POST', /^\/api\/propostas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial cadastram orçamentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const oportunidadeId = Number(body.oportunidade_id);
  if (!oportunidadeId || !tenant.buscar(data, 'oportunidades', oportunidadeId, user.empresa_id)) {
    return enviarJSON(res, 400, { erro: 'Oportunidade não encontrada.' });
  }
  const itens = sanitizarItensProposta(body.itens);
  if (!itens) return enviarJSON(res, 400, { erro: 'Adicione ao menos um item com descrição, quantidade e valor unitário válidos.' });
  const item = tenant.criar(data, 'propostas', user.empresa_id, {
    oportunidade_id: oportunidadeId,
    itens,
    valor_total: valorTotalProposta(itens),
    validade: body.validade || '',
    // pedido do usuário: "gerador de orçamento profissional" — condições de pagamento/entrega/
    // garantia que entram no PDF junto do que foi orçado, texto livre.
    observacoes: body.observacoes || '',
    status: 'rascunho',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { proposta: item });
});

// PUT /api/propostas/:id — edita itens/validade/observações ou muda status (Enviar/Aceitar/Recusar)
rota('PUT', /^\/api\/propostas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'comercial'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou comercial editam orçamentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'propostas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Orçamento não encontrado.' });
  if (body.itens !== undefined) {
    const itens = sanitizarItensProposta(body.itens);
    if (!itens) return enviarJSON(res, 400, { erro: 'Adicione ao menos um item com descrição, quantidade e valor unitário válidos.' });
    item.itens = itens;
    item.valor_total = valorTotalProposta(itens);
  }
  if (body.validade !== undefined) item.validade = body.validade || '';
  if (body.observacoes !== undefined) item.observacoes = body.observacoes || '';
  if (body.status !== undefined) {
    if (!STATUS_PROPOSTA_VALIDOS.includes(body.status)) return enviarJSON(res, 400, { erro: 'Status inválido.' });
    item.status = body.status;
  }
  db.save(data);
  enviarJSON(res, 200, { proposta: item });
});

// GET /api/equipamentos
rota('GET', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let lista = tenant.listar(data, 'equipamentos', user.empresa_id);
  if (user.papel === 'cliente') lista = lista.filter((e) => e.cliente_id === user.cliente_id);
  // versão Restaurantes/rede multiunidade (Fase 1 — Base): gerente/coordenador/consultor só veem
  // os equipamentos das filiais do próprio escopo (ver escopo.js) — catálogo (sem filial_id nem
  // cliente_id) continua visível pra todo mundo com acesso a este módulo, igual já era.
  else if (['gerente_loja', 'coordenador_tecnico', 'consultor_mercado'].includes(user.papel)) {
    const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
    lista = lista.filter((e) => e.filial_id === null || filiaisIds.has(e.filial_id));
  }
  enviarJSON(res, 200, { equipamentos: lista });
});

// GET /api/equipamentos/por-qr/:token — página do equipamento aberta pelo QR Code (exige login;
// sem login, o front mostra só a tela de entrada — ver fluxo ?qr= no app.js). Mesmo escopo da
// listagem acima: quem não pode ver a filial deste equipamento recebe 404, não um erro de permissão
// que denuncie que o equipamento existe.
rota('GET', /^\/api\/equipamentos\/por-qr\/([a-f0-9]+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const equipamento = tenant.listar(data, 'equipamentos', user.empresa_id).find((e) => e.qr_token === m[1]);
  if (!equipamento) return enviarJSON(res, 404, { erro: 'Equipamento não encontrado.' });
  if (['gerente_loja', 'coordenador_tecnico', 'consultor_mercado'].includes(user.papel)) {
    const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
    if (equipamento.filial_id === null || !filiaisIds.has(equipamento.filial_id)) return enviarJSON(res, 404, { erro: 'Equipamento não encontrado.' });
  }
  // registro de presença (seção 5 do pedido do usuário): cada scan do técnico/gerente/coordenador
  // gera um registro simples de quem leu o QR e quando — não precisa de coleção própria: é um
  // array curto dentro do próprio equipamento, mais que suficiente pra "visto por último".
  if (!Array.isArray(equipamento.scans_qr)) equipamento.scans_qr = [];
  equipamento.scans_qr.push({ usuario_id: user.id, em: new Date().toISOString() });
  db.save(data);
  // O.S. e solicitações já abertas pra este equipamento vêm junto — o pedido do usuário é pra
  // mostrar isso ANTES de qualquer ação, pra evitar duplicidade (seção 5).
  const agendaAberta = tenant.listar(data, 'agenda', user.empresa_id).filter((a) => a.equipamento_id === equipamento.id && !a.finalizada);
  // versão Restaurantes/rede multiunidade (Fase 3 — Peças): solicitações de peça ainda não
  // instaladas pra este equipamento — linha do tempo de responsabilidade, seção 9.
  const solicitacoesAbertas = tenant.listar(data, 'solicitacoes_peca', user.empresa_id)
    .filter((s) => s.equipamento_id === equipamento.id && s.status !== 'instalado' && s.status !== 'nao_aprovado')
    .map((s) => solicitacaoComDetalhes(data, s));
  enviarJSON(res, 200, { equipamento, agenda_aberta: agendaAberta, solicitacoes_abertas: solicitacoesAbertas });
});

// GET /api/equipamentos/buscar-por-serie?numero_serie=XXX — usado pelo Relatório > Automático:
// a partir do nº de série lido na etiqueta, descobre se o equipamento já está atrelado a um
// cliente cadastrado, pra pré-preencher os dados no Termo de Manutenção Preventiva. Não expõe a
// lista de clientes inteira pro técnico — só os dados básicos do cliente deste equipamento.
rota('GET', /^\/api\/equipamentos\/buscar-por-serie$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const serie = String(query.numero_serie || '').trim().toLowerCase();
  if (!serie) return enviarJSON(res, 400, { erro: 'Informe o número de série.' });
  const data = db.load();
  const equipamento = tenant.listar(data, 'equipamentos', user.empresa_id).find((e) => e.numero_serie && e.numero_serie.trim().toLowerCase() === serie);
  if (!equipamento) return enviarJSON(res, 200, { equipamento: null, cliente: null });
  const cliente = equipamento.cliente_id ? data.clientes.find((c) => c.id === equipamento.cliente_id && c.empresa_id === user.empresa_id) : null;
  enviarJSON(res, 200, {
    equipamento: { id: equipamento.id, tipo: equipamento.tipo, modelo: equipamento.modelo, numero_serie: equipamento.numero_serie, data_fabricacao: equipamento.data_fabricacao },
    cliente: cliente ? {
      nome_empresa: cliente.nome_empresa, endereco: cliente.endereco, numero: cliente.numero,
      bairro: cliente.bairro, cidade: cliente.cidade, estado: cliente.estado, cep: cliente.cep, setor: cliente.setor,
      contato: cliente.contato, telefone: cliente.telefone,
    } : null,
  });
});

// POST /api/equipamentos — cadastra um tipo/modelo no catálogo (ainda sem cliente nem nº de série)
// cota de plano (Etapa 6/passo 3) — limite de equipamentos contratado pela empresa (catálogo +
// unidades atreladas, contadas juntas); null/sem campo = sem limite. Devolve a mensagem de erro
// (ou null se estiver dentro da cota) — os dois pontos de criação de equipamento chamam isso.
function erroLimiteEquipamentos(data, empresaId) {
  const empresa = data.empresas.find((e) => e.id === empresaId);
  const limite = empresa && empresa.limite_equipamentos;
  if (limite == null) return null;
  const jaTem = tenant.listar(data, 'equipamentos', empresaId).length;
  if (jaTem >= limite) return `Limite de equipamentos do plano atingido (${limite}). Fale com o suporte pra ampliar.`;
  return null;
}

rota('POST', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção cadastram equipamentos.' });
  const body = await lerCorpo(req);
  if (!body.tipo || !String(body.tipo).trim() || !body.modelo || !String(body.modelo).trim()) {
    return enviarJSON(res, 400, { erro: 'Tipo e modelo são obrigatórios.' });
  }
  const data = db.load();
  const erroLimite = erroLimiteEquipamentos(data, user.empresa_id);
  if (erroLimite) return enviarJSON(res, 400, { erro: erroLimite });
  const item = tenant.criar(data, 'equipamentos', user.empresa_id, {
    cliente_id: null, catalogo_id: null, // é o próprio catálogo — não referencia outro (RCM/FMEA, passo 2)
    tipo: body.tipo.trim(), modelo: body.modelo.trim(), numero_serie: '', data_fabricacao: '', localizacao: '',
    // versão Restaurantes/rede multiunidade (Fase 1 — Base): campos da unidade física atrelada a
    // uma filial (ver atrelar-filial abaixo) — null aqui porque isto ainda é só o catálogo, sem
    // unidade nenhuma. Têm que nascer com o campo (não só "undefined") pra uma comparação
    // === null/!== null em qualquer outro lugar do código classificar certo "isto é catálogo".
    filial_id: null, area_id: null, qr_token: null, codigo_interno: null,
    status_operacional: null, garantia_ate: null, fornecedor_assistencia: null,
  });
  db.save(data);
  enviarJSON(res, 201, { equipamento: item });
});

// PUT /api/equipamentos/:id — edita um item do catálogo (tipo/modelo) ou uma unidade já atrelada
// (número de série, data de fabricação, localização), conforme o equipamento já tenha cliente ou não
rota('PUT', /^\/api\/equipamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita equipamentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const equipamento = tenant.buscar(data, 'equipamentos', Number(m[1]), user.empresa_id);
  if (!equipamento) return enviarJSON(res, 404, { erro: 'Equipamento não encontrado.' });
  // catálogo (tipo/modelo, sem unidade física ainda) = sem cliente E sem filial. Unidade física
  // atrelada a uma filial (versão Restaurantes) também tem cliente_id null, então cliente_id só
  // decide "é catálogo" quando filial_id também é null — senão cairia no ramo errado.
  if (equipamento.cliente_id === null && equipamento.filial_id === null) {
    if (!body.tipo || !String(body.tipo).trim() || !body.modelo || !String(body.modelo).trim()) {
      return enviarJSON(res, 400, { erro: 'Tipo e modelo são obrigatórios.' });
    }
    equipamento.tipo = body.tipo.trim();
    equipamento.modelo = body.modelo.trim();
  } else {
    if (!body.numero_serie || !String(body.numero_serie).trim()) {
      return enviarJSON(res, 400, { erro: 'Número de série é obrigatório.' });
    }
    equipamento.numero_serie = body.numero_serie.trim();
    equipamento.data_fabricacao = body.data_fabricacao || '';
    equipamento.localizacao = body.localizacao || '';
    // admin sempre pode mudar aqui, mesmo já travado pelos outros 2 lugares (ver
    // aplicarContratoDoValor) — inclusive voltar pra null ("ainda não informado") de propósito.
    if (body.tem_contrato_manutencao === true || body.tem_contrato_manutencao === false || body.tem_contrato_manutencao === null) {
      equipamento.tem_contrato_manutencao = body.tem_contrato_manutencao;
    }
    // campos só da unidade atrelada a uma filial (versão Restaurantes/rede multiunidade, Fase 1)
    if (equipamento.filial_id !== null) {
      if (body.area_id !== undefined) {
        if (body.area_id) {
          const area = tenant.buscar(data, 'areas', Number(body.area_id), user.empresa_id);
          if (!area || area.filial_id !== equipamento.filial_id) return enviarJSON(res, 400, { erro: 'Área inválida para esta filial.' });
          equipamento.area_id = area.id;
        } else equipamento.area_id = null;
      }
      if (body.codigo_interno !== undefined) equipamento.codigo_interno = body.codigo_interno || null;
      if (STATUS_OPERACIONAL_VALIDOS.includes(body.status_operacional)) equipamento.status_operacional = body.status_operacional;
      if (body.garantia_ate !== undefined) equipamento.garantia_ate = body.garantia_ate || null;
      if (body.fornecedor_assistencia !== undefined) equipamento.fornecedor_assistencia = body.fornecedor_assistencia || '';
    }
  }
  db.save(data);
  enviarJSON(res, 200, { equipamento });
});
const STATUS_OPERACIONAL_VALIDOS = ['operando', 'restricao', 'parado'];

// DELETE /api/equipamentos/:id — bloqueado se houver O.S. vinculadas a este equipamento
rota('DELETE', /^\/api\/equipamentos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui equipamentos.' });
  const data = db.load();
  const id = Number(m[1]);
  const equipamento = tenant.buscar(data, 'equipamentos', id, user.empresa_id);
  if (!equipamento) return enviarJSON(res, 404, { erro: 'Equipamento não encontrado.' });
  if (tenant.listar(data, 'agenda', user.empresa_id).some((a) => a.equipamento_id === id)) return enviarJSON(res, 400, { erro: 'Existem ordens de serviço vinculadas a este equipamento. Exclua-as antes.' });
  data.equipamentos = data.equipamentos.filter((e) => e.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/equipamentos/:id/atrelar — vincula um equipamento do catálogo a um cliente,
// criando a unidade física de fato (com nº de série próprio)
rota('POST', /^\/api\/equipamentos\/(\d+)\/atrelar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção atrelam equipamentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const catalogo = tenant.buscar(data, 'equipamentos', Number(m[1]), user.empresa_id);
  if (!catalogo || catalogo.cliente_id !== null) return enviarJSON(res, 404, { erro: 'Equipamento do catálogo não encontrado.' });
  if (!body.cliente_id || !body.numero_serie || !String(body.numero_serie).trim()) {
    return enviarJSON(res, 400, { erro: 'Cliente e número de série são obrigatórios.' });
  }
  const cliente = tenant.buscar(data, 'clientes', Number(body.cliente_id), user.empresa_id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  const erroLimite = erroLimiteEquipamentos(data, user.empresa_id);
  if (erroLimite) return enviarJSON(res, 400, { erro: erroLimite });
  const item = tenant.criar(data, 'equipamentos', user.empresa_id, {
    cliente_id: cliente.id,
    catalogo_id: catalogo.id, // vínculo de verdade com o modelo de origem (RCM/FMEA, passo 2) — não
    // depende de casar tipo+modelo por texto, como as unidades atreladas antes deste campo existir
    tipo: catalogo.tipo,
    modelo: catalogo.modelo,
    numero_serie: body.numero_serie.trim(),
    data_fabricacao: body.data_fabricacao || '',
    localizacao: body.localizacao || '',
    tem_contrato_manutencao: body.tem_contrato_manutencao === true ? true : body.tem_contrato_manutencao === false ? false : null,
    // versão Restaurantes/rede multiunidade: esta unidade é atrelada a um CLIENTE, não a uma
    // filial — nasce explicitamente null (nunca "undefined"), ver comentário equivalente em
    // POST /api/equipamentos.
    filial_id: null, area_id: null, qr_token: null, codigo_interno: null,
    status_operacional: null, garantia_ate: null, fornecedor_assistencia: null,
  });
  db.save(data);
  enviarJSON(res, 201, { equipamento: item });
});

// POST /api/equipamentos/:id/atrelar-filial — versão Restaurantes/rede multiunidade (Fase 1 —
// Base): mesma ideia do /atrelar acima, mas pra uma FILIAL (loja) em vez de um cliente externo —
// cria a unidade física com nº de série próprio e já ganha QR Code (seção 5 do pedido do usuário).
rota('POST', /^\/api\/equipamentos\/(\d+)\/atrelar-filial$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao', 'gerente_loja'])) return enviarJSON(res, 403, { erro: 'Sem permissão pra atrelar equipamento a uma filial.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await lerCorpo(req);
  const catalogo = tenant.buscar(data, 'equipamentos', Number(m[1]), user.empresa_id);
  if (!catalogo || catalogo.cliente_id !== null || catalogo.filial_id !== null) return enviarJSON(res, 404, { erro: 'Equipamento do catálogo não encontrado.' });
  if (!body.filial_id || !body.numero_serie || !String(body.numero_serie).trim()) {
    return enviarJSON(res, 400, { erro: 'Filial e número de série são obrigatórios.' });
  }
  const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  if (user.papel === 'gerente_loja' && filial.id !== usuarioCompleto(data, user).filial_id) {
    return enviarJSON(res, 403, { erro: 'Você só pode atrelar equipamentos à sua própria filial.' });
  }
  let area = null;
  if (body.area_id) {
    area = tenant.buscar(data, 'areas', Number(body.area_id), user.empresa_id);
    if (!area || area.filial_id !== filial.id) return enviarJSON(res, 400, { erro: 'Área inválida para esta filial.' });
  }
  const erroLimite = erroLimiteEquipamentos(data, user.empresa_id);
  if (erroLimite) return enviarJSON(res, 400, { erro: erroLimite });
  const item = tenant.criar(data, 'equipamentos', user.empresa_id, {
    cliente_id: null, filial_id: filial.id, area_id: area ? area.id : null,
    catalogo_id: catalogo.id, tipo: catalogo.tipo, modelo: catalogo.modelo,
    numero_serie: body.numero_serie.trim(), data_fabricacao: body.data_fabricacao || '', localizacao: body.localizacao || '',
    codigo_interno: body.codigo_interno || null, status_operacional: 'operando',
    garantia_ate: body.garantia_ate || null, fornecedor_assistencia: body.fornecedor_assistencia || '',
    qr_token: db.gerarQrToken(), scans_qr: [],
  });
  db.save(data);
  enviarJSON(res, 201, { equipamento: item });
});

// ---------- VERSÃO RESTAURANTES/REDE MULTIUNIDADE — FASE 2 (OPERAÇÃO) ----------
// Vistoria guiada por área, O.S. com SLA configurável (prazo + pausa) e apoio técnico entre
// setores. Tudo abaixo só se aplica a O.S. com filial_id (criadas pelas rotas novas desta seção)
// — o fluxo de O.S. de cliente externo (POST/PUT /api/agenda já existentes) continua intocado.

const PAPEIS_OPERACAO_FILIAL = ['gerente_loja', 'coordenador_tecnico', 'consultor_mercado', 'suporte', 'administrador'];
const SLA_CRITICIDADES = ['critico', 'alto', 'medio', 'baixo'];
// prazos padrão em horas por criticidade (editável por empresa em PUT /api/empresa) — "Baixo" não
// tem prazo fixo (pedido do usuário: "Baixo — próxima preventiva"), fica null de propósito.
const SLA_PRAZOS_HORAS_PADRAO = { critico: 24, alto: 72, medio: 168 };
// etapas que PAUSAM a contagem do SLA (pedido do usuário, seção 7) — o prazo "estica" pelo tempo
// que a O.S. passou numa dessas três, em vez de continuar correndo sem ninguém poder agir.
const ETAPAS_PAUSAM_SLA = ['aguardando_peca', 'aguardando_autorizacao', 'aguardando_terceiro'];
// etapas que PUT /api/agenda/:id/etapa aceita direto — concluída/validada/reaberta têm rota
// própria (concluir-filial/validar-filial/reabrir-filial) porque exigem foto/descrição/motivo.
const ETAPAS_VIA_PUT = ['aberta', 'programada', 'em_execucao', ...ETAPAS_PAUSAM_SLA];

function calcularPrazoSla(empresa, criticidade, desdeIso) {
  if (criticidade === 'baixo') return null;
  const prazos = (empresa && empresa.sla_prazos_horas) || SLA_PRAZOS_HORAS_PADRAO;
  const horas = prazos[criticidade];
  if (!horas) return null;
  return new Date(new Date(desdeIso).getTime() + horas * 3600000).toISOString();
}

// aplica a pausa/retomada do SLA ao trocar de etapa (ver ETAPAS_PAUSAM_SLA acima) e registra no
// histórico — chamada por toda rota que muda `etapa`, nunca por atribuição direta do campo.
function aplicarMudancaEtapaFilial(item, novaEtapa, userId) {
  const etapaAnterior = item.etapa;
  const estavaPausado = ETAPAS_PAUSAM_SLA.includes(etapaAnterior);
  const vaiPausar = ETAPAS_PAUSAM_SLA.includes(novaEtapa);
  const agora = new Date().toISOString();
  if (!estavaPausado && vaiPausar) {
    item.sla_pausas.push({ motivo: novaEtapa, pausado_em: agora, retomado_em: null });
  } else if (estavaPausado && !vaiPausar) {
    const pausaAberta = [...item.sla_pausas].reverse().find((p) => !p.retomado_em);
    if (pausaAberta) {
      pausaAberta.retomado_em = agora;
      if (item.sla_prazo_em) {
        const duracaoMs = new Date(agora).getTime() - new Date(pausaAberta.pausado_em).getTime();
        item.sla_prazo_em = new Date(new Date(item.sla_prazo_em).getTime() + duracaoMs).toISOString();
      }
    }
  }
  item.etapa = novaEtapa;
  item.etapa_historico.push({ de: etapaAnterior, para: novaEtapa, por: userId, em: agora });
}

// uma filial está no escopo de acesso do usuário? (reaproveita escopo.js — grupo/tecnico veem
// todas, setor/filial são filtrados)
function filialAcessivel(data, user, filial) {
  return escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).some((f) => f.id === filial.id);
}

// o técnico (papel suporte) não tem setor_id próprio (ver validarReferenciasEstruturaFiliais —
// só filial_id, opcional, é a loja base dele) — o setor dele é o da própria filial. Usado pra
// decidir se um técnico "pertence" ao setor de destino de um apoio/redesignação.
function setorDoTecnico(data, empresaId, tecnico) {
  if (!tecnico || !tecnico.filial_id) return null;
  const filial = tenant.buscar(data, 'filiais', tecnico.filial_id, empresaId);
  return filial ? filial.setor_id : null;
}

// já existe O.S. (de filial) aberta pra este equipamento? — aviso de duplicidade (seção 6 do
// pedido do usuário), nunca bloqueia, só avisa.
function osFilialAbertaParaEquipamento(data, empresaId, equipamentoId) {
  if (!equipamentoId) return null;
  return tenant.listar(data, 'agenda', empresaId).find((a) => (
    a.equipamento_id === equipamentoId && a.filial_id !== null && !['concluida', 'validada'].includes(a.etapa)
  ));
}

// cria a O.S. (agenda) de uma filial — usado tanto pela criação direta (POST /api/agenda/filial)
// quanto pela conclusão de vistoria (POST /api/vistorias/:id/concluir). Espelha os campos
// "sempre presentes" da O.S. de cliente externo (ver POST /api/agenda) com valores neutros, pra
// não deixar nenhum campo undefined que o resto do código (agendaComDetalhes, PDFs, dashboards)
// não espera — e adiciona os campos próprios da versão Restaurantes no final.
function criarOsFilial(data, user, { filial, area_id, equipamento_id, problema, sla_criticidade, origem_vistoria_id }) {
  const empresaAtual = data.empresas.find((e) => e.id === user.empresa_id);
  const agora = new Date().toISOString();
  const criticidade = SLA_CRITICIDADES.includes(sla_criticidade) ? sla_criticidade : 'medio';
  const item = tenant.criar(data, 'agenda', user.empresa_id, {
    numero_os: null, criado_por: user.id,
    tecnico_id: filial.tecnico_id || null, cliente_id: null, equipamento_id: equipamento_id || null,
    cliente_nome_manual: '', equipamento_manual: '',
    data_hora_inicio: agora, data_hora_fim: agora,
    tipo: 'corretiva', categoria: categoriaDoTipo('corretiva'),
    problema: problema || '',
    contato: '', telefone: '', email: '', setor_cliente: '',
    endereco: '', numero: '', bairro: '', cep: '', cidade: '', estado: '',
    garantia: '', garantia_obs: '',
    sla_nivel: null, sla_pontuacao: null, sla_horas_atendimento: null, sla_dias_manutencao: null, sla_dias_visita_tecnica: null,
    status: 'pendente', valor_servico: null, retrabalho: false, criado_em: agora, lida_tecnico: false,
    deslocamento_iniciado_em: null, chegada_confirmada_em: null, confirmado_cliente_em: null, feedback_cliente_em: null,
    orcamento_aprovado_em: null, orcamento_reprovado_em: null,
    retorno_pendente_tecnico: false, retorno_confirmado_cliente_em: null, retorno_deslocamento_iniciado_em: null, retorno_chegada_confirmada_em: null,
    viagem_volta_iniciada_em: null, viagem_volta_chegada_em: null, viagem_volta_destino_agenda_id: null,
    bonus_viagem: false, viagem_dia_inicio: '', viagem_dia_fim_previsto: '', justificativa_limite_viagens: '', fora_de_ordem_viagem: false,
    escala_conflito_tipo: null, justificativa_escala_conflito: '',
    // campos próprios da versão Restaurantes/rede multiunidade (Fase 2 — Operação)
    filial_id: filial.id, area_id: area_id || null, origem_vistoria_id: origem_vistoria_id || null,
    etapa: 'aberta', etapa_historico: [{ de: null, para: 'aberta', por: user.id, em: agora }],
    sla_criticidade: criticidade, sla_prazo_em: calcularPrazoSla(empresaAtual, criticidade, agora),
    sla_pausas: [], sla_historico: [{ de: null, para: criticidade, por: user.id, em: agora }],
    apoio_id: null,
    concluido_em: null, concluido_por: null, descricao_conclusao: '', fotos_conclusao: [],
    validado_em: null, validado_por: null, motivo_reabertura: null,
  });
  item.numero_os = `OS-${String(item.id).padStart(6, '0')}`;
  return item;
}

// POST /api/agenda/filial — abre uma O.S. direto (sem passar por vistoria), pra qualquer papel da
// operação (técnico em qualquer loja, gerente/coordenador/consultor no próprio escopo).
rota('POST', /^\/api\/agenda\/filial$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão pra abrir O.S. de filial.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await lerCorpo(req);
  if (!body.filial_id || !body.problema || !String(body.problema).trim()) {
    return enviarJSON(res, 400, { erro: 'Filial e descrição do problema são obrigatórios.' });
  }
  const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  if (!filialAcessivel(data, user, filial)) return enviarJSON(res, 403, { erro: 'Você não tem acesso a esta filial.' });
  let area = null;
  if (body.area_id) {
    area = tenant.buscar(data, 'areas', Number(body.area_id), user.empresa_id);
    if (!area || area.filial_id !== filial.id) return enviarJSON(res, 400, { erro: 'Área inválida para esta filial.' });
  }
  let equipamento = null;
  if (body.equipamento_id) {
    equipamento = tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
    if (!equipamento || equipamento.filial_id !== filial.id) return enviarJSON(res, 400, { erro: 'Equipamento inválido para esta filial.' });
  }
  const duplicidade = osFilialAbertaParaEquipamento(data, user.empresa_id, equipamento ? equipamento.id : null);
  const item = criarOsFilial(data, user, {
    filial, area_id: area ? area.id : null, equipamento_id: equipamento ? equipamento.id : null,
    problema: body.problema.trim(), sla_criticidade: body.sla_criticidade,
  });
  db.save(data);
  if (item.tecnico_id) {
    enviarPush(data, item.tecnico_id, { titulo: 'Nova O.S. na sua loja', corpo: `${filial.nome} — ${item.problema}`, url: '/' }).catch(() => {});
  }
  enviarJSON(res, 201, { agenda: agendaComDetalhes(data, item), aviso_duplicidade: duplicidade ? { agenda_id: duplicidade.id, numero_os: duplicidade.numero_os } : null });
});

// PUT /api/agenda/:id/etapa { etapa } — avança/retrocede o fluxo (ver ETAPAS_VIA_PUT); concluir,
// validar e reabrir têm rota própria (exigem foto/descrição/motivo).
rota('PUT', /^\/api\/agenda\/(\d+)\/etapa$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const completo = usuarioCompleto(data, user);
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  const podeAgir = user.papel === 'administrador'
    || (user.papel === 'suporte' && item.tecnico_id === user.id)
    || (user.papel === 'gerente_loja' && completo.filial_id === item.filial_id)
    || (user.papel === 'coordenador_tecnico' && filial && completo.setor_id === filial.setor_id);
  if (!podeAgir) return enviarJSON(res, 403, { erro: 'Você não pode alterar esta O.S.' });
  const body = await lerCorpo(req);
  if (!ETAPAS_VIA_PUT.includes(body.etapa)) return enviarJSON(res, 400, { erro: 'Etapa inválida.' });
  aplicarMudancaEtapaFilial(item, body.etapa, user.id);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// PUT /api/agenda/:id/sla-criticidade { sla_criticidade } — quem abriu sugere o nível; só o
// coordenador técnico do setor (ou administrador) pode alterar depois, com registro (pedido do
// usuário, seção 7).
rota('PUT', /^\/api\/agenda\/(\d+)\/sla-criticidade$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o coordenador técnico do setor altera a criticidade do SLA.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  if (user.papel === 'coordenador_tecnico' && (!filial || usuarioCompleto(data, user).setor_id !== filial.setor_id)) {
    return enviarJSON(res, 403, { erro: 'Esta O.S. não é do seu setor.' });
  }
  const body = await lerCorpo(req);
  if (!SLA_CRITICIDADES.includes(body.sla_criticidade)) return enviarJSON(res, 400, { erro: 'Criticidade inválida.' });
  const agora = new Date().toISOString();
  const empresaAtual = data.empresas.find((e) => e.id === user.empresa_id);
  item.sla_historico.push({ de: item.sla_criticidade, para: body.sla_criticidade, por: user.id, em: agora });
  item.sla_criticidade = body.sla_criticidade;
  item.sla_prazo_em = calcularPrazoSla(empresaAtual, body.sla_criticidade, agora);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/concluir-filial { descricao, fotos } — técnico conclui (exige foto "depois"
// + descrição, pedido do usuário seção 7).
rota('POST', /^\/api\/agenda\/(\d+)\/concluir-filial$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico responsável conclui esta O.S.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  if (user.papel === 'suporte' && item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta O.S. não é sua.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.descricao || !String(body.descricao).trim()) return enviarJSON(res, 400, { erro: 'Descreva o serviço realizado.' });
  if (!Array.isArray(body.fotos) || !body.fotos.length) return enviarJSON(res, 400, { erro: 'Envie ao menos uma foto do "depois".' });
  aplicarMudancaEtapaFilial(item, 'concluida', user.id);
  item.descricao_conclusao = body.descricao.trim();
  item.fotos_conclusao = body.fotos;
  item.concluido_em = new Date().toISOString();
  item.concluido_por = user.id;
  db.save(data);
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  if (filial && filial.gerente_id) {
    enviarPush(data, filial.gerente_id, { titulo: 'O.S. concluída — validar', corpo: `${item.numero_os} em ${filial.nome}.`, url: '/' }).catch(() => {});
  }
  enviarJSON(res, 200, { agenda: { ...agendaComDetalhes(data, item), fotos_conclusao: await hidratarFotosProfundo(item.fotos_conclusao) } });
});

// POST /api/agenda/:id/validar-filial — gerente da loja (ou quem abriu) valida a conclusão.
rota('POST', /^\/api\/agenda\/(\d+)\/validar-filial$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  const completo = usuarioCompleto(data, user);
  const podeValidar = user.papel === 'administrador' || item.criado_por === user.id
    || (user.papel === 'gerente_loja' && completo.filial_id === item.filial_id)
    || (user.papel === 'coordenador_tecnico' && filial && completo.setor_id === filial.setor_id);
  if (!podeValidar) return enviarJSON(res, 403, { erro: 'Você não pode validar esta O.S.' });
  if (item.etapa !== 'concluida') return enviarJSON(res, 400, { erro: 'Esta O.S. ainda não foi concluída pelo técnico.' });
  aplicarMudancaEtapaFilial(item, 'validada', user.id);
  item.validado_em = new Date().toISOString();
  item.validado_por = user.id;
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/reabrir-filial { motivo } — gerente/coordenador/quem abriu recusa a
// conclusão e devolve pro técnico.
rota('POST', /^\/api\/agenda\/(\d+)\/reabrir-filial$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  const completo = usuarioCompleto(data, user);
  const podeReabrir = user.papel === 'administrador' || item.criado_por === user.id
    || (user.papel === 'gerente_loja' && completo.filial_id === item.filial_id)
    || (user.papel === 'coordenador_tecnico' && filial && completo.setor_id === filial.setor_id);
  if (!podeReabrir) return enviarJSON(res, 403, { erro: 'Você não pode reabrir esta O.S.' });
  if (item.etapa !== 'concluida') return enviarJSON(res, 400, { erro: 'Só dá pra reabrir uma O.S. que já foi concluída pelo técnico.' });
  const body = await lerCorpo(req);
  if (!body.motivo || !String(body.motivo).trim()) return enviarJSON(res, 400, { erro: 'Informe o motivo da reabertura.' });
  aplicarMudancaEtapaFilial(item, 'reaberta', user.id);
  item.motivo_reabertura = body.motivo.trim();
  db.save(data);
  if (item.tecnico_id) enviarPush(data, item.tecnico_id, { titulo: 'O.S. reaberta', corpo: `${item.numero_os}: ${item.motivo_reabertura}`, url: '/' }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// GET /api/filiais/descobertas?data=AAAA-MM-DD — lojas do escopo do usuário cujo técnico fixo
// está de folga/férias nesse dia, com as O.S. críticas/altas em aberto nelas (pedido do usuário,
// seção 4: "o sistema mostra lojas descobertas em cada dia").
rota('GET', /^\/api\/filiais\/descobertas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'consultor_mercado', 'administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const diaISO = query.data || hojeBrasiliaISO();
  const data = db.load();
  const filiais = escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user));
  const descobertas = filiais
    .filter((f) => f.tecnico_id && diaTemFolgaTecnico(data, user.empresa_id, f.tecnico_id, diaISO))
    .map((f) => ({
      filial: f,
      os_abertas: tenant.listar(data, 'agenda', user.empresa_id).filter((a) => (
        a.filial_id === f.id && !['concluida', 'validada'].includes(a.etapa) && ['critico', 'alto'].includes(a.sla_criticidade)
      )).map((a) => agendaComDetalhes(data, a)),
    }));
  enviarJSON(res, 200, { descobertas });
});

// ---------- apoio técnico entre setores (pedido do usuário, seção 7) ----------
// POST /api/apoios { agenda_id, setor_destino_id, motivo } — coordenador do setor de origem pede
// apoio de técnico de outro setor pra uma O.S. específica.
rota('POST', /^\/api\/apoios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o coordenador técnico pede apoio entre setores.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await lerCorpo(req);
  const item = tenant.buscar(data, 'agenda', Number(body.agenda_id), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const filialOrigem = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  if (!filialOrigem) return enviarJSON(res, 404, { erro: 'Filial da O.S. não encontrada.' });
  const completo = usuarioCompleto(data, user);
  if (user.papel === 'coordenador_tecnico' && completo.setor_id !== filialOrigem.setor_id) {
    return enviarJSON(res, 403, { erro: 'Esta O.S. não é do seu setor.' });
  }
  const setorDestino = tenant.buscar(data, 'setores', Number(body.setor_destino_id), user.empresa_id);
  if (!setorDestino) return enviarJSON(res, 404, { erro: 'Setor de destino não encontrado.' });
  if (setorDestino.id === filialOrigem.setor_id) return enviarJSON(res, 400, { erro: 'Escolha um setor diferente do da própria O.S.' });
  const apoio = tenant.criar(data, 'apoios', user.empresa_id, {
    agenda_id: item.id, setor_origem_id: filialOrigem.setor_id, setor_destino_id: setorDestino.id,
    tecnico_designado_id: null, status: 'pedido', motivo: body.motivo || '',
    criado_por: user.id, criado_em: new Date().toISOString(), decidido_em: null,
  });
  item.apoio_id = apoio.id;
  db.save(data);
  if (setorDestino.coordenador_id) {
    enviarPush(data, setorDestino.coordenador_id, { titulo: 'Pedido de apoio entre setores', corpo: `${item.numero_os} — ${filialOrigem.nome} precisa de apoio.`, url: '/' }).catch(() => {});
  }
  enviarJSON(res, 201, { apoio });
});

// GET /api/apoios?agenda_id= — lista pedidos de apoio (do setor do coordenador, como origem ou
// destino; administrador vê todos).
rota('GET', /^\/api\/apoios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'apoios', user.empresa_id);
  if (query.agenda_id) lista = lista.filter((a) => a.agenda_id === Number(query.agenda_id));
  if (user.papel === 'coordenador_tecnico') {
    const setorId = usuarioCompleto(data, user).setor_id;
    lista = lista.filter((a) => a.setor_origem_id === setorId || a.setor_destino_id === setorId);
  }
  enviarJSON(res, 200, { apoios: lista });
});

// PUT /api/apoios/:id/aceitar { tecnico_id } — coordenador do setor de DESTINO aceita e designa
// um técnico do próprio setor.
rota('PUT', /^\/api\/apoios\/(\d+)\/aceitar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o coordenador técnico do setor de destino aceita o apoio.' });
  const data = db.load();
  const apoio = tenant.buscar(data, 'apoios', Number(m[1]), user.empresa_id);
  if (!apoio) return enviarJSON(res, 404, { erro: 'Pedido de apoio não encontrado.' });
  if (apoio.status !== 'pedido') return enviarJSON(res, 400, { erro: 'Este pedido já foi decidido.' });
  if (user.papel === 'coordenador_tecnico' && usuarioCompleto(data, user).setor_id !== apoio.setor_destino_id) {
    return enviarJSON(res, 403, { erro: 'Só o coordenador do setor de destino decide este pedido.' });
  }
  const body = await lerCorpo(req);
  const tecnico = tenant.buscar(data, 'usuarios', Number(body.tecnico_id), user.empresa_id);
  if (!tecnico || tecnico.papel !== 'suporte' || setorDoTecnico(data, user.empresa_id, tecnico) !== apoio.setor_destino_id) {
    return enviarJSON(res, 400, { erro: 'Escolha um técnico do seu próprio setor.' });
  }
  const item = tenant.buscar(data, 'agenda', apoio.agenda_id, user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'O.S. da O.S. de apoio não encontrada.' });
  apoio.status = 'aceito';
  apoio.tecnico_designado_id = tecnico.id;
  apoio.decidido_em = new Date().toISOString();
  item.tecnico_id = tecnico.id;
  db.save(data);
  enviarPush(data, tecnico.id, { titulo: 'Você foi designado em apoio a outra loja', corpo: item.numero_os, url: '/' }).catch(() => {});
  enviarJSON(res, 200, { apoio, agenda: agendaComDetalhes(data, item) });
});

// PUT /api/apoios/:id/recusar
rota('PUT', /^\/api\/apoios\/(\d+)\/recusar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o coordenador técnico do setor de destino decide este pedido.' });
  const data = db.load();
  const apoio = tenant.buscar(data, 'apoios', Number(m[1]), user.empresa_id);
  if (!apoio) return enviarJSON(res, 404, { erro: 'Pedido de apoio não encontrado.' });
  if (apoio.status !== 'pedido') return enviarJSON(res, 400, { erro: 'Este pedido já foi decidido.' });
  if (user.papel === 'coordenador_tecnico' && usuarioCompleto(data, user).setor_id !== apoio.setor_destino_id) {
    return enviarJSON(res, 403, { erro: 'Só o coordenador do setor de destino decide este pedido.' });
  }
  apoio.status = 'recusado';
  apoio.decidido_em = new Date().toISOString();
  const item = tenant.buscar(data, 'agenda', apoio.agenda_id, user.empresa_id);
  if (item) item.apoio_id = null;
  db.save(data);
  enviarJSON(res, 200, { apoio });
});

// PUT /api/agenda/:id/designar-tecnico { tecnico_id } — coordenador redesigna, sem apoio externo,
// outro técnico do PRÓPRIO setor pra uma O.S. (ex.: técnico fixo de folga, mas tem outro disponível).
rota('PUT', /^\/api\/agenda\/(\d+)\/designar-tecnico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o coordenador técnico do setor redesigna o técnico.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item || item.filial_id === null) return enviarJSON(res, 404, { erro: 'O.S. de filial não encontrada.' });
  const filial = tenant.buscar(data, 'filiais', item.filial_id, user.empresa_id);
  if (user.papel === 'coordenador_tecnico' && (!filial || usuarioCompleto(data, user).setor_id !== filial.setor_id)) {
    return enviarJSON(res, 403, { erro: 'Esta O.S. não é do seu setor.' });
  }
  const body = await lerCorpo(req);
  const tecnico = tenant.buscar(data, 'usuarios', Number(body.tecnico_id), user.empresa_id);
  if (!tecnico || tecnico.papel !== 'suporte' || (filial && setorDoTecnico(data, user.empresa_id, tecnico) !== filial.setor_id)) {
    return enviarJSON(res, 400, { erro: 'Escolha um técnico do mesmo setor da loja.' });
  }
  item.tecnico_id = tecnico.id;
  db.save(data);
  enviarPush(data, tecnico.id, { titulo: 'Você foi designado nesta O.S.', corpo: item.numero_os, url: '/' }).catch(() => {});
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// ---------- vistoria guiada por área (pedido do usuário, seção 6) ----------
// POST /api/vistorias { filial_id } — abre uma vistoria (cabeçalho); os itens entram depois.
rota('POST', /^\/api\/vistorias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão pra fazer vistoria.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await lerCorpo(req);
  const filial = tenant.buscar(data, 'filiais', Number(body.filial_id), user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  if (!filialAcessivel(data, user, filial)) return enviarJSON(res, 403, { erro: 'Você não tem acesso a esta filial.' });
  const vistoria = tenant.criar(data, 'vistorias', user.empresa_id, {
    filial_id: filial.id, autor_id: user.id, criado_em: new Date().toISOString(), status: 'em_andamento',
  });
  db.save(data);
  enviarJSON(res, 201, { vistoria });
});

// GET /api/vistorias?filial_id= — lista (escopo igual ao de filiais)
rota('GET', /^\/api\/vistorias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso a vistorias.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
  let lista = tenant.listar(data, 'vistorias', user.empresa_id).filter((v) => filiaisIds.has(v.filial_id));
  if (query.filial_id) lista = lista.filter((v) => v.filial_id === Number(query.filial_id));
  enviarJSON(res, 200, { vistorias: lista });
});

// GET /api/vistorias/:id — com os itens já lançados
rota('GET', /^\/api\/vistorias\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso a vistorias.' });
  const data = db.load();
  const vistoria = tenant.buscar(data, 'vistorias', Number(m[1]), user.empresa_id);
  if (!vistoria) return enviarJSON(res, 404, { erro: 'Vistoria não encontrada.' });
  const filial = tenant.buscar(data, 'filiais', vistoria.filial_id, user.empresa_id);
  if (!filial || !filialAcessivel(data, user, filial)) return enviarJSON(res, 404, { erro: 'Vistoria não encontrada.' });
  const itens = tenant.listar(data, 'vistoria_itens', user.empresa_id).filter((i) => i.vistoria_id === vistoria.id);
  const itensComFotos = await Promise.all(itens.map(async (i) => ({ ...i, fotos: await hidratarFotosProfundo(i.fotos) })));
  enviarJSON(res, 200, { vistoria, itens: itensComFotos });
});

// POST /api/vistorias/:id/itens { area_id, equipamento_id?, descricao, fotos?, sla_sugerido } —
// cada pendência encontrada numa área, com aviso (não bloqueio) se já existe O.S. aberta pro
// mesmo equipamento.
rota('POST', /^\/api\/vistorias\/(\d+)\/itens$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const vistoria = tenant.buscar(data, 'vistorias', Number(m[1]), user.empresa_id);
  if (!vistoria) return enviarJSON(res, 404, { erro: 'Vistoria não encontrada.' });
  if (vistoria.status !== 'em_andamento') return enviarJSON(res, 400, { erro: 'Esta vistoria já foi concluída.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const area = tenant.buscar(data, 'areas', Number(body.area_id), user.empresa_id);
  if (!area || area.filial_id !== vistoria.filial_id) return enviarJSON(res, 400, { erro: 'Área inválida para esta filial.' });
  if (!body.descricao || !String(body.descricao).trim()) return enviarJSON(res, 400, { erro: 'Descreva a pendência encontrada.' });
  let equipamento = null;
  if (body.equipamento_id) {
    equipamento = tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
    if (!equipamento || equipamento.filial_id !== vistoria.filial_id) return enviarJSON(res, 400, { erro: 'Equipamento inválido para esta filial.' });
  }
  const duplicidade = osFilialAbertaParaEquipamento(data, user.empresa_id, equipamento ? equipamento.id : null);
  const item = tenant.criar(data, 'vistoria_itens', user.empresa_id, {
    vistoria_id: vistoria.id, area_id: area.id, equipamento_id: equipamento ? equipamento.id : null,
    descricao: body.descricao.trim(), fotos: Array.isArray(body.fotos) ? body.fotos : [],
    sla_sugerido: SLA_CRITICIDADES.includes(body.sla_sugerido) ? body.sla_sugerido : 'medio',
    agenda_id: null,
  });
  db.save(data);
  enviarJSON(res, 201, { item: { ...item, fotos: await hidratarFotosProfundo(item.fotos) }, aviso_duplicidade: duplicidade ? { agenda_id: duplicidade.id, numero_os: duplicidade.numero_os } : null });
});

// POST /api/vistorias/:id/concluir — cada pendência sem O.S. ainda virar uma O.S. individual pro
// técnico da loja (pedido do usuário, seção 6).
rota('POST', /^\/api\/vistorias\/(\d+)\/concluir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const vistoria = tenant.buscar(data, 'vistorias', Number(m[1]), user.empresa_id);
  if (!vistoria) return enviarJSON(res, 404, { erro: 'Vistoria não encontrada.' });
  if (vistoria.status !== 'em_andamento') return enviarJSON(res, 400, { erro: 'Esta vistoria já foi concluída.' });
  const filial = tenant.buscar(data, 'filiais', vistoria.filial_id, user.empresa_id);
  if (!filial) return enviarJSON(res, 404, { erro: 'Filial não encontrada.' });
  const itens = tenant.listar(data, 'vistoria_itens', user.empresa_id).filter((i) => i.vistoria_id === vistoria.id);
  const criadas = [];
  for (const item of itens) {
    if (item.agenda_id) continue;
    const os = criarOsFilial(data, user, {
      filial, area_id: item.area_id, equipamento_id: item.equipamento_id,
      problema: item.descricao, sla_criticidade: item.sla_sugerido, origem_vistoria_id: vistoria.id,
    });
    item.agenda_id = os.id;
    criadas.push(os);
  }
  vistoria.status = 'concluida';
  vistoria.concluido_em = new Date().toISOString();
  db.save(data);
  for (const os of criadas) {
    if (os.tecnico_id) enviarPush(data, os.tecnico_id, { titulo: 'Nova O.S. — vistoria', corpo: `${filial.nome}: ${os.problema}`, url: '/' }).catch(() => {});
  }
  enviarJSON(res, 200, { vistoria, criadas: criadas.map((os) => agendaComDetalhes(data, os)) });
});

// ---------- VERSÃO RESTAURANTES/REDE MULTIUNIDADE — FASE 3 (PEÇAS) ----------
// Catálogo de peças compartilhado entre filiais + solicitação de peça com "ciente", cadeia de
// autorização por valor (gerente/coordenador -> consultor -> diretoria) e linha do tempo de
// responsabilidade. Só se aplica a equipamentos com filial_id (versão Restaurantes) — não toca em
// nada do fluxo de cliente externo.

const LIMITES_APROVACAO_PADRAO = { limite1: 200, limite2: 1000 };
function limitesAprovacao(empresa) {
  return {
    limite1: empresa && empresa.limite_aprovacao_1 != null ? empresa.limite_aprovacao_1 : LIMITES_APROVACAO_PADRAO.limite1,
    limite2: empresa && empresa.limite_aprovacao_2 != null ? empresa.limite_aprovacao_2 : LIMITES_APROVACAO_PADRAO.limite2,
  };
}
const PRIORIDADES_SOLICITACAO_PECA = ['urgente', 'nao_urgente'];
const STATUS_SOLICITACAO_PECA = ['pendente', 'ciente', 'orcando', 'aguardando_consultor', 'aguardando_diretoria', 'aprovado', 'nao_aprovado', 'comprado', 'peca_na_loja', 'instalado'];
// pra quem está a pendência AGORA (seção 9 — "linha do tempo de responsabilidade"/lembretes) —
// puramente informativo, não é checagem de permissão (essa é feita rota a rota).
const RESPONSAVEL_POR_STATUS = {
  pendente: 'Gerente da loja / Coordenador técnico (dar ciente)',
  ciente: 'Gerente da loja / Coordenador técnico (orçar)',
  orcando: 'Gerente da loja / Coordenador técnico (decidir ou pedir autorização)',
  aguardando_consultor: 'Consultor de mercado do setor',
  aguardando_diretoria: 'Diretoria',
  aprovado: 'Gerente da loja / Coordenador técnico (comprar)',
  nao_aprovado: null,
  comprado: 'Gerente da loja / técnico (confirmar chegada na loja)',
  peca_na_loja: 'Técnico da loja (instalar)',
  instalado: null,
};
function registrarHistoricoSolicitacao(solicitacao, de, para, userId, observacao) {
  solicitacao.historico.push({ de, para, por: userId, em: new Date().toISOString(), observacao: observacao || '' });
  solicitacao.status = para;
}
function diasParadoSolicitacao(solicitacao) {
  if (['nao_aprovado', 'instalado'].includes(solicitacao.status)) return 0;
  const ultima = solicitacao.historico[solicitacao.historico.length - 1];
  const desde = ultima ? ultima.em : solicitacao.criado_em;
  return Math.floor((Date.now() - new Date(desde).getTime()) / 86400000);
}
// atrasada = parada no status atual mais tempo do que o prazo de lembrete (menor pra urgente).
function solicitacaoAtrasada(solicitacao) {
  if (['nao_aprovado', 'instalado'].includes(solicitacao.status)) return false;
  const limite = solicitacao.prioridade === 'urgente' ? 1 : 3;
  return diasParadoSolicitacao(solicitacao) > limite;
}
function solicitacaoComDetalhes(data, s) {
  const equipamento = data.equipamentos.find((e) => e.id === s.equipamento_id && e.empresa_id === s.empresa_id);
  const filial = data.filiais.find((f) => f.id === s.filial_id && f.empresa_id === s.empresa_id);
  const area = s.area_id ? data.areas.find((a) => a.id === s.area_id && a.empresa_id === s.empresa_id) : null;
  const nomeUsuario = (id) => id ? ((data.usuarios.find((u) => u.id === id && u.empresa_id === s.empresa_id) || {}).nome || null) : null;
  return {
    ...s,
    equipamento_tipo: equipamento ? equipamento.tipo : null, equipamento_modelo: equipamento ? equipamento.modelo : null,
    filial_nome: filial ? filial.nome : null, area_nome: area ? area.nome : null,
    solicitante_nome: nomeUsuario(s.solicitante_id),
    responsavel_atual: RESPONSAVEL_POR_STATUS[s.status] || null,
    dias_parado: diasParadoSolicitacao(s), atrasada: solicitacaoAtrasada(s),
  };
}

// escopo de quem pode AGIR numa solicitação, dentro da sua filial/setor (ver escopo.js) — usado
// por toda rota que o gerente/coordenador/consultor chama sobre uma solicitação específica.
function solicitacaoNoEscopo(data, user, s) {
  if (['administrador', 'supervisor', 'suporte'].includes(user.papel)) return true;
  const completo = usuarioCompleto(data, user);
  if (user.papel === 'gerente_loja') return completo.filial_id === s.filial_id;
  if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') {
    const filial = data.filiais.find((f) => f.id === s.filial_id && f.empresa_id === s.empresa_id);
    return !!filial && completo.setor_id === filial.setor_id;
  }
  return false;
}

// ---- catálogo de peças (compartilhado entre filiais) ----
// GET /api/pecas-catalogo?busca= — autocompletar ao digitar (pedido do usuário, seção 9)
rota('GET', /^\/api\/pecas-catalogo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso ao catálogo de peças.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'pecas_catalogo', user.empresa_id);
  if (query.busca) {
    const termo = String(query.busca).trim().toLowerCase();
    lista = lista.filter((p) => p.codigo.toLowerCase().includes(termo) || p.descricao.toLowerCase().includes(termo));
  }
  enviarJSON(res, 200, { pecas: lista });
});

rota('POST', /^\/api\/pecas-catalogo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'coordenador_tecnico'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou coordenador técnico cadastram peças no catálogo.' });
  const data = db.load();
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.codigo || !String(body.codigo).trim() || !body.descricao || !String(body.descricao).trim()) {
    return enviarJSON(res, 400, { erro: 'Código e descrição são obrigatórios.' });
  }
  const peca = tenant.criar(data, 'pecas_catalogo', user.empresa_id, {
    codigo: body.codigo.trim(), descricao: body.descricao.trim(), foto: body.foto || null,
    fornecedor: body.fornecedor || '', ultimo_preco: body.ultimo_preco != null && body.ultimo_preco !== '' ? Number(body.ultimo_preco) : null,
  });
  db.save(data);
  enviarJSON(res, 201, { peca });
});

rota('PUT', /^\/api\/pecas-catalogo\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'coordenador_tecnico'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou coordenador técnico editam o catálogo.' });
  const data = db.load();
  const peca = tenant.buscar(data, 'pecas_catalogo', Number(m[1]), user.empresa_id);
  if (!peca) return enviarJSON(res, 404, { erro: 'Peça não encontrada.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.codigo || !String(body.codigo).trim() || !body.descricao || !String(body.descricao).trim()) {
    return enviarJSON(res, 400, { erro: 'Código e descrição são obrigatórios.' });
  }
  peca.codigo = body.codigo.trim(); peca.descricao = body.descricao.trim();
  if (body.foto !== undefined) peca.foto = body.foto || null;
  peca.fornecedor = body.fornecedor || '';
  peca.ultimo_preco = body.ultimo_preco != null && body.ultimo_preco !== '' ? Number(body.ultimo_preco) : null;
  db.save(data);
  enviarJSON(res, 200, { peca });
});

rota('DELETE', /^\/api\/pecas-catalogo\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui do catálogo.' });
  const data = db.load();
  const id = Number(m[1]);
  const peca = tenant.buscar(data, 'pecas_catalogo', id, user.empresa_id);
  if (!peca) return enviarJSON(res, 404, { erro: 'Peça não encontrada.' });
  if (tenant.listar(data, 'solicitacoes_peca', user.empresa_id).some((s) => s.peca_catalogo_id === id)) {
    return enviarJSON(res, 400, { erro: 'Existem solicitações usando esta peça. Não é possível excluir.' });
  }
  data.pecas_catalogo = data.pecas_catalogo.filter((p) => p.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- solicitação de peça ----
// POST /api/solicitacoes-peca { equipamento_id, prioridade, descricao, peca_catalogo_id?,
// codigo_produto?, fornecedor?, quantidade?, valor_unitario?, justificativa?, fotos?, agenda_id? }
rota('POST', /^\/api\/solicitacoes-peca$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão pra solicitar peça.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  // equipamento é vínculo OBRIGATÓRIO (pedido do usuário, seção 9) — loja/área vêm dele, não são
  // escolhidas à parte, pra nunca ficar destalinhadas do equipamento de verdade.
  const equipamento = tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
  if (!equipamento || equipamento.filial_id === null) return enviarJSON(res, 400, { erro: 'Escolha um equipamento de uma filial.' });
  const filial = tenant.buscar(data, 'filiais', equipamento.filial_id, user.empresa_id);
  if (!filial || !filialAcessivel(data, user, filial)) return enviarJSON(res, 403, { erro: 'Você não tem acesso à filial deste equipamento.' });
  if (!body.descricao || !String(body.descricao).trim()) return enviarJSON(res, 400, { erro: 'Descreva a peça/material necessário.' });
  const prioridade = PRIORIDADES_SOLICITACAO_PECA.includes(body.prioridade) ? body.prioridade : 'nao_urgente';
  let pecaCatalogo = null;
  if (body.peca_catalogo_id) {
    pecaCatalogo = tenant.buscar(data, 'pecas_catalogo', Number(body.peca_catalogo_id), user.empresa_id);
    if (!pecaCatalogo) return enviarJSON(res, 400, { erro: 'Peça do catálogo não encontrada.' });
  }
  if (body.agenda_id) {
    const agendaVinculada = tenant.buscar(data, 'agenda', Number(body.agenda_id), user.empresa_id);
    if (!agendaVinculada || agendaVinculada.equipamento_id !== equipamento.id) return enviarJSON(res, 400, { erro: 'O.S. inválida para este equipamento.' });
  }
  const quantidade = Number(body.quantidade) > 0 ? Number(body.quantidade) : 1;
  const valorUnitario = body.valor_unitario != null && body.valor_unitario !== '' ? Number(body.valor_unitario) : (pecaCatalogo ? pecaCatalogo.ultimo_preco : null);
  const agora = new Date().toISOString();
  const solicitacao = tenant.criar(data, 'solicitacoes_peca', user.empresa_id, {
    filial_id: filial.id, area_id: equipamento.area_id, equipamento_id: equipamento.id, agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
    prioridade, descricao: body.descricao.trim(),
    peca_catalogo_id: pecaCatalogo ? pecaCatalogo.id : null,
    codigo_produto: body.codigo_produto || (pecaCatalogo ? pecaCatalogo.codigo : ''),
    fornecedor: body.fornecedor || (pecaCatalogo ? pecaCatalogo.fornecedor : ''),
    quantidade, valor_unitario: valorUnitario, valor_total: valorUnitario != null ? Number((valorUnitario * quantidade).toFixed(2)) : null,
    justificativa: body.justificativa || '', fotos: Array.isArray(body.fotos) ? body.fotos : [],
    solicitante_id: user.id, criado_em: agora,
    ciente_gerente_id: null, ciente_gerente_em: null, ciente_coordenador_id: null, ciente_coordenador_em: null,
    status: 'pendente', historico: [{ de: null, para: 'pendente', por: user.id, em: agora, observacao: '' }],
    nota_fiscal_numero: null, instalacao_agenda_id: null, instalado_em: null, instalado_por: null,
    pedido_item_id: null, // Fase 4 — Compras: preenchido se esta solicitação entrou num pedido em atacado
  });
  db.save(data);
  if (filial.gerente_id) enviarPush(data, filial.gerente_id, { titulo: 'Nova solicitação de peça', corpo: `${filial.nome}: ${solicitacao.descricao}`, url: '/' }).catch(() => {});
  enviarJSON(res, 201, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// GET /api/solicitacoes-peca?equipamento_id=&agenda_id=&status= — escopo igual ao de filiais
rota('GET', /^\/api\/solicitacoes-peca$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso a solicitações de peça.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
  let lista = tenant.listar(data, 'solicitacoes_peca', user.empresa_id).filter((s) => filiaisIds.has(s.filial_id));
  if (query.equipamento_id) lista = lista.filter((s) => s.equipamento_id === Number(query.equipamento_id));
  if (query.agenda_id) lista = lista.filter((s) => s.agenda_id === Number(query.agenda_id));
  if (query.status) lista = lista.filter((s) => s.status === query.status);
  enviarJSON(res, 200, { solicitacoes: lista.map((s) => solicitacaoComDetalhes(data, s)) });
});

rota('GET', /^\/api\/solicitacoes-peca\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  enviarJSON(res, 200, { solicitacao: { ...solicitacaoComDetalhes(data, solicitacao), fotos: await hidratarFotosProfundo(solicitacao.fotos) } });
});

// POST /api/solicitacoes-peca/:id/ciente — gerente da loja e coordenador técnico dão "ciente"
// (campos independentes — pedido do usuário, seção 9) cada um clica só a própria confirmação.
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/ciente$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['gerente_loja', 'coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o gerente da loja ou o coordenador técnico dão ciente.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  const agora = new Date().toISOString();
  if (user.papel === 'gerente_loja') { solicitacao.ciente_gerente_id = user.id; solicitacao.ciente_gerente_em = agora; }
  else if (user.papel === 'coordenador_tecnico') { solicitacao.ciente_coordenador_id = user.id; solicitacao.ciente_coordenador_em = agora; }
  if (solicitacao.status === 'pendente') registrarHistoricoSolicitacao(solicitacao, 'pendente', 'ciente', user.id, '');
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// PUT /api/solicitacoes-peca/:id/orcamento { codigo_produto?, fornecedor?, valor_unitario?, quantidade? }
rota('PUT', /^\/api\/solicitacoes-peca\/(\d+)\/orcamento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['gerente_loja', 'coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o gerente da loja ou o coordenador técnico orçam a peça.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (['aprovado', 'nao_aprovado', 'comprado', 'peca_na_loja', 'instalado'].includes(solicitacao.status)) {
    return enviarJSON(res, 400, { erro: 'Esta solicitação já passou da fase de orçamento.' });
  }
  const body = await lerCorpo(req);
  if (body.codigo_produto !== undefined) solicitacao.codigo_produto = body.codigo_produto;
  if (body.fornecedor !== undefined) solicitacao.fornecedor = body.fornecedor;
  if (body.quantidade !== undefined && Number(body.quantidade) > 0) solicitacao.quantidade = Number(body.quantidade);
  if (body.valor_unitario !== undefined) solicitacao.valor_unitario = body.valor_unitario === '' ? null : Number(body.valor_unitario);
  solicitacao.valor_total = solicitacao.valor_unitario != null ? Number((solicitacao.valor_unitario * solicitacao.quantidade).toFixed(2)) : null;
  if (solicitacao.status === 'ciente') registrarHistoricoSolicitacao(solicitacao, 'ciente', 'orcando', user.id, '');
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// POST /api/solicitacoes-peca/:id/aprovar-local — gerente/coordenador aprova e compra direto,
// só dentro do limite 1 (pedido do usuário, seção 9).
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/aprovar-local$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['gerente_loja', 'coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o gerente da loja ou o coordenador técnico aprovam localmente.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (!['ciente', 'orcando'].includes(solicitacao.status)) return enviarJSON(res, 400, { erro: 'Esta solicitação não está pronta pra aprovação local.' });
  const empresaAtual = data.empresas.find((e) => e.id === user.empresa_id);
  const { limite1 } = limitesAprovacao(empresaAtual);
  if (solicitacao.valor_total == null || solicitacao.valor_total > limite1) {
    return enviarJSON(res, 400, { erro: `Valor acima do limite de aprovação local (R$ ${limite1}). Peça autorização ao consultor.` });
  }
  const body = await lerCorpo(req);
  registrarHistoricoSolicitacao(solicitacao, solicitacao.status, 'aprovado', user.id, body.observacao || '');
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// POST /api/solicitacoes-peca/:id/pedir-autorizacao-consultor { observacao? }
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/pedir-autorizacao-consultor$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['gerente_loja', 'coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o gerente da loja ou o coordenador técnico pedem autorização.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (!['ciente', 'orcando'].includes(solicitacao.status)) return enviarJSON(res, 400, { erro: 'Esta solicitação não está pronta pra pedir autorização.' });
  const body = await lerCorpo(req);
  registrarHistoricoSolicitacao(solicitacao, solicitacao.status, 'aguardando_consultor', user.id, body.observacao || '');
  db.save(data);
  const filial = tenant.buscar(data, 'filiais', solicitacao.filial_id, user.empresa_id);
  const setor = filial ? tenant.buscar(data, 'setores', filial.setor_id, user.empresa_id) : null;
  if (setor && setor.consultor_id) enviarPush(data, setor.consultor_id, { titulo: 'Autorização de compra pendente', corpo: solicitacao.descricao, url: '/' }).catch(() => {});
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// POST /api/solicitacoes-peca/:id/consultor-decidir { decisao: 'aprovado'|'reprovado'|'encaminhar_diretoria', observacao? }
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/consultor-decidir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['consultor_mercado', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o consultor de mercado do setor decide.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'aguardando_consultor') return enviarJSON(res, 400, { erro: 'Esta solicitação não está aguardando o consultor.' });
  const body = await lerCorpo(req);
  const empresaAtual = data.empresas.find((e) => e.id === user.empresa_id);
  const { limite2 } = limitesAprovacao(empresaAtual);
  const acimaDoLimite2 = solicitacao.valor_total == null || solicitacao.valor_total > limite2;
  if (acimaDoLimite2 && body.decisao !== 'encaminhar_diretoria') {
    return enviarJSON(res, 400, { erro: `Valor acima do limite 2 (R$ ${limite2}) — é obrigatório encaminhar à diretoria.` });
  }
  const novoStatus = body.decisao === 'aprovado' ? 'aprovado' : body.decisao === 'reprovado' ? 'nao_aprovado' : body.decisao === 'encaminhar_diretoria' ? 'aguardando_diretoria' : null;
  if (!novoStatus) return enviarJSON(res, 400, { erro: 'Decisão inválida.' });
  registrarHistoricoSolicitacao(solicitacao, solicitacao.status, novoStatus, user.id, body.observacao || '');
  db.save(data);
  if (novoStatus === 'aguardando_diretoria') {
    const diretoria = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
    await Promise.all(diretoria.map((d) => enviarPush(data, d.id, { titulo: 'Autorização de compra pendente', corpo: solicitacao.descricao, url: '/' }).catch(() => {})));
  }
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// POST /api/solicitacoes-peca/:id/diretoria-decidir { decisao: 'aprovado'|'reprovado', observacao? }
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/diretoria-decidir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só a diretoria (administrador) decide nesta etapa.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'aguardando_diretoria') return enviarJSON(res, 400, { erro: 'Esta solicitação não está aguardando a diretoria.' });
  const body = await lerCorpo(req);
  const novoStatus = body.decisao === 'aprovado' ? 'aprovado' : body.decisao === 'reprovado' ? 'nao_aprovado' : null;
  if (!novoStatus) return enviarJSON(res, 400, { erro: 'Decisão inválida.' });
  registrarHistoricoSolicitacao(solicitacao, 'aguardando_diretoria', novoStatus, user.id, body.observacao || '');
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// POST /api/solicitacoes-peca/:id/marcar-comprado { nota_fiscal_numero? }
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/marcar-comprado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['gerente_loja', 'coordenador_tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'aprovado') return enviarJSON(res, 400, { erro: 'Esta solicitação ainda não foi aprovada.' });
  const body = await lerCorpo(req);
  solicitacao.nota_fiscal_numero = body.nota_fiscal_numero || null;
  registrarHistoricoSolicitacao(solicitacao, 'aprovado', 'comprado', user.id, '');
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// avança a solicitação pra "peça na loja" e já gera a O.S. de instalação pro técnico fixo —
// reaproveitado tanto pela baixa manual (rota abaixo) quanto pela confirmação de recebimento de
// uma transferência vinda da Fase 4 (Compras/estoque) — nunca db.save/enviarJSON aqui, isso fica
// por conta de quem chama, pra poder salvar tudo numa única escrita.
function marcarSolicitacaoPecaNaLoja(data, user, solicitacao) {
  registrarHistoricoSolicitacao(solicitacao, solicitacao.status, 'peca_na_loja', user.id, '');
  const filial = tenant.buscar(data, 'filiais', solicitacao.filial_id, user.empresa_id);
  const os = criarOsFilial(data, user, {
    filial, area_id: solicitacao.area_id, equipamento_id: solicitacao.equipamento_id,
    problema: `Instalar peça: ${solicitacao.descricao}`, sla_criticidade: solicitacao.prioridade === 'urgente' ? 'alto' : 'medio',
  });
  solicitacao.instalacao_agenda_id = os.id;
  if (os.tecnico_id) enviarPush(data, os.tecnico_id, { titulo: 'Peça na loja — instalar', corpo: solicitacao.descricao, url: '/' }).catch(() => {});
  return os;
}

// POST /api/solicitacoes-peca/:id/marcar-peca-na-loja — pedido do usuário, seção 9: "quando o
// status chega a 'Peça na loja', gerar automaticamente uma O.S. de instalação pro técnico".
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/marcar-peca-na-loja$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'comprado') return enviarJSON(res, 400, { erro: 'Esta solicitação ainda não foi marcada como comprada.' });
  const os = marcarSolicitacaoPecaNaLoja(data, user, solicitacao);
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao), agenda: agendaComDetalhes(data, os) });
});

// POST /api/solicitacoes-peca/:id/marcar-instalado — técnico dá baixa (seção 5/9 do pedido do
// usuário); se existir a O.S. de instalação automática, conclui ela também.
rota('POST', /^\/api\/solicitacoes-peca\/(\d+)\/marcar-instalado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico confirma a instalação.' });
  const data = db.load();
  const solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(m[1]), user.empresa_id);
  if (!solicitacao || !solicitacaoNoEscopo(data, user, solicitacao)) return enviarJSON(res, 404, { erro: 'Solicitação não encontrada.' });
  if (solicitacao.status !== 'peca_na_loja') return enviarJSON(res, 400, { erro: 'A peça ainda não chegou na loja.' });
  registrarHistoricoSolicitacao(solicitacao, 'peca_na_loja', 'instalado', user.id, '');
  solicitacao.instalado_em = new Date().toISOString();
  solicitacao.instalado_por = user.id;
  db.save(data);
  enviarJSON(res, 200, { solicitacao: solicitacaoComDetalhes(data, solicitacao) });
});

// ---------- VERSÃO RESTAURANTES/REDE MULTIUNIDADE — FASE 4 (COMPRAS) ----------
// Compra em atacado (consolida solicitações de várias lojas pelo mesmo código), estoque central e
// por loja, e transferência (central->loja ou entre filiais, com pedido/aceite/envio/recebimento
// quando é entre lojas — pedido do usuário, seções 10 e 10.1).

const PAPEIS_COMPRAS = ['administrador', 'coordenador_tecnico'];

function upsertEstoqueCentral(data, empresaId, codigoProduto, descricao, delta) {
  let linha = tenant.listar(data, 'estoque_central', empresaId).find((e) => e.codigo_produto.trim().toLowerCase() === codigoProduto.trim().toLowerCase());
  if (!linha) linha = tenant.criar(data, 'estoque_central', empresaId, { codigo_produto: codigoProduto, descricao, saldo: 0 });
  linha.saldo += delta;
  return linha;
}
function upsertEstoqueLoja(data, empresaId, filialId, codigoProduto, descricao, delta) {
  let linha = tenant.listar(data, 'estoque_loja', empresaId).find((e) => e.filial_id === filialId && e.codigo_produto.trim().toLowerCase() === codigoProduto.trim().toLowerCase());
  if (!linha) linha = tenant.criar(data, 'estoque_loja', empresaId, { filial_id: filialId, codigo_produto: codigoProduto, descricao, saldo: 0 });
  linha.saldo += delta;
  return linha;
}

// GET /api/pedidos-compra/sugestoes — consolidação (seção 10 passo 1): agrupa solicitações
// aprovadas, ainda sem pedido de compra, pelo código do produto — "compra no atacado em vez de
// uma por uma".
rota('GET', /^\/api\/pedidos-compra\/sugestoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_COMPRAS)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const pendentes = tenant.listar(data, 'solicitacoes_peca', user.empresa_id).filter((s) => s.status === 'aprovado' && !s.pedido_item_id && s.codigo_produto);
  const grupos = {};
  for (const s of pendentes) {
    const chave = s.codigo_produto.trim().toLowerCase();
    if (!grupos[chave]) grupos[chave] = { codigo_produto: s.codigo_produto, descricao: s.descricao, quantidade_total: 0, solicitacoes: [] };
    grupos[chave].quantidade_total += s.quantidade;
    grupos[chave].solicitacoes.push(solicitacaoComDetalhes(data, s));
  }
  enviarJSON(res, 200, { sugestoes: Object.values(grupos) });
});

// POST /api/pedidos-compra { fornecedor, nota_fiscal_numero?, nota_fiscal_arquivo?, itens:
// [{codigo_produto, descricao, quantidade, valor_unitario, solicitacoes_atendidas:[ids]}] }
rota('POST', /^\/api\/pedidos-compra$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_COMPRAS)) return enviarJSON(res, 403, { erro: 'Sem permissão pra registrar pedido de compra.' });
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  if (!body.fornecedor || !String(body.fornecedor).trim()) return enviarJSON(res, 400, { erro: 'Fornecedor é obrigatório.' });
  if (!Array.isArray(body.itens) || !body.itens.length) return enviarJSON(res, 400, { erro: 'Informe ao menos um item.' });
  // valida tudo ANTES de criar qualquer coisa, pra nunca gravar pedido pela metade.
  const itensValidados = [];
  for (const item of body.itens) {
    if (!item.codigo_produto || !item.descricao || !(Number(item.quantidade) > 0) || !(Number(item.valor_unitario) >= 0)) {
      return enviarJSON(res, 400, { erro: 'Cada item precisa de código, descrição, quantidade e valor unitário.' });
    }
    const solicitacoes = [];
    for (const solId of (item.solicitacoes_atendidas || [])) {
      const s = tenant.buscar(data, 'solicitacoes_peca', Number(solId), user.empresa_id);
      if (!s || s.status !== 'aprovado' || s.pedido_item_id) return enviarJSON(res, 400, { erro: `Solicitação #${solId} não está disponível pra entrar num pedido (precisa estar aprovada e sem pedido ainda).` });
      solicitacoes.push(s);
    }
    itensValidados.push({ ...item, solicitacoesObjs: solicitacoes });
  }
  const agora = new Date().toISOString();
  const pedido = tenant.criar(data, 'pedidos_compra', user.empresa_id, {
    fornecedor: body.fornecedor.trim(), nota_fiscal_numero: body.nota_fiscal_numero || null,
    nota_fiscal_arquivo: body.nota_fiscal_arquivo || null, comprado_por: user.id, criado_em: agora,
  });
  const itensCriados = [];
  for (const item of itensValidados) {
    const quantidade = Number(item.quantidade), valorUnitario = Number(item.valor_unitario);
    const pedidoItem = tenant.criar(data, 'pedido_itens', user.empresa_id, {
      pedido_id: pedido.id, codigo_produto: String(item.codigo_produto).trim(), descricao: String(item.descricao).trim(),
      quantidade, valor_unitario: valorUnitario, valor_total: Number((quantidade * valorUnitario).toFixed(2)),
      solicitacoes_atendidas: item.solicitacoesObjs.map((s) => s.id),
    });
    for (const s of item.solicitacoesObjs) {
      s.pedido_item_id = pedidoItem.id;
      s.nota_fiscal_numero = pedido.nota_fiscal_numero;
      registrarHistoricoSolicitacao(s, 'aprovado', 'comprado', user.id, `Pedido de compra #${pedido.id} — ${pedido.fornecedor}`);
    }
    upsertEstoqueCentral(data, user.empresa_id, pedidoItem.codigo_produto, pedidoItem.descricao, quantidade);
    itensCriados.push(pedidoItem);
  }
  db.save(data);
  enviarJSON(res, 201, { pedido, itens: itensCriados });
});

rota('GET', /^\/api\/pedidos-compra$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, [...PAPEIS_COMPRAS, 'consultor_mercado'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const pedidos = tenant.listar(data, 'pedidos_compra', user.empresa_id);
  enviarJSON(res, 200, { pedidos });
});

rota('GET', /^\/api\/pedidos-compra\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, [...PAPEIS_COMPRAS, 'consultor_mercado'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const pedido = tenant.buscar(data, 'pedidos_compra', Number(m[1]), user.empresa_id);
  if (!pedido) return enviarJSON(res, 404, { erro: 'Pedido não encontrado.' });
  const itens = tenant.listar(data, 'pedido_itens', user.empresa_id).filter((i) => i.pedido_id === pedido.id).map((i) => ({
    ...i, solicitacoes: i.solicitacoes_atendidas.map((id) => tenant.buscar(data, 'solicitacoes_peca', id, user.empresa_id)).filter(Boolean).map((s) => solicitacaoComDetalhes(data, s)),
  }));
  enviarJSON(res, 200, { pedido, itens });
});

// GET /api/pedidos-compra/rastreio?codigo_produto=|nota_fiscal=|pedido_id= — consulta de rastreio
// (seção 10): quantas foram compradas, pra onde foram, quantas instaladas e quantas paradas onde.
rota('GET', /^\/api\/pedidos-compra\/rastreio$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, [...PAPEIS_COMPRAS, 'consultor_mercado'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let itens = tenant.listar(data, 'pedido_itens', user.empresa_id);
  if (query.pedido_id) itens = itens.filter((i) => i.pedido_id === Number(query.pedido_id));
  if (query.codigo_produto) itens = itens.filter((i) => i.codigo_produto.trim().toLowerCase() === String(query.codigo_produto).trim().toLowerCase());
  if (query.nota_fiscal) {
    const pedidosComNf = tenant.listar(data, 'pedidos_compra', user.empresa_id).filter((p) => p.nota_fiscal_numero === query.nota_fiscal).map((p) => p.id);
    itens = itens.filter((i) => pedidosComNf.includes(i.pedido_id));
  }
  const resultado = itens.map((item) => {
    const transferencias = tenant.listar(data, 'transferencias', user.empresa_id).filter((t) => t.pedido_item_id === item.id);
    const solicitacoes = item.solicitacoes_atendidas.map((id) => tenant.buscar(data, 'solicitacoes_peca', id, user.empresa_id)).filter(Boolean);
    return {
      item, pedido: tenant.buscar(data, 'pedidos_compra', item.pedido_id, user.empresa_id),
      distribuido: transferencias.reduce((soma, t) => soma + (t.status !== 'recusada' ? t.quantidade : 0), 0),
      recebido_nas_lojas: transferencias.filter((t) => t.status === 'recebida').reduce((soma, t) => soma + t.quantidade, 0),
      instalado: solicitacoes.filter((s) => s.status === 'instalado').length,
      parado_na_loja: solicitacoes.filter((s) => s.status === 'peca_na_loja').map((s) => solicitacaoComDetalhes(data, s)),
      transferencias,
    };
  });
  enviarJSON(res, 200, { rastreio: resultado });
});

// GET /api/pedidos-compra/custos?agrupar_por=filial|setor|area|equipamento — custo real a partir
// do valor de verdade pago (pedido_itens quando veio de compra em atacado; senão o valor_total da
// própria solicitação, pra cobrir também a compra direta sem pedido).
rota('GET', /^\/api\/pedidos-compra\/custos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, [...PAPEIS_COMPRAS, 'consultor_mercado'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const agruparPor = ['filial', 'setor', 'area', 'equipamento'].includes(query.agrupar_por) ? query.agrupar_por : 'filial';
  const data = db.load();
  const solicitacoes = tenant.listar(data, 'solicitacoes_peca', user.empresa_id).filter((s) => !['pendente', 'ciente', 'orcando', 'aguardando_consultor', 'aguardando_diretoria', 'nao_aprovado'].includes(s.status));
  const grupos = {};
  for (const s of solicitacoes) {
    const pedidoItem = s.pedido_item_id ? tenant.buscar(data, 'pedido_itens', s.pedido_item_id, user.empresa_id) : null;
    const valor = pedidoItem ? Number((pedidoItem.valor_unitario * s.quantidade).toFixed(2)) : (s.valor_total || 0);
    let chave, label;
    if (agruparPor === 'filial') { chave = s.filial_id; label = (tenant.buscar(data, 'filiais', s.filial_id, user.empresa_id) || {}).nome || '—'; }
    else if (agruparPor === 'area') { chave = s.area_id; label = s.area_id ? ((tenant.buscar(data, 'areas', s.area_id, user.empresa_id) || {}).nome || '—') : '—'; }
    else if (agruparPor === 'equipamento') { chave = s.equipamento_id; const e = tenant.buscar(data, 'equipamentos', s.equipamento_id, user.empresa_id); label = e ? `${e.tipo} ${e.modelo}` : '—'; }
    else { const filial = tenant.buscar(data, 'filiais', s.filial_id, user.empresa_id); chave = filial ? filial.setor_id : null; label = filial ? ((tenant.buscar(data, 'setores', filial.setor_id, user.empresa_id) || {}).nome || '—') : '—'; }
    if (!grupos[chave]) grupos[chave] = { chave, label, total: 0, quantidade_solicitacoes: 0 };
    grupos[chave].total = Number((grupos[chave].total + valor).toFixed(2));
    grupos[chave].quantidade_solicitacoes += 1;
  }
  enviarJSON(res, 200, { custos: Object.values(grupos).sort((a, b) => b.total - a.total) });
});

// ---- estoque ----
rota('GET', /^\/api\/estoque-central$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_COMPRAS)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  enviarJSON(res, 200, { estoque: tenant.listar(data, 'estoque_central', user.empresa_id) });
});

rota('GET', /^\/api\/estoque-loja$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
  let lista = tenant.listar(data, 'estoque_loja', user.empresa_id).filter((e) => filiaisIds.has(e.filial_id));
  if (query.filial_id) lista = lista.filter((e) => e.filial_id === Number(query.filial_id));
  enviarJSON(res, 200, { estoque: lista.map((e) => ({ ...e, filial_nome: (tenant.buscar(data, 'filiais', e.filial_id, user.empresa_id) || {}).nome || null })) });
});

// GET /api/estoque-loja/buscar?codigo_produto= — "busca de peça no grupo" (seção 10.1): quais
// filiais já têm a peça, antes de comprar/pedir de novo. Cross-filial de propósito (não aplica o
// escopo normal) — é só contagem de estoque, não dado operacional sensível.
rota('GET', /^\/api\/estoque-loja\/buscar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  if (!query.codigo_produto) return enviarJSON(res, 400, { erro: 'Informe o código do produto.' });
  const data = db.load();
  const termo = String(query.codigo_produto).trim().toLowerCase();
  const resultado = tenant.listar(data, 'estoque_loja', user.empresa_id)
    .filter((e) => e.codigo_produto.trim().toLowerCase() === termo && e.saldo > 0)
    .map((e) => ({ filial_id: e.filial_id, filial_nome: (tenant.buscar(data, 'filiais', e.filial_id, user.empresa_id) || {}).nome || null, saldo: e.saldo }));
  const noCentral = tenant.listar(data, 'estoque_central', user.empresa_id).find((e) => e.codigo_produto.trim().toLowerCase() === termo);
  enviarJSON(res, 200, { nas_lojas: resultado, no_central: noCentral ? noCentral.saldo : 0 });
});

// ---- transferências (central->loja ou entre filiais) ----
// POST /api/transferencias { origem_tipo: 'central'|'filial', origem_filial_id?, destino_filial_id,
// codigo_produto, descricao, quantidade, pedido_item_id?, solicitacao_id? }
rota('POST', /^\/api\/transferencias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!db.moduloAtivo(data, user.empresa_id, 'filiais')) return enviarJSON(res, 400, { erro: 'Módulo "Redes e Filiais" não está ativo pra sua empresa.' });
  const body = await lerCorpo(req);
  const destino = tenant.buscar(data, 'filiais', Number(body.destino_filial_id), user.empresa_id);
  if (!destino) return enviarJSON(res, 404, { erro: 'Filial de destino não encontrada.' });
  if (!body.codigo_produto || !body.descricao || !(Number(body.quantidade) > 0)) {
    return enviarJSON(res, 400, { erro: 'Código, descrição e quantidade são obrigatórios.' });
  }
  let solicitacao = null;
  if (body.solicitacao_id) {
    solicitacao = tenant.buscar(data, 'solicitacoes_peca', Number(body.solicitacao_id), user.empresa_id);
    if (!solicitacao || solicitacao.filial_id !== destino.id) return enviarJSON(res, 400, { erro: 'Solicitação inválida para esta filial de destino.' });
  }
  const quantidade = Number(body.quantidade);
  const agora = new Date().toISOString();

  if (body.origem_tipo === 'central') {
    if (!exigirPapel(user, PAPEIS_COMPRAS)) return enviarJSON(res, 403, { erro: 'Só administrador/coordenador técnico distribuem do estoque central.' });
    const linhaCentral = tenant.listar(data, 'estoque_central', user.empresa_id).find((e) => e.codigo_produto.trim().toLowerCase() === body.codigo_produto.trim().toLowerCase());
    if (!linhaCentral || linhaCentral.saldo < quantidade) return enviarJSON(res, 400, { erro: 'Saldo insuficiente no estoque central.' });
    linhaCentral.saldo -= quantidade;
    const transferencia = tenant.criar(data, 'transferencias', user.empresa_id, {
      origem_tipo: 'central', origem_filial_id: null, destino_filial_id: destino.id,
      codigo_produto: body.codigo_produto.trim(), descricao: body.descricao.trim(), quantidade,
      pedido_item_id: body.pedido_item_id ? Number(body.pedido_item_id) : null, solicitacao_id: solicitacao ? solicitacao.id : null,
      status: 'enviada', criado_por: user.id, criado_em: agora, decidido_por: null, decidido_em: null,
      enviado_por: user.id, enviado_em: agora, recebido_por: null, recebido_em: null,
    });
    db.save(data);
    if (destino.gerente_id) enviarPush(data, destino.gerente_id, { titulo: 'Peça enviada pra sua loja', corpo: `${body.descricao} — confirme o recebimento.`, url: '/' }).catch(() => {});
    return enviarJSON(res, 201, { transferencia });
  }

  // entre filiais: pedido do usuário, seção 10.1 — "pedido -> aceite da loja que envia -> envio
  // -> confirmação de recebimento". Quem pede é o lado que PRECISA (destino) — gerente/coordenador/
  // administrador — e a filial de ORIGEM (quem tem a peça) precisa aceitar antes de enviar.
  if (body.origem_tipo !== 'filial') return enviarJSON(res, 400, { erro: 'origem_tipo inválido.' });
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const origem = tenant.buscar(data, 'filiais', Number(body.origem_filial_id), user.empresa_id);
  if (!origem) return enviarJSON(res, 404, { erro: 'Filial de origem não encontrada.' });
  if (origem.id === destino.id) return enviarJSON(res, 400, { erro: 'Origem e destino não podem ser a mesma filial.' });
  if (!filialAcessivel(data, user, destino)) return enviarJSON(res, 403, { erro: 'Você não tem acesso à filial de destino.' });
  const transferencia = tenant.criar(data, 'transferencias', user.empresa_id, {
    origem_tipo: 'filial', origem_filial_id: origem.id, destino_filial_id: destino.id,
    codigo_produto: body.codigo_produto.trim(), descricao: body.descricao.trim(), quantidade,
    pedido_item_id: null, solicitacao_id: solicitacao ? solicitacao.id : null,
    status: 'pedida', criado_por: user.id, criado_em: agora, decidido_por: null, decidido_em: null,
    enviado_por: null, enviado_em: null, recebido_por: null, recebido_em: null,
  });
  db.save(data);
  if (origem.gerente_id) enviarPush(data, origem.gerente_id, { titulo: 'Pedido de transferência de peça', corpo: `${destino.nome} precisa de ${body.descricao}.`, url: '/' }).catch(() => {});
  enviarJSON(res, 201, { transferencia });
});

rota('GET', /^\/api\/transferencias$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const filiaisIds = new Set(escopo.filiaisVisiveis(data, user.empresa_id, usuarioCompleto(data, user)).map((f) => f.id));
  let lista = tenant.listar(data, 'transferencias', user.empresa_id).filter((t) => filiaisIds.has(t.destino_filial_id) || filiaisIds.has(t.origem_filial_id));
  if (query.status) lista = lista.filter((t) => t.status === query.status);
  enviarJSON(res, 200, { transferencias: lista.map((t) => ({
    ...t,
    origem_nome: t.origem_filial_id ? (tenant.buscar(data, 'filiais', t.origem_filial_id, user.empresa_id) || {}).nome : 'Estoque central',
    destino_nome: (tenant.buscar(data, 'filiais', t.destino_filial_id, user.empresa_id) || {}).nome || null,
  })) });
});

function filialAcessivelOuAdmin(data, user, filial) { return user.papel === 'administrador' || filialAcessivel(data, user, filial); }

// PUT /api/transferencias/:id/aceitar — a filial de ORIGEM aceita enviar.
rota('PUT', /^\/api\/transferencias\/(\d+)\/aceitar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const t = tenant.buscar(data, 'transferencias', Number(m[1]), user.empresa_id);
  if (!t || t.origem_tipo !== 'filial') return enviarJSON(res, 404, { erro: 'Transferência não encontrada.' });
  if (t.status !== 'pedida') return enviarJSON(res, 400, { erro: 'Esta transferência já foi decidida.' });
  const origem = tenant.buscar(data, 'filiais', t.origem_filial_id, user.empresa_id);
  if (!filialAcessivelOuAdmin(data, user, origem)) return enviarJSON(res, 403, { erro: 'Só a filial de origem decide este pedido.' });
  t.status = 'aceita'; t.decidido_por = user.id; t.decidido_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { transferencia: t });
});

rota('PUT', /^\/api\/transferencias\/(\d+)\/recusar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const t = tenant.buscar(data, 'transferencias', Number(m[1]), user.empresa_id);
  if (!t || t.origem_tipo !== 'filial') return enviarJSON(res, 404, { erro: 'Transferência não encontrada.' });
  if (t.status !== 'pedida') return enviarJSON(res, 400, { erro: 'Esta transferência já foi decidida.' });
  const origem = tenant.buscar(data, 'filiais', t.origem_filial_id, user.empresa_id);
  if (!filialAcessivelOuAdmin(data, user, origem)) return enviarJSON(res, 403, { erro: 'Só a filial de origem decide este pedido.' });
  t.status = 'recusada'; t.decidido_por = user.id; t.decidido_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { transferencia: t });
});

// PUT /api/transferencias/:id/enviar — a filial de origem despacha de verdade (decrementa o
// próprio estoque só agora, não na aceitação — o saldo pode ter mudado entre as duas).
rota('PUT', /^\/api\/transferencias\/(\d+)\/enviar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const t = tenant.buscar(data, 'transferencias', Number(m[1]), user.empresa_id);
  if (!t || t.origem_tipo !== 'filial') return enviarJSON(res, 404, { erro: 'Transferência não encontrada.' });
  if (t.status !== 'aceita') return enviarJSON(res, 400, { erro: 'Esta transferência ainda não foi aceita.' });
  const origem = tenant.buscar(data, 'filiais', t.origem_filial_id, user.empresa_id);
  if (!filialAcessivelOuAdmin(data, user, origem)) return enviarJSON(res, 403, { erro: 'Só a filial de origem despacha esta transferência.' });
  const linhaOrigem = tenant.listar(data, 'estoque_loja', user.empresa_id).find((e) => e.filial_id === origem.id && e.codigo_produto.trim().toLowerCase() === t.codigo_produto.trim().toLowerCase());
  if (!linhaOrigem || linhaOrigem.saldo < t.quantidade) return enviarJSON(res, 400, { erro: 'Saldo insuficiente na filial de origem pra enviar.' });
  linhaOrigem.saldo -= t.quantidade;
  t.status = 'enviada'; t.enviado_por = user.id; t.enviado_em = new Date().toISOString();
  db.save(data);
  const destino = tenant.buscar(data, 'filiais', t.destino_filial_id, user.empresa_id);
  if (destino && destino.gerente_id) enviarPush(data, destino.gerente_id, { titulo: 'Peça a caminho', corpo: t.descricao, url: '/' }).catch(() => {});
  enviarJSON(res, 200, { transferencia: t });
});

// PUT /api/transferencias/:id/confirmar-recebimento — a filial de DESTINO confirma (seção 10
// passo 4) — credita o estoque da loja e, se vinculada a uma solicitação, já avança ela pra
// "peça na loja" (gera a O.S. de instalação automaticamente, ver marcarSolicitacaoPecaNaLoja).
rota('PUT', /^\/api\/transferencias\/(\d+)\/confirmar-recebimento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem permissão.' });
  const data = db.load();
  const t = tenant.buscar(data, 'transferencias', Number(m[1]), user.empresa_id);
  if (!t) return enviarJSON(res, 404, { erro: 'Transferência não encontrada.' });
  if (t.status !== 'enviada') return enviarJSON(res, 400, { erro: 'Esta transferência ainda não foi enviada.' });
  const destino = tenant.buscar(data, 'filiais', t.destino_filial_id, user.empresa_id);
  if (!filialAcessivelOuAdmin(data, user, destino)) return enviarJSON(res, 403, { erro: 'Só a filial de destino confirma o recebimento.' });
  upsertEstoqueLoja(data, user.empresa_id, destino.id, t.codigo_produto, t.descricao, t.quantidade);
  t.status = 'recebida'; t.recebido_por = user.id; t.recebido_em = new Date().toISOString();
  let osGerada = null;
  if (t.solicitacao_id) {
    const solicitacao = tenant.buscar(data, 'solicitacoes_peca', t.solicitacao_id, user.empresa_id);
    if (solicitacao && solicitacao.status === 'comprado') osGerada = marcarSolicitacaoPecaNaLoja(data, user, solicitacao);
  }
  db.save(data);
  enviarJSON(res, 200, { transferencia: t, agenda: osGerada ? agendaComDetalhes(data, osGerada) : null });
});

// ---------- VERSÃO RESTAURANTES/REDE MULTIUNIDADE — FASE 5 (GESTÃO E COMUNICAÇÃO) ----------
// GET /api/dashboards/filiais?setor_id=&filial_id=&area_id= — pedido do usuário, seção 11.
// "Equipamentos parados aguardando peça" é o painel principal (lista + cards); o resto (O.S. por
// loja/SLA estourado, matriz de compras, quebras com pendência perdida, apoios entre setores) vem
// junto na mesma resposta pra evitar ida e volta. Cada visão (diretoria/consultor/coordenador/
// gerente/técnico) já sai certa sozinha, porque tudo é filtrado pelo escopo de quem pediu.
rota('GET', /^\/api\/dashboards\/filiais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const completo = usuarioCompleto(data, user);
  let filiaisFiltradas = escopo.filiaisVisiveis(data, user.empresa_id, completo);
  if (query.setor_id) filiaisFiltradas = filiaisFiltradas.filter((f) => f.setor_id === Number(query.setor_id));
  if (query.filial_id) filiaisFiltradas = filiaisFiltradas.filter((f) => f.id === Number(query.filial_id));
  const filiaisIds = new Set(filiaisFiltradas.map((f) => f.id));

  // --- equipamentos parados aguardando peça: lista + cards, clique abre a linha do tempo (já
  // disponível em GET /api/solicitacoes-peca/:id — ver histórico) ---
  let pendentesPeca = tenant.listar(data, 'solicitacoes_peca', user.empresa_id)
    .filter((s) => filiaisIds.has(s.filial_id) && !['instalado', 'nao_aprovado'].includes(s.status));
  if (query.area_id) pendentesPeca = pendentesPeca.filter((s) => s.area_id === Number(query.area_id));
  const listaParados = pendentesPeca.map((s) => solicitacaoComDetalhes(data, s))
    .sort((a, b) => (b.dias_parado - a.dias_parado) || ((a.prioridade === 'urgente' ? 0 : 1) - (b.prioridade === 'urgente' ? 0 : 1)));
  const cardsParados = {
    total: listaParados.length,
    aguardando_consultor: listaParados.filter((s) => s.status === 'aguardando_consultor').length,
    aguardando_diretoria: listaParados.filter((s) => s.status === 'aguardando_diretoria').length,
    aguardando_entrega: listaParados.filter((s) => s.status === 'comprado').length,
    media_dias_parado: listaParados.length ? Number((listaParados.reduce((soma, s) => soma + s.dias_parado, 0) / listaParados.length).toFixed(1)) : 0,
  };

  // --- O.S. abertas por loja/setor, SLA estourado, backlog ---
  const agendaEscopo = tenant.listar(data, 'agenda', user.empresa_id).filter((a) => a.filial_id != null && filiaisIds.has(a.filial_id));
  const osAbertas = agendaEscopo.filter((a) => !['concluida', 'validada'].includes(a.etapa));
  const agora = Date.now();
  const porLoja = {};
  for (const a of osAbertas) {
    if (!porLoja[a.filial_id]) {
      const filial = tenant.buscar(data, 'filiais', a.filial_id, user.empresa_id);
      porLoja[a.filial_id] = { filial_id: a.filial_id, filial_nome: filial ? filial.nome : '—', abertas: 0, sla_estourado: 0 };
    }
    porLoja[a.filial_id].abertas += 1;
    if (a.sla_prazo_em && new Date(a.sla_prazo_em).getTime() < agora) porLoja[a.filial_id].sla_estourado += 1;
  }

  // --- matriz de compras por prioridade x status (igual a planilha que o pedido do usuário cita) ---
  const BUCKETS_COMPRA = {
    pendente: ['pendente', 'ciente', 'orcando', 'aguardando_consultor', 'aguardando_diretoria'],
    aprovado: ['aprovado'], comprado: ['comprado', 'peca_na_loja'], finalizado: ['instalado'], nao_aprovado: ['nao_aprovado'],
  };
  const todasSolicitacoes = tenant.listar(data, 'solicitacoes_peca', user.empresa_id).filter((s) => filiaisIds.has(s.filial_id));
  const matrizCompras = {};
  for (const prioridade of PRIORIDADES_SOLICITACAO_PECA) {
    matrizCompras[prioridade] = {};
    for (const bucket of Object.keys(BUCKETS_COMPRA)) {
      matrizCompras[prioridade][bucket] = todasSolicitacoes.filter((s) => s.prioridade === prioridade && BUCKETS_COMPRA[bucket].includes(s.status)).length;
    }
  }

  // --- quebras que tinham solicitação de peça pendente (indicador de prevenção perdida) ---
  const quebrasComPendencia = tenant.listar(data, 'equipamentos', user.empresa_id)
    .filter((e) => filiaisIds.has(e.filial_id) && e.status_operacional === 'parado' && todasSolicitacoes.some((s) => s.equipamento_id === e.id && !['instalado', 'nao_aprovado'].includes(s.status)))
    .length;

  // --- apoios entre setores envolvendo os setores no escopo ---
  const setoresIds = new Set(filiaisFiltradas.map((f) => f.setor_id));
  const apoiosEnvolvidos = tenant.listar(data, 'apoios', user.empresa_id).filter((a) => setoresIds.has(a.setor_origem_id) || setoresIds.has(a.setor_destino_id));

  enviarJSON(res, 200, {
    parados: { lista: listaParados, cards: cardsParados },
    os: { por_loja: Object.values(porLoja), total_abertas: osAbertas.length, sla_estourado: osAbertas.filter((a) => a.sla_prazo_em && new Date(a.sla_prazo_em).getTime() < agora).length },
    matriz_compras: matrizCompras,
    quebras_com_pendencia: quebrasComPendencia,
    apoios: { quantidade: apoiosEnvolvidos.length, aceitos: apoiosEnvolvidos.filter((a) => a.status === 'aceito').length },
  });
});

// ---- mural de avisos (seção 10.1 do pedido do usuário) ----
// quem publica: administrador (geral ou qualquer setor) e coordenador técnico/consultor de
// mercado (só o próprio setor). Quem só lê (gerente/técnico) vê geral + o setor da própria loja.
function setorEscopoAvisos(data, user, completo) {
  if (user.papel === 'administrador' || user.papel === 'supervisor') return undefined; // sem filtro — vê tudo
  if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') return completo.setor_id;
  if (user.papel === 'gerente_loja' || user.papel === 'suporte') {
    const filial = completo.filial_id ? tenant.buscar(data, 'filiais', completo.filial_id, user.empresa_id) : null;
    return filial ? filial.setor_id : null;
  }
  return null;
}
rota('GET', /^\/api\/avisos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const setorEscopo = setorEscopoAvisos(data, user, usuarioCompleto(data, user));
  let lista = tenant.listar(data, 'avisos', user.empresa_id);
  if (setorEscopo !== undefined) lista = lista.filter((a) => a.setor_id === null || a.setor_id === setorEscopo);
  lista = lista.map((a) => ({
    ...a,
    autor_nome: (data.usuarios.find((u) => u.id === a.autor_id && u.empresa_id === a.empresa_id) || {}).nome || null,
    setor_nome: a.setor_id ? ((tenant.buscar(data, 'setores', a.setor_id, user.empresa_id) || {}).nome || null) : 'Geral',
  })).sort((a, b) => b.criado_em.localeCompare(a.criado_em));
  enviarJSON(res, 200, { avisos: lista });
});
rota('POST', /^\/api\/avisos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'coordenador_tecnico', 'consultor_mercado'])) return enviarJSON(res, 403, { erro: 'Só administrador, coordenador técnico ou consultor de mercado publicam avisos.' });
  const data = db.load();
  const body = await lerCorpo(req);
  if (!body.titulo || !String(body.titulo).trim() || !body.corpo || !String(body.corpo).trim()) {
    return enviarJSON(res, 400, { erro: 'Título e corpo são obrigatórios.' });
  }
  let setorId = null;
  if (user.papel === 'administrador') {
    if (body.setor_id) {
      const setor = tenant.buscar(data, 'setores', Number(body.setor_id), user.empresa_id);
      if (!setor) return enviarJSON(res, 400, { erro: 'Setor não encontrado.' });
      setorId = setor.id;
    }
  } else {
    const completo = usuarioCompleto(data, user);
    if (!completo.setor_id) return enviarJSON(res, 400, { erro: 'Você não está vinculado a um setor.' });
    setorId = completo.setor_id;
  }
  const aviso = tenant.criar(data, 'avisos', user.empresa_id, {
    setor_id: setorId, autor_id: user.id, titulo: body.titulo.trim(), corpo: body.corpo.trim(), criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { aviso });
});
rota('DELETE', /^\/api\/avisos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const aviso = tenant.buscar(data, 'avisos', Number(m[1]), user.empresa_id);
  if (!aviso) return enviarJSON(res, 404, { erro: 'Aviso não encontrado.' });
  if (user.papel !== 'administrador' && aviso.autor_id !== user.id) return enviarJSON(res, 403, { erro: 'Só quem publicou (ou o administrador) exclui este aviso.' });
  data.avisos = data.avisos.filter((a) => a.id !== aviso.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---- chat por canal (geral/setor/loja — seção 10.1): separado de propósito do chat interno
// 1-pra-1 já existente (mensagens_internas), que fica intocado. Pode citar O.S./equipamento/
// solicitação de peça (link clicável no front, a partir de `referencia`). ----
function canalAcessivel(data, user, completo, canal) {
  if (user.papel === 'administrador' || user.papel === 'supervisor') return true;
  if (canal === 'geral') return true;
  if (canal.startsWith('setor:')) {
    const setorId = Number(canal.slice(6));
    if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') return completo.setor_id === setorId;
    if (user.papel === 'gerente_loja' || user.papel === 'suporte') {
      const filial = completo.filial_id ? tenant.buscar(data, 'filiais', completo.filial_id, user.empresa_id) : null;
      return !!filial && filial.setor_id === setorId;
    }
    return false;
  }
  if (canal.startsWith('filial:')) {
    const filialId = Number(canal.slice(7));
    const filial = tenant.buscar(data, 'filiais', filialId, user.empresa_id);
    if (!filial) return false;
    if (user.papel === 'gerente_loja' || user.papel === 'suporte') return completo.filial_id === filialId;
    if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') return completo.setor_id === filial.setor_id;
    return false;
  }
  return false;
}
// GET /api/mensagens-canal/canais — canais que o usuário pode usar, já com nome legível pro front.
rota('GET', /^\/api\/mensagens-canal\/canais$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const completo = usuarioCompleto(data, user);
  const canais = [{ canal: 'geral', nome: 'Geral (toda a rede)' }];
  if (['administrador', 'supervisor'].includes(user.papel)) {
    for (const s of tenant.listar(data, 'setores', user.empresa_id)) canais.push({ canal: `setor:${s.id}`, nome: `Setor: ${s.nome}` });
    for (const f of tenant.listar(data, 'filiais', user.empresa_id)) canais.push({ canal: `filial:${f.id}`, nome: `Loja: ${f.nome}` });
  } else if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') {
    if (completo.setor_id) {
      const setor = tenant.buscar(data, 'setores', completo.setor_id, user.empresa_id);
      if (setor) canais.push({ canal: `setor:${setor.id}`, nome: `Setor: ${setor.nome}` });
      for (const f of tenant.listar(data, 'filiais', user.empresa_id).filter((f) => f.setor_id === completo.setor_id)) canais.push({ canal: `filial:${f.id}`, nome: `Loja: ${f.nome}` });
    }
  } else if (user.papel === 'gerente_loja' || user.papel === 'suporte') {
    if (completo.filial_id) {
      const filial = tenant.buscar(data, 'filiais', completo.filial_id, user.empresa_id);
      if (filial) {
        canais.push({ canal: `filial:${filial.id}`, nome: `Loja: ${filial.nome}` });
        const setor = tenant.buscar(data, 'setores', filial.setor_id, user.empresa_id);
        if (setor) canais.push({ canal: `setor:${setor.id}`, nome: `Setor: ${setor.nome}` });
      }
    }
  }
  enviarJSON(res, 200, { canais });
});
rota('GET', /^\/api\/mensagens-canal$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const completo = usuarioCompleto(data, user);
  const canal = query.canal || 'geral';
  if (!canalAcessivel(data, user, completo, canal)) return enviarJSON(res, 403, { erro: 'Você não tem acesso a este canal.' });
  const mensagens = tenant.listar(data, 'mensagens_canal', user.empresa_id).filter((m) => m.canal === canal)
    .map((m) => ({ ...m, autor_nome: (data.usuarios.find((u) => u.id === m.autor_id && u.empresa_id === m.empresa_id) || {}).nome || null }))
    .sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  enviarJSON(res, 200, { mensagens: await Promise.all(mensagens.map(async (m) => ({ ...m, foto: await hidratarFotosProfundo(m.foto) }))) });
});
rota('POST', /^\/api\/mensagens-canal$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, PAPEIS_OPERACAO_FILIAL)) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const completo = usuarioCompleto(data, user);
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const canal = body.canal || 'geral';
  if (!canalAcessivel(data, user, completo, canal)) return enviarJSON(res, 403, { erro: 'Você não tem acesso a este canal.' });
  if (!body.texto || !String(body.texto).trim()) return enviarJSON(res, 400, { erro: 'Escreva uma mensagem.' });
  let referencia = null;
  if (body.referencia && body.referencia.tipo && body.referencia.id) {
    const colecaoPorTipo = { os: 'agenda', equipamento: 'equipamentos', solicitacao: 'solicitacoes_peca' };
    const colecao = colecaoPorTipo[body.referencia.tipo];
    if (colecao && tenant.buscar(data, colecao, Number(body.referencia.id), user.empresa_id)) {
      referencia = { tipo: body.referencia.tipo, id: Number(body.referencia.id) };
    }
  }
  const msg = tenant.criar(data, 'mensagens_canal', user.empresa_id, {
    canal, autor_id: user.id, texto: body.texto.trim(), foto: body.foto || null, referencia, criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { mensagem: { ...msg, foto: await hidratarFotosProfundo(msg.foto) } });
});

// ---------- sincronização de rascunho de relatório/laudo entre aparelhos (núcleo — ver
// comentário em rotas-modulo.js) ----------
// pedido do usuário: rascunho (Relatório manual, relatório de O.S., laudo técnico) era salvo só
// no localStorage do aparelho — começar no celular e continuar no PC era impossível. Isto é só um
// espelho server-side por usuário+chave (a MESMA chave que o localStorage já usa — ver
// chaveRascunho*/chaveRascunhoManual em app.js); o localStorage continua sendo a fonte instantânea
// (zero espera, funciona offline), o servidor só entra pra puxar/empurrar entre aparelhos (ver
// sincronizarRascunhoServidor em app.js). Pessoal: nunca aparece pra outro usuário, mesmo da
// mesma empresa (filtra por usuario_id, não só empresa_id como o resto do sistema) — por isso não
// usa tenant.listar/buscar puro, que só sabe filtrar por empresa.
//
// De propósito, NUNCA passa pelo extrairFotosProfundo (que salva cada data: URI como arquivo
// próprio, ver db.salvarFoto): o autosalvamento dispara a cada pausa de digitação E a cada
// clique/mudança em QUALQUER campo do formulário (ver ligarAutoSalvarRascunho em app.js), então
// uma foto já anexada seria "salva de novo" a cada ciclo desses — um arquivo novo e órfão por
// ciclo, sem nunca ser limpo, pra uma foto que não mudou. O cliente já tira as fotos do draft
// antes de mandar pra cá (ver semFotosProfundo em app.js); o limite de tamanho abaixo é só uma
// rede de segurança contra isso falhar algum dia, não o mecanismo principal.
function rascunhoDoUsuario(data, user, chave) {
  return data.rascunhos.find((r) => r.empresa_id === user.empresa_id && r.usuario_id === user.id && r.chave === chave) || null;
}
const TAMANHO_MAX_RASCUNHO_BYTES = 200 * 1024; // texto de formulário nunca chega perto disso — só pega quem esqueceu de tirar foto
rota('GET', /^\/api\/rascunhos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const meus = data.rascunhos
    .filter((r) => r.empresa_id === user.empresa_id && r.usuario_id === user.id)
    .map((r) => ({ chave: r.chave, draft: r.draft, atualizado_em: r.atualizado_em }));
  enviarJSON(res, 200, { rascunhos: meus });
});
// GET /api/rascunhos/:chave — um rascunho específico (chave = a mesma usada no localStorage)
rota('GET', /^\/api\/rascunhos\/([^/]+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const r = rascunhoDoUsuario(data, user, decodeURIComponent(m[1]));
  enviarJSON(res, 200, { rascunho: r ? { chave: r.chave, draft: r.draft, atualizado_em: r.atualizado_em } : null });
});
// PUT /api/rascunhos { chave, draft } — cria ou substitui (upsert por usuario_id+chave)
rota('PUT', /^\/api\/rascunhos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  const chave = String(body.chave || '').trim();
  if (!chave) return enviarJSON(res, 400, { erro: 'Informe a chave do rascunho.' });
  if (Buffer.byteLength(JSON.stringify(body.draft || {})) > TAMANHO_MAX_RASCUNHO_BYTES) {
    return enviarJSON(res, 400, { erro: 'Rascunho grande demais pra sincronizar — provavelmente tem foto anexada (fotos não sincronizam entre aparelhos).' });
  }
  const data = db.load();
  const agora = new Date().toISOString();
  let r = data.rascunhos.find((x) => x.empresa_id === user.empresa_id && x.usuario_id === user.id && x.chave === chave);
  if (r) { r.draft = body.draft; r.atualizado_em = agora; }
  else { r = tenant.criar(data, 'rascunhos', user.empresa_id, { usuario_id: user.id, chave, draft: body.draft, atualizado_em: agora }); }
  db.save(data);
  enviarJSON(res, 200, { rascunho: { chave: r.chave, draft: r.draft, atualizado_em: r.atualizado_em } });
});
// DELETE /api/rascunhos/:chave — chamado junto com o localStorage.removeItem (envio concluído ou
// "Descartar rascunho" explícito), pra não deixar o espelho do servidor sobrando.
rota('DELETE', /^\/api\/rascunhos\/([^/]+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const chave = decodeURIComponent(m[1]);
  const data = db.load();
  data.rascunhos = data.rascunhos.filter((r) => !(r.empresa_id === user.empresa_id && r.usuario_id === user.id && r.chave === chave));
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/equipamentos/:id/historico
rota('GET', /^\/api\/equipamentos\/(\d+)\/historico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const eqId = Number(m[1]);
  const agendaItens = tenant.listar(data, 'agenda', user.empresa_id).filter((a) => a.equipamento_id === eqId).map((a) => agendaComDetalhes(data, a));
  const visitasItens = data.visitas.filter((v) => v.equipamento_id === eqId && v.empresa_id === user.empresa_id);
  enviarJSON(res, 200, { agenda: agendaItens, visitas: visitasItens });
});

// ---------- FMEA (RCM/SAP PM, Fase 1 passo 1 do plano aprovado) ----------
// catálogo em cascata cadastrado pelo administrador — Componente (preso a um modelo do catálogo
// de equipamentos, ou seja, um "equipamentos" com cliente_id null) → Modo de falha
// (severidade/ocorrência/detecção, 1-10, RPN = S×O×D) → Causa → Efeito. Ainda não é usado em
// nenhuma O.S./laudo (isso é o passo 3) — este passo só cria a fundação de dados. Mesmo padrão de
// permissão já usado nos outros catálogos administrativos (feriados etc.): qualquer autenticado
// da empresa lê, só o administrador cadastra/edita/exclui.

function calcularRpn(severidade, ocorrencia, deteccao) { return severidade * ocorrencia * deteccao; }

function validarEscalaFmea(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 10) return `${campo} precisa ser um número inteiro de 1 a 10.`;
  return null;
}

// GET /api/fmea/componentes?catalogo_id=X
rota('GET', /^\/api\/fmea\/componentes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'fmea_componentes', user.empresa_id);
  if (query.catalogo_id) lista = lista.filter((c) => c.catalogo_id === Number(query.catalogo_id));
  enviarJSON(res, 200, { componentes: lista });
});

// POST /api/fmea/componentes { catalogo_id, nome }
rota('POST', /^\/api\/fmea\/componentes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra componentes.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do componente.' });
  const data = db.load();
  const catalogoId = Number(body.catalogo_id);
  const catalogo = tenant.buscar(data, 'equipamentos', catalogoId, user.empresa_id);
  if (!catalogo || catalogo.cliente_id !== null) {
    return enviarJSON(res, 400, { erro: 'Modelo do catálogo não encontrado (escolha um equipamento do catálogo, não uma unidade já atrelada a um cliente).' });
  }
  const item = tenant.criar(data, 'fmea_componentes', user.empresa_id, {
    catalogo_id: catalogoId, nome: String(body.nome).trim(), criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { componente: item });
});

// PUT /api/fmea/componentes/:id
rota('PUT', /^\/api\/fmea\/componentes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita componentes.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do componente.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_componentes', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Componente não encontrado.' });
  item.nome = String(body.nome).trim();
  db.save(data);
  enviarJSON(res, 200, { componente: item });
});

// DELETE /api/fmea/componentes/:id — bloqueado se já tiver modo de falha cadastrado embaixo
rota('DELETE', /^\/api\/fmea\/componentes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui componentes.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_componentes', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Componente não encontrado.' });
  if (tenant.listar(data, 'fmea_modos_falha', user.empresa_id).some((mf) => mf.componente_id === item.id)) {
    return enviarJSON(res, 400, { erro: 'Existem modos de falha cadastrados neste componente. Exclua-os antes.' });
  }
  data.fmea_componentes = data.fmea_componentes.filter((c) => c.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/fmea/modos-falha?componente_id=X
// enriquece com nome do componente, tipo/modelo do catálogo de origem, e ocorrencias_reais —
// quantas vezes esse modo de falha foi escolhido de verdade num laudo técnico (ver passo 3). Usado
// tanto pros selects em cascata (ignora os campos extras) quanto pelo ranking RPN e pela sugestão
// de ocorrência na tela de edição (passo 5) — sem precisar de outro endpoint pra isso.
function modosFalhaEnriquecidos(data, empresaId, lista) {
  const visitasComFmea = tenant.listar(data, 'visitas', empresaId).filter((v) => v.laudo && v.laudo.modo_falha_id);
  return lista.map((mf) => {
    const componente = data.fmea_componentes.find((c) => c.id === mf.componente_id && c.empresa_id === empresaId);
    const catalogo = componente ? data.equipamentos.find((e) => e.id === componente.catalogo_id && e.empresa_id === empresaId) : null;
    return {
      ...mf,
      componente_nome: componente ? componente.nome : '',
      catalogo_tipo: catalogo ? catalogo.tipo : '',
      catalogo_modelo: catalogo ? catalogo.modelo : '',
      ocorrencias_reais: visitasComFmea.filter((v) => v.laudo.modo_falha_id === mf.id).length,
    };
  });
}

rota('GET', /^\/api\/fmea\/modos-falha$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'fmea_modos_falha', user.empresa_id);
  if (query.componente_id) lista = lista.filter((mf) => mf.componente_id === Number(query.componente_id));
  enviarJSON(res, 200, { modos_falha: modosFalhaEnriquecidos(data, user.empresa_id, lista) });
});

// POST /api/fmea/modos-falha { componente_id, nome, severidade, ocorrencia, deteccao }
rota('POST', /^\/api\/fmea\/modos-falha$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra modos de falha.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do modo de falha.' });
  for (const [valor, campo] of [[body.severidade, 'Severidade'], [body.ocorrencia, 'Ocorrência'], [body.deteccao, 'Detecção']]) {
    const erro = validarEscalaFmea(valor, campo);
    if (erro) return enviarJSON(res, 400, { erro });
  }
  const data = db.load();
  const componente = tenant.buscar(data, 'fmea_componentes', Number(body.componente_id), user.empresa_id);
  if (!componente) return enviarJSON(res, 400, { erro: 'Componente não encontrado.' });
  const severidade = Number(body.severidade), ocorrencia = Number(body.ocorrencia), deteccao = Number(body.deteccao);
  const item = tenant.criar(data, 'fmea_modos_falha', user.empresa_id, {
    componente_id: componente.id, nome: String(body.nome).trim(),
    severidade, ocorrencia, deteccao, rpn: calcularRpn(severidade, ocorrencia, deteccao),
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { modo_falha: item });
});

// PUT /api/fmea/modos-falha/:id
rota('PUT', /^\/api\/fmea\/modos-falha\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita modos de falha.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do modo de falha.' });
  for (const [valor, campo] of [[body.severidade, 'Severidade'], [body.ocorrencia, 'Ocorrência'], [body.deteccao, 'Detecção']]) {
    const erro = validarEscalaFmea(valor, campo);
    if (erro) return enviarJSON(res, 400, { erro });
  }
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_modos_falha', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Modo de falha não encontrado.' });
  item.nome = String(body.nome).trim();
  item.severidade = Number(body.severidade);
  item.ocorrencia = Number(body.ocorrencia);
  item.deteccao = Number(body.deteccao);
  item.rpn = calcularRpn(item.severidade, item.ocorrencia, item.deteccao);
  db.save(data);
  enviarJSON(res, 200, { modo_falha: item });
});

// DELETE /api/fmea/modos-falha/:id — bloqueado se já tiver causa cadastrada embaixo
rota('DELETE', /^\/api\/fmea\/modos-falha\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui modos de falha.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_modos_falha', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Modo de falha não encontrado.' });
  if (tenant.listar(data, 'fmea_causas', user.empresa_id).some((c) => c.modo_falha_id === item.id)) {
    return enviarJSON(res, 400, { erro: 'Existem causas cadastradas neste modo de falha. Exclua-as antes.' });
  }
  data.fmea_modos_falha = data.fmea_modos_falha.filter((mf) => mf.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/fmea/causas?modo_falha_id=X
rota('GET', /^\/api\/fmea\/causas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'fmea_causas', user.empresa_id);
  if (query.modo_falha_id) lista = lista.filter((c) => c.modo_falha_id === Number(query.modo_falha_id));
  enviarJSON(res, 200, { causas: lista });
});

// POST /api/fmea/causas { modo_falha_id, nome }
rota('POST', /^\/api\/fmea\/causas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra causas.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome da causa.' });
  const data = db.load();
  const modoFalha = tenant.buscar(data, 'fmea_modos_falha', Number(body.modo_falha_id), user.empresa_id);
  if (!modoFalha) return enviarJSON(res, 400, { erro: 'Modo de falha não encontrado.' });
  const item = tenant.criar(data, 'fmea_causas', user.empresa_id, {
    modo_falha_id: modoFalha.id, nome: String(body.nome).trim(), criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { causa: item });
});

// PUT /api/fmea/causas/:id
rota('PUT', /^\/api\/fmea\/causas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita causas.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome da causa.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_causas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Causa não encontrada.' });
  item.nome = String(body.nome).trim();
  db.save(data);
  enviarJSON(res, 200, { causa: item });
});

// DELETE /api/fmea/causas/:id — bloqueado se já tiver efeito cadastrado embaixo
rota('DELETE', /^\/api\/fmea\/causas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui causas.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_causas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Causa não encontrada.' });
  if (tenant.listar(data, 'fmea_efeitos', user.empresa_id).some((e) => e.causa_id === item.id)) {
    return enviarJSON(res, 400, { erro: 'Existem efeitos cadastrados nesta causa. Exclua-os antes.' });
  }
  data.fmea_causas = data.fmea_causas.filter((c) => c.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/fmea/efeitos?causa_id=X
rota('GET', /^\/api\/fmea\/efeitos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'fmea_efeitos', user.empresa_id);
  if (query.causa_id) lista = lista.filter((e) => e.causa_id === Number(query.causa_id));
  enviarJSON(res, 200, { efeitos: lista });
});

// POST /api/fmea/efeitos { causa_id, nome }
rota('POST', /^\/api\/fmea\/efeitos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra efeitos.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do efeito.' });
  const data = db.load();
  const causa = tenant.buscar(data, 'fmea_causas', Number(body.causa_id), user.empresa_id);
  if (!causa) return enviarJSON(res, 400, { erro: 'Causa não encontrada.' });
  const item = tenant.criar(data, 'fmea_efeitos', user.empresa_id, {
    causa_id: causa.id, nome: String(body.nome).trim(), criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { efeito: item });
});

// PUT /api/fmea/efeitos/:id
rota('PUT', /^\/api\/fmea\/efeitos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita efeitos.' });
  const body = await lerCorpo(req);
  if (!String(body.nome || '').trim()) return enviarJSON(res, 400, { erro: 'Informe o nome do efeito.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_efeitos', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Efeito não encontrado.' });
  item.nome = String(body.nome).trim();
  db.save(data);
  enviarJSON(res, 200, { efeito: item });
});

// DELETE /api/fmea/efeitos/:id
rota('DELETE', /^\/api\/fmea\/efeitos\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui efeitos.' });
  const data = db.load();
  const item = tenant.buscar(data, 'fmea_efeitos', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Efeito não encontrado.' });
  data.fmea_efeitos = data.fmea_efeitos.filter((e) => e.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/fmea/pareto?agrupar_por=componente|equipamento (padrão: componente) — Fase 1/passo 5.
// Diferente do ranking RPN (que é o catálogo cadastrado, sem depender de nenhum atendimento ter
// acontecido), o Pareto conta falhas DE VERDADE: cada laudo técnico (visita) que teve a cascata
// FMEA preenchida (passo 3) soma 1 na contagem do componente ou do equipamento escolhido ali.
// Ordenado do mais frequente pro menos, com percentual e percentual acumulado — a curva clássica
// de Pareto (os ~20% das causas que respondem por ~80% das falhas).
rota('GET', /^\/api\/fmea\/pareto$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const agruparPor = query.agrupar_por === 'equipamento' ? 'equipamento' : 'componente';
  const data = db.load();
  const visitasComFmea = tenant.listar(data, 'visitas', user.empresa_id).filter((v) => v.laudo && v.laudo.componente_id);
  const contagem = new Map();
  for (const v of visitasComFmea) {
    let chave, label;
    if (agruparPor === 'equipamento') {
      const eq = data.equipamentos.find((e) => e.id === v.equipamento_id && e.empresa_id === user.empresa_id);
      chave = `eq-${v.equipamento_id}`;
      label = eq ? `${eq.tipo} ${eq.modelo}${eq.numero_serie ? ` (${eq.numero_serie})` : ''}` : 'Equipamento removido';
    } else {
      chave = `comp-${v.laudo.componente_id}`;
      label = v.laudo.componente_nome || 'Componente removido';
    }
    if (!contagem.has(chave)) contagem.set(chave, { label, qtd: 0 });
    contagem.get(chave).qtd += 1;
  }
  const lista = [...contagem.values()].sort((a, b) => b.qtd - a.qtd);
  const total = lista.reduce((soma, i) => soma + i.qtd, 0);
  let acumulado = 0;
  const pareto = lista.map((i) => {
    acumulado += i.qtd;
    return {
      ...i,
      percentual: total ? Math.round((i.qtd / total) * 1000) / 10 : 0,
      percentual_acumulado: total ? Math.round((acumulado / total) * 1000) / 10 : 0,
    };
  });
  enviarJSON(res, 200, { pareto, total, agrupado_por: agruparPor });
});

// KPIs do dashboard do administrador (RCM/SAP PM, Fase 1, passos 6-7) — MTBF, MTTR,
// disponibilidade, backlog, % preventiva×corretiva e gráficos mensais, calculados a partir das
// datas/horas de entrada e conclusão das próprias O.S./laudos técnicos, sem nenhuma coleção nova.
// "Aderência ao plano" fica de fora por enquanto: depende dos Planos de Manutenção (Fase 2, só
// prevista no banco, ainda não implementada) — a tela mostra isso como indisponível.

// filtros = { periodoInicio, periodoFim (strings "AAAA-MM-DD" ou null), clienteId, equipamentoId,
// tecnicoId, contratoManutencao ("com"|"sem"|null) } — os 5 filtros do dashboard de KPIs
// (período/cliente/equipamento/técnico/contrato), aplicados sempre na mesma função pra garantir
// que o dashboard, os gráficos mensais e o drill-down nunca divirjam na definição de "quais O.S.
// entram na conta". `data` só é usado pelo filtro de contrato, que precisa olhar o equipamento de
// cada O.S. (o contrato mora no cadastro do equipamento, não na própria O.S.).
function filtrarAgendaKpis(data, agendaEmpresa, filtros) {
  let lista = agendaEmpresa;
  if (filtros.periodoInicio) {
    const inicioMs = new Date(`${filtros.periodoInicio}T00:00:00`).getTime();
    if (Number.isFinite(inicioMs)) lista = lista.filter((a) => new Date(a.criado_em).getTime() >= inicioMs);
  }
  if (filtros.periodoFim) {
    const fimMs = new Date(`${filtros.periodoFim}T23:59:59.999`).getTime();
    if (Number.isFinite(fimMs)) lista = lista.filter((a) => new Date(a.criado_em).getTime() <= fimMs);
  }
  if (filtros.clienteId) lista = lista.filter((a) => a.cliente_id === filtros.clienteId);
  if (filtros.equipamentoId) lista = lista.filter((a) => a.equipamento_id === filtros.equipamentoId);
  if (filtros.tecnicoId) lista = lista.filter((a) => a.tecnico_id === filtros.tecnicoId);
  if (filtros.contratoManutencao === 'com' || filtros.contratoManutencao === 'sem') {
    lista = lista.filter((a) => {
      const equipamento = data.equipamentos.find((e) => e.id === a.equipamento_id && e.empresa_id === a.empresa_id);
      // tri-estado: equipamento "ainda não informado" (null) não entra em nenhum dos 2 filtros —
      // ele não é "com" nem "sem" contrato de verdade, é desconhecido (passo 11).
      const valor = equipamento ? equipamento.tem_contrato_manutencao : null;
      return filtros.contratoManutencao === 'com' ? valor === true : valor === false;
    });
  }
  return lista;
}

// horas de reparo (conclusão - entrada do Laudo Técnico, rodada 1) de cada O.S. corretiva da lista
// — usado tanto pelo MTTR quanto pela disponibilidade (mesma base, sem duplicar a lógica).
// `incluirParcial` (pedido do usuário: "No mttr o gráfico colocar valores parcial atualizado
// durante o mês") conta também reparos ainda em andamento (entrada preenchida, sem conclusão
// ainda) usando "agora - entrada" como horas parciais — só usado pelo mês corrente do gráfico
// mensal, nunca pro indicador MTTR principal nem pros meses já fechados (ver calcularKpisMensais).
function horasReparoDeCorretivas(data, empresaId, corretivas, { incluirParcial = false, agora = Date.now() } = {}) {
  const horas = [];
  for (const os of corretivas) {
    const visita = data.visitas.find((v) => v.agenda_id === os.id && v.empresa_id === empresaId && (v.rodada || 1) === 1);
    const laudo = visita && visita.laudo;
    if (!laudo || !laudo.data_entrada) continue;
    if (laudo.data_conclusao) {
      const h = (new Date(laudo.data_conclusao).getTime() - new Date(laudo.data_entrada).getTime()) / 36e5;
      if (Number.isFinite(h) && h >= 0) horas.push(h);
    } else if (incluirParcial) {
      const h = (agora - new Date(laudo.data_entrada).getTime()) / 36e5;
      if (Number.isFinite(h) && h >= 0) horas.push(h);
    }
  }
  return horas;
}

function calcularKpis(data, empresaId, filtros = {}) {
  const agendaEmpresa = filtrarAgendaKpis(data, tenant.listar(data, 'agenda', empresaId), filtros);
  const agora = Date.now();

  // MTTR: pega o laudo técnico (rodada 1) de cada O.S. corretiva com data de entrada e conclusão
  // preenchidas — os mesmos campos que o técnico já preenche hoje no Laudo Técnico (ver
  // validarLaudoTecnico). Horas de reparo = conclusão - entrada; MTTR = média dessas horas.
  const corretivas = agendaEmpresa.filter((a) => a.tipo === 'corretiva');
  const horasReparo = horasReparoDeCorretivas(data, empresaId, corretivas);
  const mttrHoras = horasReparo.length ? horasReparo.reduce((s, h) => s + h, 0) / horasReparo.length : null;

  // MTBF: tempo de CALENDÁRIO entre corretivas consecutivas do mesmo equipamento, dentro do
  // recorte filtrado (campo pronto pra receber horas reais de operação no futuro — ver README).
  // Agrupa as corretivas por equipamento, ordena por data de abertura e calcula o intervalo entre
  // cada par consecutivo; MTBF é a média de todos os intervalos (de todos os equipamentos juntos).
  const corretivasPorEquipamento = new Map();
  for (const os of corretivas) {
    if (!os.equipamento_id) continue;
    if (!corretivasPorEquipamento.has(os.equipamento_id)) corretivasPorEquipamento.set(os.equipamento_id, []);
    corretivasPorEquipamento.get(os.equipamento_id).push(os);
  }
  const intervalosDias = [];
  for (const lista of corretivasPorEquipamento.values()) {
    const ordenada = [...lista].sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime());
    for (let i = 1; i < ordenada.length; i++) {
      const dias = (new Date(ordenada[i].criado_em).getTime() - new Date(ordenada[i - 1].criado_em).getTime()) / 864e5;
      if (Number.isFinite(dias) && dias >= 0) intervalosDias.push(dias);
    }
  }
  const mtbfDias = intervalosDias.length ? intervalosDias.reduce((s, d) => s + d, 0) / intervalosDias.length : null;

  // Disponibilidade: aproximação com os mesmos dados (sem horas reais de operação ainda) — horas
  // paradas = soma de todas as horas de reparo (as mesmas do MTTR); horas totais = soma, por
  // equipamento com pelo menos uma O.S. no recorte filtrado, do tempo de calendário dentro da
  // janela analisada. Sem filtro de período, a janela é "desde a primeira O.S. até agora" (mesma
  // conta do passo 6); com período, fica limitada a esse intervalo.
  const fimJanela = filtros.periodoFim
    ? Math.min(new Date(`${filtros.periodoFim}T23:59:59.999`).getTime(), agora)
    : agora;
  const equipamentosComOS = new Set(agendaEmpresa.filter((a) => a.equipamento_id).map((a) => a.equipamento_id));
  let horasTotaisFrota = 0;
  for (const equipamentoId of equipamentosComOS) {
    const primeiraOS = agendaEmpresa.filter((a) => a.equipamento_id === equipamentoId)
      .reduce((menor, a) => Math.min(menor, new Date(a.criado_em).getTime()), Infinity);
    if (!Number.isFinite(primeiraOS)) continue;
    const inicioJanela = filtros.periodoInicio
      ? Math.max(new Date(`${filtros.periodoInicio}T00:00:00`).getTime(), primeiraOS)
      : primeiraOS;
    if (fimJanela > inicioJanela) horasTotaisFrota += (fimJanela - inicioJanela) / 36e5;
  }
  const horasParadas = horasReparo.reduce((s, h) => s + h, 0);
  const disponibilidadePercentual = horasTotaisFrota > 0
    ? Math.round(Math.max(0, 1 - horasParadas / horasTotaisFrota) * 1000) / 10
    : null;

  // Backlog: O.S. ainda não finalizadas — quantidade e quanto tempo (em horas) elas já estão
  // abertas, somado.
  const abertas = agendaEmpresa.filter((a) => !a.finalizada);
  const backlogQtd = abertas.length;
  const backlogHoras = Math.round(abertas.reduce((s, a) => s + (agora - new Date(a.criado_em).getTime()) / 36e5, 0) * 10) / 10;

  // % preventiva × corretiva: proporção simples entre as O.S. desses 2 tipos (os únicos que hoje
  // usam o Laudo Técnico de verdade — ver TIPOS_LAUDO_TECNICO).
  const preventivas = agendaEmpresa.filter((a) => a.tipo === 'preventiva');
  const totalPC = preventivas.length + corretivas.length;
  const percentualPreventiva = totalPC ? Math.round((preventivas.length / totalPC) * 1000) / 10 : null;
  const percentualCorretiva = totalPC ? Math.round((corretivas.length / totalPC) * 1000) / 10 : null;

  return {
    mtbf_dias: mtbfDias !== null ? Math.round(mtbfDias * 10) / 10 : null,
    mttr_horas: mttrHoras !== null ? Math.round(mttrHoras * 10) / 10 : null,
    disponibilidade_percentual: disponibilidadePercentual,
    backlog_qtd: backlogQtd,
    backlog_horas: backlogHoras,
    percentual_preventiva: percentualPreventiva,
    percentual_corretiva: percentualCorretiva,
    total_os: agendaEmpresa.length, // tile "O.S. no recorte" do dashboard (passo 3 da Opção F)
    aderencia_plano: null, // Fase 2 (Planos de Manutenção) ainda não existe — ver README
  };
}

// Série mensal pros gráficos (passo 7): qtd de preventivas/corretivas e MTTR médio, mês a mês. Sem
// filtro de período informado, cobre os últimos 12 meses (até o mês atual); com período, cobre os
// meses dentro do intervalo pedido, limitado a 24 meses pra não gerar uma série enorme por engano.
// Os filtros de cliente/equipamento/técnico se aplicam normalmente — só o período decide quais
// meses existem na série, não filtra as O.S. dentro de cada mês (isso seria redundante).
function calcularKpisMensais(data, empresaId, filtros = {}) {
  const agendaEmpresa = filtrarAgendaKpis(data, tenant.listar(data, 'agenda', empresaId), {
    clienteId: filtros.clienteId, equipamentoId: filtros.equipamentoId, tecnicoId: filtros.tecnicoId,
    contratoManutencao: filtros.contratoManutencao,
  });
  const fimRef = filtros.periodoFim ? new Date(`${filtros.periodoFim}T00:00:00`) : new Date();
  const inicioRef = filtros.periodoInicio
    ? new Date(`${filtros.periodoInicio}T00:00:00`)
    : new Date(fimRef.getFullYear(), fimRef.getMonth() - 11, 1);

  const chaves = [];
  const cursor = new Date(inicioRef.getFullYear(), inicioRef.getMonth(), 1);
  const limite = new Date(fimRef.getFullYear(), fimRef.getMonth(), 1);
  while (cursor <= limite && chaves.length < 500) {
    chaves.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const chavesLimitadas = chaves.slice(-24);
  const hoje = new Date();
  const chaveMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

  return chavesLimitadas.map((chave) => {
    const [ano, mes] = chave.split('-').map(Number);
    const itensDoMes = agendaEmpresa.filter((a) => {
      const d = new Date(a.criado_em);
      return d.getFullYear() === ano && d.getMonth() + 1 === mes;
    });
    const corretivasMes = itensDoMes.filter((a) => a.tipo === 'corretiva');
    const preventivasMes = itensDoMes.filter((a) => a.tipo === 'preventiva');
    // pedido do usuário: "No mttr o gráfico colocar valores parcial atualizado durante o mês" — o
    // mês corrente entra com reparo em andamento contado parcialmente (agora - entrada), pra não
    // ficar sem ponto no gráfico até o 1º reparo do mês ser concluído; meses já fechados continuam
    // só com reparo concluído mesmo (histórico não deve ficar "andando" depois de fechado).
    const ehMesAtual = chave === chaveMesAtual;
    const horasReparoMes = horasReparoDeCorretivas(data, empresaId, corretivasMes, { incluirParcial: ehMesAtual });
    return {
      mes: chave,
      parcial: ehMesAtual,
      preventivas: preventivasMes.length,
      corretivas: corretivasMes.length,
      mttr_horas: horasReparoMes.length ? Math.round((horasReparoMes.reduce((s, h) => s + h, 0) / horasReparoMes.length) * 10) / 10 : null,
    };
  });
}

// Ranking de técnicos por O.S. concluídas no recorte atual (passo 2 da Opção F — dashboard de KPIs
// evoluído). Mesmos filtros/recorte do resto dos indicadores; só entra O.S. com finalizada=true, e
// só técnico (papel suporte) com pelo menos 1 concluída aparece — top 10, do maior pro menor.
function calcularRankingTecnicosKpis(data, empresaId, filtros = {}) {
  const agendaEmpresa = filtrarAgendaKpis(data, tenant.listar(data, 'agenda', empresaId), filtros)
    .filter((a) => a.finalizada && a.tecnico_id);
  const contagem = new Map();
  for (const os of agendaEmpresa) {
    contagem.set(os.tecnico_id, (contagem.get(os.tecnico_id) || 0) + 1);
  }
  const usuariosEmpresa = tenant.listar(data, 'usuarios', empresaId);
  return [...contagem.entries()]
    .map(([tecnicoId, qtd]) => {
      const tecnico = usuariosEmpresa.find((u) => u.id === tecnicoId);
      return { tecnico_id: tecnicoId, tecnico_nome: tecnico ? tecnico.nome : 'Técnico removido', qtd_os_concluidas: qtd };
    })
    .sort((a, b) => b.qtd_os_concluidas - a.qtd_os_concluidas)
    .slice(0, 10);
}

// ---------- KPI de Mão de Obra (pedido do usuário) ----------
// "Crie um indicador kpi de mão de obra, horas em que o técnico fica parado e trabalhando." —
// horas trabalhadas somam a duração real de cada O.S. (data_hora_fim - data_hora_inicio, sempre
// preenchidos — ver obrig em POST/PUT /api/agenda) mais a duração das atividades não programadas
// concluídas/em andamento (ver STATUS_ATIVIDADE_NAO_PROGRAMADA); horas paradas são uma aproximação
// — cada dia 'pendente' (ocioso e ainda sem justificativa, ver statusDiaTecnico) conta como uma
// jornada padrão inteira. É a mesma lógica de aproximação já usada em "Disponibilidade" (comentário
// ali: "sem horas reais de operação ainda") — fica explícito no retorno (jornada_padrao_horas) pra
// quem for interpretar o número saber a base de cálculo.
const JORNADA_PADRAO_HORAS = 8;

function horasEntreDatasHora(inicio, fim) {
  const i = horarioBrasiliaParaData(inicio);
  const f = horarioBrasiliaParaData(fim);
  if (!i || !f) return 0;
  const h = (f.getTime() - i.getTime()) / 36e5;
  return Number.isFinite(h) && h > 0 ? h : 0;
}

function horasEntreHoraSoDia(diaISO, horaInicio, horaFim) {
  return horasEntreDatasHora(`${diaISO}T${horaInicio}`, `${diaISO}T${horaFim}`);
}

// pedido do usuário: "usar também a O.S. que for feita — técnico inicia deslocamento e, ao indicar
// chegada no destino, mesmo ultrapassando as horas de trabalho normal, as horas excedentes entram
// como saldo positivo." Em vez do horário AGENDADO (data_hora_inicio/fim, que é só a previsão),
// usa o ciclo REAL que o próprio técnico registrou pelos botões de deslocamento (ver
// POST /api/agenda/:id/deslocamento e /chegada): início do deslocamento até a chegada — e, quando
// a O.S. também tem retorno rastreado (viagem com volta), estende até a chegada do retorno, pra
// cobrir o dia inteiro de trabalho (ida + no local + volta). deslocamento_iniciado_em/
// chegada_confirmada_em/retorno_chegada_confirmada_em são timestamps ISO reais (new Date().
// toISOString()), por isso dá pra comparar direto, sem precisar do ajuste de fuso de Brasília que
// data_hora_inicio/fim (vindos de <input type="datetime-local">) exigem.
function horasReaisDaOS(os) {
  if (!os.deslocamento_iniciado_em) return null; // ainda não iniciou (ou não é O.S. em loco) — cai no horário agendado
  const fimIso = os.retorno_chegada_confirmada_em || os.chegada_confirmada_em;
  if (!fimIso) return null; // deslocamento iniciado mas ainda sem chegada registrada — cedo demais pra contar
  const h = (new Date(fimIso).getTime() - new Date(os.deslocamento_iniciado_em).getTime()) / 36e5;
  return Number.isFinite(h) && h > 0 ? h : null;
}

// horas de O.S. do técnico num dia específico (dentro do recorte de filtros já aplicado) — usa o
// ciclo real de deslocamento quando já registrado, senão o horário agendado.
function horasOSDoTecnicoNoDia(agendaFiltrada, tecnicoId, diaISO) {
  return agendaFiltrada.filter((a) => a.tecnico_id === tecnicoId && String(a.data_hora_inicio || '').slice(0, 10) === diaISO)
    .reduce((s, a) => s + (horasReaisDaOS(a) ?? horasEntreDatasHora(a.data_hora_inicio, a.data_hora_fim)), 0);
}

// horas de atividade não programada do técnico num dia específico. "Em andamento" com um fim já
// informado usa esse fim igual uma concluída (é o mesmo horário que a tela mostra — contar outra
// coisa faria o número da tela e o do KPI divergirem); só quando não tem fim nenhum informado é
// que conta até agora (se for hoje) ou até o fim daquele dia (se for um dia passado que o técnico
// nunca voltou a marcar como concluído), pra nunca deixar uma atividade esquecida inflar as horas
// trabalhadas indefinidamente.
function horasAtividadesDoTecnicoNoDia(registro, diaISO, hojeISO, agora) {
  if (!registro) return 0;
  let horas = 0;
  for (const at of (registro.atividades || [])) {
    if (at.inicio && at.fim && (at.status === 'concluido' || at.status === 'em_andamento')) {
      horas += horasEntreHoraSoDia(diaISO, at.inicio, at.fim);
    } else if (at.status === 'em_andamento' && at.inicio) {
      const inicioMs = horarioBrasiliaParaData(`${diaISO}T${at.inicio}`);
      if (!inicioMs) continue;
      const tetoMs = diaISO === hojeISO ? agora : (horarioBrasiliaParaData(`${diaISO}T23:59`) || agora).getTime();
      const h = (Math.min(agora, tetoMs) - inicioMs.getTime()) / 36e5;
      if (Number.isFinite(h) && h > 0) horas += h;
    }
  }
  return horas;
}

function calcularMaoDeObra(data, empresaId, filtros = {}) {
  const hojeISO = hojeBrasiliaISO();
  const periodoInicio = filtros.periodoInicio || `${hojeISO.slice(0, 7)}-01`;
  const periodoFim = filtros.periodoFim || hojeISO;

  const agendaFiltrada = filtrarAgendaKpis(data, tenant.listar(data, 'agenda', empresaId), filtros);
  const atividadesNoPeriodo = tenant.listar(data, 'atividades_nao_programadas', empresaId)
    .filter((a) => a.data >= periodoInicio && a.data <= periodoFim);

  let tecnicos = tenant.listar(data, 'usuarios', empresaId).filter((u) => u.papel === 'suporte' && u.status === 'ativo');
  if (filtros.tecnicoId) tecnicos = tecnicos.filter((u) => u.id === filtros.tecnicoId);

  const agora = Date.now();
  // pedido do usuário: "as horas trabalhadas são 8 horas diárias pra cada técnico, evitar se ele
  // justificar 3 horas, 5 horas está ocioso" — a jornada de referência é checada DIA A DIA, não só
  // no agregado do período: um dia com 3h de atividade registrada ainda sobra 5h de "parado" nesse
  // mesmo dia, mesmo ele não sendo mais um dia 'pendente' pra tela de Atividades do Dia.
  //
  // Depois, outro pedido: "mesmo ultrapassando as horas de trabalho normal, as horas excedentes
  // entram como saldo positivo pra [um] colchão acumulado" — ex.: um dia só com 6h de atividade
  // (2h parado) e outro dia de O.S. com 14h reais de trabalho (6h excedentes) juntos no período dão
  // saldo líquido +4h (6 − 2), não "2h paradas + 6h excedentes" cada um isolado. Por isso o saldo de
  // cada dia (horas logadas − jornada, pode ser negativo) é somado ALGEBRICAMENTE no período inteiro
  // antes de separar em paradas (déficit líquido) e excedentes (superávit líquido) — dia bom cobre
  // dia ruim dentro do mesmo recorte.
  //
  // E por último: "se ele recebe uma compensação essas horas também é abatida — pode ser
  // compensação de dia inteiro e horas definida parcial" — um dia marcado na Escala de Folga como
  // banco_horas é o técnico GASTANDO o colchão (reaproveita horasBancoDaModalidade, a mesma conta
  // já usada lá: dia inteiro = jornada cheia, entrada/saída parcial = só a diferença do horário
  // escolhido pro turno padrão). DSR/férias/home_office continuam neutros — não é banco de horas.
  const linhas = tecnicos.map((t) => {
    const dias = diasNoIntervaloTecnico(data, empresaId, t.id, periodoInicio, periodoFim);
    let horasTrabalhadas = 0; // soma bruta logada (informativa — sem compensação entre dias)
    let saldoLiquido = 0; // soma de (logadas − jornada) de cada dia útil, menos o que já foi gasto em banco_horas — pode virar negativo ou positivo
    let diasUteis = 0;
    let diasPendentes = 0; // dias sem NENHUMA O.S./atividade registrada (métrica à parte, pra "preencheu ou nem abriu o formulário")
    for (const d of dias) {
      if (d.status === 'futuro') continue; // ainda não aconteceu
      if (d.status === 'folga') {
        if (d.escala && d.escala.tipo === 'banco_horas') {
          saldoLiquido -= horasBancoDaModalidade(d.escala.modalidade_banco, d.escala.horario);
        }
        continue; // folga não soma dia útil nem gera déficit — só abate o colchão quando é banco_horas
      }
      diasUteis++;
      let logadas = 0;
      if (d.status === 'os') {
        logadas = horasOSDoTecnicoNoDia(agendaFiltrada, t.id, d.data);
      } else if (d.status === 'justificado') {
        const registro = atividadesNoPeriodo.find((a) => a.usuario_id === t.id && a.data === d.data);
        logadas = horasAtividadesDoTecnicoNoDia(registro, d.data, hojeISO, agora);
      } else {
        diasPendentes++; // 'pendente' — nada registrado nesse dia
      }
      horasTrabalhadas += logadas;
      saldoLiquido += logadas - JORNADA_PADRAO_HORAS;
    }
    horasTrabalhadas = Math.round(horasTrabalhadas * 10) / 10;
    const horasParadas = Math.round(Math.max(0, -saldoLiquido) * 10) / 10; // déficit líquido do período
    const horasExcedentes = Math.round(Math.max(0, saldoLiquido) * 10) / 10; // saldo positivo (colchão) do período
    const jornadaTotal = diasUteis * JORNADA_PADRAO_HORAS;
    const percentualOcupacao = jornadaTotal > 0 ? Math.round((horasTrabalhadas / jornadaTotal) * 1000) / 10 : null;

    return {
      tecnico_id: t.id, tecnico_nome: t.nome,
      horas_trabalhadas: horasTrabalhadas, horas_paradas: horasParadas, horas_excedentes: horasExcedentes,
      dias_pendentes: diasPendentes, percentual_ocupacao: percentualOcupacao, _jornada_total: jornadaTotal,
    };
  }).sort((a, b) => (a.percentual_ocupacao ?? 101) - (b.percentual_ocupacao ?? 101)); // mais ocioso primeiro

  const totalTrabalhadas = Math.round(linhas.reduce((s, l) => s + l.horas_trabalhadas, 0) * 10) / 10;
  const totalParadas = Math.round(linhas.reduce((s, l) => s + l.horas_paradas, 0) * 10) / 10;
  const totalExcedentes = Math.round(linhas.reduce((s, l) => s + l.horas_excedentes, 0) * 10) / 10;
  // ponderado pelos dias úteis de cada técnico (não é só a média simples dos %), pra um técnico com
  // poucos dias no recorte (ex.: entrou na equipe no meio do período) não pesar igual a um que tem
  // o período inteiro.
  const jornadaTotalEquipe = linhas.reduce((s, l) => s + l._jornada_total, 0);
  const tecnicosSemCampoInterno = linhas.map(({ _jornada_total, ...resto }) => resto);

  return {
    periodo: { inicio: periodoInicio, fim: periodoFim },
    jornada_padrao_horas: JORNADA_PADRAO_HORAS,
    equipe: {
      horas_trabalhadas: totalTrabalhadas, horas_paradas: totalParadas, horas_excedentes: totalExcedentes,
      percentual_ocupacao: jornadaTotalEquipe > 0 ? Math.round((totalTrabalhadas / jornadaTotalEquipe) * 1000) / 10 : null,
    },
    tecnicos: tecnicosSemCampoInterno,
  };
}

// lê e normaliza os 5 filtros (período/cliente/equipamento/técnico/contrato) da query string —
// mesma leitura pros 3 endpoints (dashboard, série mensal e drill-down), pra nunca interpretarem o
// mesmo filtro de jeitos diferentes.
function filtrosKpisDaQuery(query) {
  return {
    periodoInicio: query.periodo_inicio ? String(query.periodo_inicio).slice(0, 10) : null,
    periodoFim: query.periodo_fim ? String(query.periodo_fim).slice(0, 10) : null,
    clienteId: query.cliente_id ? Number(query.cliente_id) : null,
    equipamentoId: query.equipamento_id ? Number(query.equipamento_id) : null,
    tecnicoId: query.tecnico_id ? Number(query.tecnico_id) : null,
    contratoManutencao: query.contrato === 'com' || query.contrato === 'sem' ? query.contrato : null,
  };
}

// cliente/equipamento/nº da O.S. legíveis pra exibir numa linha de detalhe — mesma resolução que
// agendaComDetalhes já faz, só que sem o resto dos ~15 campos que o detalhe de KPI não usa.
function contextoOS(data, empresaId, os) {
  const cliente = data.clientes.find((c) => c.id === os.cliente_id && c.empresa_id === empresaId);
  const equipamento = data.equipamentos.find((e) => e.id === os.equipamento_id && e.empresa_id === empresaId);
  return {
    numero_os: os.numero_os || `OS-${String(os.id).padStart(6, '0')}`,
    cliente_nome: cliente ? cliente.nome_empresa : (os.cliente_nome_manual || '—'),
    equipamento_descricao: equipamento
      ? `${equipamento.tipo} ${equipamento.modelo}${equipamento.numero_serie ? ` (${equipamento.numero_serie})` : ''}`
      : (os.equipamento_manual || '—'),
  };
}

// Drill-down por indicador (passo 9) — quais clientes/equipamentos/O.S. formam o número de cada
// card do dashboard, no mesmo recorte de filtros já aplicado. Reaproveita exatamente a mesma
// filtragem (filtrarAgendaKpis) e a mesma base de horas de reparo (horasReparoDeCorretivas) que
// calcularKpis usa, pra nunca a lista de detalhe divergir do número agregado que ela explica.
function calcularKpiDetalhe(data, empresaId, indicador, filtros) {
  const agendaEmpresa = filtrarAgendaKpis(data, tenant.listar(data, 'agenda', empresaId), filtros);
  const agora = Date.now();

  if (indicador === 'mttr') {
    const corretivas = agendaEmpresa.filter((a) => a.tipo === 'corretiva');
    const linhas = [];
    for (const os of corretivas) {
      const visita = data.visitas.find((v) => v.agenda_id === os.id && v.empresa_id === empresaId && (v.rodada || 1) === 1);
      const laudo = visita && visita.laudo;
      if (!laudo || !laudo.data_entrada || !laudo.data_conclusao) continue;
      const horas = (new Date(laudo.data_conclusao).getTime() - new Date(laudo.data_entrada).getTime()) / 36e5;
      if (!Number.isFinite(horas) || horas < 0) continue;
      linhas.push({ ...contextoOS(data, empresaId, os), data_entrada: laudo.data_entrada, data_conclusao: laudo.data_conclusao, horas_reparo: Math.round(horas * 10) / 10 });
    }
    return linhas;
  }

  if (indicador === 'mtbf') {
    const corretivasPorEquipamento = new Map();
    for (const os of agendaEmpresa) {
      if (os.tipo !== 'corretiva' || !os.equipamento_id) continue;
      if (!corretivasPorEquipamento.has(os.equipamento_id)) corretivasPorEquipamento.set(os.equipamento_id, []);
      corretivasPorEquipamento.get(os.equipamento_id).push(os);
    }
    const linhas = [];
    for (const lista of corretivasPorEquipamento.values()) {
      const ordenada = [...lista].sort((a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime());
      for (let i = 1; i < ordenada.length; i++) {
        const dias = (new Date(ordenada[i].criado_em).getTime() - new Date(ordenada[i - 1].criado_em).getTime()) / 864e5;
        if (!Number.isFinite(dias) || dias < 0) continue;
        const ctx = contextoOS(data, empresaId, ordenada[i]);
        linhas.push({
          cliente_nome: ctx.cliente_nome, equipamento_descricao: ctx.equipamento_descricao,
          os_anterior: ordenada[i - 1].numero_os || `OS-${String(ordenada[i - 1].id).padStart(6, '0')}`, data_anterior: ordenada[i - 1].criado_em,
          os_atual: ctx.numero_os, data_atual: ordenada[i].criado_em,
          intervalo_dias: Math.round(dias * 10) / 10,
        });
      }
    }
    return linhas;
  }

  if (indicador === 'backlog') {
    return agendaEmpresa.filter((a) => !a.finalizada).map((os) => ({
      ...contextoOS(data, empresaId, os), tipo: os.tipo, criado_em: os.criado_em,
      horas_aberta: Math.round(((agora - new Date(os.criado_em).getTime()) / 36e5) * 10) / 10,
    }));
  }

  if (indicador === 'preventiva_corretiva') {
    return agendaEmpresa.filter((a) => a.tipo === 'preventiva' || a.tipo === 'corretiva')
      .map((os) => ({ ...contextoOS(data, empresaId, os), tipo: os.tipo, criado_em: os.criado_em }));
  }

  // "O.S. no recorte" (passo 3 da Opção F) — qualquer tipo, não só preventiva/corretiva. Serve a
  // tile de total e o calendário mensal do dashboard (que pinta os pontos de cada dia a partir
  // daqui, filtrando o período pro mês em exibição).
  if (indicador === 'total_os') {
    return agendaEmpresa.map((os) => ({ ...contextoOS(data, empresaId, os), tipo: os.tipo, criado_em: os.criado_em }));
  }

  if (indicador === 'disponibilidade') {
    const corretivas = agendaEmpresa.filter((a) => a.tipo === 'corretiva');
    const horasReparoPorEquipamento = new Map();
    for (const os of corretivas) {
      const visita = data.visitas.find((v) => v.agenda_id === os.id && v.empresa_id === empresaId && (v.rodada || 1) === 1);
      const laudo = visita && visita.laudo;
      if (!laudo || !laudo.data_entrada || !laudo.data_conclusao) continue;
      const h = (new Date(laudo.data_conclusao).getTime() - new Date(laudo.data_entrada).getTime()) / 36e5;
      if (!Number.isFinite(h) || h < 0) continue;
      horasReparoPorEquipamento.set(os.equipamento_id, (horasReparoPorEquipamento.get(os.equipamento_id) || 0) + h);
    }
    const fimJanela = filtros.periodoFim
      ? Math.min(new Date(`${filtros.periodoFim}T23:59:59.999`).getTime(), agora)
      : agora;
    const equipamentosComOS = new Set(agendaEmpresa.filter((a) => a.equipamento_id).map((a) => a.equipamento_id));
    const linhas = [];
    for (const equipamentoId of equipamentosComOS) {
      const itensDoEquipamento = agendaEmpresa.filter((a) => a.equipamento_id === equipamentoId);
      const primeiraOS = itensDoEquipamento.reduce((menor, a) => Math.min(menor, new Date(a.criado_em).getTime()), Infinity);
      if (!Number.isFinite(primeiraOS)) continue;
      const inicioJanela = filtros.periodoInicio
        ? Math.max(new Date(`${filtros.periodoInicio}T00:00:00`).getTime(), primeiraOS)
        : primeiraOS;
      const horasTotais = fimJanela > inicioJanela ? (fimJanela - inicioJanela) / 36e5 : 0;
      const horasParadas = horasReparoPorEquipamento.get(equipamentoId) || 0;
      const ctx = contextoOS(data, empresaId, itensDoEquipamento[0]);
      const equipamento = data.equipamentos.find((e) => e.id === equipamentoId && e.empresa_id === empresaId);
      linhas.push({
        cliente_nome: ctx.cliente_nome, equipamento_descricao: ctx.equipamento_descricao,
        tem_contrato_manutencao: equipamento ? equipamento.tem_contrato_manutencao : null,
        horas_totais: Math.round(horasTotais * 10) / 10, horas_paradas: Math.round(horasParadas * 10) / 10,
        disponibilidade_percentual: horasTotais > 0 ? Math.round(Math.max(0, 1 - horasParadas / horasTotais) * 1000) / 10 : null,
      });
    }
    return linhas;
  }

  return [];
}

rota('GET', /^\/api\/kpis$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê os indicadores.' });
  const { query } = url.parse(req.url, true);
  const filtros = filtrosKpisDaQuery(query);
  const data = db.load();
  enviarJSON(res, 200, { kpis: calcularKpis(data, user.empresa_id, filtros), filtros_aplicados: filtros });
});

rota('GET', /^\/api\/kpis\/mensal$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê os indicadores.' });
  const { query } = url.parse(req.url, true);
  const filtros = filtrosKpisDaQuery(query);
  const data = db.load();
  enviarJSON(res, 200, { meses: calcularKpisMensais(data, user.empresa_id, filtros) });
});

rota('GET', /^\/api\/kpis\/ranking-tecnicos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê os indicadores.' });
  const { query } = url.parse(req.url, true);
  const filtros = filtrosKpisDaQuery(query);
  const data = db.load();
  enviarJSON(res, 200, { ranking: calcularRankingTecnicosKpis(data, user.empresa_id, filtros) });
});

// GET /api/kpis/mao-de-obra — horas trabalhadas × paradas por técnico, no mesmo recorte de
// filtros do resto do dashboard (ver calcularMaoDeObra).
rota('GET', /^\/api\/kpis\/mao-de-obra$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê os indicadores.' });
  const { query } = url.parse(req.url, true);
  const filtros = filtrosKpisDaQuery(query);
  const data = db.load();
  enviarJSON(res, 200, calcularMaoDeObra(data, user.empresa_id, filtros));
});

const INDICADORES_KPI_VALIDOS = ['mtbf', 'mttr', 'disponibilidade', 'backlog', 'preventiva_corretiva', 'total_os'];
// GET /api/kpis/detalhe?indicador=mtbf|mttr|disponibilidade|backlog|preventiva_corretiva (+ mesmos
// filtros de período/cliente/equipamento/técnico) — passo 9: quais clientes/equipamentos/O.S.
// formam o número de cada card, pro botão "Ver detalhes" da tela.
rota('GET', /^\/api\/kpis\/detalhe$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê os indicadores.' });
  const { query } = url.parse(req.url, true);
  const indicador = String(query.indicador || '');
  if (!INDICADORES_KPI_VALIDOS.includes(indicador)) {
    return enviarJSON(res, 400, { erro: `Indicador inválido. Use um de: ${INDICADORES_KPI_VALIDOS.join(', ')}.` });
  }
  const filtros = filtrosKpisDaQuery(query);
  const data = db.load();
  enviarJSON(res, 200, { indicador, linhas: calcularKpiDetalhe(data, user.empresa_id, indicador, filtros) });
});

// GET /api/usuarios
rota('GET', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê usuários.' });
  const data = db.load();
  const usuariosDaEmpresa = tenant.listar(data, 'usuarios', user.empresa_id);
  const admin = usuariosDaEmpresa.find((u) => u.id === user.id) || user;
  const usuarios = admin.departamento
    ? usuariosDaEmpresa.filter((u) => u.id === admin.id || papelGerenciavelPorAdmin(admin, u.papel))
    : usuariosDaEmpresa;
  enviarJSON(res, 200, { usuarios: usuarios.map(usuarioPublico) });
});

// POST /api/usuarios  (administrador cadastra usuário — envia convite de primeiro acesso, sem senha)
rota('POST', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra usuários.' });
  const body = await lerCorpo(req);
  if (!body.nome || !body.email || !body.papel) {
    return enviarJSON(res, 400, { erro: 'nome, email e papel são obrigatórios.' });
  }
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
  if (!papelGerenciavelPorAdmin(admin, body.papel)) {
    return enviarJSON(res, 403, { erro: 'Você só pode cadastrar usuários do seu departamento e clientes.' });
  }
  if (papelExigeDepartamentalizacao(data, user.empresa_id, body.papel)) {
    return enviarJSON(res, 400, { erro: 'Perfis de departamento (Comercial/Financeiro) ficam disponíveis a partir do plano em que a equipe cresce ("Equipe e Escala"). Até lá, use o próprio administrador pras funções de orçamento/despesas.' });
  }
  if (papelExigeEstruturaFiliais(data, user.empresa_id, body.papel)) {
    return enviarJSON(res, 400, { erro: 'Gerente de loja/Coordenador técnico/Consultor de mercado ficam disponíveis a partir do módulo "Redes e Filiais". Cadastre primeiro os setores/filiais da empresa.' });
  }
  const refsFilial = validarReferenciasEstruturaFiliais(data, user.empresa_id, body.papel, body);
  if (refsFilial.erro) return enviarJSON(res, 400, { erro: refsFilial.erro });
  if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  // cota de plano (Etapa 6/passo 3) — limite de técnicos (papel "suporte") contratado pela
  // empresa; null/sem campo = sem limite (maioria das empresas hoje). Conta convite pendente
  // junto (já ocupa a vaga, mesmo antes de ativar a conta).
  if (body.papel === 'suporte') {
    const empresaDoUsuario = data.empresas.find((e) => e.id === user.empresa_id);
    const limite = empresaDoUsuario && empresaDoUsuario.limite_tecnicos;
    if (limite != null) {
      const jaTem = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte').length;
      if (jaTem >= limite) {
        return enviarJSON(res, 400, { erro: `Limite de técnicos do plano atingido (${limite}). Fale com o suporte pra ampliar.` });
      }
    }
  }
  const convite_token = gerarTokenConvite();
  const { acesso_total, menus } = sanitizarMenusAcesso(body.papel, body);
  const departamento = body.papel === 'administrador' && !admin.departamento && DEPARTAMENTOS_ADMIN.includes(body.departamento) ? body.departamento : null;
  const novo = tenant.criar(data, 'usuarios', user.empresa_id, {
    nome: body.nome, email: body.email, papel: body.papel,
    cargo: body.cargo || '', setor: body.setor || '',
    celular: body.celular || '', foto_perfil: '', cliente_id: body.cliente_id || null,
    // portal do cliente final do pacote PMOC (Fase 4) — ver comentário em POST /api/login.
    os_refrigeracao_cliente_id: body.papel === 'cliente' ? (body.os_refrigeracao_cliente_id || null) : null,
    filial_id: refsFilial.filial_id, setor_id: refsFilial.setor_id,
    acesso_total, menus, departamento,
    status: 'convite_enviado', convite_token,
    salt: null, hash: null,
  });
  db.save(data);
  const link = `${APP_URL}/ativar.html?token=${convite_token}`;
  const nomeEmpresa = (data.empresas.find((e) => e.id === user.empresa_id) || {}).nome;
  const resultado = await email.enviarConvite({ nome: novo.nome, email: novo.email, link, nomeEmpresa });
  enviarJSON(res, 201, { usuario: usuarioPublico(novo), convite: resultado });
});

// POST /api/usuarios/:id/reenviar-convite
rota('POST', /^\/api\/usuarios\/(\d+)\/reenviar-convite$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador reenvia convites.' });
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
  const u = tenant.buscar(data, 'usuarios', Number(m[1]), user.empresa_id);
  if (!u) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (!papelGerenciavelPorAdmin(admin, u.papel)) {
    return enviarJSON(res, 403, { erro: 'Você só pode reenviar convites do seu departamento e clientes.' });
  }
  if (u.status !== 'convite_enviado') return enviarJSON(res, 400, { erro: 'Este usuário já ativou a conta.' });
  u.convite_token = gerarTokenConvite();
  db.save(data);
  const link = `${APP_URL}/ativar.html?token=${u.convite_token}`;
  const nomeEmpresa = (data.empresas.find((e) => e.id === user.empresa_id) || {}).nome;
  const resultado = await email.enviarConvite({ nome: u.nome, email: u.email, link, nomeEmpresa });
  enviarJSON(res, 200, { usuario: usuarioPublico(u), convite: resultado });
});

// PUT /api/usuarios/:id — administrador edita um usuário
rota('PUT', /^\/api\/usuarios\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador edita usuários.' });
  const body = await lerCorpo(req);
  if (!body.nome || !body.email || !body.papel) {
    return enviarJSON(res, 400, { erro: 'nome, email e papel são obrigatórios.' });
  }
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
  const alvo = tenant.buscar(data, 'usuarios', Number(m[1]), user.empresa_id);
  if (!alvo) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (alvo.protegido && alvo.id !== user.id) {
    return enviarJSON(res, 403, { erro: 'Esta conta é protegida e só pode ser editada por ela mesma.' });
  }
  const editandoASiMesmo = alvo.id === admin.id;
  if (editandoASiMesmo && body.papel !== alvo.papel) {
    return enviarJSON(res, 403, { erro: 'Você não pode alterar seu próprio tipo de acesso.' });
  }
  if (!editandoASiMesmo && (!papelGerenciavelPorAdmin(admin, alvo.papel) || !papelGerenciavelPorAdmin(admin, body.papel))) {
    return enviarJSON(res, 403, { erro: 'Você só pode editar usuários do seu departamento e clientes.' });
  }
  // só bloqueia ao TROCAR pra um perfil de departamento — editar quem já é comercial/financeiro
  // (ex. corrigir telefone) não deve travar por conta de uma empresa que nunca tinha esse perfil
  // antes desta regra existir.
  // só bloqueia ao TROCAR pra um perfil da estrutura de filiais — editar quem já é gerente/
  // coordenador/consultor (ex. corrigir telefone) não trava, mesmo pedido já aplicado acima pra
  // comercial/financeiro (papelExigeDepartamentalizacao).
  if (body.papel !== alvo.papel && papelExigeEstruturaFiliais(data, user.empresa_id, body.papel)) {
    return enviarJSON(res, 400, { erro: 'Gerente de loja/Coordenador técnico/Consultor de mercado ficam disponíveis a partir do módulo "Redes e Filiais". Cadastre primeiro os setores/filiais da empresa.' });
  }
  const refsFilial = validarReferenciasEstruturaFiliais(data, user.empresa_id, body.papel, body, alvo);
  if (refsFilial.erro) return enviarJSON(res, 400, { erro: refsFilial.erro });
  if (body.papel !== alvo.papel && papelExigeDepartamentalizacao(data, user.empresa_id, body.papel)) {
    return enviarJSON(res, 400, { erro: 'Perfis de departamento (Comercial/Financeiro) ficam disponíveis a partir do plano em que a equipe cresce ("Equipe e Escala"). Até lá, use o próprio administrador pras funções de orçamento/despesas.' });
  }
  if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.id !== alvo.id && u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  const { acesso_total, menus } = sanitizarMenusAcesso(body.papel, body);
  const departamento = body.papel === 'administrador'
    ? (admin.departamento ? (alvo.departamento || null) : (DEPARTAMENTOS_ADMIN.includes(body.departamento) ? body.departamento : null))
    : null;
  Object.assign(alvo, {
    nome: body.nome, email: body.email, papel: body.papel,
    cargo: body.cargo || '', setor: body.setor || '',
    celular: body.celular || '', foto_perfil: body.foto_perfil !== undefined ? body.foto_perfil : (alvo.foto_perfil || ''),
    cliente_id: body.papel === 'cliente' ? (body.cliente_id || null) : null,
    os_refrigeracao_cliente_id: body.papel === 'cliente' ? (body.os_refrigeracao_cliente_id || null) : null,
    filial_id: refsFilial.filial_id, setor_id: refsFilial.setor_id,
    acesso_total, menus, departamento,
  });
  db.save(data);
  enviarJSON(res, 200, { usuario: usuarioPublico(alvo) });
});

// DELETE /api/usuarios/:id
rota('DELETE', /^\/api\/usuarios\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui usuários.' });
  const id = Number(m[1]);
  if (id === user.id) return enviarJSON(res, 400, { erro: 'Você não pode excluir a si mesmo.' });
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id) || user;
  const alvoExcluir = tenant.buscar(data, 'usuarios', id, user.empresa_id);
  if (!alvoExcluir) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (alvoExcluir.protegido) {
    return enviarJSON(res, 403, { erro: 'Esta conta é protegida e não pode ser excluída.' });
  }
  if (!papelGerenciavelPorAdmin(admin, alvoExcluir.papel)) {
    return enviarJSON(res, 403, { erro: 'Você só pode excluir usuários do seu departamento e clientes.' });
  }
  data.usuarios = data.usuarios.filter((u) => u.id !== alvoExcluir.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- ficha cadastral ampliada (menu Equipe > Cadastros): certificados, integrações com
// empresas-cliente e competências do técnico. As 3 coleções seguem o mesmo padrão: uma rota GET
// que devolve tudo junto (abrir a ficha não devia precisar de 3 requisições), e POST/DELETE
// dedicados por tipo. Mesma regra de acesso do resto da ficha: só administrador.
rota('GET', /^\/api\/usuarios\/(\d+)\/ficha-extra$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê a ficha cadastral.' });
  const data = db.load();
  const usuarioId = Number(m[1]);
  if (!tenant.buscar(data, 'usuarios', usuarioId, user.empresa_id)) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const certificados = tenant.listar(data, 'certificados_colaborador', user.empresa_id).filter((c) => c.usuario_id === usuarioId);
  const integracoes = tenant.listar(data, 'integracoes_colaborador', user.empresa_id).filter((i) => i.usuario_id === usuarioId).map((i) => {
    const cliente = data.clientes.find((c) => c.id === i.cliente_id && c.empresa_id === user.empresa_id);
    return { ...i, cliente_nome: cliente ? cliente.nome_empresa : i.cliente_nome_manual || '(empresa excluída)' };
  });
  const competencias = tenant.listar(data, 'competencias_colaborador', user.empresa_id).filter((c) => c.usuario_id === usuarioId);
  enviarJSON(res, 200, { certificados, integracoes, competencias });
});

// POST /api/usuarios/:id/certificados — nome + validade opcional + arquivo (PDF ou imagem, base64)
rota('POST', /^\/api\/usuarios\/(\d+)\/certificados$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra certificados.' });
  const data = db.load();
  const usuarioId = Number(m[1]);
  if (!tenant.buscar(data, 'usuarios', usuarioId, user.empresa_id)) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome do certificado é obrigatório.' });
  const item = tenant.criar(data, 'certificados_colaborador', user.empresa_id, {
    usuario_id: usuarioId,
    nome: String(body.nome).trim(),
    data_validade: body.data_validade || null,
    arquivo: body.arquivo || null,
    arquivo_nome: body.arquivo_nome || null,
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { certificado: item });
});

rota('DELETE', /^\/api\/certificados\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui certificados.' });
  const data = db.load();
  const item = tenant.buscar(data, 'certificados_colaborador', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Certificado não encontrado.' });
  data.certificados_colaborador = data.certificados_colaborador.filter((c) => c.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/usuarios/:id/integracoes — empresa-cliente (cliente_id) em que o técnico tem
// acesso/credencial pra atuar, com validade opcional
rota('POST', /^\/api\/usuarios\/(\d+)\/integracoes$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra integrações.' });
  const data = db.load();
  const usuarioId = Number(m[1]);
  if (!tenant.buscar(data, 'usuarios', usuarioId, user.empresa_id)) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const body = await lerCorpo(req);
  const cliente = body.cliente_id ? tenant.buscar(data, 'clientes', Number(body.cliente_id), user.empresa_id) : null;
  if (!cliente && !(body.cliente_nome_manual && String(body.cliente_nome_manual).trim())) {
    return enviarJSON(res, 400, { erro: 'Escolha uma empresa cadastrada ou digite o nome.' });
  }
  const item = tenant.criar(data, 'integracoes_colaborador', user.empresa_id, {
    usuario_id: usuarioId,
    cliente_id: cliente ? cliente.id : null,
    cliente_nome_manual: cliente ? null : String(body.cliente_nome_manual).trim(),
    data_validade: body.data_validade || null,
    observacao: body.observacao || '',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { integracao: { ...item, cliente_nome: cliente ? cliente.nome_empresa : item.cliente_nome_manual } });
});

rota('DELETE', /^\/api\/integracoes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui integrações.' });
  const data = db.load();
  const item = tenant.buscar(data, 'integracoes_colaborador', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Integração não encontrada.' });
  data.integracoes_colaborador = data.integracoes_colaborador.filter((i) => i.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/usuarios/:id/competencias — nível de conhecimento do técnico num equipamento
const NIVEIS_COMPETENCIA = ['basico', 'intermediario', 'avancado'];
rota('POST', /^\/api\/usuarios\/(\d+)\/competencias$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra competências.' });
  const data = db.load();
  const usuarioId = Number(m[1]);
  if (!tenant.buscar(data, 'usuarios', usuarioId, user.empresa_id)) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const body = await lerCorpo(req);
  if (!body.equipamento || !String(body.equipamento).trim()) return enviarJSON(res, 400, { erro: 'Informe o equipamento.' });
  if (!NIVEIS_COMPETENCIA.includes(body.nivel)) return enviarJSON(res, 400, { erro: 'Nível inválido.' });
  const item = tenant.criar(data, 'competencias_colaborador', user.empresa_id, {
    usuario_id: usuarioId,
    equipamento: String(body.equipamento).trim(),
    nivel: body.nivel,
    observacao: body.observacao || '',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { competencia: item });
});

rota('DELETE', /^\/api\/competencias\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui competências.' });
  const data = db.load();
  const item = tenant.buscar(data, 'competencias_colaborador', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Competência não encontrada.' });
  data.competencias_colaborador = data.competencias_colaborador.filter((c) => c.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- atendimento por chat (chamados: IA de 1º nível -> fila -> técnico) ----------
// o mesmo "chamado" é o fio da conversa tanto quando o cliente entra pelo chat dentro do
// Nexor Connect quanto quando manda mensagem pelo WhatsApp (ver whatsapp.js) — o técnico responde
// num lugar só, e se a conversa veio do WhatsApp a resposta dele volta pro WhatsApp do cliente.

// versão pra LISTA (fila, histórico) — sem buscar o histórico de mensagens (mora numa tabela à
// parte agora); usa o resumo já salvo no próprio chamado (primeira_mensagem_cliente) igual antes.
function chamadoResumoLista(data, c) {
  const cliente = data.clientes.find((cl) => cl.id === c.cliente_id && cl.empresa_id === c.empresa_id);
  const tecnico = data.usuarios.find((u) => u.id === c.tecnico_id && u.empresa_id === c.empresa_id);
  const equipamento = data.equipamentos.find((e) => e.id === c.equipamento_id && e.empresa_id === c.empresa_id);
  const os = c.os_id ? tenant.buscar(data, 'agenda', c.os_id, c.empresa_id) : null;
  return {
    ...c,
    cliente_nome: cliente ? cliente.nome_empresa : null,
    tecnico_nome: tecnico ? tecnico.nome : null,
    equipamento_tipo: equipamento ? equipamento.tipo : null,
    equipamento_modelo: equipamento ? equipamento.modelo : null,
    numero_os: os ? (os.numero_os || `OS-${String(os.id).padStart(6, '0')}`) : null,
    os_fase_atendimento: os ? os.fase_atendimento : null,
    os_finalizada: os ? !!os.finalizada : false,
  };
}

// versão pra ITEM ÚNICO (abrir o chat) — busca o histórico de mensagens de verdade
async function chamadoComMensagens(data, c) {
  const mensagens = await db.carregarMensagensChamado(c.id);
  return { ...chamadoResumoLista(data, c), mensagens };
}

async function enviarPushTecnicos(data, empresaId, payload) {
  const tecnicos = tenant.listar(data, 'usuarios', empresaId).filter((u) => u.papel === 'suporte');
  await Promise.all(tecnicos.map((t) => enviarPush(data, t.id, payload).catch(() => {})));
}

// notificarNovoAtendimento — quando um chamado cai na fila, avisa por push todos os técnicos
// (não atribui a ninguém): o chamado fica no pool "Aguardando técnico", visível pra qualquer
// técnico, até alguém entrar e assumir manualmente — nunca vai direto pra um técnico específico.
function notificarNovoAtendimento(data, chamado) {
  const cliente = data.clientes.find((c) => c.id === chamado.cliente_id && c.empresa_id === chamado.empresa_id);
  enviarPushTecnicos(data, chamado.empresa_id, { titulo: 'Novo atendimento aguardando técnico', corpo: cliente ? cliente.nome_empresa : 'Um cliente precisa de ajuda.', url: '/' }).catch(() => {});
}

// POST /api/chamados — o cliente (logado no Nexor Connect) inicia um atendimento com a primeira
// mensagem. Se a IA estiver configurada ela já responde; senão cai direto pra fila do técnico
// (a funcionalidade continua utilizável mesmo sem a IA ligada).
rota('POST', /^\/api\/chamados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['cliente'])) return enviarJSON(res, 403, { erro: 'Só clientes iniciam atendimento por aqui.' });
  if (!user.cliente_id) return enviarJSON(res, 400, { erro: 'Sua conta não está vinculada a uma empresa cliente — fale com o administrador.' });
  const body = await lerCorpo(req);
  if (!body.mensagem || !String(body.mensagem).trim()) return enviarJSON(res, 400, { erro: 'Descreva o problema pra começar o atendimento.' });
  const data = db.load();

  const agora = new Date().toISOString();
  const textoInicial = String(body.mensagem).trim();
  const chamado = tenant.criar(data, 'chamados', user.empresa_id, {
    cliente_id: user.cliente_id,
    telefone_whatsapp: null,
    origem: 'app',
    equipamento_id: body.equipamento_id ? Number(body.equipamento_id) : null,
    status: 'ia',
    prioridade: 'normal',
    tecnico_id: null,
    os_id: null,
    resumo_ia: '',
    resolvido_por: null,
    primeira_mensagem_cliente: textoInicial,
    // mensagens fica só na memória durante esta requisição (histórico mora numa tabela à parte —
    // ver salvarMensagemChamado/chamadoComMensagens); nunca é isso que vai pro banco no blob.
    mensagens: [{ autor: 'cliente', texto: textoInicial, criado_em: agora }],
    lida_tecnico: true,
    lida_cliente: true,
    criado_em: agora,
    atualizado_em: agora,
    assumido_em: null,
    resolvido_em: null,
  });

  if (ia.ativa()) {
    await ia.processarTurno(data, chamado);
  } else {
    chamado.status = 'aguardando_tecnico';
    chamado.mensagens.push({ autor: 'sistema', texto: 'Assistente automático indisponível no momento — um técnico vai te atender em breve.', criado_em: new Date().toISOString() });
  }
  if (chamado.status === 'aguardando_tecnico') {
    notificarNovoAtendimento(data, chamado);
  }
  const mensagensCompletas = chamado.mensagens;
  for (const msg of mensagensCompletas) await db.salvarMensagemChamado(chamado.id, msg);
  chamado.mensagens = [];
  db.save(data);
  enviarJSON(res, 201, { chamado: { ...chamadoResumoLista(data, chamado), mensagens: mensagensCompletas } });
});

// GET /api/chamados/meu-ativo — o cliente pede o atendimento em andamento dele (se tiver), pra
// abrir o chat direto sem precisar saber o id.
rota('GET', /^\/api\/chamados\/meu-ativo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['cliente'])) return enviarJSON(res, 403, { erro: 'Só clientes usam este atendimento.' });
  const data = db.load();
  const chamado = tenant.listar(data, 'chamados', user.empresa_id)
    .filter((c) => c.cliente_id === user.cliente_id && c.status !== 'encerrado')
    .sort((a, b) => (b.atualizado_em || '').localeCompare(a.atualizado_em || ''))[0];
  if (chamado && !chamado.lida_cliente) { chamado.lida_cliente = true; db.save(data); }
  enviarJSON(res, 200, { chamado: chamado ? await chamadoComMensagens(data, chamado) : null });
});

// GET /api/chamados/meus-encerrados — histórico do cliente. Fica escondido por padrão no chat
// (só carrega quando o cliente clica pra abrir) e aceita ?de=AAAA-MM-DD&ate=AAAA-MM-DD pra
// filtrar por período direto no servidor, sem precisar mandar a lista inteira pro navegador.
rota('GET', /^\/api\/chamados\/meus-encerrados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['cliente'])) return enviarJSON(res, 403, { erro: 'Só clientes usam este atendimento.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'chamados', user.empresa_id).filter((c) => c.cliente_id === user.cliente_id && c.status === 'encerrado');
  if (query.de) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) >= query.de);
  if (query.ate) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) <= query.ate);
  lista = lista
    .sort((a, b) => (b.atualizado_em || '').localeCompare(a.atualizado_em || ''))
    .map((c) => chamadoResumoLista(data, c));
  enviarJSON(res, 200, { chamados: lista });
});

// GET /api/chamados — fila (técnico/administrador). ?fila=1 lista quem tá esperando um técnico
// (qualquer técnico pode assumir); ?encerrados=1 (+ ?de=&ate= opcionais) é o histórico do
// próprio técnico, só carregado sob demanda; sem nenhum dos dois, lista os ativos que o próprio
// técnico já assumiu (administrador sempre vê tudo, e ainda pode filtrar por ?status= e
// ?tecnico_id= — usado pela tela "Chat" do administrador pra abrir o painel de um técnico
// específico, incluindo o histórico dele com ?status=encerrado&tecnico_id=).
rota('GET', /^\/api\/chamados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Só técnico ou administrador acessam a fila de atendimento.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const chamadosDaEmpresa = tenant.listar(data, 'chamados', user.empresa_id);
  let lista;
  if (['administrador', 'supervisor'].includes(user.papel)) {
    lista = query.status ? chamadosDaEmpresa.filter((c) => c.status === query.status) : chamadosDaEmpresa.filter((c) => c.status !== 'encerrado');
    // tela "Chat" do administrador: além do painel geral (sem filtro), usa isso pra abrir o
    // histórico/atendimentos de um técnico específico (modal "técnicos atendendo").
    if (query.tecnico_id) lista = lista.filter((c) => c.tecnico_id === Number(query.tecnico_id));
    if (query.de) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) >= query.de);
    if (query.ate) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) <= query.ate);
  } else if (query.fila === '1') {
    lista = chamadosDaEmpresa.filter((c) => c.status === 'aguardando_tecnico' && !c.tecnico_id);
  } else if (query.encerrados === '1') {
    lista = chamadosDaEmpresa.filter((c) => c.tecnico_id === user.id && c.status === 'encerrado');
    if (query.de) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) >= query.de);
    if (query.ate) lista = lista.filter((c) => (c.criado_em || '').slice(0, 10) <= query.ate);
  } else {
    // só os ativos — os encerrados ficam à parte, atrás do ?encerrados=1, pra não carregar (e
    // desenhar) a lista toda, que só cresce, sempre que o técnico abre a fila
    lista = chamadosDaEmpresa.filter((c) => c.tecnico_id === user.id && c.status !== 'encerrado');
  }
  lista = lista.sort((a, b) => (b.atualizado_em || '').localeCompare(a.atualizado_em || '')).map((c) => chamadoResumoLista(data, c));
  enviarJSON(res, 200, { chamados: lista });
});

// GET /api/chamados/:id — detalhe + mensagens
rota('GET', /^\/api\/chamados\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const chamado = tenant.buscar(data, 'chamados', Number(m[1]), user.empresa_id);
  if (!chamado) return enviarJSON(res, 404, { erro: 'Atendimento não encontrado.' });
  if (user.papel === 'cliente' && chamado.cliente_id !== user.cliente_id) return enviarJSON(res, 403, { erro: 'Este atendimento não é seu.' });
  if (user.papel === 'suporte' && chamado.tecnico_id !== user.id && chamado.status !== 'aguardando_tecnico') return enviarJSON(res, 403, { erro: 'Este atendimento não é seu.' });
  if (user.papel === 'pos_venda' && !chamadoEstaComPosVenda(data, chamado)) return enviarJSON(res, 403, { erro: 'Este atendimento ainda não está com o pós-venda.' });
  if (user.papel === 'cliente') { chamado.lida_cliente = true; db.save(data); }
  else if (user.papel === 'suporte' && chamado.tecnico_id === user.id) { chamado.lida_tecnico = true; db.save(data); }
  enviarJSON(res, 200, { chamado: await chamadoComMensagens(data, chamado) });
});

// POST /api/chamados/:id/mensagens — cliente ou técnico manda mensagem no atendimento
rota('POST', /^\/api\/chamados\/(\d+)\/mensagens$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  if (!body.texto || !String(body.texto).trim()) return enviarJSON(res, 400, { erro: 'Mensagem vazia.' });
  const texto = String(body.texto).trim();
  const data = db.load();
  const chamado = tenant.buscar(data, 'chamados', Number(m[1]), user.empresa_id);
  if (!chamado) return enviarJSON(res, 404, { erro: 'Atendimento não encontrado.' });
  if (chamado.status === 'encerrado') return enviarJSON(res, 400, { erro: 'Este atendimento já foi encerrado.' });

  let autor;
  if (user.papel === 'cliente') {
    if (chamado.cliente_id !== user.cliente_id) return enviarJSON(res, 403, { erro: 'Este atendimento não é seu.' });
    autor = 'cliente';
  } else if (user.papel === 'suporte') {
    if (chamado.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Este atendimento não é seu.' });
    autor = 'tecnico';
  } else if (user.papel === 'pos_venda') {
    if (!chamadoEstaComPosVenda(data, chamado)) return enviarJSON(res, 403, { erro: 'Este atendimento ainda não está com o pós-venda.' });
    autor = 'pos_venda';
  } else if (user.papel === 'administrador') {
    autor = 'tecnico';
  } else {
    return enviarJSON(res, 403, { erro: 'Sem acesso a este atendimento.' });
  }

  // carrega o histórico de verdade pra dentro do objeto em memória só pra esta requisição — é
  // assim que a IA (ia.js) continua enxergando/alimentando chamado.mensagens sem precisar mudar
  // a lógica dela; só as mensagens NOVAS deste turno (a partir daqui) são persistidas no fim.
  chamado.mensagens = await db.carregarMensagensChamado(chamado.id);
  const totalAntes = chamado.mensagens.length;

  const agora = new Date().toISOString();
  chamado.mensagens.push({ autor, texto, criado_em: agora });
  chamado.atualizado_em = agora;

  if (autor === 'cliente' && chamado.status === 'ia') {
    if (ia.ativa()) {
      await ia.processarTurno(data, chamado);
    } else {
      chamado.status = 'aguardando_tecnico';
      chamado.mensagens.push({ autor: 'sistema', texto: 'Assistente automático indisponível no momento — um técnico vai te atender em breve.', criado_em: new Date().toISOString() });
    }
    if (chamado.status === 'aguardando_tecnico') {
      notificarNovoAtendimento(data, chamado);
    }
  } else if (autor === 'cliente') {
    chamado.lida_tecnico = false;
    if (chamado.tecnico_id) enviarPush(data, chamado.tecnico_id, { titulo: 'Nova mensagem no atendimento', corpo: texto.slice(0, 120), url: '/' }).catch(() => {});
  } else if (autor === 'tecnico') {
    chamado.lida_cliente = false;
    if (chamado.origem === 'whatsapp' && chamado.telefone_whatsapp) {
      whatsapp.enviarMensagemWhatsApp(chamado.telefone_whatsapp, texto).catch((e) => console.error('Erro ao enviar mensagem pro WhatsApp:', e.message));
    } else if (chamado.cliente_id) {
      const usuarioCliente = data.usuarios.find((u) => u.cliente_id === chamado.cliente_id && u.papel === 'cliente' && u.empresa_id === chamado.empresa_id);
      if (usuarioCliente) enviarPush(data, usuarioCliente.id, { titulo: 'Nova mensagem do técnico', corpo: texto.slice(0, 120), url: '/' }).catch(() => {});
    }
  }

  const mensagensCompletas = chamado.mensagens;
  for (const msg of mensagensCompletas.slice(totalAntes)) await db.salvarMensagemChamado(chamado.id, msg);
  chamado.mensagens = [];
  db.save(data);
  enviarJSON(res, 201, { chamado: { ...chamadoResumoLista(data, chamado), mensagens: mensagensCompletas } });
});

// POST /api/chamados/:id/assumir — técnico assume o atendimento; vira Ordem de Serviço na hora
// (pré-preenchida com os dados do cliente já cadastrados), pra admin/técnico completarem o
// agendamento depois se precisar de visita.
// O administrador, além disso, pode assumir de qualquer estado não encerrado — inclusive
// tirando um atendimento que já está com a IA (status "ia") ou com outro técnico (status
// "convertido_os"), igual à tela "Chat" descreve (ver abrirPreviewAtendimentoAdmin no front).
// O técnico continua só podendo pegar da fila (status "aguardando_tecnico"), nunca tomar de
// outro técnico.
rota('POST', /^\/api\/chamados\/(\d+)\/assumir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só técnico ou administrador assumem atendimentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const chamado = tenant.buscar(data, 'chamados', Number(m[1]), user.empresa_id);
  if (!chamado) return enviarJSON(res, 404, { erro: 'Atendimento não encontrado.' });
  const estadosQuePodemSerAssumidos = user.papel === 'administrador' ? ['aguardando_tecnico', 'ia', 'convertido_os'] : ['aguardando_tecnico'];
  if (!estadosQuePodemSerAssumidos.includes(chamado.status)) return enviarJSON(res, 400, { erro: 'Este atendimento não está disponível pra assumir.' });
  if (!chamado.cliente_id) return enviarJSON(res, 400, { erro: 'Este atendimento não tem um cliente identificado no cadastro — não é possível abrir uma O.S. a partir dele.' });

  // administrador tomando de outro técnico: já existe O.S. aberta pro chamado — só transfere
  // a titularidade (chamado + O.S.), sem duplicar o agendamento.
  if (chamado.status === 'convertido_os' && chamado.os_id) {
    const osExistente = tenant.buscar(data, 'agenda', chamado.os_id, user.empresa_id);
    const tecnicoAnterior = data.usuarios.find((u) => u.id === chamado.tecnico_id && u.empresa_id === user.empresa_id);
    const agora = new Date().toISOString();
    if (osExistente) { osExistente.tecnico_id = user.id; osExistente.tecnico_chat_id = user.id; }
    chamado.tecnico_id = user.id;
    chamado.assumido_em = agora;
    chamado.lida_cliente = false;
    await db.salvarMensagemChamado(chamado.id, { autor: 'sistema', texto: `${user.nome} assumiu o atendimento${tecnicoAnterior ? ` de ${tecnicoAnterior.nome}` : ''} — O.S. ${osExistente ? (osExistente.numero_os || `OS-${String(osExistente.id).padStart(6, '0')}`) : ''} transferida.`, criado_em: agora });
    db.save(data);
    return enviarJSON(res, 200, { chamado: await chamadoComMensagens(data, chamado), agenda: osExistente ? agendaComDetalhes(data, osExistente) : null });
  }

  const cliente = data.clientes.find((c) => c.id === chamado.cliente_id && c.empresa_id === chamado.empresa_id);
  const equipamentoDoChamado = chamado.equipamento_id ? data.equipamentos.find((e) => e.id === chamado.equipamento_id && e.cliente_id === chamado.cliente_id && e.empresa_id === chamado.empresa_id) : null;
  // toda O.S. aberta a partir de um chamado do chat nasce como "Atendimento" — é o técnico quem,
  // ao preencher o Laudo Técnico, define se era mesmo uma corretiva/preventiva de verdade
  const tipo = 'atendimento';

  const agora = new Date();
  const inicioISO = agora.toISOString().slice(0, 16);
  const fimISO = new Date(agora.getTime() + 60 * 60000).toISOString().slice(0, 16);
  const osItem = tenant.criar(data, 'agenda', user.empresa_id, {
    criado_por: user.id,
    tecnico_id: user.id,
    cliente_id: chamado.cliente_id,
    equipamento_id: equipamentoDoChamado ? equipamentoDoChamado.id : null,
    data_hora_inicio: inicioISO,
    data_hora_fim: fimISO,
    tipo,
    categoria: categoriaDoTipo(tipo),
    problema: chamado.resumo_ia || chamado.primeira_mensagem_cliente || '',
    contato: (cliente && cliente.nome_empresa) || '', telefone: (cliente && cliente.telefone) || '', email: (cliente && cliente.email) || '', setor_cliente: (cliente && cliente.setor) || '',
    endereco: (cliente && cliente.endereco) || '', numero: (cliente && cliente.numero) || '', bairro: (cliente && cliente.bairro) || '',
    cep: (cliente && cliente.cep) || '', cidade: (cliente && cliente.cidade) || '', estado: (cliente && cliente.estado) || '',
    garantia: '', garantia_obs: '',
    // SLA calculado pela IA no chat antes de escalar (quando o atendimento não foi resolvido
    // remotamente) — segue com a O.S. pra qualquer lugar que ela vá (inclusive pós-venda)
    sla_nivel: chamado.sla_nivel || null,
    sla_pontuacao: chamado.sla_pontuacao != null ? chamado.sla_pontuacao : null,
    sla_horas_atendimento: chamado.sla_horas_atendimento || null,
    sla_dias_manutencao: chamado.sla_dias_manutencao || null,
    sla_dias_visita_tecnica: chamado.sla_dias_visita_tecnica || null,
    status: 'pendente',
    valor_servico: null,
    retrabalho: false,
    criado_em: agora.toISOString(),
    lida_tecnico: true,
    deslocamento_iniciado_em: null,
    chegada_confirmada_em: null,
    // o cliente já pediu o atendimento pelo chat — não faz sentido pedir confirmação de novo
    confirmado_cliente_em: agora.toISOString(),
    feedback_cliente_em: null,
    orcamento_aprovado_em: null,
    orcamento_reprovado_em: null,
    retorno_pendente_tecnico: false,
    retorno_confirmado_cliente_em: null,
    retorno_deslocamento_iniciado_em: null,
    retorno_chegada_confirmada_em: null,
    viagem_volta_iniciada_em: null,
    viagem_volta_chegada_em: null,
    viagem_volta_destino_agenda_id: null,
    origem_chamado_id: chamado.id,
    // fluxo de pós-venda/reparo — nasce em "em_atendimento" (ainda no chat com o técnico);
    // ver seção "pós-venda / setor reparo" mais abaixo
    fase_atendimento: 'em_atendimento',
    motivo_pos_venda: null,
    encaminhado_pos_venda_em: null,
    equipamento_recebido_em: null,
    pos_venda_orcamento_enviado_em: null,
    pos_venda_decisao: null,
    pos_venda_decisao_em: null,
    tecnico_chat_id: user.id,
    estoque_recebido_em: null,
    equipamento_liberado_reparo_em: null,
    estoque_saida_em: null,
    os_criada_id: null,
  });
  osItem.numero_os = `OS-${String(osItem.id).padStart(6, '0')}`;

  chamado.status = 'convertido_os';
  chamado.tecnico_id = user.id;
  chamado.os_id = osItem.id;
  chamado.assumido_em = agora.toISOString();
  chamado.lida_cliente = false;
  await db.salvarMensagemChamado(chamado.id, { autor: 'sistema', texto: `${user.nome} assumiu o atendimento — O.S. ${osItem.numero_os} aberta.`, criado_em: agora.toISOString() });
  db.save(data);

  if (chamado.origem === 'whatsapp' && chamado.telefone_whatsapp) {
    // pedido do usuário (varredura de vazamento PRO Marking): isso estava fixo em "empresa id 1",
    // mesmo esta função já sendo isolada por empresa (user.empresa_id/chamado em outros pontos) —
    // usa o empresa_id do próprio chamado, igual o resto da função já faz.
    const nomeEmpresa = (data.empresas.find((e) => e.id === chamado.empresa_id) || {}).nome || 'a empresa';
    whatsapp.enviarMensagemWhatsApp(chamado.telefone_whatsapp, `${user.nome}, de ${nomeEmpresa}, assumiu seu atendimento e vai continuar por aqui.`).catch(() => {});
  }
  enviarJSON(res, 200, { chamado: await chamadoComMensagens(data, chamado), agenda: agendaComDetalhes(data, osItem) });
});

// ---------- pós-venda / setor reparo / estoque (O.S. tipo "atendimento" que não resolveu no chat) ----------
// depois que o chat não resolve, o técnico encaminha pro pós-venda escolhendo o motivo; o
// pós-venda manda o orçamento (direto, ou depois de o equipamento passar pelo estoque e pelo
// setor de reparo pro diagnóstico) e registra manualmente se o cliente aprovou. A partir daí o
// caminho depende do motivo:
//  - cliente manda o equipamento: setor de reparo executa e preenche um segundo relatório (mesmo
//    modelo do laudo técnico) liberando o equipamento; o estoque confirma a saída e a O.S. finaliza.
//  - peça enviada pro cliente: não passa pelo reparo — o estoque confirma o envio da peça e a
//    O.S. finaliza sozinha.
//  - técnico vai até o cliente: o administrador é avisado e cria uma O.S. de verdade (visita
//    técnica) a partir da "Solicitação de Atendimento", puxando os dados do atendimento original,
//    que finaliza assim que a nova O.S. é criada. Ver fluxo completo no db.js (migrar()).

const MOTIVOS_POS_VENDA = ['cliente_envia_equipamento', 'tecnico_visita', 'peca_enviada'];

// POST /api/agenda/:id/encerrar-atendimento — o técnico resolveu tudo direto no chat, sem
// precisar do pós-venda/reparo — finaliza a O.S. na hora
rota('POST', /^\/api\/agenda\/(\d+)\/encerrar-atendimento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico encerra o atendimento.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tipo !== 'atendimento') return enviarJSON(res, 400, { erro: 'Só O.S. de atendimento são encerradas por aqui.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'em_atendimento') return enviarJSON(res, 400, { erro: 'Este atendimento já foi encaminhado pro pós-venda — não é mais possível encerrar direto.' });
  const agora = new Date().toISOString();
  item.finalizada = true;
  item.finalizado_em = agora;
  await encerrarChamadoDaOS(data, item);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/encaminhar-pos-venda — o técnico do chat encaminha o atendimento que
// não resolveu remotamente
rota('POST', /^\/api\/agenda\/(\d+)\/encaminhar-pos-venda$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico encaminha pro pós-venda.' });
  const body = await lerCorpo(req);
  if (!MOTIVOS_POS_VENDA.includes(body.motivo)) return enviarJSON(res, 400, { erro: 'Motivo inválido.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tipo !== 'atendimento') return enviarJSON(res, 400, { erro: 'Só O.S. de atendimento passam pelo pós-venda.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'em_atendimento') return enviarJSON(res, 400, { erro: 'Este atendimento já foi encaminhado pro pós-venda.' });
  item.fase_atendimento = 'aguardando_pos_venda';
  item.motivo_pos_venda = body.motivo;
  item.encaminhado_pos_venda_em = new Date().toISOString();
  // o técnico pode responder o questionário de SLA aqui, antes de encaminhar — opcional
  const equipamentoDoItem = item.equipamento_id ? data.equipamentos.find((e) => e.id === item.equipamento_id && e.empresa_id === item.empresa_id) : null;
  const sla = slaDoBody(body, equipamentoDoItem);
  if (sla) Object.assign(item, sla);
  const chamadoOrigem = item.origem_chamado_id ? data.chamados.find((c) => c.id === item.origem_chamado_id && c.empresa_id === item.empresa_id) : null;
  if (chamadoOrigem) {
    await db.salvarMensagemChamado(chamadoOrigem.id, { autor: 'sistema', texto: 'Atendimento encaminhado pro setor de pós-venda.', criado_em: item.encaminhado_pos_venda_em });
    chamadoOrigem.atualizado_em = item.encaminhado_pos_venda_em;
  }
  db.save(data);
  const posVendas = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'pos_venda');
  const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  await Promise.all(posVendas.map((pv) => enviarPush(data, pv.id, {
    titulo: 'Atendimento aguardando pós-venda',
    corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
    url: '/',
  }).catch(() => {})));
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/pos-venda/aguardando-equipamento — pós-venda avisa que o cliente vai
// mandar o equipamento; o estoque é quem recebe e confirma a chegada antes do reparo assumir
rota('POST', /^\/api\/agenda\/(\d+)\/pos-venda\/aguardando-equipamento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['pos_venda', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o pós-venda faz isso.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_pos_venda') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando uma decisão do pós-venda.' });
  item.fase_atendimento = 'aguardando_equipamento';
  db.save(data);
  const estoques = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'estoque');
  const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  await Promise.all(estoques.map((e) => enviarPush(data, e.id, {
    titulo: 'Equipamento a caminho do estoque',
    corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
    url: '/',
  }).catch(() => {})));
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/pos-venda/orcamento-enviado — pós-venda avisa que já mandou o orçamento
// pro cliente (direto, quando o técnico vai até o cliente ou vai uma peça; ou depois que o
// setor reparo devolveu com o diagnóstico do equipamento recebido)
rota('POST', /^\/api\/agenda\/(\d+)\/pos-venda\/orcamento-enviado$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['pos_venda', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o pós-venda faz isso.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_pos_venda') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando uma decisão do pós-venda.' });
  item.fase_atendimento = 'orcamento_enviado';
  item.pos_venda_orcamento_enviado_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/pos-venda/decisao — pós-venda registra manualmente se o cliente
// aprovou o orçamento (fala com o cliente por fora do sistema)
rota('POST', /^\/api\/agenda\/(\d+)\/pos-venda\/decisao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['pos_venda', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o pós-venda faz isso.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'orcamento_enviado') return enviarJSON(res, 400, { erro: 'O orçamento ainda não foi enviado pro cliente.' });
  const agora = new Date().toISOString();
  if (body.aprovado) {
    item.pos_venda_decisao = 'aprovado';
    item.pos_venda_decisao_em = agora;
    const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
    const numeroOSItem = item.numero_os || 'OS-' + String(item.id).padStart(6, '0');
    if (item.motivo_pos_venda === 'cliente_envia_equipamento') {
      // o equipamento já está com o setor de reparo (fez o diagnóstico) — agora executa o
      // conserto de verdade e libera com um segundo relatório
      item.fase_atendimento = 'executando_reparo';
      db.save(data);
      const reparos = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte' && temAcessoMenu(data, u, 'fila-reparo'));
      await Promise.all(reparos.map((r) => enviarPush(data, r.id, {
        titulo: 'Orçamento aprovado — executar reparo',
        corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${numeroOSItem}.`,
        url: '/',
      }).catch(() => {})));
    } else if (item.motivo_pos_venda === 'peca_enviada') {
      // não tem reparo nenhum — é só o estoque despachar a peça pro cliente
      item.fase_atendimento = 'aguardando_saida_estoque';
      db.save(data);
      const estoques = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'estoque');
      await Promise.all(estoques.map((e) => enviarPush(data, e.id, {
        titulo: 'Orçamento aprovado — enviar peça pro cliente',
        corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${numeroOSItem}.`,
        url: '/',
      }).catch(() => {})));
    } else {
      // técnico vai até o cliente: o administrador precisa criar uma O.S. de verdade (visita
      // técnica) — ver "Solicitação de Atendimento"
      item.fase_atendimento = 'aguardando_criacao_os';
      db.save(data);
      const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
      await Promise.all(admins.map((adm) => enviarPush(data, adm.id, {
        titulo: 'Orçamento aprovado — criar O.S. de visita técnica',
        corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${numeroOSItem}.`,
        url: '/',
      }).catch(() => {})));
    }
  } else {
    item.pos_venda_decisao = 'reprovado';
    item.pos_venda_decisao_em = agora;
    item.finalizada = true;
    item.finalizado_em = agora;
    await encerrarChamadoDaOS(data, item);
    db.save(data);
  }
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/reparo/iniciar-atendimento — o equipamento chegou no setor de reparo;
// o técnico do reparo assume a O.S. (fica designado a ele) e libera o relatório
rota('POST', /^\/api\/agenda\/(\d+)\/reparo\/iniciar-atendimento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPapel(user, ['suporte', 'administrador']) || !temAcessoMenu(data, user, 'fila-reparo')) return enviarJSON(res, 403, { erro: 'Só o setor de reparo faz isso.' });
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_equipamento') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando o equipamento.' });
  if (!item.estoque_recebido_em) return enviarJSON(res, 400, { erro: 'O estoque ainda não confirmou o recebimento do equipamento.' });
  item.tecnico_id = user.id;
  item.fase_atendimento = 'em_diagnostico_reparo';
  item.equipamento_recebido_em = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/estoque/confirmar-chegada — o estoque confirma que o equipamento
// enviado pelo cliente chegou fisicamente; libera o setor de reparo pra iniciar o diagnóstico
rota('POST', /^\/api\/agenda\/(\d+)\/estoque\/confirmar-chegada$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['estoque', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o estoque faz isso.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_equipamento' || item.motivo_pos_venda !== 'cliente_envia_equipamento') {
    return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando a chegada de um equipamento no estoque.' });
  }
  if (item.estoque_recebido_em) return enviarJSON(res, 400, { erro: 'A chegada já foi confirmada.' });
  item.estoque_recebido_em = new Date().toISOString();
  db.save(data);
  const reparos = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte' && temAcessoMenu(data, u, 'fila-reparo'));
  const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  await Promise.all(reparos.map((r) => enviarPush(data, r.id, {
    titulo: 'Equipamento pronto pro diagnóstico',
    corpo: `${cliente ? cliente.nome_empresa : 'Um cliente'} — ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
    url: '/',
  }).catch(() => {})));
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/agenda/:id/estoque/confirmar-saida — o estoque confirma que o equipamento
// consertado (ou a peça) saiu rumo ao cliente; finaliza a O.S.
rota('POST', /^\/api\/agenda\/(\d+)\/estoque\/confirmar-saida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['estoque', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o estoque faz isso.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_saida_estoque') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando uma saída do estoque.' });
  const agora = new Date().toISOString();
  item.estoque_saida_em = agora;
  item.finalizada = true;
  item.finalizado_em = agora;
  await encerrarChamadoDaOS(data, item);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// GET /api/agenda/fila-estoque — equipamentos aguardando confirmação de chegada (enviados pelo
// cliente) ou de saída (consertados, ou peça enviada) no estoque
rota('GET', /^\/api\/agenda\/fila-estoque$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['estoque', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o estoque acessa esta fila.' });
  const data = db.load();
  const lista = tenant.listar(data, 'agenda', user.empresa_id)
    .filter((a) => a.tipo === 'atendimento' && !a.finalizada && (
      (a.fase_atendimento === 'aguardando_equipamento' && a.motivo_pos_venda === 'cliente_envia_equipamento' && !a.estoque_recebido_em) ||
      a.fase_atendimento === 'aguardando_saida_estoque'
    ))
    .sort((a, b) => (a.encaminhado_pos_venda_em || '').localeCompare(b.encaminhado_pos_venda_em || ''))
    .map((a) => agendaComDetalhes(data, a));
  enviarJSON(res, 200, { agenda: lista });
});

// GET /api/agenda/fila-solicitacao-atendimento — atendimentos com orçamento aprovado pro
// caminho "técnico vai até o cliente": o administrador cria a O.S. de visita técnica de verdade
rota('GET', /^\/api\/agenda\/fila-solicitacao-atendimento$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador acessa esta fila.' });
  const data = db.load();
  const lista = tenant.listar(data, 'agenda', user.empresa_id)
    .filter((a) => a.tipo === 'atendimento' && !a.finalizada && a.fase_atendimento === 'aguardando_criacao_os')
    .sort((a, b) => (a.pos_venda_decisao_em || '').localeCompare(b.pos_venda_decisao_em || ''))
    .map((a) => agendaComDetalhes(data, a));
  enviarJSON(res, 200, { agenda: lista });
});

// POST /api/agenda/:id/finalizar-solicitacao — o administrador já criou a O.S. de visita técnica
// a partir dos dados desta solicitação; encerra o atendimento original (chat incluso)
rota('POST', /^\/api\/agenda\/(\d+)\/finalizar-solicitacao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador faz isso.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.fase_atendimento !== 'aguardando_criacao_os') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando a criação de uma O.S.' });
  const agora = new Date().toISOString();
  item.os_criada_id = body.nova_os_id ? Number(body.nova_os_id) : null;
  item.finalizada = true;
  item.finalizado_em = agora;
  // o SLA já foi definido pelo técnico/pós-venda no atendimento original — passa pra nova O.S.
  // de visita técnica automaticamente, pro administrador se basear nele (não redefine aqui)
  if (item.os_criada_id && item.sla_nivel) {
    const novaOS = tenant.buscar(data, 'agenda', item.os_criada_id, user.empresa_id);
    if (novaOS) {
      novaOS.sla_nivel = item.sla_nivel;
      novaOS.sla_pontuacao = item.sla_pontuacao;
      novaOS.sla_horas_atendimento = item.sla_horas_atendimento;
      novaOS.sla_dias_manutencao = item.sla_dias_manutencao;
      novaOS.sla_dias_visita_tecnica = item.sla_dias_visita_tecnica;
    }
  }
  await encerrarChamadoDaOS(data, item);
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// GET /api/agenda/fila-pos-venda — atendimentos aguardando alguma ação do pós-venda
rota('GET', /^\/api\/agenda\/fila-pos-venda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['pos_venda', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o pós-venda acessa esta fila.' });
  const data = db.load();
  const lista = tenant.listar(data, 'agenda', user.empresa_id)
    .filter((a) => a.tipo === 'atendimento' && !a.finalizada && ['aguardando_pos_venda', 'orcamento_enviado'].includes(a.fase_atendimento))
    .sort((a, b) => (a.encaminhado_pos_venda_em || '').localeCompare(b.encaminhado_pos_venda_em || ''))
    .map((a) => agendaComDetalhes(data, a));
  enviarJSON(res, 200, { agenda: lista });
});

// GET /api/agenda/fila-reparo — equipamentos aguardando o setor de reparo, mais o que já está
// designado ao técnico logado (diagnóstico) e o que está liberado pra execução do reparo
rota('GET', /^\/api\/agenda\/fila-reparo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  const data = db.load();
  if (!exigirPapel(user, ['suporte', 'administrador']) || !temAcessoMenu(data, user, 'fila-reparo')) return enviarJSON(res, 403, { erro: 'Só o setor de reparo acessa esta fila.' });
  const lista = tenant.listar(data, 'agenda', user.empresa_id)
    .filter((a) => a.tipo === 'atendimento' && !a.finalizada && (
      (a.fase_atendimento === 'aguardando_equipamento' && !!a.estoque_recebido_em) ||
      a.fase_atendimento === 'executando_reparo' ||
      (a.fase_atendimento === 'em_diagnostico_reparo' && a.tecnico_id === user.id)
    ))
    .sort((a, b) => (a.encaminhado_pos_venda_em || '').localeCompare(b.encaminhado_pos_venda_em || ''))
    .map((a) => agendaComDetalhes(data, a));
  enviarJSON(res, 200, { agenda: lista });
});

// GET /api/chamados/stats — administrador: números de hoje pro painel de atendimentos
rota('GET', /^\/api\/chamados\/stats$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê as estatísticas de atendimento.' });
  const data = db.load();
  const chamadosDaEmpresa = tenant.listar(data, 'chamados', user.empresa_id);
  const hojeISO = new Date().toISOString().slice(0, 10);
  const deHoje = chamadosDaEmpresa.filter((c) => (c.criado_em || '').slice(0, 10) === hojeISO);
  const resolvidosIa = deHoje.filter((c) => c.status === 'encerrado' && c.resolvido_por === 'ia');
  const paraTecnico = deHoje.filter((c) => c.status === 'convertido_os' || (c.status !== 'ia' && c.tecnico_id));
  const aguardando = chamadosDaEmpresa.filter((c) => c.status === 'aguardando_tecnico').length; // fila atual, não só de hoje
  const mediaMinutos = (lista, campoFim, campoInicio) => {
    const validos = lista.filter((c) => c[campoFim] && c[campoInicio]);
    if (!validos.length) return null;
    const total = validos.reduce((soma, c) => soma + (new Date(c[campoFim]) - new Date(c[campoInicio])), 0);
    return Math.round(total / validos.length / 60000);
  };
  const fmtMin = (min) => min === null ? null : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  enviarJSON(res, 200, {
    total: deHoje.length,
    resolvidos_ia: resolvidosIa.length,
    tecnico: paraTecnico.length,
    aguardando,
    tempo_medio_ia: fmtMin(mediaMinutos(resolvidosIa, 'resolvido_em', 'criado_em')),
    tempo_medio_tecnico: fmtMin(mediaMinutos(paraTecnico, 'assumido_em', 'criado_em')),
  });
});

// POST /api/tecnico/online — técnico liga/desliga a presença dele na fila de atendimento.
// Fica online só quem tá realmente disponível pra receber atendimento agora.
rota('POST', /^\/api\/tecnico\/online$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só técnico controla a própria presença.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const usuario = data.usuarios.find((u) => u.id === user.id && u.empresa_id === user.empresa_id);
  if (!usuario) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  const novoOnline = !!body.online;
  if (novoOnline && !usuario.online) usuario.online_desde = new Date().toISOString();
  if (!novoOnline) usuario.online_desde = null;
  usuario.online = novoOnline;
  db.save(data);
  enviarJSON(res, 200, { usuario: usuarioPublico(usuario) });
});

// soma o tamanho (em caracteres) de todo texto dentro de um objeto, sem nunca montar uma string
// gigante nova (JSON.stringify de um objeto grande dobraria o uso de memória na hora — isso aqui
// só soma números, é seguro mesmo com o processo já perto do limite de RAM).
function tamanhoTextoRecursivo(valor) {
  if (typeof valor === 'string') return valor.length;
  if (Array.isArray(valor)) return valor.reduce((soma, v) => soma + tamanhoTextoRecursivo(v), 0);
  if (valor && typeof valor === 'object') return Object.values(valor).reduce((soma, v) => soma + tamanhoTextoRecursivo(v), 0);
  return 0;
}

// GET /api/admin/diagnostico-memoria — administrador: quanto texto (aproximadamente MB) tem em
// cada parte do banco, pra achar o que está pesando na memória do processo (limite de RAM do
// plano do Render). Temporário, só pra diagnóstico — remover depois de resolver.
rota('GET', /^\/api\/admin\/diagnostico-memoria$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador acessa isso.' });
  const data = db.load();
  const partes = Object.keys(data)
    .map((k) => ({ chave: k, mb_aprox: +(tamanhoTextoRecursivo(data[k]) / 1024 / 1024).toFixed(2) }))
    .sort((a, b) => b.mb_aprox - a.mb_aprox);
  const mem = process.memoryUsage();
  enviarJSON(res, 200, {
    partes,
    memoria_processo_mb: { rss: +(mem.rss / 1024 / 1024).toFixed(1), heapUsed: +(mem.heapUsed / 1024 / 1024).toFixed(1) },
  });
});

// ---------- esqueleto dos módulos novos (agendamento, financeiro) ----------
// ainda não têm tela nem dado nenhum — só provam que o pipeline de ativação funciona ponta a
// ponta: rota gated pelo módulo certo (ver rotas-modulo.js), menu que só aparece se o módulo
// estiver ativo (ver NAV em public/app.js) levando a uma tela "Em breve". Quando um desses módulos
// ganhar telas de verdade, essa rota de status é substituída pelas rotas reais — como já aconteceu
// com prestacao_contas, e agora com "comercial" (ver rotas de Leads/Oportunidades/Propostas).
for (const chave of ['agendamento', 'financeiro']) {
  rota('GET', new RegExp(`^/api/${chave}/status$`), async (req, res) => {
    const user = usuarioAutenticado(req);
    if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
    enviarJSON(res, 200, { modulo: chave, status: 'em construção' });
  });
}

// ---------- prestação de contas (Etapa 6/passo 2 do briefing white label) ----------
// despesas de viagem/campo (hospedagem, alimentação, combustível, pedágio, outros) que o técnico
// lança pra aprovação — complementa o bônus fixo por diária (ver valorBonusViagem) com despesas
// reais, variáveis, uma a uma. Pode ser vinculada a uma O.S. (agenda_id) ou lançada solta.
const CATEGORIAS_DESPESA = ['hospedagem', 'alimentacao', 'combustivel', 'pedagio', 'outros'];
function sanitizarItensDespesa(itens) {
  if (!Array.isArray(itens)) return [];
  return itens
    .filter((it) => it && CATEGORIAS_DESPESA.includes(it.categoria) && Number(it.valor) > 0)
    .map((it) => ({
      categoria: it.categoria,
      descricao: String(it.descricao || '').slice(0, 300),
      valor: Number(it.valor),
      data: it.data || '',
      foto: it.foto || null,
    }));
}

// POST /api/prestacao-contas — técnico (ou administrador, em nome de alguém da equipe) lança uma
// prestação de contas nova. Nasce sempre "pendente" — só financeiro/administrador decide.
rota('POST', /^\/api\/prestacao-contas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador lançam prestação de contas.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const itens = sanitizarItensDespesa(body.itens);
  if (!itens.length) return enviarJSON(res, 400, { erro: 'Adicione ao menos um item de despesa válido (categoria e valor maior que zero).' });
  const data = db.load();
  if (body.agenda_id && !tenant.buscar(data, 'agenda', Number(body.agenda_id), user.empresa_id)) {
    return enviarJSON(res, 400, { erro: 'O.S. informada não encontrada.' });
  }
  const valor_total = itens.reduce((soma, it) => soma + it.valor, 0);
  const item = tenant.criar(data, 'prestacoes_contas', user.empresa_id, {
    autor_id: user.id, autor_nome: user.nome,
    agenda_id: body.agenda_id ? Number(body.agenda_id) : null,
    descricao: String(body.descricao || '').slice(0, 500),
    itens, valor_total,
    status: 'pendente',
    aprovado_por: null, data_decisao: null, comentario_financeiro: '',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { prestacao: item });
});

// GET /api/prestacao-contas/minhas — o técnico só vê as próprias; administrador vê com ?todas=1
// (mesmo padrão de /api/relatorios-manutencao/meus).
rota('GET', /^\/api\/prestacao-contas\/minhas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'financeiro', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'prestacoes_contas', user.empresa_id);
  if (!(['administrador', 'financeiro', 'supervisor'].includes(user.papel) && query.todas === '1')) {
    lista = lista.filter((p) => p.autor_id === user.id);
  }
  lista = [...lista].sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { prestacoes: await hidratarFotosProfundo(lista) });
});

// GET /api/prestacao-contas/fila — fila de aprovação (pendentes), pra financeiro/administrador.
rota('GET', /^\/api\/prestacao-contas\/fila$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só financeiro ou administrador acessam a fila de aprovação.' });
  const data = db.load();
  const lista = tenant.listar(data, 'prestacoes_contas', user.empresa_id)
    .filter((p) => p.status === 'pendente')
    .sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  enviarJSON(res, 200, { prestacoes: await hidratarFotosProfundo(lista) });
});

// POST /api/prestacao-contas/:id/aprovar
rota('POST', /^\/api\/prestacao-contas\/(\d+)\/aprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só financeiro ou administrador decidem prestações de contas.' });
  const data = db.load();
  const item = tenant.buscar(data, 'prestacoes_contas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Prestação de contas não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Esta prestação de contas já foi decidida.' });
  item.status = 'aprovado';
  item.aprovado_por = user.nome;
  item.data_decisao = new Date().toISOString();
  db.save(data);
  enviarPush(data, item.autor_id, {
    titulo: 'Prestação de contas aprovada',
    corpo: `Sua prestação de contas de R$ ${item.valor_total.toFixed(2)} foi aprovada.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { prestacao: item });
});

// POST /api/prestacao-contas/:id/reprovar { comentario }
rota('POST', /^\/api\/prestacao-contas\/(\d+)\/reprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só financeiro ou administrador decidem prestações de contas.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !String(body.comentario).trim()) return enviarJSON(res, 400, { erro: 'Explique o motivo da reprovação.' });
  const data = db.load();
  const item = tenant.buscar(data, 'prestacoes_contas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Prestação de contas não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Esta prestação de contas já foi decidida.' });
  item.status = 'reprovado';
  item.aprovado_por = user.nome;
  item.data_decisao = new Date().toISOString();
  item.comentario_financeiro = String(body.comentario).trim();
  db.save(data);
  enviarPush(data, item.autor_id, {
    titulo: 'Prestação de contas reprovada',
    corpo: `Sua prestação de contas de R$ ${item.valor_total.toFixed(2)} foi reprovada: ${item.comentario_financeiro}`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { prestacao: item });
});

// ---------- justificar despesa ----------
// pedido do usuário: "crie no menu técnico um menu justificar despesa, ao clicar terá uma opção de
// tirar foto... ou sistema lê automaticamente extraindo data, estabelecimento, valor da compra e
// descrição... Ou opção de colocar manual... Essa justificativa vai pro financeiro." Um lançamento
// por despesa (sem categoria, diferente de prestacoes_contas), com campo de estabelecimento. Pedido
// posterior do usuário: "esse menu precisa ter no acesso do administrador ele também precisa
// justificar e não aprovar. Quem aprova é o setor financeiro" — administrador lança despesa (igual
// o técnico), só o papel financeiro decide (pendente/aprovado/reprovado).

// POST /api/despesas-justificadas/ler-recibo { foto } — lê o comprovante via IA, só devolve os
// dados extraídos pra pré-preencher o formulário (não salva nada aqui, igual ler-etiqueta).
rota('POST', /^\/api\/despesas-justificadas\/ler-recibo$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só quem justifica despesa (técnico ou administrador) usa a leitura automática.' });
  if (!ia.ativa()) return enviarJSON(res, 400, { erro: 'A leitura automática por IA não está configurada neste sistema.' });
  const body = await lerCorpo(req);
  if (!body.foto) return enviarJSON(res, 400, { erro: 'Envie uma foto do comprovante.' });
  try {
    const extraido = await ia.lerRecibo(body.foto);
    enviarJSON(res, 200, { extraido });
  } catch (e) {
    enviarJSON(res, 502, { erro: e.message });
  }
});

// POST /api/despesas-justificadas — cria um lançamento novo (via IA pré-preenchido ou 100% manual,
// tanto faz pro servidor — ele só recebe os campos finais já revisados pelo técnico).
rota('POST', /^\/api\/despesas-justificadas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador justificam despesa.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const valor = Number(body.valor);
  if (!(valor > 0)) return enviarJSON(res, 400, { erro: 'Informe um valor maior que zero.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data da despesa.' });
  const estabelecimento = String(body.estabelecimento || '').trim();
  if (!estabelecimento) return enviarJSON(res, 400, { erro: 'Informe o estabelecimento.' });
  const data = db.load();
  const item = tenant.criar(data, 'despesas_justificadas', user.empresa_id, {
    tecnico_id: user.id, tecnico_nome: user.nome,
    data: body.data, estabelecimento: estabelecimento.slice(0, 200),
    descricao: String(body.descricao || '').trim().slice(0, 300),
    valor, fotos: Array.isArray(body.fotos) ? body.fotos : [],
    categoria: body.categoria === 'alimentacao' ? 'alimentacao' : 'outros',
    origem: body.origem === 'ocr' ? 'ocr' : 'manual',
    status: 'pendente',
    aprovado_por: null, data_decisao: null, comentario_financeiro: '',
    criado_em: new Date().toISOString(),
  });
  db.save(data);
  enviarJSON(res, 201, { despesa: item });
});

// PUT /api/despesas-justificadas/:id — edita um lançamento próprio (pedido do usuário: "coloque
// opção de excluir e editar o documento"). Só o autor edita o próprio lançamento, e só enquanto
// ainda estiver pendente — depois que o financeiro decide, o lançamento fica travado (mesmo
// padrão de cancelarSolicitacaoRH).
rota('PUT', /^\/api\/despesas-justificadas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador justificam despesa.' });
  const data = db.load();
  const item = tenant.buscar(data, 'despesas_justificadas', Number(m[1]), user.empresa_id);
  if (!item || item.tecnico_id !== user.id) return enviarJSON(res, 404, { erro: 'Despesa não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Só é possível editar um lançamento ainda pendente.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), user.empresa_id);
  const valor = Number(body.valor);
  if (!(valor > 0)) return enviarJSON(res, 400, { erro: 'Informe um valor maior que zero.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.data || '')) return enviarJSON(res, 400, { erro: 'Informe a data da despesa.' });
  const estabelecimento = String(body.estabelecimento || '').trim();
  if (!estabelecimento) return enviarJSON(res, 400, { erro: 'Informe o estabelecimento.' });
  item.data = body.data;
  item.estabelecimento = estabelecimento.slice(0, 200);
  item.descricao = String(body.descricao || '').trim().slice(0, 300);
  item.valor = valor;
  item.fotos = Array.isArray(body.fotos) ? body.fotos : [];
  item.categoria = body.categoria === 'alimentacao' ? 'alimentacao' : 'outros';
  db.save(data);
  enviarJSON(res, 200, { despesa: item });
});

// DELETE /api/despesas-justificadas/:id — exclui um lançamento próprio ainda pendente (mesmo
// pedido do usuário acima).
rota('DELETE', /^\/api\/despesas-justificadas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só o técnico ou o administrador justificam despesa.' });
  const data = db.load();
  const item = tenant.buscar(data, 'despesas_justificadas', Number(m[1]), user.empresa_id);
  if (!item || item.tecnico_id !== user.id) return enviarJSON(res, 404, { erro: 'Despesa não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Só é possível excluir um lançamento ainda pendente.' });
  data.despesas_justificadas = data.despesas_justificadas.filter((d) => d.id !== item.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// filtro de período por data da despesa (não por criado_em) — é a data que aparece no relatório/
// impressão/PDF, então o filtro tem que bater com o que a pessoa vê na tela.
function filtrarDespesasPorPeriodo(lista, query) {
  let filtrada = lista;
  if (query.periodo_inicio) filtrada = filtrada.filter((d) => d.data >= String(query.periodo_inicio).slice(0, 10));
  if (query.periodo_fim) filtrada = filtrada.filter((d) => d.data <= String(query.periodo_fim).slice(0, 10));
  return filtrada;
}

// GET /api/despesas-justificadas/minhas?periodo_inicio=&periodo_fim=&todas=1 — cada pessoa (técnico
// ou administrador) só vê as próprias despesas lançadas; só financeiro/supervisor veem todas com
// ?todas=1 (administrador não decide mais despesa — ver pedido do usuário citado acima — então não
// precisa enxergar o lançamento alheio, só o próprio, igual o técnico).
rota('GET', /^\/api\/despesas-justificadas\/minhas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador', 'financeiro', 'supervisor'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = tenant.listar(data, 'despesas_justificadas', user.empresa_id);
  if (!(['financeiro', 'supervisor'].includes(user.papel) && query.todas === '1')) {
    lista = lista.filter((d) => d.tecnico_id === user.id);
  }
  lista = filtrarDespesasPorPeriodo(lista, query);
  lista = [...lista].sort((a, b) => (b.data || '').localeCompare(a.data || '') || (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { despesas: await hidratarFotosProfundo(lista) });
});

// GET /api/despesas-justificadas/fila — fila de aprovação (pendentes). Pedido do usuário: "quem
// aprova é o setor financeiro" — só o papel financeiro, administrador não aprova mais.
rota('GET', /^\/api\/despesas-justificadas\/fila$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro'])) return enviarJSON(res, 403, { erro: 'Só o financeiro acessa a fila de aprovação.' });
  const data = db.load();
  const lista = tenant.listar(data, 'despesas_justificadas', user.empresa_id)
    .filter((d) => d.status === 'pendente')
    .sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  enviarJSON(res, 200, { despesas: await hidratarFotosProfundo(lista) });
});

// POST /api/despesas-justificadas/:id/aprovar — só financeiro (ver pedido do usuário acima).
rota('POST', /^\/api\/despesas-justificadas\/(\d+)\/aprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro'])) return enviarJSON(res, 403, { erro: 'Só o financeiro decide despesas justificadas.' });
  const data = db.load();
  const item = tenant.buscar(data, 'despesas_justificadas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Despesa não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Esta despesa já foi decidida.' });
  item.status = 'aprovado';
  item.aprovado_por = user.nome;
  item.data_decisao = new Date().toISOString();
  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Despesa justificada aprovada',
    corpo: `Sua despesa de R$ ${item.valor.toFixed(2)} em ${item.estabelecimento} foi aprovada.`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { despesa: item });
});

// POST /api/despesas-justificadas/:id/reprovar { comentario } — só financeiro (ver pedido do
// usuário acima).
rota('POST', /^\/api\/despesas-justificadas\/(\d+)\/reprovar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['financeiro'])) return enviarJSON(res, 403, { erro: 'Só o financeiro decide despesas justificadas.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !String(body.comentario).trim()) return enviarJSON(res, 400, { erro: 'Explique o motivo da reprovação.' });
  const data = db.load();
  const item = tenant.buscar(data, 'despesas_justificadas', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Despesa não encontrada.' });
  if (item.status !== 'pendente') return enviarJSON(res, 400, { erro: 'Esta despesa já foi decidida.' });
  item.status = 'reprovado';
  item.aprovado_por = user.nome;
  item.data_decisao = new Date().toISOString();
  item.comentario_financeiro = String(body.comentario).trim();
  db.save(data);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Despesa justificada reprovada',
    corpo: `Sua despesa de R$ ${item.valor.toFixed(2)} em ${item.estabelecimento} foi reprovada: ${item.comentario_financeiro}`,
    url: '/',
  }).catch(() => {});
  enviarJSON(res, 200, { despesa: item });
});

// ---------- Agendamentos — conexão com o Outlook (Microsoft Graph) ----------
// pedido do usuário: "como conectar minha agenda do outlook, quero criar um menu agendamentos, e
// puxar tudo que tem na agenda do outlook" / "cada técnico tem seu email. recebe um e-mail de
// agendamento eu aceito e já entra no calendário" / "só ler (puxar pra cá)" — cada técnico ou
// administrador conecta a própria conta Microsoft (OAuth2); o sistema só LÊ os compromissos (ver
// outlook.js), nunca cria/edita nada no Outlook da pessoa.
//
// a URL de callback é FIXA (não depende de subdomínio de empresa) porque é isso que fica
// registrado no app do Azure AD — o "state" assinado abaixo é quem identifica de qual usuário
// (de qual empresa) é essa conexão quando a Microsoft devolve o navegador pra cá.
const OUTLOOK_REDIRECT_URI = `${APP_URL}/api/outlook/callback`;

// GET /api/outlook/status — se a integração está configurada no servidor e se o usuário logado já
// conectou a própria conta.
rota('GET', /^\/api\/outlook\/status$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  enviarJSON(res, 200, { disponivel: outlook.ativa(), conectado: !!(u && u.outlook_conectado), email: (u && u.outlook_email) || null });
});

// GET /api/outlook/conectar — devolve a URL de autorização da Microsoft pro front redirecionar o
// navegador (não dá pra fazer por fetch/XHR, o consentimento da Microsoft precisa de navegação de
// verdade). O "state" carrega o id do usuário, assinado (gerarToken, mesmo mecanismo do login) —
// é assim que o callback (que chega sem Bearer token, só com o parâmetro state) sabe quem conectou.
rota('GET', /^\/api\/outlook\/conectar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  if (!outlook.ativa()) return enviarJSON(res, 400, { erro: 'A conexão com o Outlook ainda não foi configurada neste sistema (fale com o administrador da plataforma).' });
  const state = gerarToken({ outlook_usuario_id: user.id });
  enviarJSON(res, 200, { url: outlook.urlAutorizacao(OUTLOOK_REDIRECT_URI, state) });
});

// GET /api/outlook/callback?code&state — rota PÚBLICA (ver rotas-modulo.js): é a Microsoft quem
// redireciona o navegador pra cá depois do consentimento, sem nenhum Bearer token. Troca o code
// pelo refresh_token, salva no usuário identificado pelo state, e manda o navegador de volta pro
// app (que detecta "?outlook=conectado" na URL e abre a tela de Agendamentos — ver app.js).
rota('GET', /^\/api\/outlook\/callback$/, async (req, res) => {
  const { query } = url.parse(req.url, true);
  function voltarComErro(mensagem) {
    res.writeHead(302, { Location: `${APP_URL}/?outlook=erro&msg=${encodeURIComponent(mensagem)}` });
    res.end();
  }
  const payload = query.state && verificarToken(query.state);
  if (!payload || !payload.outlook_usuario_id) return voltarComErro('Conexão expirada — tente conectar de novo.');
  if (query.error) return voltarComErro(query.error_description || 'Você não concluiu a autorização no Microsoft.');
  if (!query.code) return voltarComErro('Resposta inesperada da Microsoft.');
  try {
    const tokens = await outlook.trocarCodigoPorToken(query.code, OUTLOOK_REDIRECT_URI);
    const emailConectado = await outlook.buscarPerfil(tokens.access_token);
    const data = db.load();
    const u = data.usuarios.find((x) => x.id === payload.outlook_usuario_id);
    if (!u) return voltarComErro('Usuário não encontrado.');
    u.outlook_conectado = true;
    u.outlook_email = emailConectado;
    u.outlook_refresh_token = tokens.refresh_token;
    db.save(data);
    res.writeHead(302, { Location: `${APP_URL}/?outlook=conectado` });
    res.end();
  } catch (e) {
    voltarComErro(e.message);
  }
});

// POST /api/outlook/desconectar — apaga o refresh_token guardado (não revoga do lado da
// Microsoft — isso só a própria pessoa faz pelo portal da conta dela — só o sistema para de usar).
rota('POST', /^\/api\/outlook\/desconectar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  if (u) { u.outlook_conectado = false; u.outlook_email = null; u.outlook_refresh_token = null; db.save(data); }
  enviarJSON(res, 200, { ok: true });
});

// GET /api/outlook/eventos?inicio=AAAA-MM-DD&fim=AAAA-MM-DD — busca os compromissos do período na
// conta Microsoft conectada do usuário logado (renova o access_token a cada chamada — tem vida
// curta, ~1h; o refresh_token guardado é quem permite renovar sem pedir login de novo).
rota('GET', /^\/api\/outlook\/eventos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  if (!u || !u.outlook_conectado || !u.outlook_refresh_token) return enviarJSON(res, 400, { erro: 'Conecte sua conta do Outlook primeiro.', codigo: 'outlook_desconectado' });
  const { query } = url.parse(req.url, true);
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(query.inicio || '') ? query.inicio : new Date().toISOString().slice(0, 10);
  const fimBase = /^\d{4}-\d{2}-\d{2}$/.test(query.fim || '') ? query.fim : inicio;
  try {
    const tokens = await outlook.renovarToken(u.outlook_refresh_token);
    // a Microsoft normalmente devolve um refresh_token novo a cada renovação (rotação) — se não
    // guardar o mais recente, a conexão para de funcionar na próxima vez que o antigo expirar.
    if (tokens.refresh_token && tokens.refresh_token !== u.outlook_refresh_token) {
      u.outlook_refresh_token = tokens.refresh_token;
      db.save(data);
    }
    const eventos = await outlook.buscarEventos(tokens.access_token, `${inicio}T00:00:00`, `${fimBase}T23:59:59`);
    enviarJSON(res, 200, { eventos, email: u.outlook_email });
  } catch (e) {
    // refresh_token revogado (trocou a senha, desconectou o app pelo portal da Microsoft etc.) —
    // marca como desconectado aqui pra a tela já oferecer "Conectar" de novo, em vez de ficar
    // mostrando erro genérico pra sempre. e.codigo vem de outlook.js (campo "error" curto da
    // resposta da Microsoft — o texto longo de error_description muda a cada chamada, não dá
    // pra confiar nele pra decidir isso).
    if (e.status === 401 || e.codigo === 'invalid_grant') {
      u.outlook_conectado = false; u.outlook_refresh_token = null; db.save(data);
      return enviarJSON(res, 400, { erro: 'Sua conexão com o Outlook expirou — conecte de novo.', codigo: 'outlook_desconectado' });
    }
    enviarJSON(res, 502, { erro: e.message });
  }
});

// ---------- Agendamentos — alternativa via e-mail de cópia (IMAP) ----------
// pedido do usuário: "a conta do e-mail já é logada no notebook, não tenho a senha... fiz um
// e-mail em cópia e toda vez que recebo um e-mail no técnico9 recebi uma cópia... pode usar o
// e-mail em cópia" — pra quem não tem a senha da própria conta Microsoft (login Outlook acima
// não dá), conecta numa caixa DIFERENTE (usuário+senha comuns, que a pessoa realmente tem em
// mãos) que já recebe cópia dos convites, e lê os .ics de lá (ver agenda-email.js).

// GET /api/agenda-email/status
rota('GET', /^\/api\/agenda-email\/status$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  enviarJSON(res, 200, { conectado: !!(u && u.agenda_email_conectado), endereco: (u && u.agenda_email_endereco) || null });
});

// POST /api/agenda-email/conectar { email, senha, provedor?, host?, porta? } — testa a conexão
// IMAP na hora (pedido implícito: avisar já se a senha/host estiver errado) antes de salvar.
rota('POST', /^\/api\/agenda-email\/conectar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const body = await lerCorpo(req);
  const email = String(body.email || '').trim();
  const senha = String(body.senha || '');
  if (!email || !senha) return enviarJSON(res, 400, { erro: 'Informe o e-mail e a senha.' });
  let host = String(body.host || '').trim();
  let porta = Number(body.porta) || 993;
  if (!host) {
    const provedor = body.provedor && agendaEmail.PROVEDORES_IMAP[body.provedor] ? body.provedor : agendaEmail.detectarProvedor(email);
    const preset = provedor && agendaEmail.PROVEDORES_IMAP[provedor];
    if (!preset) return enviarJSON(res, 400, { erro: 'Não reconheci o provedor desse e-mail — informe o servidor IMAP manualmente.' });
    host = preset.host; porta = preset.port;
  }
  try {
    await agendaEmail.testarConexao({ host, port: porta, email, senha });
  } catch (e) {
    // e.message já vem com o texto de verdade que o provedor de e-mail devolveu (ver
    // mensagemClara em agenda-email.js) — é o que diz exatamente o que está errado (ex.: "senha
    // de app necessária", "IMAP desativado para esta conta"), então só repassa.
    return enviarJSON(res, 400, { erro: `Não consegui conectar: ${e.message}` });
  }
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  if (!u) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  u.agenda_email_conectado = true;
  u.agenda_email_endereco = email;
  u.agenda_email_senha_cifrada = cifrar(senha);
  u.agenda_email_host = host;
  u.agenda_email_porta = porta;
  db.save(data);
  enviarJSON(res, 200, { ok: true, endereco: email });
});

// POST /api/agenda-email/desconectar
rota('POST', /^\/api\/agenda-email\/desconectar$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  if (u) {
    u.agenda_email_conectado = false; u.agenda_email_endereco = null;
    u.agenda_email_senha_cifrada = null; u.agenda_email_host = null; u.agenda_email_porta = null;
    db.save(data);
  }
  enviarJSON(res, 200, { ok: true });
});

// GET /api/agenda-email/eventos?inicio=&fim= — mesmo formato de resposta de GET
// /api/outlook/eventos, pra reaproveitar a mesma tela/renderização no front.
rota('GET', /^\/api\/agenda-email\/eventos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
  const data = db.load();
  const u = data.usuarios.find((x) => x.id === user.id);
  if (!u || !u.agenda_email_conectado || !u.agenda_email_senha_cifrada) return enviarJSON(res, 400, { erro: 'Conecte seu e-mail de cópia primeiro.', codigo: 'agenda_email_desconectado' });
  const { query } = url.parse(req.url, true);
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(query.inicio || '') ? query.inicio : new Date().toISOString().slice(0, 10);
  const fim = /^\d{4}-\d{2}-\d{2}$/.test(query.fim || '') ? query.fim : inicio;
  let senha;
  try {
    senha = decifrar(u.agenda_email_senha_cifrada);
  } catch (e) {
    // PROCONECTA_SECRET mudou (ex.: não tinha sido configurado e o processo reiniciou com um
    // segredo novo sorteado — ver auth.js) — a senha salva nunca mais vai decifrar sozinha.
    u.agenda_email_conectado = false; db.save(data);
    return enviarJSON(res, 400, { erro: 'Sua conexão precisa ser refeita.', codigo: 'agenda_email_desconectado' });
  }
  try {
    const eventos = await agendaEmail.buscarEventos({ host: u.agenda_email_host, port: u.agenda_email_porta, email: u.agenda_email_endereco, senha }, inicio, fim);
    enviarJSON(res, 200, { eventos, email: u.agenda_email_endereco });
  } catch (e) {
    if (/auth/i.test(e.message || '')) {
      u.agenda_email_conectado = false; db.save(data);
      return enviarJSON(res, 400, { erro: 'A senha desse e-mail mudou ou parou de funcionar — conecte de novo.', codigo: 'agenda_email_desconectado' });
    }
    enviarJSON(res, 502, { erro: e.message });
  }
});

// ---------- painel da plataforma (Super Admin) ----------
// papel `super_admin` é o dono da plataforma, não de uma empresa — não tem empresa_id (fica null
// de propósito, ver bootstrapSuperAdmin em db.js) e nunca passa pelas coleções tenant-scoped.
// Essas rotas ficam de fora da checagem de módulo (não têm prefixo em rotas-modulo.js, então caem
// no padrão 'nucleo': exige login, mas não módulo ativo) — a única checagem de acesso real é o
// papel, feita aqui dentro, do mesmo jeito que qualquer outra rota admin-only já faz com
// exigirPapel.

// GET /api/plataforma/modulos — catálogo fixo de módulos que o sistema sabe suportar
rota('GET', /^\/api\/plataforma\/modulos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  enviarJSON(res, 200, { modulos: db.MODULOS_DISPONIVEIS });
});

// GET /api/plataforma/versoes — pacotes prontos de módulos (ex.: "Manutenção")
rota('GET', /^\/api\/plataforma\/versoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const data = db.load();
  enviarJSON(res, 200, { versoes: data.versoes });
});

// categorias de plano em cascata (pedido do usuário: "ajude a criar categorias de plano. Ao
// selecionar já é selecionado automático o que é liberado até o plano em que todas as funções é
// liberada") — cada versão só manda modulos_proprios (os módulos que ELA introduz); o campo
// modulos final (cumulativo, o que toda troca de plano já consumia) é sempre recalculado por
// db.recalcularModulosVersoes logo depois de qualquer criação/edição/exclusão, porque mexer numa
// versão de ordem baixa muda o acumulado de todas as de ordem mais alta também.
function validarModulosProprios(valor) {
  if (!Array.isArray(valor)) return { erro: 'Informe a lista de módulos deste plano.' };
  const invalido = valor.find((chave) => !db.CHAVES_MODULOS.includes(chave));
  if (invalido) return { erro: `Módulo desconhecido: ${invalido}` };
  return { modulos: [...new Set(valor)] };
}

// POST /api/plataforma/versoes — cria uma nova categoria de plano
rota('POST', /^\/api\/plataforma\/versoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  const nome = String(body.nome || '').trim();
  if (!nome) return enviarJSON(res, 400, { erro: 'Nome do plano é obrigatório.' });
  const validacao = validarModulosProprios(body.modulos_proprios || []);
  if (validacao.erro) return enviarJSON(res, 400, { erro: validacao.erro });
  const data = db.load();
  const maiorOrdemAtual = data.versoes.reduce((max, v) => Math.max(max, v.ordem || 0), 0);
  const ordem = Number.isFinite(Number(body.ordem)) && Number(body.ordem) > 0 ? Math.trunc(Number(body.ordem)) : maiorOrdemAtual + 1;
  const precoMensal = body.preco_mensal === null || body.preco_mensal === '' || body.preco_mensal === undefined ? null : Number(body.preco_mensal);
  const versao = { id: nextId(data, 'versoes'), nome, ordem, modulos_proprios: validacao.modulos, modulos: [], preco_mensal: precoMensal };
  data.versoes.push(versao);
  db.recalcularModulosVersoes(data);
  db.save(data);
  enviarJSON(res, 200, { versoes: data.versoes });
});

// PUT /api/plataforma/versoes/:id — edita nome/ordem/módulos próprios/preço de uma categoria
rota('PUT', /^\/api\/plataforma\/versoes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const versao = data.versoes.find((v) => v.id === Number(m[1]));
  if (!versao) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  if (body.nome !== undefined) {
    const nome = String(body.nome || '').trim();
    if (!nome) return enviarJSON(res, 400, { erro: 'Nome do plano é obrigatório.' });
    versao.nome = nome;
  }
  if (body.modulos_proprios !== undefined) {
    const validacao = validarModulosProprios(body.modulos_proprios);
    if (validacao.erro) return enviarJSON(res, 400, { erro: validacao.erro });
    versao.modulos_proprios = validacao.modulos;
  }
  if (body.ordem !== undefined) {
    if (!Number.isFinite(Number(body.ordem)) || Number(body.ordem) <= 0) return enviarJSON(res, 400, { erro: 'Ordem inválida.' });
    versao.ordem = Math.trunc(Number(body.ordem));
  }
  if (body.preco_mensal !== undefined) {
    versao.preco_mensal = body.preco_mensal === null || body.preco_mensal === '' ? null : Number(body.preco_mensal);
  }
  db.recalcularModulosVersoes(data);
  db.save(data);
  enviarJSON(res, 200, { versoes: data.versoes });
});

// DELETE /api/plataforma/versoes/:id — remove uma categoria de plano (bloqueado se alguma empresa
// ainda estiver nela, pra não deixar empresa.versao_id apontando pro nada)
rota('DELETE', /^\/api\/plataforma\/versoes\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const data = db.load();
  const id = Number(m[1]);
  const versao = data.versoes.find((v) => v.id === id);
  if (!versao) return enviarJSON(res, 404, { erro: 'Plano não encontrado.' });
  const emUso = data.empresas.filter((e) => e.versao_id === id).length;
  if (emUso > 0) return enviarJSON(res, 400, { erro: `Esse plano está em uso por ${emUso} empresa(s) — troque o plano delas antes de excluir.` });
  data.versoes = data.versoes.filter((v) => v.id !== id);
  db.recalcularModulosVersoes(data);
  db.save(data);
  enviarJSON(res, 200, { versoes: data.versoes });
});

// GET /api/plataforma/perfis — catálogo de perfil/segmento (Etapa 8), usado no cadastro de
// empresa nova (atalho de preenchimento) e na tela de edição do Super Admin.
rota('GET', /^\/api\/plataforma\/perfis$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  enviarJSON(res, 200, { perfis: db.PERFIS_DISPONIVEIS, tipos_os: db.TIPOS_OS_DISPONIVEIS, tipos_relatorio: db.TIPOS_RELATORIO_DISPONIVEIS });
});

// GET /api/plataforma/empresas — todas as empresas cadastradas na plataforma, cada uma já com a
// lista de administradores (pra o painel saber se a empresa ainda não tem ninguém pra logar).
rota('GET', /^\/api\/plataforma\/empresas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const data = db.load();
  const empresas = await Promise.all(data.empresas.map(async (e) => ({
    ...e,
    logo_url: await hidratarFotosProfundo(e.logo_url),
    administradores: data.usuarios
      .filter((u) => u.empresa_id === e.id && u.papel === 'administrador')
      .map((u) => ({ id: u.id, nome: u.nome, email: u.email, status: u.status })),
  })));
  enviarJSON(res, 200, { empresas });
});

// POST /api/plataforma/empresas — cadastra uma empresa nova, já com os módulos da versão escolhida
rota('POST', /^\/api\/plataforma\/empresas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  const data = db.load();
  const versao = body.versao_id ? data.versoes.find((v) => v.id === Number(body.versao_id)) : null;
  if (body.versao_id && !versao) return enviarJSON(res, 400, { erro: 'Versão não encontrada.' });
  const subdominio = normalizarSubdominio(body.subdominio);
  if (subdominio && !SUBDOMINIO_REGEX.test(subdominio)) {
    return enviarJSON(res, 400, { erro: 'Subdomínio inválido — use só letras minúsculas, números e hífen.' });
  }
  if (subdominio && data.empresas.some((e) => e.subdominio === subdominio)) {
    return enviarJSON(res, 400, { erro: 'Esse subdomínio já está em uso por outra empresa.' });
  }
  // Perfil/Segmento (Etapa 8): atalho de preenchimento — perfil ausente/não reconhecido = nenhum
  // atalho aplicado (empresa nasce sem restrição nenhuma, igual ao comportamento de antes dessa
  // etapa). Segmento ausente/não pertencente ao perfil escolhido cai em "generico".
  const perfilEscolhido = db.CHAVES_PERFIS.includes(body.perfil) ? body.perfil : null;
  const perfilCatalogo = perfilEscolhido ? db.PERFIS_DISPONIVEIS.find((p) => p.chave === perfilEscolhido) : null;
  const segmentoEscolhido = perfilCatalogo && perfilCatalogo.segmentos.some((s) => s.chave === body.segmento) ? body.segmento : (perfilCatalogo ? 'generico' : null);
  const preset = db.presetPerfilSegmento(perfilEscolhido, segmentoEscolhido);
  const empresa = {
    id: nextId(data, 'empresas'),
    nome: String(body.nome).trim(),
    subdominio,
    site: body.site || '', whatsapp: body.whatsapp || '', telefone: body.telefone || '',
    emails: Array.isArray(body.emails) ? body.emails : [],
    cor_primaria: body.cor_primaria || '#0B2D4F', cor_secundaria: body.cor_secundaria || '#0891B2',
    versao_id: versao ? versao.id : null,
    modulos_ativos: versao ? [...versao.modulos] : [],
    terminologia: preset.terminologia,
    perfil: perfilEscolhido,
    segmento: segmentoEscolhido,
    tipos_os_ativos: preset.tipos_os_ativos,
    tipos_relatorio_ativos: preset.tipos_relatorio_ativos,
    escala_ativa: preset.escala_ativa,
    // cotas de plano (Etapa 6/passo 3): a empresa nova herda o limite padrão da versão
    // escolhida (null = sem limite), editável depois por empresa pela rota de PUT abaixo.
    limite_tecnicos: versao && versao.limite_tecnicos != null ? versao.limite_tecnicos : null,
    limite_equipamentos: versao && versao.limite_equipamentos != null ? versao.limite_equipamentos : null,
    // status (Etapa 7/passo 1) — nasce "teste", diferente da empresa 1 (instalação atual, que
    // sincronizarEmpresaPadrao em db.js já marca "ativa"). Super Admin muda depois pelo PUT de
    // status. Plano/cobrança (passo 2) nascem vazios — só exibição, sem gateway de pagamento.
    status: 'teste',
    plano_valor_mensal: null,
    plano_dia_vencimento: null,
  };
  data.empresas.push(empresa);
  db.save(data);
  enviarJSON(res, 201, { empresa: { ...empresa, administradores: [] } });
});

// PUT /api/plataforma/empresas/:id — edita os dados básicos da empresa (nome, contato, cores).
// Não mexe em versão/módulos/terminologia — isso continua nas rotas próprias abaixo.
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await extrairFotosProfundo(await lerCorpo(req), Number(m[1]));
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome da empresa é obrigatório.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  const subdominio = body.subdominio !== undefined ? normalizarSubdominio(body.subdominio) : empresa.subdominio;
  if (subdominio && !SUBDOMINIO_REGEX.test(subdominio)) {
    return enviarJSON(res, 400, { erro: 'Subdomínio inválido — use só letras minúsculas, números e hífen.' });
  }
  if (subdominio && data.empresas.some((e) => e.id !== empresa.id && e.subdominio === subdominio)) {
    return enviarJSON(res, 400, { erro: 'Esse subdomínio já está em uso por outra empresa.' });
  }
  // site/whatsapp/telefone/emails só mudam quando vêm no corpo (Etapa 7/passo 2: a tela de
  // status/plano manda um PUT parcial, só com o que ela edita — sem isso, apagaria esses campos).
  Object.assign(empresa, {
    nome: String(body.nome).trim(),
    subdominio,
    site: body.site !== undefined ? body.site : empresa.site,
    whatsapp: body.whatsapp !== undefined ? body.whatsapp : empresa.whatsapp,
    telefone: body.telefone !== undefined ? body.telefone : empresa.telefone,
    emails: body.emails !== undefined ? (Array.isArray(body.emails) ? body.emails : []) : empresa.emails,
    cor_primaria: body.cor_primaria || empresa.cor_primaria, cor_secundaria: body.cor_secundaria || empresa.cor_secundaria,
  });
  if (body.logo_url !== undefined) empresa.logo_url = body.logo_url || null;
  if (body.valor_bonus_viagem !== undefined) {
    const valor = Number(body.valor_bonus_viagem);
    if (Number.isFinite(valor) && valor >= 0) empresa.valor_bonus_viagem = valor;
  }
  if (body.limite_viagens_bonus_mes !== undefined) {
    const limite = Number(body.limite_viagens_bonus_mes);
    if (Number.isInteger(limite) && limite >= 0) empresa.limite_viagens_bonus_mes = limite;
  }
  // cotas de plano (Etapa 6/passo 3) — vazio/null = sem limite (removido de propósito, pra o
  // Super Admin conseguir voltar uma empresa pra "sem limite" depois de ter definido uma cota).
  if (body.limite_tecnicos !== undefined) {
    empresa.limite_tecnicos = body.limite_tecnicos === null || body.limite_tecnicos === '' ? null : Number(body.limite_tecnicos);
  }
  if (body.limite_equipamentos !== undefined) {
    empresa.limite_equipamentos = body.limite_equipamentos === null || body.limite_equipamentos === '' ? null : Number(body.limite_equipamentos);
  }
  // plano e cobrança (Etapa 7/passo 2) — só exibição, sem gateway de pagamento.
  if (body.plano_valor_mensal !== undefined) {
    empresa.plano_valor_mensal = body.plano_valor_mensal === null || body.plano_valor_mensal === '' ? null : Number(body.plano_valor_mensal);
  }
  if (body.plano_dia_vencimento !== undefined) {
    empresa.plano_dia_vencimento = body.plano_dia_vencimento === null || body.plano_dia_vencimento === '' ? null : Number(body.plano_dia_vencimento);
  }
  // Perfil/Segmento (Etapa 8) — metadado simples, editável igual nome/site: nunca reaplica o
  // preset aqui (evitaria sobrescrever terminologia/tipos que o Super Admin já customizou depois
  // do cadastro). Quem quiser reaplicar um preset faz isso manualmente pelas rotas de tipos/módulos.
  if (body.perfil !== undefined) {
    empresa.perfil = db.CHAVES_PERFIS.includes(body.perfil) ? body.perfil : null;
  }
  if (body.segmento !== undefined) {
    const perfilAtual = db.PERFIS_DISPONIVEIS.find((p) => p.chave === empresa.perfil);
    empresa.segmento = perfilAtual && perfilAtual.segmentos.some((s) => s.chave === body.segmento) ? body.segmento : null;
  }
  db.save(data);
  enviarJSON(res, 200, { empresa: { ...empresa, logo_url: await hidratarFotosProfundo(empresa.logo_url) } });
});

// PUT /api/plataforma/empresas/:id/status { status } — Etapa 7/passo 1: suspender/reativar (ou
// marcar como "teste"). "suspensa" bloqueia login novo e qualquer rota pra quem já estava logado
// (ver checagem central no dispatcher, mais abaixo) — a empresa 1 (instalação atual, em uso de
// verdade) nunca pode ser suspensa por aqui, mesma trava do DELETE.
// "teste_expirado" (SaaS, passo 2) é diferente de "suspensa": nasce automático (ver
// verificarExpiracaoTeste), nunca de uma ação manual do Super Admin — mas ele pode reverter pra
// "ativa" pela mesma rota, igual já faz com "suspensa".
const STATUS_EMPRESA_VALIDOS = ['teste', 'ativa', 'suspensa', 'teste_expirado'];

// SaaS, passo 2: validade do trial. Dias configuráveis por variável de ambiente (padrão 14) — só
// empresa com status 'teste' é afetada; 'ativa'/'suspensa'/'teste_expirado' nunca passam por aqui
// de novo. Transforma o status na primeira requisição (login ou qualquer rota autenticada) que
// detectar que passou do prazo, e salva na hora — não é um job agendado, é checado sob demanda.
const DIAS_TRIAL = Number(process.env.DIAS_TRIAL) || 14;
function verificarExpiracaoTeste(empresa, data) {
  if (!empresa || empresa.status !== 'teste' || !empresa.criado_em) return false;
  const diasDesdeCriacao = (Date.now() - new Date(empresa.criado_em).getTime()) / (24 * 60 * 60 * 1000);
  if (diasDesdeCriacao <= DIAS_TRIAL) return false;
  empresa.status = 'teste_expirado';
  db.save(data);
  return true;
}
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)\/status$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const id = Number(m[1]);
  const body = await lerCorpo(req);
  if (!STATUS_EMPRESA_VALIDOS.includes(body.status)) {
    return enviarJSON(res, 400, { erro: `Status inválido — use um de: ${STATUS_EMPRESA_VALIDOS.join(', ')}.` });
  }
  if (id === 1 && body.status === 'suspensa') {
    return enviarJSON(res, 400, { erro: 'A instalação atual (empresa 1) não pode ser suspensa.' });
  }
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === id);
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  empresa.status = body.status;
  db.save(data);
  enviarJSON(res, 200, { empresa });
});

// DELETE /api/plataforma/empresas/:id — exclui a empresa e todo o dado que pertence só a ela
// (usuários, clientes, equipamentos, O.S., visitas, biblioteca, chamados, relatórios, RH, chat
// interno). Irreversível, por isso exige `confirmar_nome` batendo com o nome atual da empresa
// (o painel já confirma com o usuário antes de mandar — isso aqui é a segunda trava, no servidor).
// A empresa 1 (instalação atual) nunca pode ser excluída por aqui.
rota('DELETE', /^\/api\/plataforma\/empresas\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const id = Number(m[1]);
  if (id === 1) return enviarJSON(res, 400, { erro: 'A instalação atual (empresa 1) não pode ser excluída.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === id);
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  const body = await lerCorpo(req);
  if (String(body.confirmar_nome || '').trim() !== empresa.nome) {
    return enviarJSON(res, 400, { erro: 'Confirmação não bate com o nome da empresa.' });
  }
  for (const colecao of ['usuarios', 'clientes', 'equipamentos', 'agenda', 'visitas', 'registros', 'chamados', 'relatorios_manutencao', 'solicitacoes_rh', 'mensagens_internas']) {
    data[colecao] = data[colecao].filter((r) => r.empresa_id !== id);
  }
  data.empresas = data.empresas.filter((e) => e.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/plataforma/empresas/:id/administrador — cria o login de administrador da empresa.
// Empresa cadastrada pelo painel não nasce com usuário nenhum (só o registro da empresa em si) —
// sem isso não tem como ninguém entrar nela. Pode ser chamada mais de uma vez pra criar mais de
// um administrador na mesma empresa.
rota('POST', /^\/api\/plataforma\/empresas\/(\d+)\/administrador$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome é obrigatório.' });
  if (!body.email || !String(body.email).trim()) return enviarJSON(res, 400, { erro: 'E-mail é obrigatório.' });
  if (!body.senha || String(body.senha).length < 6) return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  if (data.usuarios.some((u) => u.email === body.email)) return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  const { salt, hash } = hashSenha(body.senha);
  const admin = tenant.criar(data, 'usuarios', empresa.id, {
    nome: String(body.nome).trim(), email: String(body.email).trim(), papel: 'administrador',
    cargo: '', setor: '', celular: '', cliente_id: null,
    acesso_total: true, menus: [], departamento: null,
    status: 'ativo', convite_token: null, salt, hash,
  });
  db.save(data);
  enviarJSON(res, 201, { usuario: usuarioPublico(admin) });
});

// PUT /api/plataforma/administradores/:id — edita nome/e-mail/status (e, opcionalmente, redefine a
// senha) de um administrador de qualquer empresa. Diferente de PUT /api/usuarios/:id (que só edita
// dentro da própria empresa de quem está logado) porque o super admin não pertence a empresa
// nenhuma — precisa de uma rota que enxergue todas.
rota('PUT', /^\/api\/plataforma\/administradores\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!body.nome || !String(body.nome).trim()) return enviarJSON(res, 400, { erro: 'Nome é obrigatório.' });
  if (!body.email || !String(body.email).trim()) return enviarJSON(res, 400, { erro: 'E-mail é obrigatório.' });
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === Number(m[1]) && u.papel === 'administrador');
  if (!admin) return enviarJSON(res, 404, { erro: 'Administrador não encontrado.' });
  if (admin.protegido) return enviarJSON(res, 403, { erro: 'Esta conta é protegida e só pode ser editada por ela mesma.' });
  if (data.usuarios.some((u) => u.id !== admin.id && u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  admin.nome = String(body.nome).trim();
  admin.email = String(body.email).trim();
  if (body.status === 'ativo' || body.status === 'inativo') admin.status = body.status;
  if (body.senha) {
    if (String(body.senha).length < 6) return enviarJSON(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    const { salt, hash } = hashSenha(body.senha);
    admin.salt = salt; admin.hash = hash;
  }
  db.save(data);
  enviarJSON(res, 200, { usuario: usuarioPublico(admin) });
});

// DELETE /api/plataforma/administradores/:id — remove o login de um administrador de qualquer
// empresa. Se era o único administrador da empresa, ela volta ao estado "sem administrador" (o
// próprio painel já trata isso, mostrando o aviso e o formulário de criar administrador de novo).
rota('DELETE', /^\/api\/plataforma\/administradores\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const data = db.load();
  const admin = data.usuarios.find((u) => u.id === Number(m[1]) && u.papel === 'administrador');
  if (!admin) return enviarJSON(res, 404, { erro: 'Administrador não encontrado.' });
  if (admin.protegido) return enviarJSON(res, 403, { erro: 'Esta conta é protegida e não pode ser excluída.' });
  data.usuarios = data.usuarios.filter((u) => u.id !== admin.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// PUT /api/plataforma/empresas/:id/modulos — liga/desliga módulos avulsos, independente da versão
// original (body.modulos = array final de chaves ativas — o painel manda a lista já resolvida)
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)\/modulos$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!Array.isArray(body.modulos)) return enviarJSON(res, 400, { erro: 'Informe a lista de módulos.' });
  const invalido = body.modulos.find((chave) => !db.CHAVES_MODULOS.includes(chave));
  if (invalido) return enviarJSON(res, 400, { erro: `Módulo desconhecido: ${invalido}` });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  empresa.modulos_ativos = [...new Set(body.modulos)];
  db.save(data);
  enviarJSON(res, 200, { empresa });
});

// PUT /api/plataforma/empresas/:id/tipos-os — Etapa 8: quais tipos de O.S. aparecem no formulário
// de "Nova Ordem de Serviço" dessa empresa (body.tipos vazio = "todos", mesmo efeito de null).
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)\/tipos-os$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!Array.isArray(body.tipos)) return enviarJSON(res, 400, { erro: 'Informe a lista de tipos de O.S.' });
  const invalido = body.tipos.find((tipo) => !db.TIPOS_OS_DISPONIVEIS.includes(tipo));
  if (invalido) return enviarJSON(res, 400, { erro: `Tipo de O.S. desconhecido: ${invalido}` });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  empresa.tipos_os_ativos = [...new Set(body.tipos)];
  db.save(data);
  enviarJSON(res, 200, { empresa });
});

// PUT /api/plataforma/empresas/:id/tipos-relatorio — Etapa 8: quais tipos de relatório aparecem
// na criação manual de relatório dessa empresa (body.tipos vazio = "todos", mesmo efeito de null).
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)\/tipos-relatorio$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!Array.isArray(body.tipos)) return enviarJSON(res, 400, { erro: 'Informe a lista de tipos de relatório.' });
  const invalido = body.tipos.find((tipo) => !db.TIPOS_RELATORIO_DISPONIVEIS.includes(tipo));
  if (invalido) return enviarJSON(res, 400, { erro: `Tipo de relatório desconhecido: ${invalido}` });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  empresa.tipos_relatorio_ativos = [...new Set(body.tipos)];
  db.save(data);
  enviarJSON(res, 200, { empresa });
});

// PUT /api/plataforma/empresas/:id/terminologia — troca os termos padrão do sistema pelos que a
// empresa escolher (ex.: { equipamento: 'Paciente' }); chave ausente/vazia volta a usar o padrão.
rota('PUT', /^\/api\/plataforma\/empresas\/(\d+)\/terminologia$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const body = await lerCorpo(req);
  if (!body.terminologia || typeof body.terminologia !== 'object') return enviarJSON(res, 400, { erro: 'Informe a terminologia.' });
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === Number(m[1]));
  if (!empresa) return enviarJSON(res, 404, { erro: 'Empresa não encontrada.' });
  const limpa = {};
  for (const [chave, valor] of Object.entries(body.terminologia)) {
    if (String(valor || '').trim()) limpa[chave] = String(valor).trim();
  }
  empresa.terminologia = limpa;
  db.save(data);
  enviarJSON(res, 200, { empresa });
});

// ---------- assistente de suporte via WhatsApp (opcional) ----------
// só funciona se as variáveis de ambiente estiverem configuradas (WHATSAPP_TOKEN,
// WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN, ANTHROPIC_API_KEY) — ver whatsapp.js
whatsapp.registrarRotasWhatsApp({ rota, enviarJSON, lerCorpo, url, db, enviarPush });

// ---------- arquivos estáticos (frontend) ----------

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function servirEstatico(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Proibido'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Não encontrado'); }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(content);
  });
}

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);
  const rotaEncontrada = rotas.find((r) => r.metodo === req.method && r.regex.test(pathname));
  if (rotaEncontrada) {
    try {
      // espera o banco (Postgres) terminar de conectar antes de tocar em qualquer
      // rota da API, pra nenhuma requisição cair no fallback de arquivo local por engano
      await db.pronto;
      // bloqueio central de módulo: roda antes de qualquer handler, então nenhuma rota escapa
      // dessa checagem — mesmo uma chamada direta na API (sem passar pelo menu do front) recebe
      // 403 se o módulo dono da rota não estiver ativo pra empresa do usuário.
      if (rotaEncontrada.modulo !== 'publico') {
        const user = usuarioAutenticado(req);
        if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
        // empresa suspensa (Etapa 7/passo 1): bloqueia também quem já estava logado antes da
        // suspensão — o token continua válido por até 12h, então checa de novo a cada requisição,
        // não só no login. super_admin não pertence a empresa (empresa_id null) e nunca é afetado.
        const dadosAtuais = db.load();
        if (user.empresa_id) {
          const empresaDoUsuario = dadosAtuais.empresas.find((e) => e.id === user.empresa_id);
          if (empresaDoUsuario && empresaDoUsuario.status === 'suspensa') {
            return enviarJSON(res, 403, { erro: 'Esta empresa está suspensa. Fale com o suporte.', codigo: 'empresa_suspensa' });
          }
          if (empresaDoUsuario && verificarExpiracaoTeste(empresaDoUsuario, dadosAtuais)) {
            return enviarJSON(res, 403, { erro: 'Seu período de teste acabou — fale com o suporte pra continuar.', codigo: 'teste_expirado' });
          }
        }
        if (rotaEncontrada.modulo !== 'nucleo' && !db.moduloAtivo(dadosAtuais, user.empresa_id, rotaEncontrada.modulo)) {
          return enviarJSON(res, 403, { erro: `Módulo "${rotaEncontrada.modulo}" não está ativo pra sua empresa.` });
        }
      }
      const m = pathname.match(rotaEncontrada.regex);
      await rotaEncontrada.handler(req, res, m);
    } catch (e) {
      console.error(e);
      // erro.publico = true marca um erro de validação com mensagem segura pra mostrar ao usuário
      // (ex.: limite de tamanho de foto) — tudo o mais continua como "Erro interno." genérico, pra
      // nunca vazar detalhe de uma falha inesperada de verdade pra quem está do outro lado da API.
      if (e.publico) return enviarJSON(res, e.status || 400, { erro: e.message });
      enviarJSON(res, 500, { erro: 'Erro interno.', detalhe: String(e.message || e) });
    }
    return;
  }
  if (pathname.startsWith('/api/')) {
    return enviarJSON(res, 404, { erro: 'Rota não encontrada.' });
  }
  // arquivos estáticos (login, html, css, js) não dependem do banco: servidos imediatamente
  servirEstatico(req, res, pathname);
});

// o servidor começa a aceitar conexões imediatamente, sem esperar o Postgres conectar,
// pra evitar 502 no Render enquanto a conexão com o banco ainda está sendo estabelecida.
// as rotas da API individualmente esperam `db.pronto` (acima) antes de processar qualquer coisa.
server.listen(PORT, () => {
  console.log(`Nexor Connect rodando em http://localhost:${PORT}`);
  if (process.env.ADMIN_EMAIL) console.log(`Conta de administrador: ${process.env.ADMIN_EMAIL}`);
});

db.pronto.then(() => {
  console.log(`Banco de dados: ${db.estaUsandoPostgres() ? 'Postgres' : db.DB_PATH}`);
  verificarLembretesRecorrentes();
  setInterval(verificarLembretesRecorrentes, 5 * 60 * 1000);
  migrarFotosParaTabelaSeparada().catch((e) => console.error('[fotos] erro na migração:', e.message));
});

// migração única: fotos que já estavam guardadas dentro do bloco principal (de antes de existir a
// tabela separada) saem de lá na primeira vez que o servidor sobe com este código — depois disso
// tudo já nasce pequeno (só a referência), então roda só essa vez (guardado em data._fotos_migradas).
async function migrarFotosParaTabelaSeparada() {
  const data = db.load();
  if (data._fotos_migradas) return;
  // cada registro já carrega seu próprio empresa_id — processa um a um (em vez de passar o
  // array inteiro de uma vez) pra cada foto nascer marcada com a empresa certa, não uma só pra
  // todo mundo.
  data.visitas = await Promise.all(data.visitas.map((v) => extrairFotosProfundo(v, v.empresa_id)));
  data.registros = await Promise.all(data.registros.map((r) => extrairFotosProfundo(r, r.empresa_id)));
  data.relatorios_manutencao = await Promise.all(data.relatorios_manutencao.map((r) => extrairFotosProfundo(r, r.empresa_id)));
  data._fotos_migradas = true;
  db.save(data);
  console.log('[fotos] migração de fotos pra tabela separada concluída.');
}
