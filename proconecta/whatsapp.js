// whatsapp.js — assistente de suporte técnico pelo WhatsApp: recebe a mensagem do cliente,
// consulta a Biblioteca de Defeitos/Procedimentos já aprovada no sistema (nunca inventa solução)
// e conduz passo a passo usando a API da Anthropic (Claude); se não resolver, abre um chamado
// técnico de verdade. Módulo à parte pra não inchar o server.js — se as variáveis de ambiente
// não estiverem configuradas, o webhook simplesmente não faz nada (ativo() = false).

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const WHATSAPP_API_VERSION = 'v21.0';

function ativo() {
  return !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_VERIFY_TOKEN && ANTHROPIC_API_KEY);
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

// ---------- ferramentas que a IA pode chamar ----------

function buscarBiblioteca(data, { termo, equipamento } = {}) {
  let lista = data.registros.filter((r) => r.status === 'aprovado');
  if (equipamento) {
    const eq = String(equipamento).toLowerCase();
    lista = lista.filter((r) => (r.equipamento_tipo || '').toLowerCase().includes(eq) || (r.equipamento_modelo || '').toLowerCase().includes(eq));
  }
  if (termo) {
    const q = String(termo).toLowerCase();
    lista = lista.filter((r) => [r.titulo, r.sintoma, r.causa, r.solucao].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  if (!lista.length) return { resultados: [], aviso: 'Nada encontrado na biblioteca pra essa busca.' };
  return {
    resultados: lista.slice(0, 5).map((r) => ({
      titulo: r.titulo,
      tipo: r.tipo,
      equipamento: `${r.equipamento_tipo || ''} ${r.equipamento_modelo || ''}`.trim(),
      sintoma: r.sintoma || '',
      causa: r.causa || '',
      solucao: r.solucao || '',
    })),
  };
}

function listarEquipamentosCliente(data, cliente) {
  const lista = data.equipamentos
    .filter((e) => e.cliente_id === cliente.id)
    .map((e) => ({ id: e.id, tipo: e.tipo, modelo: e.modelo, numero_serie: e.numero_serie }));
  return { equipamentos: lista };
}

function abrirChamado(data, nextId, cliente, { equipamento_id, tipo_servico, descricao } = {}) {
  const equipamento = data.equipamentos.find((e) => e.id === Number(equipamento_id) && e.cliente_id === cliente.id);
  if (!equipamento) return { erro: 'Não encontrei esse equipamento cadastrado pra esse cliente — use listar_equipamentos_cliente pra pegar o ID certo.' };
  if (!descricao || !String(descricao).trim()) return { erro: 'Descrição é obrigatória.' };
  const item = {
    id: nextId(data, 'chamados'),
    cliente_id: cliente.id,
    equipamento_id: equipamento.id,
    tipo_servico: ['preventiva', 'corretiva', 'treinamento'].includes(tipo_servico) ? tipo_servico : 'corretiva',
    descricao: String(descricao).slice(0, 2000),
    status: 'aberto',
    origem: 'ia_whatsapp',
    criado_em: new Date().toISOString(),
  };
  data.chamados.push(item);
  return { ok: true, chamado_id: item.id };
}

const FERRAMENTAS = [
  {
    name: 'buscar_biblioteca',
    description: 'Busca na Biblioteca de Defeitos/Falhas e Procedimentos já aprovados pela empresa, por palavra-chave e/ou tipo de equipamento. Use isso antes de sugerir qualquer solução — nunca invente um passo que não esteja na biblioteca.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Palavra-chave do sintoma, causa ou defeito relatado pelo cliente.' },
        equipamento: { type: 'string', description: 'Tipo ou modelo do equipamento, se souber.' },
      },
    },
  },
  {
    name: 'listar_equipamentos_cliente',
    description: 'Lista os equipamentos cadastrados desse cliente, pra ajudar a identificar qual equipamento ele está relatando o problema, ou pra pegar o ID certo antes de abrir um chamado.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'abrir_chamado',
    description: 'Abre um chamado técnico de verdade pra um humano continuar o atendimento, quando os passos da biblioteca não resolveram o problema do cliente. Só use depois de tentar ajudar com a biblioteca (a menos que o problema seja claramente grave/urgente).',
    input_schema: {
      type: 'object',
      properties: {
        equipamento_id: { type: 'number', description: 'ID do equipamento (use listar_equipamentos_cliente pra descobrir).' },
        tipo_servico: { type: 'string', enum: ['preventiva', 'corretiva', 'treinamento'] },
        descricao: { type: 'string', description: 'Resumo do problema e do que já foi tentado, pra o técnico não perguntar tudo de novo.' },
      },
      required: ['equipamento_id', 'tipo_servico', 'descricao'],
    },
  },
];

const SYSTEM_PROMPT = `Você é o assistente de suporte técnico da PRO Marking, atendendo clientes pelo WhatsApp.

Seu trabalho: ajudar o cliente a resolver o problema do equipamento dele, passo a passo, consultando a ferramenta buscar_biblioteca — que é a base de conhecimento real da empresa (defeitos, causas e soluções já registrados pelos técnicos). NUNCA invente uma causa ou solução que não esteja na biblioteca.

Como conduzir a conversa:
- Seja objetivo e claro, em mensagens curtas (é WhatsApp, não e-mail).
- Primeiro entenda o problema: que equipamento, o que está acontecendo.
- Busque na biblioteca (buscar_biblioteca) antes de sugerir qualquer coisa.
- Guie um passo de cada vez, esperando o cliente confirmar se funcionou antes de ir pro próximo passo.
- Se a biblioteca não tiver nada relevante, ou depois de tentar os passos e não resolver, use abrir_chamado pra um técnico de verdade continuar — explique isso pro cliente com naturalidade, sem parecer que "desistiu".
- Nunca abra chamado sem antes tentar ajudar com a biblioteca, a menos que o problema seja claramente grave/urgente (ex: risco de segurança).
- Se não conseguir identificar o cliente no cadastro (a ferramenta listar_equipamentos_cliente vai indicar isso), ainda pode conversar e orientar com base na biblioteca, mas avise que pra abrir um chamado formal ele precisa estar cadastrado no sistema — e nesse caso não tente abrir chamado.`;

async function chamarClaude(mensagens) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: FERRAMENTAS,
      messages: mensagens,
    }),
  });
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new Error(`Erro na API da Anthropic: ${resp.status} ${corpo}`);
  }
  return resp.json();
}

const MAX_RODADAS_FERRAMENTA = 5;
const MAX_MENSAGENS_HISTORICO = 20;

// processa uma mensagem recebida: carrega/atualiza a conversa, roda o Claude (executando as
// ferramentas que ele pedir) até ele responder só com texto, e devolve esse texto pra enviar.
async function processarTurno(db, telefoneWhatsApp, textoRecebido) {
  const data = db.load();
  const cliente = encontrarClientePorTelefone(data, telefoneWhatsApp);

  let conversa = data.conversas_whatsapp.find((c) => c.telefone === telefoneWhatsApp);
  if (!conversa) {
    conversa = { telefone: telefoneWhatsApp, cliente_id: cliente ? cliente.id : null, mensagens: [], atualizado_em: new Date().toISOString() };
    data.conversas_whatsapp.push(conversa);
  }
  conversa.mensagens.push({ role: 'user', content: textoRecebido });

  let mensagens = conversa.mensagens.slice(-MAX_MENSAGENS_HISTORICO).map((m) => ({ role: m.role, content: m.content }));

  let textoFinal = '';
  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await chamarClaude(mensagens);
    const blocosTexto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const blocosFerramenta = resposta.content.filter((b) => b.type === 'tool_use');

    if (!blocosFerramenta.length) { textoFinal = blocosTexto; break; }

    mensagens.push({ role: 'assistant', content: resposta.content });
    const resultados = blocosFerramenta.map((bloco) => {
      let resultado;
      if (bloco.name === 'buscar_biblioteca') resultado = buscarBiblioteca(data, bloco.input);
      else if (bloco.name === 'listar_equipamentos_cliente') resultado = cliente ? listarEquipamentosCliente(data, cliente) : { erro: 'Cliente não identificado no cadastro.' };
      else if (bloco.name === 'abrir_chamado') resultado = cliente ? abrirChamado(data, db.nextId, cliente, bloco.input) : { erro: 'Cliente não identificado — não é possível abrir chamado.' };
      else resultado = { erro: 'Ferramenta desconhecida.' };
      return { type: 'tool_result', tool_use_id: bloco.id, content: JSON.stringify(resultado) };
    });
    mensagens.push({ role: 'user', content: resultados });
    if (blocosTexto) textoFinal = blocosTexto;
  }

  if (!textoFinal) textoFinal = 'Desculpa, tive um problema pra processar sua mensagem agora — pode tentar de novo em instantes?';

  conversa.mensagens.push({ role: 'assistant', content: textoFinal });
  conversa.mensagens = conversa.mensagens.slice(-MAX_MENSAGENS_HISTORICO);
  conversa.cliente_id = cliente ? cliente.id : conversa.cliente_id;
  conversa.atualizado_em = new Date().toISOString();
  db.save(data);

  return textoFinal;
}

// ids de mensagem já processadas, pra ignorar reentregas do webhook (a Meta reenvia se não
// receber 200 rápido o suficiente) — em memória só, não precisa sobreviver a reinício
const mensagensProcessadas = new Set();

// registra as duas rotas do webhook no roteador do server.js. Recebe as peças do server.js como
// parâmetro (em vez de reimportar) pra não duplicar a lógica de resposta/leitura de corpo.
function registrarRotasWhatsApp({ rota, enviarJSON, lerCorpo, url, db }) {
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
            processarTurno(db, de, texto)
              .then((resposta) => enviarMensagemWhatsApp(de, resposta))
              .catch((e) => console.error('Erro no assistente de WhatsApp:', e.message));
          }
        }
      }
    } catch (e) {
      console.error('Erro ao processar webhook do WhatsApp:', e.message);
    }
  });
}

module.exports = { registrarRotasWhatsApp, ativo };
