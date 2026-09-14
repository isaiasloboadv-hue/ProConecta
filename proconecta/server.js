// server.js — Pro Conecta, backend real (Fase 1 + Biblioteca técnica), sem dependências externas.
// Rode com: node server.js
// Abra: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const email = require('./email');
const webpush = require('web-push');
const { gerarToken, verificarToken, } = require('./auth');
const { hashSenha, conferirSenha, nextId, gerarTokenConvite } = db;

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

// junta dados de exibição (nome do técnico/cliente/equipamento) numa agenda
function agendaComDetalhes(data, item) {
  const tecnico = data.usuarios.find((u) => u.id === item.tecnico_id);
  const cliente = data.clientes.find((c) => c.id === item.cliente_id);
  const equipamento = data.equipamentos.find((e) => e.id === item.equipamento_id);
  const visita = data.visitas.find((v) => v.agenda_id === item.id && (v.rodada || 1) === 1);
  const visitaRetorno = data.visitas.find((v) => v.agenda_id === item.id && v.rodada === 2);
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
  };
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
  webpush.setVapidDetails('mailto:contato@promarking.com.br', data.vapid.publicKey, data.vapid.privateKey);
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

// lembrete do dia do atendimento: pra cada O.S. de hoje que já passou do horário marcado e
// o técnico ainda não avisou que está a caminho, manda um push uma única vez (lembrete_deslocamento_enviado
// evita repetir). Não é um cron de verdade — só funciona enquanto o processo do servidor
// estiver de pé; num plano que "dorme" por inatividade isso pode não disparar.
async function verificarLembretesDeslocamento() {
  try {
    const data = db.load();
    const agora = new Date();
    const hojeISO = agora.toISOString().slice(0, 10);
    let mudou = false;
    for (const item of data.agenda) {
      if (item.finalizada || item.deslocamento_iniciado_em || item.lembrete_deslocamento_enviado) continue;
      if (!item.data_hora_inicio || !item.data_hora_inicio.startsWith(hojeISO)) continue;
      if (agora < new Date(item.data_hora_inicio)) continue; // só lembra a partir do horário marcado
      const cliente = data.clientes.find((c) => c.id === item.cliente_id);
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
const TIPOS_LAUDO_TECNICO = ['corretiva', 'preventiva'];
// tipos que usam o termo de aceite com checklist/assinatura — hoje só treinamento presencial,
// enquanto o modelo de referência específico dele não chega
const TIPOS_TERMO_ACEITE = ['treinamento_presencial'];

// dados do atendimento definidos pelo administrador na abertura da OS — o técnico só visualiza,
// nunca são aceitos a partir do que o técnico envia (mesmo que ele tente via chamada direta à API)
function dadosAtendimentoBloqueados(data, agendaItem, user) {
  const cliente = data.clientes.find((c) => c.id === agendaItem.cliente_id);
  const equipamento = data.equipamentos.find((e) => e.id === agendaItem.equipamento_id);
  // o token de sessão só carrega id/papel/nome/cliente_id — o e-mail vem do cadastro completo
  const usuarioCompleto = data.usuarios.find((u) => u.id === user.id);
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
  const autor = data.usuarios.find((u) => u.id === r.autor_id);
  return { ...r, autor_nome: autor ? autor.nome : null };
}

// ---------- rotas da API ----------

const rotas = [];
function rota(metodo, regex, handler) {
  rotas.push({ metodo, regex, handler });
}

// POST /api/login
rota('POST', /^\/api\/login$/, async (req, res) => {
  const { email: emailLogin, senha } = await lerCorpo(req);
  const data = db.load();
  const u = data.usuarios.find((x) => x.email === emailLogin);
  if (!u || u.status !== 'ativo' || !conferirSenha(senha || '', u.salt, u.hash)) {
    return enviarJSON(res, 401, { erro: 'E-mail ou senha inválidos.' });
  }
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id });
  enviarJSON(res, 200, { token, usuario: usuarioPublico(u) });
});

// GET /api/me
rota('GET', /^\/api\/me$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  enviarJSON(res, 200, { usuario: user });
});

// GET /api/status — só pro administrador: mostra se o banco é o Postgres (persistente) ou o
// arquivo local (some a cada reinício do Render sem "disco persistente"), pra nunca ficar na
// dúvida se os dados de teste estão realmente seguros.
rota('GET', /^\/api\/status$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê o status do banco.' });
  enviarJSON(res, 200, { banco: db.estaUsandoPostgres() ? 'postgres' : 'arquivo' });
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
  const token = gerarToken({ id: u.id, papel: u.papel, nome: u.nome, cliente_id: u.cliente_id });
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
  let lista = data.agenda;
  if (user.papel === 'tecnico' && query.todas !== '1') {
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
  const equipamentoEscolhido = data.equipamentos.find((e) => e.id === Number(body.equipamento_id));
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado && data.agenda.some((a) => (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado)) {
    return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
  }
  const novoId = nextId(data, 'agenda');
  const item = {
    id: novoId,
    numero_os: numeroOSDigitado || `OS-${String(novoId).padStart(6, '0')}`,
    tecnico_id: Number(body.tecnico_id),
    cliente_id: Number(body.cliente_id),
    equipamento_id: Number(body.equipamento_id),
    data_hora_inicio: body.data_hora_inicio,
    data_hora_fim: body.data_hora_fim,
    tipo: body.tipo, // preventiva | corretiva | treinamento
    categoria: body.categoria || 'inloco', // online | inloco
    problema: body.problema || '',
    // dados do atendimento definidos pelo administrador ao abrir a OS — o técnico só visualiza
    contato: body.contato, telefone: body.telefone, email: body.email, setor_cliente: body.setor_cliente || '',
    endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
    cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    // garantia definida pelo administrador na abertura da OS — o técnico só visualiza no Laudo Técnico
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
    status: 'pendente',
    valor_servico: body.valor_servico || null,
    retrabalho: false,
    criado_em: new Date().toISOString(),
    lida_tecnico: false,
    deslocamento_iniciado_em: null,
    lembrete_deslocamento_enviado: false,
    confirmado_cliente_em: null,
    feedback_cliente_em: null,
    orcamento_aprovado_em: null,
    retorno_pendente_tecnico: false,
    retorno_deslocamento_iniciado_em: null,
  };
  data.agenda.push(item);
  db.save(data);
  const clienteNovaOS = data.clientes.find((c) => c.id === item.cliente_id);
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
  const item = data.agenda.find((a) => a.id === Number(m[1]));
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
  const equipamentoEscolhido = data.equipamentos.find((e) => e.id === Number(body.equipamento_id));
  if (TIPOS_LAUDO_TECNICO.includes(body.tipo) && (!equipamentoEscolhido || !equipamentoEscolhido.numero_serie)) {
    return enviarJSON(res, 400, { erro: 'Este equipamento ainda não está atrelado a um cliente (sem número de série). Atrele-o em Equipamentos > Atrelar equipamento antes de abrir esta O.S.' });
  }
  const numeroOSDigitado = String(body.numero_os || '').trim();
  if (numeroOSDigitado) {
    const jaExisteEmOutra = data.agenda.some((a) => a.id !== item.id && (a.numero_os || `OS-${String(a.id).padStart(6, '0')}`) === numeroOSDigitado);
    if (jaExisteEmOutra) return enviarJSON(res, 400, { erro: `Já existe uma O.S. com o número "${numeroOSDigitado}". Escolha outro número.` });
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
    problema: body.problema || '',
    contato: body.contato, telefone: body.telefone, email: body.email, setor_cliente: body.setor_cliente || '',
    endereco: body.endereco || '', numero: body.numero || '', bairro: body.bairro || '',
    cep: body.cep || '', cidade: body.cidade || '', estado: body.estado || '',
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
  });
  if (trocouTecnico) item.lida_tecnico = false;
  db.save(data);
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// checa se a O.S. já pode chegar na etapa de feedback do cliente: o relatório original
// precisa estar aprovado, o orçamento (se houve peças fornecidas) precisa estar aprovado, e
// não pode haver um retorno do técnico ainda pendente
function erroAntesDoFeedback(data, item) {
  const visita = data.visitas.find((v) => v.agenda_id === item.id && (v.rodada || 1) === 1);
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
  const item = data.agenda.find((a) => a.id === Number(m[1]));
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const visita = data.visitas.find((v) => v.agenda_id === item.id && (v.rodada || 1) === 1);
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

// POST /api/agenda/:id/registrar-feedback — administrador marca que o cliente aprovou o
// serviço ("Cliente OK"); é o passo anterior e obrigatório antes de poder finalizar a O.S.
rota('POST', /^\/api\/agenda\/(\d+)\/registrar-feedback$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador registra o feedback do cliente.' });
  const data = db.load();
  const item = data.agenda.find((a) => a.id === Number(m[1]));
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
  const item = data.agenda.find((a) => a.id === Number(m[1]));
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  const erro = erroAntesDoFeedback(data, item);
  if (erro) return enviarJSON(res, 400, { erro });
  if (item.feedback_cliente_em) return enviarJSON(res, 400, { erro: 'O feedback do cliente já foi registrado.' });
  if (item.retrabalho || data.visitas.some((v) => v.agenda_id === item.id && v.rodada === 2)) {
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
  const item = data.agenda.find((a) => a.id === Number(m[1]));
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já está finalizada.' });
  const visita = data.visitas.find((v) => v.agenda_id === item.id && (v.rodada || 1) === 1);
  if (item.status !== 'concluida' || !visita || visita.status_aprovacao !== 'aprovado') {
    return enviarJSON(res, 400, { erro: 'Só é possível finalizar uma O.S. já concluída e aprovada.' });
  }
  const agora = new Date().toISOString();
  if (!forcar) {
    if (!item.feedback_cliente_em) {
      return enviarJSON(res, 400, { erro: 'Registre o feedback do cliente antes de finalizar esta O.S.' });
    }
    const visitaRetorno = data.visitas.find((v) => v.agenda_id === item.id && v.rodada === 2);
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
  db.save(data);
  const clienteFinal = data.clientes.find((c) => c.id === item.cliente_id);
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
  const idx = data.agenda.findIndex((a) => a.id === Number(m[1]));
  if (idx === -1) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  const agendaId = data.agenda[idx].id;
  const visita = data.visitas.find((v) => v.agenda_id === agendaId);
  if (visita) {
    data.registros = data.registros.filter((r) => !(r.origem === 'visita' && r.visita_id === visita.id));
    data.visitas = data.visitas.filter((v) => v.id !== visita.id);
  }
  data.agenda.splice(idx, 1);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/agenda/:id/marcar-lida — o técnico marcou a notificação de nova O.S. atribuída como vista
rota('POST', /^\/api\/agenda\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const item = data.agenda.find((a) => a.id === Number(m[1]));
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
  const item = data.agenda.find((a) => a.id === Number(m[1]));
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
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico designado inicia o deslocamento.' });
  const data = db.load();
  const item = data.agenda.find((a) => a.id === Number(m[1]));
  if (!item) return enviarJSON(res, 404, { erro: 'Ordem de serviço não encontrada.' });
  if (item.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta ordem de serviço não é sua.' });
  if (item.finalizada) return enviarJSON(res, 400, { erro: 'Esta O.S. já foi finalizada.' });
  if (!item.confirmado_cliente_em) return enviarJSON(res, 400, { erro: 'Aguarde a confirmação do cliente antes de iniciar o deslocamento.' });
  if (item.retorno_pendente_tecnico) {
    if (item.retorno_deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.retorno_deslocamento_iniciado_em = new Date().toISOString();
  } else {
    if (item.deslocamento_iniciado_em) return enviarJSON(res, 400, { erro: 'Deslocamento já foi marcado como iniciado.' });
    item.deslocamento_iniciado_em = new Date().toISOString();
  }
  db.save(data);
  const cliente = data.clientes.find((c) => c.id === item.cliente_id);
  const admins = data.usuarios.filter((u) => u.papel === 'administrador');
  admins.forEach((admin) => {
    enviarPush(data, admin.id, {
      titulo: 'Técnico a caminho',
      corpo: `${user.nome} iniciou o deslocamento para ${cliente ? cliente.nome_empresa : 'o cliente'} (${item.numero_os || 'OS-' + String(item.id).padStart(6, '0')}).`,
      url: '/',
    }).catch(() => {});
  });
  enviarJSON(res, 200, { agenda: agendaComDetalhes(data, item) });
});

// POST /api/visitas  (técnico registra o diário técnico de uma atividade)
rota('POST', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico pode registrar uma visita.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const agendaItem = data.agenda.find((a) => a.id === Number(body.agenda_id));
  if (!agendaItem) return enviarJSON(res, 404, { erro: 'Atividade de agenda não encontrada.' });
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
    const visitaRetorno = { id: nextId(data, 'visitas'), agenda_id: agendaItem.id, tecnico_id: user.id, equipamento_id: agendaItem.equipamento_id, rodada: 2, criado_em: new Date().toISOString(), ...camposVisita };
    visitaRetorno.status_aprovacao = 'aprovado';
    visitaRetorno.aprovado_por = null;
    visitaRetorno.data_aprovacao = new Date().toISOString();
    data.visitas.push(visitaRetorno);
    agendaItem.retorno_pendente_tecnico = false;
    db.save(data);
    const adminsRetorno = data.usuarios.filter((u) => u.papel === 'administrador');
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
  let visita = data.visitas.find((v) => v.agenda_id === agendaItem.id && (v.rodada || 1) === 1);
  if (visita) {
    Object.assign(visita, camposVisita, { atualizado_em: new Date().toISOString() });
  } else {
    visita = { id: nextId(data, 'visitas'), agenda_id: agendaItem.id, tecnico_id: user.id, equipamento_id: agendaItem.equipamento_id, criado_em: new Date().toISOString(), ...camposVisita };
    data.visitas.push(visita);
  }
  agendaItem.status = 'concluida';

  // marcado como relevante: entra na fila de aprovação da Biblioteca de Defeitos/Falhas assim que o
  // técnico envia o relatório — o administrador vê na tela de Biblioteca > Aprovação e no sino, sem
  // depender de já ter aprovado a O.S. em si
  const registroExistente = data.registros.find((r) => r.origem === 'visita' && r.visita_id === visita.id);
  if (camposVisita.relevante_biblioteca) {
    const eq = data.equipamentos.find((e) => e.id === visita.equipamento_id);
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
      data.registros.push({
        id: nextId(data, 'registros'),
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
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (user.papel === 'tecnico' && visita.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta visita não é sua.' });
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/enviar-relatorio  (envia o PDF do relatório corretivo por e-mail)
rota('POST', /^\/api\/visitas\/(\d+)\/enviar-relatorio$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico envia o relatório.' });
  const body = await lerCorpo(req);
  if (!body.pdf_base64 || !Array.isArray(body.emails) || body.emails.length === 0) {
    return enviarJSON(res, 400, { erro: 'PDF e ao menos um e-mail são obrigatórios.' });
  }
  const data = db.load();
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
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
  let lista = data.visitas;
  if (user.papel === 'tecnico' && query.todas !== '1') lista = lista.filter((v) => v.tecnico_id === user.id);
  if (query.status) lista = lista.filter((v) => v.status_aprovacao === query.status);
  lista = lista.map((v) => {
    const eq = data.equipamentos.find((e) => e.id === v.equipamento_id);
    const tec = data.usuarios.find((u) => u.id === v.tecnico_id);
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
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
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
    const registro = data.registros.find((r) => r.origem === 'visita' && r.visita_id === visita.id);
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
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
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
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  visita.status_aprovacao = 'alteracao_sugerida';
  visita.comentario_edicao = body.comentario;
  visita.aprovado_por = user.id;
  visita.data_aprovacao = new Date().toISOString();
  visita.lida_tecnico = false;
  const agendaItem = data.agenda.find((a) => a.id === visita.agenda_id);
  if (agendaItem) agendaItem.status = 'pendente';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// POST /api/visitas/:id/marcar-lida — o técnico marcou a notificação de aprovação como vista
rota('POST', /^\/api\/visitas\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
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
  const idx = data.visitas.findIndex((v) => v.id === Number(m[1]));
  if (idx === -1) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const visita = data.visitas[idx];
  data.registros = data.registros.filter((r) => !(r.origem === 'visita' && r.visita_id === visita.id));
  data.visitas.splice(idx, 1);
  const agendaItem = data.agenda.find((a) => a.id === visita.agenda_id);
  if (agendaItem) agendaItem.status = 'pendente';
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/visitas/:id/reabrir — administrador reabre um relatório já concluído (aprova qualquer solicitação pendente do técnico)
rota('POST', /^\/api\/visitas\/(\d+)\/reabrir$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador reabre relatórios.' });
  const data = db.load();
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  const agendaItem = data.agenda.find((a) => a.id === visita.agenda_id);
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
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico solicita reabertura.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
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
  const visita = data.visitas.find((v) => v.id === Number(m[1]));
  if (!visita) return enviarJSON(res, 404, { erro: 'Visita não encontrada.' });
  if (!visita.solicitacao_reabertura) return enviarJSON(res, 400, { erro: 'Não há solicitação de reabertura para esta visita.' });
  visita.solicitacao_reabertura.status = 'recusada';
  db.save(data);
  enviarJSON(res, 200, { visita });
});

// ---------- biblioteca técnica: Defeitos/Falhas e Manual de Procedimentos ----------

const CAMPOS_DEFEITO = ['titulo', 'equipamento_tipo', 'equipamento_modelo', 'numero_serie', 'sintoma', 'causa', 'solucao'];
const CAMPOS_PROCEDIMENTO = ['titulo', 'equipamento_tipo', 'equipamento_modelo', 'periodicidade', 'precaucoes', 'ferramentas', 'passos'];

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

// GET /api/registros?tipo=defeito|procedimento&q=&equipamento=&serie=  — biblioteca aprovada (qualquer usuário logado)
rota('GET', /^\/api\/registros$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const { query } = url.parse(req.url, true);
  const data = db.load();
  let lista = data.registros.filter((r) => r.status === 'aprovado');
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
  lista = lista.map((r) => registroComAutor(data, r)).sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { registros: lista });
});

// GET /api/registros/meus — o próprio autor vê todos os status dos registros que enviou
rota('GET', /^\/api\/registros\/meus$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const lista = data.registros
    .filter((r) => r.autor_id === user.id)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { registros: lista });
});

// GET /api/registros/ranking — ranking de técnicos que mais contribuíram com a biblioteca aprovada
rota('GET', /^\/api\/registros\/ranking$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const contagem = new Map();
  for (const r of data.registros) {
    if (r.status !== 'aprovado') continue;
    const atual = contagem.get(r.autor_id) || { total: 0, defeitos: 0, procedimentos: 0 };
    atual.total += 1;
    if (r.tipo === 'defeito') atual.defeitos += 1; else atual.procedimentos += 1;
    contagem.set(r.autor_id, atual);
  }
  const ranking = [...contagem.entries()].map(([autor_id, c]) => {
    const autor = data.usuarios.find((u) => u.id === autor_id);
    return { autor_id, autor_nome: autor ? autor.nome : 'Ex-usuário', ...c };
  }).sort((a, b) => b.total - a.total);
  enviarJSON(res, 200, { ranking });
});

// GET /api/registros/fila — administrador: fila de aprovação (status em_analise)
rota('GET', /^\/api\/registros\/fila$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador acessa a fila de aprovação.' });
  const data = db.load();
  const lista = data.registros
    .filter((r) => r.status === 'em_analise')
    .map((r) => registroComAutor(data, r))
    .sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  enviarJSON(res, 200, { registros: lista });
});

// POST /api/registros — técnico ou administrador envia um novo registro
rota('POST', /^\/api\/registros$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico', 'administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só técnico, produção ou administrador podem enviar registros.' });
  const body = await lerCorpo(req);
  const erro = validarRegistro(body);
  if (erro) return enviarJSON(res, 400, { erro });
  const data = db.load();
  const item = {
    id: nextId(data, 'registros'),
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
  };
  data.registros.push(item);
  db.save(data);
  enviarJSON(res, 201, { registro: item });
});

// POST /api/registros/:id/reenviar — o autor edita e reenvia após uma alteração sugerida
rota('POST', /^\/api\/registros\/(\d+)\/reenviar$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const registro = data.registros.find((r) => r.id === Number(m[1]));
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
  const registro = data.registros.find((r) => r.id === Number(m[1]));
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  registro.status = 'aprovado';
  registro.comentario_admin = null;
  registro.aprovado_por = user.id;
  registro.data_aprovacao = new Date().toISOString();
  db.save(data);
  enviarJSON(res, 200, { registro });
});

// POST /api/registros/:id/sugerir-alteracao — administrador, comentário obrigatório
rota('POST', /^\/api\/registros\/(\d+)\/sugerir-alteracao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador sugere alterações.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !body.comentario.trim()) return enviarJSON(res, 400, { erro: 'O comentário é obrigatório ao sugerir uma alteração.' });
  const data = db.load();
  const registro = data.registros.find((r) => r.id === Number(m[1]));
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
  const body = await lerCorpo(req);
  const data = db.load();
  const registro = data.registros.find((r) => r.id === Number(m[1]));
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  const erro = validarRegistro({ ...registro, ...body, tipo: registro.tipo });
  if (erro) return enviarJSON(res, 400, { erro });
  Object.assign(registro, montarCamposRegistro({ ...registro, ...body, tipo: registro.tipo }));
  registro.atualizado_em = new Date().toISOString();
  registro.atualizado_por_nome = user.nome;
  registro.solicitacao_edicao = null;
  db.save(data);
  enviarJSON(res, 200, { registro: registroComAutor(data, registro) });
});

// POST /api/registros/:id/solicitar-edicao — técnico pede ao administrador uma correção num
// caso já publicado na biblioteca (não é dono do registro, por isso não pode editar direto)
rota('POST', /^\/api\/registros\/(\d+)\/solicitar-edicao$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico solicita edição.' });
  const body = await lerCorpo(req);
  if (!body.comentario || !body.comentario.trim()) return enviarJSON(res, 400, { erro: 'Descreva o que precisa ser corrigido.' });
  const data = db.load();
  const registro = data.registros.find((r) => r.id === Number(m[1]));
  if (!registro) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  registro.solicitacao_edicao = { comentario: body.comentario, solicitante_id: user.id, solicitante_nome: user.nome, criado_em: new Date().toISOString() };
  db.save(data);
  enviarJSON(res, 200, { registro: registroComAutor(data, registro) });
});

// GET /api/registros/solicitacoes-edicao — administrador: casos publicados com pedido de correção pendente
rota('GET', /^\/api\/registros\/solicitacoes-edicao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê as solicitações de edição.' });
  const data = db.load();
  const lista = data.registros
    .filter((r) => r.solicitacao_edicao)
    .map((r) => registroComAutor(data, r))
    .sort((a, b) => (b.solicitacao_edicao.criado_em || '').localeCompare(a.solicitacao_edicao.criado_em || ''));
  enviarJSON(res, 200, { registros: lista });
});

// DELETE /api/registros/:id — administrador exclui um registro de biblioteca (pendente ou já aprovado)
rota('DELETE', /^\/api\/registros\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador exclui registros.' });
  const data = db.load();
  const idx = data.registros.findIndex((r) => r.id === Number(m[1]));
  if (idx === -1) return enviarJSON(res, 404, { erro: 'Registro não encontrado.' });
  data.registros.splice(idx, 1);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// POST /api/registros/:id/marcar-lida — o autor marcou a notificação de alteração como vista
rota('POST', /^\/api\/registros\/(\d+)\/marcar-lida$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const registro = data.registros.find((r) => r.id === Number(m[1]));
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
  if (user.papel === 'tecnico' || user.papel === 'producao') {
    notificacoes = data.registros
      .filter((r) => r.autor_id === user.id && r.status === 'alteracao_sugerida' && !r.lida)
      .map((r) => ({ id: r.id, tipo: 'alteracao_sugerida', texto: `Alteração sugerida em "${r.titulo}"`, registro_id: r.id }));
    notificacoes = notificacoes.concat(
      data.visitas
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
      data.agenda
        .filter((a) => a.tecnico_id === user.id && !a.lida_tecnico)
        .map((a) => {
          const cliente = data.clientes.find((c) => c.id === a.cliente_id);
          return { id: a.id, tipo: 'os_atribuida', texto: `Nova Ordem de Serviço atribuída a você${cliente ? ' — ' + cliente.nome_empresa : ''}`, registro_id: a.id };
        })
    );
  } else if (user.papel === 'administrador') {
    notificacoes = data.registros
      .filter((r) => r.status === 'em_analise')
      .map((r) => ({ id: r.id, tipo: 'aprovacao_pendente', texto: `"${r.titulo}" aguardando aprovação`, registro_id: r.id }));
    notificacoes = notificacoes.concat(
      data.visitas
        .filter((v) => v.status_aprovacao === 'pendente')
        .map((v) => {
          const tecnico = data.usuarios.find((u) => u.id === v.tecnico_id);
          return { id: v.id, tipo: 'relatorio_pendente', texto: `Relatório de ${tecnico ? tecnico.nome : 'um técnico'} aguardando aprovação`, registro_id: v.id };
        })
    );
    notificacoes = notificacoes.concat(
      data.registros
        .filter((r) => r.solicitacao_edicao)
        .map((r) => ({ id: r.id, tipo: 'edicao_solicitada_biblioteca', texto: `${r.solicitacao_edicao.solicitante_nome} pediu uma edição no caso "${r.titulo}" da biblioteca`, registro_id: r.id }))
    );
  }
  enviarJSON(res, 200, { notificacoes, contador: notificacoes.length });
});

// ---------- chamados de serviço (cliente) ----------

// GET /api/chamados
rota('GET', /^\/api\/chamados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['cliente', 'administrador'])) return enviarJSON(res, 403, { erro: 'Acesso não permitido.' });
  const data = db.load();
  let lista = data.chamados;
  if (user.papel === 'cliente') lista = lista.filter((c) => c.cliente_id === user.cliente_id);
  lista = lista.map((c) => {
    const eq = data.equipamentos.find((e) => e.id === c.equipamento_id);
    const cli = data.clientes.find((cl) => cl.id === c.cliente_id);
    return { ...c, equipamento_tipo: eq ? eq.tipo : null, cliente_nome: cli ? cli.nome_empresa : null };
  }).sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { chamados: lista });
});

// POST /api/chamados — só cliente
rota('POST', /^\/api\/chamados$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['cliente'])) return enviarJSON(res, 403, { erro: 'Só um cliente pode abrir um chamado.' });
  const body = await lerCorpo(req);
  if (!body.tipo_servico || !body.equipamento_id || !body.descricao) {
    return enviarJSON(res, 400, { erro: 'Tipo de serviço, equipamento e descrição são obrigatórios.' });
  }
  const data = db.load();
  const item = {
    id: nextId(data, 'chamados'),
    cliente_id: user.cliente_id,
    equipamento_id: Number(body.equipamento_id),
    tipo_servico: body.tipo_servico, // preventiva | corretiva | treinamento
    descricao: body.descricao,
    status: 'aberto',
    criado_em: new Date().toISOString(),
  };
  data.chamados.push(item);
  db.save(data);
  enviarJSON(res, 201, { chamado: item });
});

// ---------- relatórios de manutenção interna (avulsos, sem vínculo com O.S./agenda) ----------
// menu "Criar Relatório" do técnico — usado pra registrar um atendimento de manutenção interna
// (ex.: análise de amostra recebida na oficina) que não passa pelo fluxo normal de O.S./aprovação.

// GET /api/relatorios-manutencao/meus — o técnico só vê os relatórios que ele mesmo criou
rota('GET', /^\/api\/relatorios-manutencao\/meus$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const lista = data.relatorios_manutencao
    .filter((r) => r.autor_id === user.id)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  enviarJSON(res, 200, { relatorios: lista });
});

// GET /api/relatorios-manutencao/:id — reabrir um relatório já criado (pra gerar o PDF de novo)
rota('GET', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const item = data.relatorios_manutencao.find((r) => r.id === Number(m[1]) && r.autor_id === user.id);
  if (!item) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  enviarJSON(res, 200, { relatorio: item });
});

// POST /api/relatorios-manutencao — cria um relatório avulso; salva na hora, sem aprovação do admin
rota('POST', /^\/api\/relatorios-manutencao$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico cria este relatório.' });
  const body = await lerCorpo(req);
  if (!String(body.empresa || '').trim() || !String(body.equipamento || '').trim()) {
    return enviarJSON(res, 400, { erro: 'Empresa e equipamento são obrigatórios.' });
  }
  const data = db.load();
  // o token de login só carrega id/papel/nome — busca o cadastro completo pra pegar o e-mail
  const autor = data.usuarios.find((u) => u.id === user.id);
  const item = {
    id: nextId(data, 'relatorios_manutencao'),
    autor_id: user.id,
    autor_nome: user.nome,
    empresa: body.empresa || '', contato: body.contato || '', telefone: body.telefone || '',
    tipo_servico: body.tipo_servico || '', tipo_servico_outros: body.tipo_servico_outros || '',
    marca: body.marca || '', equipamento: body.equipamento || '', numero_serie: body.numero_serie || '',
    garantia: body.garantia || '', garantia_obs: body.garantia_obs || '',
    data_fabricacao: body.data_fabricacao || '',
    acessorios: body.acessorios || '', defeito_informado: body.defeito_informado || '',
    tecnico_nome: user.nome, tecnico_email: (autor && autor.email) || '',
    data_entrada: body.data_entrada || '', data_conclusao: body.data_conclusao || '',
    laudo_tecnico: body.laudo_tecnico || '', servico_realizado: body.servico_realizado || '',
    pecas: Array.isArray(body.pecas) ? body.pecas : [],
    fotos: Array.isArray(body.fotos) ? body.fotos : [],
    criado_em: new Date().toISOString(),
  };
  data.relatorios_manutencao.push(item);
  db.save(data);
  enviarJSON(res, 201, { relatorio: item });
});

// DELETE /api/relatorios-manutencao/:id — o próprio autor pode apagar um relatório que criou
rota('DELETE', /^\/api\/relatorios-manutencao\/(\d+)$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico usa este relatório.' });
  const data = db.load();
  const idx = data.relatorios_manutencao.findIndex((r) => r.id === Number(m[1]) && r.autor_id === user.id);
  if (idx === -1) return enviarJSON(res, 404, { erro: 'Relatório não encontrado.' });
  data.relatorios_manutencao.splice(idx, 1);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/clientes — administrador: lista de empresas-cliente (para vincular usuário/chamado)
rota('GET', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador', 'producao'])) return enviarJSON(res, 403, { erro: 'Só o administrador ou produção veem clientes.' });
  const data = db.load();
  enviarJSON(res, 200, { clientes: data.clientes });
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
  const item = {
    id: nextId(data, 'clientes'),
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
  };
  data.clientes.push(item);
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
  const cliente = data.clientes.find((c) => c.id === Number(m[1]));
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
  const cliente = data.clientes.find((c) => c.id === id);
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  if (data.usuarios.some((u) => u.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem usuários vinculados a este cliente. Remova ou reatribua-os antes de excluir.' });
  if (data.agenda.some((a) => a.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem ordens de serviço vinculadas a este cliente. Exclua-as antes.' });
  if (data.equipamentos.some((e) => e.cliente_id === id)) return enviarJSON(res, 400, { erro: 'Existem equipamentos atrelados a este cliente. Remova-os antes.' });
  data.clientes = data.clientes.filter((c) => c.id !== id);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// GET /api/equipamentos
rota('GET', /^\/api\/equipamentos$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let lista = data.equipamentos;
  if (user.papel === 'cliente') lista = lista.filter((e) => e.cliente_id === user.cliente_id);
  enviarJSON(res, 200, { equipamentos: lista });
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
  const item = {
    id: nextId(data, 'equipamentos'),
    cliente_id: null,
    tipo: body.tipo.trim(), modelo: body.modelo.trim(), numero_serie: '', data_fabricacao: '', localizacao: '',
  };
  data.equipamentos.push(item);
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
  const equipamento = data.equipamentos.find((e) => e.id === Number(m[1]));
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
  const equipamento = data.equipamentos.find((e) => e.id === id);
  if (!equipamento) return enviarJSON(res, 404, { erro: 'Equipamento não encontrado.' });
  if (data.agenda.some((a) => a.equipamento_id === id)) return enviarJSON(res, 400, { erro: 'Existem ordens de serviço vinculadas a este equipamento. Exclua-as antes.' });
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
  const catalogo = data.equipamentos.find((e) => e.id === Number(m[1]) && e.cliente_id === null);
  if (!catalogo) return enviarJSON(res, 404, { erro: 'Equipamento do catálogo não encontrado.' });
  if (!body.cliente_id || !body.numero_serie || !String(body.numero_serie).trim()) {
    return enviarJSON(res, 400, { erro: 'Cliente e número de série são obrigatórios.' });
  }
  const cliente = data.clientes.find((c) => c.id === Number(body.cliente_id));
  if (!cliente) return enviarJSON(res, 404, { erro: 'Cliente não encontrado.' });
  const item = {
    id: nextId(data, 'equipamentos'),
    cliente_id: cliente.id,
    tipo: catalogo.tipo,
    modelo: catalogo.modelo,
    numero_serie: body.numero_serie.trim(),
    data_fabricacao: body.data_fabricacao || '',
    localizacao: body.localizacao || '',
  };
  data.equipamentos.push(item);
  db.save(data);
  enviarJSON(res, 201, { equipamento: item });
});

// GET /api/equipamentos/:id/historico
rota('GET', /^\/api\/equipamentos\/(\d+)\/historico$/, async (req, res, m) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  const eqId = Number(m[1]);
  const agendaItens = data.agenda.filter((a) => a.equipamento_id === eqId).map((a) => agendaComDetalhes(data, a));
  const visitasItens = data.visitas.filter((v) => v.equipamento_id === eqId);
  enviarJSON(res, 200, { agenda: agendaItens, visitas: visitasItens });
});

// GET /api/usuarios
rota('GET', /^\/api\/usuarios$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê usuários.' });
  const data = db.load();
  enviarJSON(res, 200, { usuarios: data.usuarios.map(usuarioPublico) });
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
  if (data.usuarios.some((u) => u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  const convite_token = gerarTokenConvite();
  const novo = {
    id: nextId(data, 'usuarios'),
    nome: body.nome, email: body.email, papel: body.papel,
    cargo: body.cargo || '', setor: body.setor || '',
    celular: body.celular || '', cliente_id: body.cliente_id || null,
    status: 'convite_enviado', convite_token,
    salt: null, hash: null,
  };
  data.usuarios.push(novo);
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
  const u = data.usuarios.find((x) => x.id === Number(m[1]));
  if (!u) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
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
  const alvo = data.usuarios.find((u) => u.id === Number(m[1]));
  if (!alvo) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (alvo.protegido && alvo.id !== user.id) {
    return enviarJSON(res, 403, { erro: 'Esta conta é protegida e só pode ser editada por ela mesma.' });
  }
  if (data.usuarios.some((u) => u.id !== alvo.id && u.email === body.email)) {
    return enviarJSON(res, 409, { erro: 'Já existe usuário com este e-mail.' });
  }
  Object.assign(alvo, {
    nome: body.nome, email: body.email, papel: body.papel,
    cargo: body.cargo || '', setor: body.setor || '',
    celular: body.celular || '', cliente_id: body.papel === 'cliente' ? (body.cliente_id || null) : null,
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
  const idx = data.usuarios.findIndex((u) => u.id === id);
  if (idx === -1) return enviarJSON(res, 404, { erro: 'Usuário não encontrado.' });
  if (data.usuarios[idx].protegido) {
    return enviarJSON(res, 403, { erro: 'Esta conta é protegida e não pode ser excluída.' });
  }
  data.usuarios.splice(idx, 1);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- assistente de suporte via WhatsApp (opcional) ----------
// só funciona se as variáveis de ambiente estiverem configuradas (WHATSAPP_TOKEN,
// WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN, ANTHROPIC_API_KEY) — ver whatsapp.js
require('./whatsapp').registrarRotasWhatsApp({ rota, enviarJSON, lerCorpo, url, db });

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
});
