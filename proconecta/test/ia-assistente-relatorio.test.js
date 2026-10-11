// Assistente IA no preenchimento de relatório — pedido do usuário: "o técnico pode apertar o
// botão assistente IA... descreve toda a atividade e a IA faz edições e correções usando termos
// altamente técnicos... abre um chat com a IA, igual nas IAs convencionais... ao apresentar o
// texto relatório a IA pergunta se deseja seguir com a sugestão. O técnico dando ok a IA já
// preenche os campos do relatório." Testa ia.assistenteRelatorio isoladamente, com fetch
// mockado (sem bater na API de verdade da Anthropic) — mesma técnica usada pelas outras funções
// de IA deste módulo (lerEtiqueta/lerRecibo), que também chamam a Anthropic direto via fetch.
const test = require('node:test');
const assert = require('node:assert/strict');

const fetchOriginal = global.fetch;
function mockarFetch(respostaMock) {
  global.fetch = async (url, opts) => {
    mockarFetch.ultimaChamada = { url, opts: JSON.parse(opts.body) };
    return { ok: true, json: async () => respostaMock };
  };
}
test.afterEach(() => { global.fetch = fetchOriginal; });

// precisa de ANTHROPIC_API_KEY definida ANTES de o módulo carregar (ia.ativa() lê isso uma vez,
// no require) — define antes do require, igual os outros testes de IA fariam.
process.env.ANTHROPIC_API_KEY = 'chave-de-teste-fake';
const ia = require('../ia.js');

const CAMPOS = [
  { chave: 'defeito_informado', rotulo: 'Defeito informado' },
  { chave: 'acoes_executadas', rotulo: 'Ações executadas' },
];

test('assistenteRelatorio: resposta só com texto (ainda sem confirmação) devolve preenchimento null', async () => {
  mockarFetch({ content: [{ type: 'text', text: 'Aqui está minha sugestão: ... Quer seguir com ela?' }] });
  const { texto, preenchimento } = await ia.assistenteRelatorio({
    tipo: 'corretiva',
    mensagens: [{ role: 'user', texto: 'troquei o rolamento que tava com ruído' }],
    campos: CAMPOS,
  });
  assert.equal(texto, 'Aqui está minha sugestão: ... Quer seguir com ela?');
  assert.equal(preenchimento, null);
});

test('assistenteRelatorio: resposta com tool_use preencher_campos_relatorio devolve o preenchimento', async () => {
  mockarFetch({
    content: [
      { type: 'text', text: 'Perfeito, preenchendo o relatório.' },
      { type: 'tool_use', id: 'x1', name: 'preencher_campos_relatorio', input: { defeito_informado: 'Ruído excessivo no rolamento do eixo principal.', acoes_executadas: 'Substituição do rolamento 6204.' } },
    ],
  });
  const { texto, preenchimento } = await ia.assistenteRelatorio({
    tipo: 'corretiva',
    mensagens: [
      { role: 'user', texto: 'troquei o rolamento que tava com ruído' },
      { role: 'assistant', texto: 'Sugestão: ... Quer seguir com ela?' },
      { role: 'user', texto: 'sim, pode seguir' },
    ],
    campos: CAMPOS,
  });
  assert.equal(texto, 'Perfeito, preenchendo o relatório.');
  assert.deepEqual(preenchimento, { defeito_informado: 'Ruído excessivo no rolamento do eixo principal.', acoes_executadas: 'Substituição do rolamento 6204.' });
});

test('assistenteRelatorio: envia o histórico de mensagens e a ferramenta certa pra Anthropic', async () => {
  mockarFetch({ content: [{ type: 'text', text: 'ok' }] });
  await ia.assistenteRelatorio({
    tipo: 'promotor',
    mensagens: [{ role: 'user', texto: 'descrição qualquer' }],
    campos: CAMPOS,
  });
  const corpo = mockarFetch.ultimaChamada.opts;
  assert.equal(corpo.messages.length, 1);
  assert.equal(corpo.messages[0].role, 'user');
  assert.equal(corpo.messages[0].content, 'descrição qualquer');
  assert.equal(corpo.tools[0].name, 'preencher_campos_relatorio');
  assert.deepEqual(Object.keys(corpo.tools[0].input_schema.properties).sort(), ['acoes_executadas', 'defeito_informado'].sort());
  assert.match(corpo.system, /promotor/);
});

test('assistenteRelatorio: erro da API da Anthropic propaga como exceção', async () => {
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'fora do ar' });
  await assert.rejects(
    () => ia.assistenteRelatorio({ tipo: 'corretiva', mensagens: [{ role: 'user', texto: 'x' }], campos: CAMPOS }),
    /Erro na API da Anthropic/,
  );
});

test('assistenteRelatorio: resposta sem texto e sem ferramenta dá erro (nunca devolve chat vazio)', async () => {
  mockarFetch({ content: [] });
  await assert.rejects(
    () => ia.assistenteRelatorio({ tipo: 'corretiva', mensagens: [{ role: 'user', texto: 'x' }], campos: CAMPOS }),
    /não respondeu/,
  );
});
