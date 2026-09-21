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

function montarSystemPrompt(nomeEmpresa) {
  return `Você é o assistente de suporte técnico da ${nomeEmpresa}, atendendo o cliente pelo chat do Pro Conecta (pode ser o app ou o WhatsApp — não faz diferença pra você).

Seu trabalho: ajudar o cliente a resolver o problema do equipamento dele, passo a passo, consultando a ferramenta buscar_biblioteca — que é a base de conhecimento real da empresa (defeitos, causas e soluções já registrados pelos técnicos). NUNCA invente uma causa ou solução que não esteja na biblioteca.

Como conduzir a conversa:
- Seja objetivo e claro, em mensagens curtas.
- Primeiro entenda o problema: que equipamento, o que está acontecendo.
- Assim que o cliente mencionar (ou você suspeitar) qual equipamento é, use listar_equipamentos_cliente pra ver os equipamentos cadastrados no nome dele. Se o que ele descreveu bater com um da lista, siga normalmente. Se NÃO bater com nenhum — nome/modelo diferente, ou a lista vier vazia — não presuma que está certo: avise o cliente que não encontrou esse equipamento cadastrado no nome da empresa dele e peça pra confirmar o modelo (pode ser um equipamento novo, ainda não cadastrado, ou um engano no nome). Só continue depois dessa confirmação.
- Busque na biblioteca (buscar_biblioteca) antes de sugerir qualquer coisa.
- Guie um passo de cada vez, esperando o cliente confirmar se funcionou antes de ir pro próximo passo.
- Se o cliente confirmar que resolveu, use resolver_atendimento.
- Se a biblioteca não tiver nada relevante, ou depois de tentar os passos e não resolver, use escalar_tecnico pra um técnico de verdade continuar — explique isso pro cliente com naturalidade, sem parecer que "desistiu".
- Nunca escale sem antes tentar ajudar com a biblioteca, a menos que o problema seja claramente grave/urgente (ex: risco de segurança) — nesse caso escale direto com urgente=true.`;
}

async function chamarClaude(mensagens, nomeEmpresa) {
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
      system: montarSystemPrompt(nomeEmpresa),
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

// lê a etiqueta/placa de identificação de um equipamento a partir de uma foto (dataUrl) e devolve
// uma lista de campos (nome + valor) com tudo que der pra identificar nela — usado pelo "Gerar
// relatório automático" no relatório de manutenção. É a própria etiqueta que decide quais campos
// existem (marca, nº de série, potência, tensão, corrente, etc.) — não é uma lista fixa, porque
// cada tipo de equipamento tem uma etiqueta diferente. Se a etiqueta estiver em inglês (comum em
// equipamento importado), os nomes dos campos vêm traduzidos pro português — só o nome do campo,
// o valor impresso (números, códigos) fica como está. Chamada avulsa à API (sem histórico/
// ferramentas), só pra visão + extração de texto.
async function lerEtiqueta(fotoDataUrl) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(String(fotoDataUrl || ''));
  if (!m) throw new Error('Foto inválida.');
  const [, mediaType, base64] = m;
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
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Essa é uma foto da etiqueta/placa de identificação de um equipamento industrial. Leia com atenção as especificações TÉCNICAS do equipamento em si — marca, tipo/modelo, número de série, potência, tensão, corrente, frequência, ano/data de fabricação, peso, capacidade, grau de proteção IP, RPM etc. — e devolva SOMENTE um JSON (sem texto antes ou depois, sem markdown), no formato exato: {"campos":[{"campo":"","valor":""}]}, um item por informação encontrada, na ordem em que aparecem na etiqueta. NÃO inclua dados do fabricante enquanto empresa: endereço, site/website, telefone/e-mail de contato, razão social completa, certificações/selos (CE, ISO, INMETRO etc.) ou país de fabricação/"Made in" — isso não interessa aqui, só as características do equipamento. Se a etiqueta estiver em inglês ou outro idioma, traduza o NOME de cada campo pro português (ex.: "Serial Number" vira "Número de Série", "Power" vira "Potência", "Voltage" vira "Tensão") mas mantenha o VALOR exatamente como está impresso (números, unidades, códigos). Se não conseguir ler nada com confiança, devolva {"campos":[]} — nunca invente um valor.' },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new Error(`Erro na API da Anthropic: ${resp.status} ${corpo}`);
  }
  const dados = await resp.json();
  const texto = (dados.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let extraido;
  try {
    const limpo = texto.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    extraido = JSON.parse(limpo);
  } catch (e) {
    throw new Error('Não consegui ler os dados dessa etiqueta — tente tirar a foto de novo, mais perto e com boa luz.');
  }
  const campos = Array.isArray(extraido.campos) ? extraido.campos : [];
  return {
    campos: campos
      .map((c) => ({ campo: String((c && c.campo) || '').trim(), valor: String((c && c.valor) || '').trim() }))
      .filter((c) => c.campo && c.valor),
  };
}

const MAX_RODADAS_FERRAMENTA = 5;
const MAX_MENSAGENS_HISTORICO = 20;

// processa um turno: o chamado já deve ter a nova mensagem do cliente no final de
// chamado.mensagens. Roda o loop de ferramentas do Claude, aplica os efeitos (escalar/resolver)
// direto no chamado, acrescenta a resposta da IA em chamado.mensagens e devolve esse texto —
// quem chamou decide o que fazer com ele (mostrar no chat, mandar por WhatsApp, etc.).
async function processarTurno(data, chamado) {
  const nomeEmpresa = (data.empresas.find((e) => e.id === 1) || {}).nome || 'nossa empresa';
  const historico = chamado.mensagens
    .filter((m) => m.autor === 'cliente' || m.autor === 'ia')
    .slice(-MAX_MENSAGENS_HISTORICO)
    .map((m) => ({ role: m.autor === 'cliente' ? 'user' : 'assistant', content: m.texto }));

  let mensagens = historico;
  let textoFinal = '';
  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await chamarClaude(mensagens, nomeEmpresa);
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

module.exports = { ativa, processarTurno, lerEtiqueta };
