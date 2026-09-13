// server.js — Pro Conecta, backend real (Fase 1 + Biblioteca técnica), sem dependências externas.
// Rode com: node server.js
// Abra: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const email = require('./email');
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
  const visita = data.visitas.find((v) => v.agenda_id === item.id);
  return {
    ...item,
    visita_id: visita ? visita.id : null,
    visita_status: visita ? visita.status_aprovacao : null,
    visita_solicitacao_reabertura: visita ? visita.solicitacao_reabertura : null,
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

// GET /api/agenda
rota('GET', /^\/api\/agenda$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let lista = data.agenda;
  if (user.papel === 'tecnico') {
    lista = lista.filter((a) => a.tecnico_id === user.id);
  } else if (user.papel === 'cliente') {
    lista = lista.filter((a) => a.cliente_id === user.cliente_id);
  }
  // administrador e supervisor veem tudo
  lista = lista.map((a) => agendaComDetalhes(data, a)).sort((x, y) => x.data_hora_inicio.localeCompare(y.data_hora_inicio));
  enviarJSON(res, 200, { agenda: lista });
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
  const item = {
    id: nextId(data, 'agenda'),
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
  };
  data.agenda.push(item);
  db.save(data);
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
  // se o técnico designado mudou, ele ainda não viu essa atribuição — reabre a notificação
  const trocouTecnico = Number(body.tecnico_id) !== item.tecnico_id;
  Object.assign(item, {
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

// POST /api/visitas  (técnico registra o diário técnico de uma atividade)
rota('POST', /^\/api\/visitas$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['tecnico'])) return enviarJSON(res, 403, { erro: 'Só o técnico pode registrar uma visita.' });
  const body = await lerCorpo(req);
  const data = db.load();
  const agendaItem = data.agenda.find((a) => a.id === Number(body.agenda_id));
  if (!agendaItem) return enviarJSON(res, 404, { erro: 'Atividade de agenda não encontrada.' });
  if (agendaItem.tecnico_id !== user.id) return enviarJSON(res, 403, { erro: 'Esta atividade não é sua.' });

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

  // se a atividade já tinha uma visita (reaberta pelo administrador), edita a mesma em vez de duplicar
  let visita = data.visitas.find((v) => v.agenda_id === agendaItem.id);
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
  if (user.papel === 'tecnico') lista = lista.filter((v) => v.tecnico_id === user.id);
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
  visita.status_aprovacao = 'pendente';
  visita.aprovado_por = null;
  visita.data_aprovacao = null;
  if (visita.solicitacao_reabertura) visita.solicitacao_reabertura.status = 'aprovada';
  const agendaItem = data.agenda.find((a) => a.id === visita.agenda_id);
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
  if (!exigirPapel(user, ['tecnico', 'administrador'])) return enviarJSON(res, 403, { erro: 'Só técnico ou administrador podem enviar registros.' });
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

// ---------- notificações ----------

// GET /api/notificacoes
rota('GET', /^\/api\/notificacoes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!user) return enviarJSON(res, 401, { erro: 'Não autenticado.' });
  const data = db.load();
  let notificacoes = [];
  if (user.papel === 'tecnico') {
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

// GET /api/clientes — administrador: lista de empresas-cliente (para vincular usuário/chamado)
rota('GET', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador vê clientes.' });
  const data = db.load();
  enviarJSON(res, 200, { clientes: data.clientes });
});

// POST /api/clientes — administrador cadastra uma nova empresa-cliente
rota('POST', /^\/api\/clientes$/, async (req, res) => {
  const user = usuarioAutenticado(req);
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra clientes.' });
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
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador cadastra equipamentos.' });
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
  if (!exigirPapel(user, ['administrador'])) return enviarJSON(res, 403, { erro: 'Só o administrador atrela equipamentos.' });
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
  data.usuarios.splice(idx, 1);
  db.save(data);
  enviarJSON(res, 200, { ok: true });
});

// ---------- arquivos estáticos (frontend) ----------

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

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
  servirEstatico(req, res, pathname);
});

db.pronto.then(() => {
  server.listen(PORT, () => {
    console.log(`Pro Conecta rodando em http://localhost:${PORT}`);
    console.log(`Banco de dados: ${db.estaUsandoPostgres() ? 'Postgres' : db.DB_PATH}`);
    if (process.env.ADMIN_EMAIL) console.log(`Conta de administrador: ${process.env.ADMIN_EMAIL}`);
  });
});
