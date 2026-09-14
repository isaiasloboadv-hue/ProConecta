// ia.js — assistente de primeiro nível do atendimento: recebe a mensagem do cliente (vinda do
// chat dentro do ProConecta ou do WhatsApp — o chamado é o mesmo objeto nos dois casos), consulta
// a Biblioteca de Defeitos/Procedimentos já aprovada (nunca inventa solução) e conduz passo a
// passo usando a API da Anthropic (Claude). Se não resolver, escala pra fila de atendimento
// técnico. Módulo à parte, reaproveitado tanto pelo chat do app (server.js) quanto pelo
// webhook do WhatsApp (whatsapp.js) — só liga se ANTHROPIC_API_KEY estiver configurada.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function ativa() {
  return !!ANTHROPIC_API_KEY;
}

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

function listarEquipamentosCliente(data, clienteId) {
  const lista = data.equipamentos
    .filter((e) => e.cliente_id === clienteId)
    .map((e) => ({ id: e.id, tipo: e.tipo, modelo: e.modelo, numero_serie: e.numero_serie }));
  return { equipamentos: lista };
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
    description: 'Lista os equipamentos cadastrados desse cliente, pra ajudar a identificar qual equipamento ele está relatando o problema.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'escalar_tecnico',
    description: 'Encaminha o atendimento pra um técnico humano continuar, quando os passos da biblioteca não resolveram o problema. Só use depois de tentar ajudar com a biblioteca (a menos que o problema seja claramente grave/urgente).',
    input_schema: {
      type: 'object',
      properties: {
        equipamento_id: { type: 'number', description: 'ID do equipamento (use listar_equipamentos_cliente pra descobrir), se souber.' },
        urgente: { type: 'boolean', description: 'true se for algo grave/de risco/urgente — muda a prioridade na fila do técnico.' },
        resumo: { type: 'string', description: 'Resumo do problema e do que já foi tentado, pra o técnico não perguntar tudo de novo.' },
      },
      required: ['resumo'],
    },
  },
  {
    name: 'resolver_atendimento',
    description: 'Encerra o atendimento quando o cliente confirmar que o problema foi resolvido com os passos da biblioteca — não precisa de um técnico.',
    input_schema: {
      type: 'object',
      properties: { resumo: { type: 'string', description: 'O que resolveu o problema, em uma frase.' } },
    },
  },
];

const SYSTEM_PROMPT = `Você é o assistente de suporte técnico da PRO Marking, atendendo o cliente pelo chat do Pro Conecta (pode ser o app ou o WhatsApp — não faz diferença pra você).

Seu trabalho: ajudar o cliente a resolver o problema do equipamento dele, passo a passo, consultando a ferramenta buscar_biblioteca — que é a base de conhecimento real da empresa (defeitos, causas e soluções já registrados pelos técnicos). NUNCA invente uma causa ou solução que não esteja na biblioteca.

Como conduzir a conversa:
- Seja objetivo e claro, em mensagens curtas.
- Primeiro entenda o problema: que equipamento, o que está acontecendo.
- Busque na biblioteca (buscar_biblioteca) antes de sugerir qualquer coisa.
- Guie um passo de cada vez, esperando o cliente confirmar se funcionou antes de ir pro próximo passo.
- Se o cliente confirmar que resolveu, use resolver_atendimento.
- Se a biblioteca não tiver nada relevante, ou depois de tentar os passos e não resolver, use escalar_tecnico pra um técnico de verdade continuar — explique isso pro cliente com naturalidade, sem parecer que "desistiu".
- Nunca escale sem antes tentar ajudar com a biblioteca, a menos que o problema seja claramente grave/urgente (ex: risco de segurança) — nesse caso escale direto com urgente=true.`;

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

// processa um turno: o chamado já deve ter a nova mensagem do cliente no final de
// chamado.mensagens. Roda o loop de ferramentas do Claude, aplica os efeitos (escalar/resolver)
// direto no chamado, acrescenta a resposta da IA em chamado.mensagens e devolve esse texto —
// quem chamou decide o que fazer com ele (mostrar no chat, mandar por WhatsApp, etc.).
async function processarTurno(data, chamado) {
  const historico = chamado.mensagens
    .filter((m) => m.autor === 'cliente' || m.autor === 'ia')
    .slice(-MAX_MENSAGENS_HISTORICO)
    .map((m) => ({ role: m.autor === 'cliente' ? 'user' : 'assistant', content: m.texto }));

  let mensagens = historico;
  let textoFinal = '';
  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await chamarClaude(mensagens);
    const blocosTexto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const blocosFerramenta = resposta.content.filter((b) => b.type === 'tool_use');

    if (!blocosFerramenta.length) { textoFinal = blocosTexto; break; }

    mensagens.push({ role: 'assistant', content: resposta.content });
    const resultados = blocosFerramenta.map((bloco) => {
      let resultado;
      if (bloco.name === 'buscar_biblioteca') {
        resultado = buscarBiblioteca(data, bloco.input);
      } else if (bloco.name === 'listar_equipamentos_cliente') {
        resultado = chamado.cliente_id ? listarEquipamentosCliente(data, chamado.cliente_id) : { erro: 'Cliente não identificado no cadastro.' };
      } else if (bloco.name === 'escalar_tecnico') {
        if (!chamado.cliente_id) {
          resultado = { erro: 'Cliente não identificado — não é possível escalar pra um técnico. Avise o cliente que ele precisa estar cadastrado no sistema.' };
        } else {
          chamado.status = 'aguardando_tecnico';
          chamado.prioridade = bloco.input.urgente ? 'alta' : 'normal';
          if (bloco.input.equipamento_id) chamado.equipamento_id = Number(bloco.input.equipamento_id);
          chamado.resumo_ia = bloco.input.resumo || '';
          resultado = { ok: true };
        }
      } else if (bloco.name === 'resolver_atendimento') {
        chamado.status = 'encerrado';
        chamado.resolvido_por = 'ia';
        chamado.resolvido_em = new Date().toISOString();
        chamado.resumo_ia = bloco.input.resumo || chamado.resumo_ia || '';
        resultado = { ok: true };
      } else {
        resultado = { erro: 'Ferramenta desconhecida.' };
      }
      return { type: 'tool_result', tool_use_id: bloco.id, content: JSON.stringify(resultado) };
    });
    mensagens.push({ role: 'user', content: resultados });
    if (blocosTexto) textoFinal = blocosTexto;
    // se a ferramenta já encerrou ou escalou o atendimento, não precisa continuar o loop
    if (chamado.status !== 'ia') break;
  }

  if (!textoFinal) textoFinal = 'Desculpa, tive um problema pra processar sua mensagem agora — pode tentar de novo em instantes?';

  chamado.mensagens.push({ autor: 'ia', texto: textoFinal, criado_em: new Date().toISOString() });
  chamado.atualizado_em = new Date().toISOString();
  return textoFinal;
}

module.exports = { ativa, processarTurno };
