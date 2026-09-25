// server.js — Pro Conecta, backend real (Fase 1 + Biblioteca técnica), sem dependências externas.
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
const webpush = require('web-push');
const { gerarToken, verificarToken, } = require('./auth');
const { hashSenha, conferirSenha, nextId, gerarTokenConvite } = db;
const { moduloDaRota } = require('./rotas-modulo');
const tenant = require('./tenant');

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
  suporte: ['agenda', 'fila-atendimento', 'relatorio-manutencao', 'calendario-tecnico', 'biblioteca', 'fila-reparo', 'chat-interno'],
  administrador: ['agenda', 'painel-atendimentos', 'solicitacao-atendimento', 'aprovacoes-visitas', 'biblioteca', 'clientes', 'equipamentos', 'usuarios', 'chat-interno'],
  cliente: ['biblioteca', 'equipamentos', 'chamados'],
  producao: ['biblioteca', 'clientes', 'equipamentos', 'chat-interno'],
  pos_venda: ['fila-pos-venda', 'chat-interno'],
  estoque: ['fila-estoque', 'chat-interno'],
};
// todo tipo de acesso interno (todo mundo menos cliente) pode usar o chat interno — é comunicação
// entre a própria equipe, cliente não faz parte.
const PAPEIS_CHAT_INTERNO = ['suporte', 'administrador', 'producao', 'pos_venda', 'estoque'];
// o token (JWT) só carrega id/papel/nome/cliente_id (ver gerarToken) — acesso_total/menus não vêm
// nele, então sempre busca o cadastro completo em `data.usuarios` pelo id antes de decidir. Único
// uso hoje é o submenu "Setor Reparo" do suporte (as outras rotas não são gated por menu, só por
// papel — o filtro dos demais menus acontece no sidebar do front, ver navDoUsuario em app.js).
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

// bônus de viagem (R$200) — nem toda O.S. dá direito (depende da região), então o administrador
// marca isso manualmente ao abrir/editar a O.S. Acima de 7 viagens com bônus no mês, o técnico
// precisaria se deslocar demais — o administrador tem que justificar antes de atribuir mais uma.
const LIMITE_VIAGENS_BONUS_MES = 7;
const VALOR_BONUS_VIAGEM = 200;
function contarViagensBonusMes(data, empresaId, tecnicoId, dataIso, excluirId) {
  const mesAno = String(dataIso || '').slice(0, 7); // "AAAA-MM"
  return tenant.listar(data, 'agenda', empresaId).filter((a) =>
    a.id !== excluirId &&
    a.tecnico_id === tecnicoId &&
    a.bonus_viagem &&
    String(a.data_hora_inicio || '').slice(0, 7) === mesAno
  ).length;
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
    tecnico_nome: tecnico ? tecnico.nome : null,
    tecnico_setor: tecnico ? tecnico.setor : null,
    cliente_nome: cliente ? cliente.nome_empresa : null,
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
    equipamento_tipo: equipamento ? equipamento.tipo : null,
    equipamento_modelo: equipamento ? equipamento.modelo : null,
    equipamento_serie: equipamento ? equipamento.numero_serie : null,
    equipamento_data_fabricacao: equipamento ? equipamento.data_fabricacao : null,
    os_criada_numero: osCriada ? (osCriada.numero_os || `OS-${String(osCriada.id).padStart(6, '0')}`) : null,
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

// lembrete do dia do atendimento: pra cada O.S. de hoje que já passou do horário marcado e
// o técnico ainda não avisou que está a caminho, manda um push uma única vez (lembrete_deslocamento_enviado
// evita repetir). Não é um cron de verdade — só funciona enquanto o processo do servidor
// estiver de pé; num plano que "dorme" por inatividade isso pode não disparar.
async function verificarLembretesDeslocamento() {
  try {
    const data = db.load();
    const agora = new Date();
    // "hoje" também precisa ser o dia em Brasília, não em UTC — perto da meia-noite os dois
    // calendários divergem (ex: 22h de Brasília já é o dia seguinte em UTC)
    const hojeISO = new Date(agora.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let mudou = false;
    for (const item of data.agenda) {
      if (item.finalizada || item.deslocamento_iniciado_em || item.lembrete_deslocamento_enviado) continue;
      // categoria 'online' não tem deslocamento nenhum (inclusive o "atendimento" criado sozinho
      // quando o técnico assume o chat, com data_hora_inicio = o instante em que assumiu — não é
      // uma visita agendada de verdade) — só faz sentido lembrar de ir pra quem é visita presencial
      if (item.categoria !== 'inloco') continue;
      if (!item.data_hora_inicio || !item.data_hora_inicio.startsWith(hojeISO)) continue;
      const horario = horarioBrasiliaParaData(item.data_hora_inicio);
      if (!horario || agora < horario) continue; // só lembra a partir do horário marcado
      const cliente = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
      await enviarPush(data, item.tecnico_id, {
        titulo: 'Atendimento hoje',
        corpo: `Não esqueça: ${cliente ? cliente.nome_empresa : 'seu atendimento'} hoje (${fmtDataHoraCurta(item.data_hora_inicio)}). Toque pra marcar "Iniciar deslocamento".`,
        url: '/',
      });
      item.lembrete_deslocamento_enviado = true;
      mudou = true;
    }
    if (mudou) db.save(data);
  } catch (e) {
    console.error('[lembrete] erro ao verificar deslocamentos:', e.message);
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

// calcula o SLA a partir das respostas enviadas na abertura/edição manual da O.S. (mesma
// pontuação usada pela IA no chat) — retorna null se o admin não preencheu o questionário
function slaDoBody(body, equipamento) {
  if (!body.sla_respostas || typeof body.sla_respostas !== 'object') return null;
  const respostas = { ...body.sla_respostas };
  if (respostas.garantia_fabricacao === undefined) {
    respostas.garantia_fabricacao = equipamento ? (dentroDaGarantiaDeFabrica(equipamento.data_fabricacao) || false) : false;
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

function usuarioPublico(u) {
  const { salt, hash, convite_token, ...resto } = u;
  return resto;
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
async function extrairFotosProfundo(valor) {
  if (typeof valor === 'string') {
    if (!valor.startsWith('data:') || valor.length < 100) return valor;
    const id = await db.salvarFoto(valor);
    return { __foto_ref: id };
  }
  if (Array.isArray(valor)) return Promise.all(valor.map((v) => extrairFotosProfundo(v)));
  if (valor && typeof valor === 'object') {
    const entradas = await Promise.all(Object.entries(valor).map(async ([k, v]) => [k, await extrairFotosProfundo(v)]));
    return Object.fromEntries(entradas);
  }
  return valor;
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

// ---------- rotas da API ----------

const rotas = [];
function rota(metodo, regex, handler) {
  rotas.push({ metodo, regex, handler, modulo: moduloDaRota(regex) });
}

// POST /api/login
rota('POST', /^\/api\/login$/, async (req, res) => {
  const { email: emailLogin, senha } = await lerCorpo(req);
  const data = db.load();
  const u = data.usuarios.find((x) => x.email === emailLogin);
  if (!u || u.status !== 'ativo' || !conferirSenha(senha || '', u.salt, u.hash)) {
    return enviarJSON(res, 401, { erro: 'E-mail ou senha inválidos.' });
  }
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id, empresa_id: u.empresa_id });
  const empresaDoUsuario = data.empresas.find((e) => e.id === u.empresa_id);
  enviarJSON(res, 200, { token, usuario: {
    ...usuarioPublico(u),
    modulos_ativos: (empresaDoUsuario && empresaDoUsuario.modulos_ativos) || [],
    terminologia: (empresaDoUsuario && empresaDoUsuario.terminologia) || {},
  } });
});

// dados de marca da empresa (nome, contato, cores) — pública porque a tela de login também usa,
// antes de qualquer autenticação. Hoje só existe uma empresa (id 1); ver db.js.
rota('GET', /^\/api\/empresa$/, async (req, res) => {
  const data = db.load();
  const empresa = data.empresas.find((e) => e.id === 1);
  enviarJSON(res, 200, { empresa });
});

// GET /api/me
rota('GET', /^\/api\/me$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const empresaDoUsuario = data.empresas.find((e) => e.id === user.empresa_id);
  enviarJSON(res, 200, { usuario: {
    ...user,
    modulos_ativos: (empresaDoUsuario && empresaDoUsuario.modulos_ativos) || [],
    terminologia: (empresaDoUsuario && empresaDoUsuario.terminologia) || {},
  } });
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
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id, empresa_id: u.empresa_id });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(u) });
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

// POST /api/agenda  (administrador cria atividade)
rota('POST', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador pode criar atividades.' });
  const body = await lerCorpo(req);
  // treinamento online não exige deslocamento até o cliente, então não pede endereço
  const obrig = ['tecnico_id', 'cliente_id', 'equipamento_id', 'data_hora_inicio', 'data_hora_fim', 'tipo', 'contato', 'telefone', 'email'];
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
  const equipamentoEscolhido = tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado && tenant.listar(data, 'agenda', user.empresa_id).some((a) => (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado)) {
    return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
  }
  const bonusViagem = !!body.bonus_viagem;
  let justificativaLimiteViagens = '';
  if (bonusViagem) {
    const jaTem = contarViagensBonusMes(data, user.empresa_id, Number(body.tecnico_id), body.data_hora_inicio, null);
    if (jaTem >= LIMITE_VIAGENS_BONUS_MES) {
      justificativaLimiteViagens = String(body.justificativa_limite_viagens || '').trim();
      if (!justificativaLimiteViagens) {
        return enviarJSON(res, 400, { erro: `Este técnico já tem ${jaTem} viagens com bônus neste mês (limite: ${LIMITE_VIAGENS_BONUS_MES}). Justifique pra continuar.`, precisa_justificativa: true });
      }
    }
  }
  const item = tenant.criar(data, 'agenda', user.empresa_id, {
    numero_os: numeroOSDigitado || null, // preenchido logo abaixo, depois de saber o id gerado
    tecnico_id: Number(body.tecnico_id),
    cliente_id: Number(body.cliente_id),
    equipamento_id: Number(body.equipamento_id),
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
    lembrete_deslocamento_enviado: false,
    confirmado_cliente_em: null,
    feedback_cliente_em: null,
    orcamento_aprovado_em: null,
    orcamento_reprovado_em: null,
    retorno_pendente_tecnico: false,
    retorno_confirmado_cliente_em: null,
    retorno_deslocamento_iniciado_em: null,
    retorno_chegada_confirmada_em: null,
    bonus_viagem: bonusViagem,
    justificativa_limite_viagens: justificativaLimiteViagens,
  });
  if (!item.numero_os) item.numero_os = `OS-${String(item.id).padStart(6, '0')}`;
  db.save(data);
  const clienteNovaOS = data.clientes.find((c) => c.id === item.cliente_id && c.empresa_id === item.empresa_id);
  enviarPush(data, item.tecnico_id, {
    titulo: 'Nova O.S. atribuída',
    corpo: `${clienteNovaOS ? clienteNovaOS.nome_empresa : 'Novo atendimento'} — ${fmtDataHoraCurta(item.data_hora_inicio)}.`,
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
  const obrig = ['tecnico_id', 'cliente_id', 'equipamento_id', 'data_hora_inicio', 'data_hora_fim', 'tipo', 'contato', 'telefone', 'email'];
  if (body.tipo !== 'treinamento_online') obrig.push('endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado');
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo)) obrig.push('garantia');
  for (const campo of obrig) {
    if (!body[campo] || !String(body[campo]).trim()) return enviarJSON(res, 400, { erro: `Campo obrigatório faltando: ${campo}` });
  }
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && body.garantia === 'na' && !String(body.garantia_obs || '').trim()) {
    return enviarJSON(res, 400, { erro: 'Especifique o motivo do "N/A" na garantia.' });
  }
  const equipamentoEscolhido = tenant.buscar(data, 'equipamentos', Number(body.equipamento_id), user.empresa_id);
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado) {
    const jaExisteEmOutra = tenant.listar(data, 'agenda', user.empresa_id).some((a) => a.id !== item.id && (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado);
    if (jaExisteEmOutra) return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
  }
  const bonusViagem = !!body.bonus_viagem;
  let justificativaLimiteViagens = '';
  if (bonusViagem) {
    const jaTem = contarViagensBonusMes(data, user.empresa_id, Number(body.tecnico_id), body.data_hora_inicio, item.id);
    if (jaTem >= LIMITE_VIAGENS_BONUS_MES) {
      justificativaLimiteViagens = String(body.justificativa_limite_viagens || item.justificativa_limite_viagens || '').trim();
      if (!justificativaLimiteViagens) {
        return enviarJSON(res, 400, { erro: `Este técnico já tem ${jaTem} viagens com bônus neste mês (limite: ${LIMITE_VIAGENS_BONUS_MES}). Justifique pra continuar.`, precisa_justificativa: true });
      }
    }
  }
  // se o técnico designado mudou, ele ainda não viu essa atribuição — reabre a notificação
  const trocouTecnico = Number(body.tecnico_id) !== item.tecnico_id;
  Object.assign(item, {
    numero_os: numeroOSDigitado || item.numero_os || `OS-${String(item.id).padStart(6, '0')}`,
    tecnico_id: Number(body.tecnico_id),
    cliente_id: Number(body.cliente_id),
    equipamento_id: Number(body.equipamento_id),
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
    justificativa_limite_viagens: bonusViagem ? justificativaLimiteViagens : '',
  });
  if (trocouTecnico) item.lida_tecnico = false;
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// GET /api/tecnicos/viagens?mes=AAAA-MM — acompanhamento do bônus de viagem por técnico: quantas
// O.S. com bônus cada um tem no mês, o valor total (R$200 cada) e quais passaram do limite de 7
// (com a justificativa que o administrador deu ao atribuir).
rota('GET', /^\/api\/tecnicos\/viagens$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador acompanha o bônus de viagem.' });
  const { query } = url.parse(req.url, true);
  const mes = query.mes || new Date().toISOString().slice(0, 7);
  const data = db.load();
  const tecnicos = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'suporte' && u.status === 'ativo');
  const porTecnico = tecnicos.map((t) => {
    const viagens = tenant.listar(data, 'agenda', user.empresa_id)
      .filter((a) => a.tecnico_id === t.id && a.bonus_viagem && String(a.data_hora_inicio || '').slice(0, 7) === mes)
      .sort((x, y) => (x.data_hora_inicio || '').localeCompare(y.data_hora_inicio || ''));
    return {
      tecnico_id: t.id,
      tecnico_nome: t.nome,
      quantidade: viagens.length,
      valor_total: viagens.length * VALOR_BONUS_VIAGEM,
      passou_limite: viagens.length > LIMITE_VIAGENS_BONUS_MES,
      viagens: viagens.map((a) => ({
        id: a.id, numero_os: a.numero_os || `OS-${String(a.id).padStart(6, '0')}`,
        cliente_nome: (data.clientes.find((c) => c.id === a.cliente_id && c.empresa_id === a.empresa_id) || {}).nome_empresa || '—',
        data_hora_inicio: a.data_hora_inicio,
        justificativa_limite_viagens: a.justificativa_limite_viagens || '',
      })),
    };
  }).sort((a, b) => b.quantidade - a.quantidade);
  enviarJSON(res, 200, { mes, limite: LIMITE_VIAGENS_BONUS_MES, valor_bonus: VALOR_BONUS_VIAGEM, tecnicos: porTecnico });
});

// ---------- solicitações de RH do técnico (folga, banco de horas, férias, home office) ----------
// mesmo padrão de "solicitação -> aprovação" já usado em outras partes do sistema (ex.: solicitação
// de edição na biblioteca) — o técnico pede, o administrador aprova ou reprova com uma resposta.

const TIPOS_SOLICITACAO_RH = ['folga', 'banco_horas', 'ferias', 'home_office'];
const LABEL_SOLICITACAO_RH = { folga: 'folga', banco_horas: 'banco de horas', ferias: 'férias', home_office: 'home office' };

// POST /api/solicitacoes-rh — o técnico cria um pedido
rota('POST', /^\/api\/solicitacoes-rh$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico faz esse tipo de solicitação.' });
  const body = await lerCorpo(req);
  if (!TIPOS_SOLICITACAO_RH.includes(body.tipo)) return enviarJSON(res, 400, { erro: 'Tipo de solicitação inválido.' });
  if (!body.data_inicio) return enviarJSON(res, 400, { erro: 'Informe a data.' });
  if (body.tipo === 'banco_horas' && (!body.horas || !['credito', 'debito'].includes(body.operacao))) {
    return enviarJSON(res, 400, { erro: 'Informe as horas e se é crédito ou débito no banco de horas.' });
  }
  if (!String(body.motivo || '').trim()) return enviarJSON(res, 400, { erro: 'Descreva o motivo do pedido.' });
  const data = db.load();
  const item = tenant.criar(data, 'solicitacoes_rh', user.empresa_id, {
    tecnico_id: user.id,
    tipo: body.tipo,
    data_inicio: body.data_inicio,
    data_fim: body.data_fim || body.data_inicio,
    horas: body.tipo === 'banco_horas' ? Number(body.horas) : null,
    operacao: body.tipo === 'banco_horas' ? body.operacao : null,
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
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Sem acesso.' });
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
rota('POST', /^\/api\/agenda\/(\d+)\/iniciar-deslocamento$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado inicia o deslocamento.' });
  const data = db.load();
  const item = tenant.buscar(data, 'agenda', Number(m[1]), user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (item.retorno_pendente_tecnico) {
    if (!item.retorno_confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de iniciar o deslocamento do retorno.' });
    if (item.retorno_deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.retorno_deslocamento_iniciado_em = new Date().toISOString();
  } else {
    if (!item.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de iniciar o deslocamento.' });
    if (item.deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.deslocamento_iniciado_em = new Date().toISOString();
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
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
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
  db.save(data);
  const admins = tenant.listar(data, 'usuarios', user.empresa_id).filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico chegou',
      corpo: `${user.nome} chegou no cliente da O.S. ${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}.`,
      url: '/',
    }).catch(() => {});
  });
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
  const body = await extrairFotosProfundo(await lerCorpo(req));
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
    laudo = laudoCompleto;
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
  const resultado = await email.enviarRelatorio({ emails: body.emails, pdfBase64: body.pdf_base64, nomeArquivo });
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
  const body = await extrairFotosProfundo(await lerCorpo(req));
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
  const body = await extrairFotosProfundo(await lerCorpo(req));
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
  const body = await extrairFotosProfundo(await lerCorpo(req));
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
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const lista = tenant.listar(data, 'relatorios_manutencao', user.empresa_id)
    .filter((r) => r.autor_id === user.id)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''))
    .map((r) => { const { fotos, ...resto } = r; return resto; });
  enviarJSON(res, 200, { relatorios: lista });
});

// GET /api/relatorios-manutencao/:id — reabrir um relatório já criado (pra gerar o PDF de novo)
rota('GET', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.autor_id === user.id && r.empresa_id === user.empresa_id);
  if (!item) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  enviarJSON(res, 200, { relatorio: await hidratarFotosProfundo(item) });
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

// POST /api/relatorios-manutencao — cria um relatório avulso; salva na hora, sem aprovação do admin.
// Três formatos possíveis, diferenciados por body.tipo: "completo" (formulário manual de sempre),
// "ficha" (só os dados que a etiqueta do equipamento tem, vindo do Lev. Estoque Etiqueta) ou
// "ciclagem" (Ensaio de Ciclagem — ciclos de teste com amostras OK/com desvio).
rota('POST', /^\/api\/relatorios-manutencao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico cria este relatório.' });
  const body = await extrairFotosProfundo(await lerCorpo(req));
  const tipo = body.tipo === 'ficha' ? 'ficha' : body.tipo === 'ciclagem' ? 'ciclagem' : body.tipo === 'preventiva' ? 'preventiva' : body.tipo === 'corretiva' ? 'corretiva' : body.tipo === 'relatorio_tecnico' ? 'relatorio_tecnico' : body.tipo === 'aceite_entrega' ? 'aceite_entrega' : 'completo';
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
  } else if (tipo === 'corretiva') {
    const erroCorretiva = validarRelatorioCorretiva(body);
    if (erroCorretiva) return enviarJSON(res, 400, { erro: erroCorretiva });
  } else if (tipo === 'relatorio_tecnico') {
    const erroTecnico = validarRelatorioTecnico(body);
    if (erroTecnico) return enviarJSON(res, 400, { erro: erroTecnico });
  } else if (tipo === 'aceite_entrega') {
    const erroAceite = validarRelatorioAceite(body);
    if (erroAceite) return enviarJSON(res, 400, { erro: erroAceite });
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
  });
  db.save(data);
  enviarJSON(res, 201, { relatorio: item });
});

// PUT /api/relatorios-manutencao/:id — o próprio autor pode editar um relatório que criou.
// O tipo (completo/ficha/ciclagem) é fixo desde a criação — só os campos daquele tipo são atualizados.
rota('PUT', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const body = await extrairFotosProfundo(await lerCorpo(req));
  const data = db.load();
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.autor_id === user.id && r.empresa_id === user.empresa_id);
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
  db.save(data);
  enviarJSON(res, 200, { relatorio: item });
});

// DELETE /api/relatorios-manutencao/:id — o próprio autor pode apagar um relatório que criou
rota('DELETE', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const relatorioExcluir = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.autor_id === user.id && r.empresa_id === user.empresa_id);
  if (!relatorioExcluir) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  data.relatorios_manutencao = data.relatorios_manutencao.filter((r) => r.id !== relatorioExcluir.id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/clientes — administrador: lista de empresas-cliente (para vincular usuário/chamado)
rota('GET', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção veem clientes.' });
  const data = db.load();
  enviarJSON(res, 200, { clientes: tenant.listar(data, 'clientes', user.empresa_id) });
});

// POST /api/clientes — administrador cadastra uma nova empresa-cliente
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
  data.clientes = data.clientes.filter((c) => c.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/equipamentos
rota('GET', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let lista = tenant.listar(data, 'equipamentos', user.empresa_id);
  if (user.papel === 'cliente') lista = lista.filter((e) => e.cliente_id === user.cliente_id);
  enviarJSON(res, 200, { equipamentos: lista });
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
rota('POST', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção cadastram equipamentos.' });
  const body = await lerCorpo(req);
  if (!body.tipo || !String(body.tipo).trim() || !body.modelo || !String(body.modelo).trim()) {
    return enviarJSON(res, 400, { erro: 'Tipo e modelo são obrigatórios.' });
  }
  const data = db.load();
  const item = tenant.criar(data, 'equipamentos', user.empresa_id, {
    cliente_id: null,
    tipo: body.tipo.trim(), modelo: body.modelo.trim(), numero_serie: '', data_fabricacao: '', localizacao: '',
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
  if (equipamento.cliente_id === null) {
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
  }
  db.save(data);
  enviarJSON(res, 200, { equipamento });
});

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
  const item = tenant.criar(data, 'equipamentos', user.empresa_id, {
    cliente_id: cliente.id,
    tipo: catalogo.tipo,
    modelo: catalogo.modelo,
    numero_serie: body.numero_serie.trim(),
    data_fabricacao: body.data_fabricacao || '',
    localizacao: body.localizacao || '',
  });
  db.save(data);
  enviarJSON(res, 201, { equipamento: item });
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

// GET /api/usuarios
rota('GET', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê usuários.' });
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
  if (tenant.listar(data, 'usuarios', user.empresa_id).some((u) => u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  const convite_token = gerarTokenConvite();
  const { acesso_total, menus } = sanitizarMenusAcesso(body.papel, body);
  const departamento = body.papel === 'administrador' && !admin.departamento && DEPARTAMENTOS_ADMIN.includes(body.departamento) ? body.departamento : null;
  const novo = tenant.criar(data, 'usuarios', user.empresa_id, {
    nome: body.nome, email: body.email, papel: body.papel,
    cargo: body.cargo || '', setor: body.setor || '',
    celular: body.celular || '', cliente_id: body.cliente_id || null,
    acesso_total, menus, departamento,
    status: 'convite_enviado', convite_token,
    salt: null, hash: null,
  });
  db.save(data);
  const link = `${APP_URL}/ativar.html?token=${convite_token}`;
  const resultado = await email.enviarConvite({ nome: novo.nome, email: novo.email, link });
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
  const resultado = await email.enviarConvite({ nome: u.nome, email: u.email, link });
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
    celular: body.celular || '', cliente_id: body.papel === 'cliente' ? (body.cliente_id || null) : null,
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

// ---------- atendimento por chat (chamados: IA de 1º nível -> fila -> técnico) ----------
// o mesmo "chamado" é o fio da conversa tanto quando o cliente entra pelo chat dentro do
// ProConecta quanto quando manda mensagem pelo WhatsApp (ver whatsapp.js) — o técnico responde
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

// POST /api/chamados — o cliente (logado no ProConecta) inicia um atendimento com a primeira
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
// técnico já assumiu (administrador sempre vê tudo).
rota('GET', /^\/api\/chamados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só técnico ou administrador acessam a fila de atendimento.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  const chamadosDaEmpresa = tenant.listar(data, 'chamados', user.empresa_id);
  let lista;
  if (user.papel === 'administrador') {
    lista = query.status ? chamadosDaEmpresa.filter((c) => c.status === query.status) : chamadosDaEmpresa.filter((c) => c.status !== 'encerrado');
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
rota('POST', /^\/api\/chamados\/(\d+)\/assumir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['suporte', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só técnico ou administrador assumem atendimentos.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const chamado = tenant.buscar(data, 'chamados', Number(m[1]), user.empresa_id);
  if (!chamado) return enviarJSON(res, 404, { erro: 'Atendimento não encontrado.' });
  if (chamado.status !== 'aguardando_tecnico') return enviarJSON(res, 400, { erro: 'Este atendimento não está aguardando um técnico.' });
  if (!chamado.cliente_id) return enviarJSON(res, 400, { erro: 'Este atendimento não tem um cliente identificado no cadastro — não é possível abrir uma O.S. a partir dele.' });

  const cliente = data.clientes.find((c) => c.id === chamado.cliente_id && c.empresa_id === chamado.empresa_id);
  const equipamentoDoChamado = chamado.equipamento_id ? data.equipamentos.find((e) => e.id === chamado.equipamento_id && e.cliente_id === chamado.cliente_id && e.empresa_id === chamado.empresa_id) : null;
  // toda O.S. aberta a partir de um chamado do chat nasce como "Atendimento" — é o técnico quem,
  // ao preencher o Laudo Técnico, define se era mesmo uma corretiva/preventiva de verdade
  const tipo = 'atendimento';

  const agora = new Date();
  const inicioISO = agora.toISOString().slice(0, 16);
  const fimISO = new Date(agora.getTime() + 60 * 60000).toISOString().slice(0, 16);
  const osItem = tenant.criar(data, 'agenda', user.empresa_id, {
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
    lembrete_deslocamento_enviado: false,
    // o cliente já pediu o atendimento pelo chat — não faz sentido pedir confirmação de novo
    confirmado_cliente_em: agora.toISOString(),
    feedback_cliente_em: null,
    orcamento_aprovado_em: null,
    orcamento_reprovado_em: null,
    retorno_pendente_tecnico: false,
    retorno_confirmado_cliente_em: null,
    retorno_deslocamento_iniciado_em: null,
    retorno_chegada_confirmada_em: null,
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
    const nomeEmpresa = (data.empresas.find((e) => e.id === 1) || {}).nome || 'a empresa';
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

// ---------- esqueleto dos módulos novos (crm, agendamento, financeiro, prestacao_contas) ----------
// ainda não têm tela nem dado nenhum — só provam que o pipeline de ativação funciona ponta a
// ponta pros 4 de uma vez: rota gated pelo módulo certo (ver rotas-modulo.js), menu que só aparece
// se o módulo estiver ativo (ver NAV em public/app.js) levando a uma tela "Em breve". Quando um
// desses módulos ganhar telas de verdade, essa rota de status é substituída pelas rotas reais.
for (const chave of ['crm', 'agendamento', 'financeiro', 'prestacao_contas']) {
  const caminho = chave === 'prestacao_contas' ? 'prestacao-contas' : chave;
  rota('GET', new RegExp(`^/api/${caminho}/status$`), async (req, res) => {
    const user = usuarioAutenticado(req);
    if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
    enviarJSON(res, 200, { modulo: chave, status: 'em construção' });
  });
}

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

// GET /api/plataforma/empresas — todas as empresas cadastradas na plataforma, cada uma já com a
// lista de administradores (pra o painel saber se a empresa ainda não tem ninguém pra logar).
rota('GET', /^\/api\/plataforma\/empresas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['super_admin'])) return enviarJSON(res, 403, { erro: 'Só o super admin acessa o painel da plataforma.' });
  const data = db.load();
  const empresas = data.empresas.map((e) => ({
    ...e,
    administradores: data.usuarios
      .filter((u) => u.empresa_id === e.id && u.papel === 'administrador')
      .map((u) => ({ id: u.id, nome: u.nome, email: u.email, status: u.status })),
  }));
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
  const empresa = {
    id: nextId(data, 'empresas'),
    nome: String(body.nome).trim(),
    site: body.site || '', whatsapp: body.whatsapp || '', telefone: body.telefone || '',
    emails: Array.isArray(body.emails) ? body.emails : [],
    cor_primaria: body.cor_primaria || '#0A2647', cor_secundaria: body.cor_secundaria || '#0E7C86',
    versao_id: versao ? versao.id : null,
    modulos_ativos: versao ? [...versao.modulos] : [],
    terminologia: {},
  };
  data.empresas.push(empresa);
  db.save(data);
  enviarJSON(res, 201, { empresa: { ...empresa, administradores: [] } });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
        if (rotaEncontrada.modulo !== 'nucleo' && !db.moduloAtivo(db.load(), user.empresa_id, rotaEncontrada.modulo)) {
          return enviarJSON(res, 403, { erro: `Módulo "${rotaEncontrada.modulo}" não está ativo pra sua empresa.` });
        }
      }
      const m = pathname.match(rotaEncontrada.regex);
      await rotaEncontrada.handler(req, res, m);
    } catch (e) {
      console.error(e);
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
  console.log(`Pro Conecta rodando em http://localhost:${PORT}`);
  if (process.env.ADMIN_EMAIL) console.log(`Conta de administrador: ${process.env.ADMIN_EMAIL}`);
});

db.pronto.then(() => {
  console.log(`Banco de dados: ${db.estaUsandoPostgres() ? 'Postgres' : db.DB_PATH}`);
  verificarLembretesDeslocamento();
  setInterval(verificarLembretesDeslocamento, 15 * 60 * 1000);
  migrarFotosParaTabelaSeparada().catch((e) => console.error('[fotos] erro na migração:', e.message));
});

// migração única: fotos que já estavam guardadas dentro do bloco principal (de antes de existir a
// tabela separada) saem de lá na primeira vez que o servidor sobe com este código — depois disso
// tudo já nasce pequeno (só a referência), então roda só essa vez (guardado em data._fotos_migradas).
async function migrarFotosParaTabelaSeparada() {
  const data = db.load();
  if (data._fotos_migradas) return;
  data.visitas = await extrairFotosProfundo(data.visitas);
  data.registros = await extrairFotosProfundo(data.registros);
  data.relatorios_manutencao = await extrairFotosProfundo(data.relatorios_manutencao);
  data._fotos_migradas = true;
  db.save(data);
  console.log('[fotos] migração de fotos pra tabela separada concluída.');
}
