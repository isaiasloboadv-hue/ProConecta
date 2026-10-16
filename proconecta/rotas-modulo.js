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
// /api/outlook/callback é chamado pelo navegador vindo direto do redirect da Microsoft (fora do
// fluxo normal de login do sistema) — não carrega o Bearer token da sessão, por isso tem que ser
// público; quem autentica ali é o próprio "state" assinado (ver GET /api/outlook/callback).
// /api/cadastro (SaaS, passo 1 — cadastro/trial self-service) também é público: quem ainda não é
// cliente nenhum precisa criar a própria empresa + primeiro administrador antes de ter qualquer
// login pra autenticar.
// /api/os-refrigeracao-assinar/:token é o link público (sem login) que o cliente usa pra assinar
// a O.S. do perfil Refrigeração — mesmo padrão de /api/entregas (token próprio, gerado na
// criação). /api/os-refrigeracao-orcamentos-assinar/:token é o equivalente pro Orçamento (ver
// orcamentoRefrigeracaoResumoPublico em server.js). As rotas autenticadas (/api/os-refrigeracao,
// /api/os-refrigeracao-clientes, /api/os-refrigeracao-orcamentos, prefixos diferentes, de
// propósito) NÃO entram aqui — continuam exigindo login normal, caem em "núcleo" por omissão
// (não há módulo de plano pra isso: o acesso é por `perfil` da empresa, checado nos próprios
// handlers em server.js — ver PAPEIS_OS_REFRIGERACAO/empresaPerfilRefrigeracao).
// pedido do usuário (pacote "Climatização / PMOC", Fase 5, item 6): "Sem login: página pública
// mínima com a data da última manutenção e o nome da empresa". Só esse prefixo específico
// (/api/pmoc/qr/...) é público — o resto de /api/pmoc continua exigindo login + módulo 'pmoc'
// normalmente (ver PREFIXO_MODULO abaixo e moduloDaRota).
const PREFIXOS_PUBLICOS = ['/api/login', '/api/empresa', '/api/convite', '/api/whatsapp', '/api/entregas', '/api/os-refrigeracao-assinar', '/api/os-refrigeracao-orcamentos-assinar', '/api/outlook/callback', '/api/cadastro', '/api/pmoc/qr'];

const PREFIXO_MODULO = [
  ['/api/agenda', 'os_chamados'],
  ['/api/visitas', 'os_chamados'],
  ['/api/chamados', 'os_chamados'],
  // pedido do usuário: "nosso sistema deve ser do mais simples ao completo: orçamento é a base,
  // depois relatório... em terceiro O.S., quando a demanda aumenta precisa de equipe, escala de
  // folgas, controle de gastos, dashboards" — "os_chamados" (O.S./Chamados) virou 3 módulos:
  // Relatório/Equipamentos/Assistente IA não exigem mais O.S. completo (liberam já no plano de
  // entrada, junto do "comercial"), e Equipe/RH/Escala/KPIs/FMEA passam a exigir o estágio de
  // equipe maior ("equipe_avancado"), em vez de vir de brinde com o O.S. básico.
  ['/api/relatorios-manutencao', 'relatorios'],
  ['/api/equipamentos', 'relatorios'],
  ['/api/ia', 'relatorios'],
  ['/api/solicitacoes-rh', 'equipe_avancado'],
  ['/api/fmea', 'equipe_avancado'],
  ['/api/kpis', 'equipe_avancado'],
  ['/api/tecnicos', 'equipe_avancado'],
  ['/api/tecnico', 'equipe_avancado'],
  ['/api/feriados', 'equipe_avancado'],
  ['/api/escala-folgas', 'equipe_avancado'],
  ['/api/registros', 'biblioteca'],
  ['/api/leads', 'comercial'],
  ['/api/oportunidades', 'comercial'],
  ['/api/propostas', 'comercial'],
  // 'nucleo' (não núcleo implícito por omissão) de propósito: evita que esse prefixo um dia seja
  // confundido com /api/empresa (público) por alguém editando essa lista às pressas — "Meu plano"
  // tem que passar pela checagem central de módulo/suspensa/trial (ver comentário em
  // PUT /api/meu-plano, server.js).
  ['/api/meu-plano', 'nucleo'],
  ['/api/agendamento', 'agendamento'],
  ['/api/financeiro', 'financeiro'],
  ['/api/prestacao-contas', 'prestacao_contas'],
  // versão Restaurantes/rede multiunidade (Fase 1 — Base, pedido do usuário): setores, filiais e
  // áreas só existem pra empresa que contratou o módulo "filiais".
  ['/api/setores', 'filiais'],
  ['/api/filiais', 'filiais'],
  ['/api/areas', 'filiais'],
  // Fase 2 — Operação: vistoria e apoio entre setores. /api/agenda/filial e as sub-rotas de O.S.
  // de filial (etapa, sla-criticidade, concluir-filial, validar-filial, reabrir-filial,
  // designar-tecnico) já caem em "os_chamados" pelo prefixo /api/agenda acima — verificação extra
  // do módulo "filiais" é feita dentro de cada rota (ver server.js).
  ['/api/vistorias', 'filiais'],
  ['/api/apoios', 'filiais'],
  // Fase 3 — Peças: catálogo compartilhado + solicitação de peça com cadeia de autorização.
  ['/api/pecas-catalogo', 'filiais'],
  ['/api/solicitacoes-peca', 'filiais'],
  // Fase 4 — Compras: pedido em atacado, estoque e transferências entre filiais/central.
  ['/api/pedidos-compra', 'filiais'],
  ['/api/estoque-central', 'filiais'],
  ['/api/estoque-loja', 'filiais'],
  ['/api/transferencias', 'filiais'],
  // Fase 5 — Gestão e comunicação: dashboards, mural de avisos e chat por canal.
  ['/api/dashboards/filiais', 'filiais'],
  ['/api/avisos', 'filiais'],
  ['/api/mensagens-canal', 'filiais'],
  // pedido do usuário (empresa JBPA): registro de atividades diárias pra cliente com contrato
  // mensal — data/descrição/valor do que foi feito, com PDF comparando o entregue com o contrato.
  ['/api/atividades-diarias', 'atividades'],
  // pacote "Climatização / PMOC" (perfil Refrigeração — ver exigirPerfilRefrigeracao dentro de
  // cada rota /api/pmoc/*, checado além deste módulo). Um prefixo só (/api/pmoc) cobre todas as
  // sub-rotas (/api/pmoc/locais, /ambientes, /aparelhos, /responsaveis-tecnicos, ...) porque elas
  // nascem com barra (bateComPrefixo abaixo exige "/" depois do prefixo).
  ['/api/pmoc', 'pmoc'],
];

// tudo que não bate com nenhum prefixo acima é núcleo: login/convite (públicos, tratados à
// parte), /api/me, /api/clientes, /api/usuarios, /api/notificacoes, /api/push, /api/chat-interno,
// /api/admin, /api/rascunhos (sincronização de rascunho de relatório/laudo entre aparelhos — só
// um espelho auxiliar do localStorage das telas de relatorios/os_chamados, que já são gated por
// elas mesmas) — sempre disponível pra qualquer empresa, qualquer que seja o módulo contratado.

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
