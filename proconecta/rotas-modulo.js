// rotas-modulo.js — decide a que módulo cada rota da API pertence, a partir do próprio caminho
// (regex) com que ela foi registrada em server.js. Não precisa marcar módulo rota por rota: o
// namespace de URL do sistema já nasceu organizado por área (/api/agenda, /api/registros, ...),
// então um prefixo por módulo cobre todas as rotas de uma vez, e uma rota nova só precisa nascer
// com o prefixo certo pra já cair no módulo certo, sem esquecimento possível.
//
// 'publico' = nem passa pela checagem de autenticação (login, dados de marca da empresa, convite).
// 'nucleo' = exige login, mas não passa pela checagem de módulo ativo (sempre disponível).
// qualquer outra string = chave de um módulo ativável (ver MODULOS_DISPONIVEIS em db.js) — exige
// login E que a empresa do usuário tenha esse módulo ativo.

// /api/whatsapp/webhook é chamado pelos servidores da Meta direto, sem Bearer token — a
// verificação lá é o hub.verify_token da própria Meta (ver whatsapp.js), não o login do sistema.
const PREFIXOS_PUBLICOS = ['/api/login', '/api/empresa', '/api/convite', '/api/whatsapp'];

const PREFIXO_MODULO = [
  ['/api/agenda', 'os_chamados'],
  ['/api/visitas', 'os_chamados'],
  ['/api/chamados', 'os_chamados'],
  ['/api/solicitacoes-rh', 'os_chamados'],
  ['/api/equipamentos', 'os_chamados'],
  ['/api/relatorios-manutencao', 'os_chamados'],
  ['/api/tecnicos', 'os_chamados'],
  ['/api/tecnico', 'os_chamados'],
  ['/api/registros', 'biblioteca'],
  ['/api/crm', 'crm'],
  ['/api/agendamento', 'agendamento'],
  ['/api/financeiro', 'financeiro'],
  ['/api/prestacao-contas', 'prestacao_contas'],
];

// tudo que não bate com nenhum prefixo acima é núcleo: login/convite (públicos, tratados à
// parte), /api/me, /api/clientes, /api/usuarios, /api/notificacoes, /api/push, /api/chat-interno,
// /api/admin — sempre disponível pra qualquer empresa, qualquer que seja o módulo contratado.

// bate só no prefixo inteiro (o próximo caractere tem que ser fim da string ou "/") — startsWith
// puro combinava por engano "/api/agendamento" com o prefixo "/api/agenda" (é prefixo de string,
// mas não é o mesmo caminho).
function bateComPrefixo(caminho, prefixo) {
  return caminho === prefixo || caminho.startsWith(`${prefixo}/`);
}

function moduloDaRota(regex) {
  // regex.source ainda traz os metacaracteres de âncora escapados (\^.../api\/agenda\$) — tira o
  // ^ do início e o \$ do fim antes de comparar, senão "/api/agenda" nunca bate exatamente com
  // "/api/agenda\$" (o \$ sobrando quebra a comparação exata que bateComPrefixo faz).
  const caminho = regex.source.replace(/\\\//g, '/').replace(/^\^/, '').replace(/\\?\$$/, '');
  if (PREFIXOS_PUBLICOS.some((p) => bateComPrefixo(caminho, p))) return 'publico';
  const achado = PREFIXO_MODULO.find(([prefixo]) => bateComPrefixo(caminho, prefixo));
  return achado ? achado[1] : 'nucleo';
}

module.exports = { moduloDaRota, PREFIXOS_PUBLICOS, PREFIXO_MODULO };
