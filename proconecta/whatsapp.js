// whatsapp.js — ponte entre o WhatsApp Business e o atendimento por chat do Pro Conecta. Recebe
// a mensagem do cliente, joga ela dentro do mesmo "chamado" (fila de atendimento) que o chat
// dentro do app usa — a IA (ia.js) responde enquanto o chamado estiver com ela; depois que
// escala pra um técnico, as mensagens do técnico mandadas pelo chat do Pro Conecta voltam pro
// cliente por aqui (enviarMensagemWhatsApp). Módulo à parte pra não inchar o server.js — se as
// variáveis de ambiente não estiverem configuradas, o webhook simplesmente não faz nada
// (ativo() = false).

const ia = require('./ia');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = 'v21.0';

function ativo() {
  return !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_VERIFY_TOKEN && ia.ativa());
}

function normalizarTelefone(t) {
  return String(t || '').replace(/\D/g, '');
}

// compara só os últimos 8 dígitos — evita falha por causa do 9º dígito do celular ou do código
// do país (55), que nem sempre batem igual entre o que o cliente cadastrou e o número que o
// WhatsApp manda no webhook
function telefonesBatem(a, b) {
  const na = normalizarTelefone(a);
  const nb = normalizarTelefone(b);
  if (na.length < 8 || nb.length < 8) return false;
  return na.slice(-8) === nb.slice(-8);
}

function encontrarClientePorTelefone(data, telefoneWhatsApp) {
  return data.clientes.find((c) => telefonesBatem(c.telefone, telefoneWhatsApp)) || null;
}

async function enviarMensagemWhatsApp(para, texto) {
  const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
  });
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    console.error('Erro ao enviar mensagem WhatsApp:', resp.status, corpo);
  }
}

// acha o chamado em andamento desse telefone (qualquer status que não seja encerrado) ou cria um
// novo — assim a conversa inteira (IA e depois técnico) fica no mesmo chamado/thread.
function encontrarOuCriarChamado(data, nextId, telefone, textoPrimeiraMensagem) {
  let chamado = data.chamados.find((c) => c.telefone_whatsapp === telefone && c.status !== 'encerrado');
  if (chamado) return chamado;
  const cliente = encontrarClientePorTelefone(data, telefone);
  chamado = {
    id: nextId(data, 'chamados'),
    cliente_id: cliente ? cliente.id : null,
    telefone_whatsapp: telefone,
    origem: 'whatsapp',
    equipamento_id: null,
    status: 'ia',
    prioridade: 'normal',
    tecnico_id: null,
    os_id: null,
    resumo_ia: '',
    resolvido_por: null,
    primeira_mensagem_cliente: textoPrimeiraMensagem,
    // mensagens fica só na memória durante a requisição — histórico de verdade mora numa tabela
    // à parte (ver salvarMensagemChamado/carregarMensagensChamado em db.js)
    mensagens: [],
    lida_tecnico: true,
    lida_cliente: true,
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
    assumido_em: null,
    resolvido_em: null,
  };
  data.chamados.push(chamado);
  return chamado;
}

// ids de mensagem já processadas, pra ignorar reentregas do webhook (a Meta reenvia se não
// receber 200 rápido o suficiente) — em memória só, não precisa sobreviver a reinício
const mensagensProcessadas = new Set();

// registra as duas rotas do webhook no roteador do server.js. Recebe as peças do server.js como
// parâmetro (em vez de reimportar) pra não duplicar a lógica de resposta/leitura de corpo.
function registrarRotasWhatsApp({ rota, enviarJSON, lerCorpo, url, db, enviarPush }) {
  // GET — handshake de verificação que a Meta faz quando você configura a URL do webhook
  rota('GET', /^\/api\/whatsapp\/webhook$/, async (req, res) => {
    const { query } = url.parse(req.url, true);
    if (ativo() && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === WHATSAPP_VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(query['hub.challenge'] || '');
      return;
    }
    res.writeHead(403); res.end();
  });

  // POST — mensagens recebidas de verdade
  rota('POST', /^\/api\/whatsapp\/webhook$/, async (req, res) => {
    // responde 200 logo de cara — a Meta espera resposta rápida e reenvia se demorar/der erro
    enviarJSON(res, 200, { ok: true });
    if (!ativo()) return;
    let body;
    try { body = await lerCorpo(req); } catch (e) { return; }
    try {
      for (const entrada of body.entry || []) {
        for (const mudanca of entrada.changes || []) {
          const valor = mudanca.value || {};
          for (const mensagem of valor.messages || []) {
            if (mensagem.type !== 'text' || !mensagem.text) continue;
            if (mensagensProcessadas.has(mensagem.id)) continue;
            mensagensProcessadas.add(mensagem.id);
            const de = mensagem.from;
            const texto = mensagem.text.body;
            if (!de || !texto) continue;
            processarMensagemRecebida(db, de, texto, enviarPush).catch((e) => console.error('Erro no assistente de WhatsApp:', e.message));
          }
        }
      }
    } catch (e) {
      console.error('Erro ao processar webhook do WhatsApp:', e.message);
    }
  });
}

async function processarMensagemRecebida(db, telefone, texto, enviarPush) {
  const data = db.load();
  const chamado = encontrarOuCriarChamado(data, db.nextId, telefone, texto);
  // carrega o histórico de verdade (vazio pra chamado recém-criado) pra dentro do objeto em
  // memória só pra esta requisição — só as mensagens NOVAS a partir daqui são persistidas no fim.
  chamado.mensagens = await db.carregarMensagensChamado(chamado.id);
  const totalAntes = chamado.mensagens.length;
  chamado.mensagens.push({ autor: 'cliente', texto, criado_em: new Date().toISOString() });
  chamado.atualizado_em = new Date().toISOString();

  if (chamado.status === 'ia') {
    const resposta = await ia.processarTurno(data, chamado);
    // não atribui a nenhum técnico específico — fica no pool "Aguardando técnico", visível pra
    // qualquer um, até alguém entrar e assumir manualmente (mesmo comportamento do chat do app)
    if (chamado.status === 'aguardando_tecnico' && enviarPush) {
      const cliente = encontrarClientePorTelefone(data, telefone);
      const tecnicos = data.usuarios.filter((u) => u.papel === 'suporte');
      await Promise.all(tecnicos.map((t) => enviarPush(data, t.id, { titulo: 'Novo atendimento aguardando técnico', corpo: cliente ? cliente.nome_empresa : 'Um cliente do WhatsApp precisa de ajuda.', url: '/' }).catch(() => {})));
    }
    for (const msg of chamado.mensagens.slice(totalAntes)) await db.salvarMensagemChamado(chamado.id, msg);
    chamado.mensagens = [];
    db.save(data);
    await enviarMensagemWhatsApp(telefone, resposta);
  } else {
    // já está com um técnico (ou esperando um) — só guarda a mensagem, o técnico responde
    // pelo chat do Pro Conecta (que manda de volta pro WhatsApp via enviarMensagemWhatsApp)
    chamado.lida_tecnico = false;
    if (enviarPush && chamado.tecnico_id) {
      enviarPush(data, chamado.tecnico_id, { titulo: 'Nova mensagem no atendimento', corpo: texto.slice(0, 120), url: '/' }).catch(() => {});
    }
    for (const msg of chamado.mensagens.slice(totalAntes)) await db.salvarMensagemChamado(chamado.id, msg);
    chamado.mensagens = [];
    db.save(data);
  }
}

module.exports = { registrarRotasWhatsApp, ativo, enviarMensagemWhatsApp };
