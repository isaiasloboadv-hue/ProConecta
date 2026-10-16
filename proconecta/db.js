// db.js — "banco de dados". Por padrão, um arquivo JSON local (sem dependências externas).
// Se a variável de ambiente DATABASE_URL estiver definida, usa Postgres (ex.: Supabase) —
// guarda o mesmo objeto inteiro como um único registro JSONB, então nenhuma outra parte do
// sistema precisa mudar (load()/save() continuam funcionando exatamente igual).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DB_PATH é configurável (DB_PATH_ARQUIVO) pra testes de ponta a ponta poderem subir o servidor
// de verdade contra um arquivo descartável, sem tocar no data.json real do ambiente.
const DB_PATH = process.env.DB_PATH_ARQUIVO || path.join(__dirname, 'data.json');
const usaPostgres = !!process.env.DATABASE_URL;

function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function conferirSenha(senha, salt, hash) {
  const tentativa = crypto.scryptSync(senha, salt, 64);
  const alvo = Buffer.from(hash, 'hex');
  return tentativa.length === alvo.length && crypto.timingSafeEqual(tentativa, alvo);
}

function gerarTokenConvite() {
  return crypto.randomBytes(24).toString('hex');
}

// módulos que o próprio código sabe suportar — lista fixa, não é dado editável: pra existir um
// módulo de verdade é preciso ter código pra ele. O que É editável por empresa é só QUAIS desses
// módulos estão ligados (empresa.modulos_ativos, ver moduloAtivo abaixo) — isso sim é dado.
// "núcleo" não entra aqui: é sempre ativo pra toda empresa, não passa por essa checagem.
const MODULOS_DISPONIVEIS = [
  // pedido do usuário: "nosso sistema deve ser do mais simples ao completo... um gerador de
  // orçamento é a base, depois o menu relatório" — Relatório (+ Equipamentos/Assistente IA que o
  // alimentam) sai de dentro de "os_chamados" e vira módulo próprio, pra poder ficar junto do
  // "comercial" (gerador de orçamento) no plano de entrada, sem exigir O.S. completo.
  { chave: 'relatorios', nome: 'Relatórios' },
  { chave: 'os_chamados', nome: 'O.S. e Chamados' },
  { chave: 'smp_preventivas', nome: 'Procedimentos e Preventivas' },
  { chave: 'biblioteca', nome: 'Biblioteca' },
  { chave: 'prestacao_contas', nome: 'Prestação de Contas' },
  // pedido do usuário: "o menu CRM é praticamente o que meu sistema já faz... vamos implementar
  // os menus do que falta" — o item "CRM" (esqueleto "Em breve" da Etapa 8) foi removido; este
  // módulo renomeado é quem vai liberar as telas de verdade (Leads, Funil, Propostas) que chegam
  // nos próximos passos, reaproveitando todo o pipeline de ativação já validado.
  { chave: 'comercial', nome: 'Comercial' },
  // "quando a equipe aumenta, precisa de controle de escala de folgas, controle de gastos,
  // dashboards" — Equipe, Solicitações/RH, Escala de Folgas, KPIs/Dashboards e FMEA saem de
  // dentro de "os_chamados" e vão para este módulo de estágio avançado (time maior/operação em
  // escala), também antes só coberto pelo pacote único de O.S.
  { chave: 'equipe_avancado', nome: 'Equipe e Escala' },
  { chave: 'agendamento', nome: 'Agendamento Online' },
  { chave: 'financeiro', nome: 'Financeiro' },
  { chave: 'assistente_ia', nome: 'Assistente IA' },
  // pedido do usuário: versão "Restaurantes" — franqueado com muitas lojas divididas em setores,
  // cada loja com técnico/gerente próprio e cada setor com coordenador técnico/consultor de
  // mercado. Reaproveitável por qualquer empresa com essa mesma estrutura (não é exclusivo de
  // restaurante) — liga a hierarquia setores/filiais/áreas e os papéis gerente_loja/
  // coordenador_tecnico/consultor_mercado (ver PAPEIS_ESTRUTURA_FILIAIS em server.js).
  { chave: 'filiais', nome: 'Redes e Filiais' },
  // pedido do usuário (empresa JBPA): cliente com contrato mensal — a empresa registra TUDO que é
  // feito pra esse cliente (data, descrição do serviço, valor), pra depois emitir um PDF mostrando
  // o que foi entregue no período e comparando com o valor do contrato ("ver que valeu a pena").
  // Reaproveitável por qualquer empresa com contrato recorrente, não é exclusivo da JBPA.
  { chave: 'atividades', nome: 'Registro de Atividades' },
  // pedido do usuário: pacote "Climatização / PMOC" — exclusivo de empresas com
  // `perfil: 'refrigeracao'` (ver PERFIS_DISPONIVEIS acima e exigirPerfilRefrigeracao em
  // server.js): cadastro de locais/ambientes/aparelhos do cliente final e, nas próximas fases,
  // plano PMOC com preventivas automáticas (Lei 13.589/2018). É módulo (ativável por empresa,
  // "flag/versão", ver moduloAtivo abaixo) ALÉM do gate de perfil — nem toda empresa de
  // Refrigeração contrata o pacote PMOC, mas só empresa de Refrigeração pode contratá-lo (o NAV
  // combina `perfil` + `modulo` no mesmo item — ver navDoUsuario em app.js).
  // `foraDaCascataPadrao`: nunca entra sozinho em "Completo"/plano de topo nem é candidato das
  // heurísticas de resgate de módulo esquecido (ver desbloquearModuloNosPlanosCompletos em
  // migrar() — compara "o plano já libera TODO o resto do catálogo" pra achar o plano de topo;
  // sem essa flag, "pmoc" entraria nessa comparação e QUEBRARIA a detecção de plano de topo pra
  // outros módulos, já que nenhum plano da cascata padrão tem "pmoc" de propósito — ver comentário
  // acima). Continua ativável normalmente por empresa (Super Admin > Cadastros > Módulos ativos).
  { chave: 'pmoc', nome: 'Climatização / PMOC', foraDaCascataPadrao: true },
];
const CHAVES_MODULOS = MODULOS_DISPONIVEIS.map((m) => m.chave);
// subconjunto de CHAVES_MODULOS elegível pra fazer parte da cascata de planos padrão (Básico →
// Completo) — exclui módulos perfil-exclusivos como "pmoc" (ver `foraDaCascataPadrao` acima).
const CHAVES_MODULOS_CASCATA_PADRAO = MODULOS_DISPONIVEIS.filter((m) => !m.foraDaCascataPadrao).map((m) => m.chave);

// Pacote "Climatização / PMOC" (Lei 13.589/2018), Fase 2 — Plano e preventivas. Periodicidade de
// cada item do checklist, em meses (usado pra calcular em que mês cada item "vence" de novo a
// partir da data de início do plano — ver geração automática de visitas em server.js).
const PMOC_PERIODICIDADES = [
  { chave: 'mensal', nome: 'Mensal', meses: 1 },
  { chave: 'bimestral', nome: 'Bimestral', meses: 2 },
  { chave: 'trimestral', nome: 'Trimestral', meses: 3 },
  { chave: 'semestral', nome: 'Semestral', meses: 6 },
  { chave: 'anual', nome: 'Anual', meses: 12 },
];
const CHAVES_PMOC_PERIODICIDADES = PMOC_PERIODICIDADES.map((p) => p.chave);
// pedido do usuário (item 1.6): "modelo padrão editável pela empresa" — itens sugeridos, usados
// pra popular o Modelo de Checklist da empresa na primeira vez que ela acessa (ver
// GET /api/pmoc/modelo-checklist em server.js). `tipos_aparelho: []` = aplica a qualquer tipo de
// aparelho (nenhuma das sugestões da Lei restringe por tipo).
const PMOC_CHECKLIST_PADRAO = [
  { descricao: 'Limpeza ou troca dos filtros de ar', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Limpeza da bandeja de condensado', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Verificação e desobstrução do dreno', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Verificação de ruídos e vibrações anormais', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Limpeza externa do gabinete', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Verificação do controle remoto e do display', periodicidade: 'mensal', tipos_aparelho: [] },
  { descricao: 'Limpeza da serpentina da evaporadora', periodicidade: 'trimestral', tipos_aparelho: [] },
  { descricao: 'Verificação do isolamento térmico das tubulações', periodicidade: 'trimestral', tipos_aparelho: [] },
  { descricao: 'Medição de temperatura de insuflamento e de retorno', periodicidade: 'trimestral', tipos_aparelho: [] },
  { descricao: 'Verificação da fixação e dos suportes', periodicidade: 'trimestral', tipos_aparelho: [] },
  { descricao: 'Limpeza da condensadora e da serpentina externa', periodicidade: 'semestral', tipos_aparelho: [] },
  { descricao: 'Medição de tensão e corrente do compressor', periodicidade: 'semestral', tipos_aparelho: [] },
  { descricao: 'Verificação de pressão do fluido refrigerante e de vazamentos', periodicidade: 'semestral', tipos_aparelho: [] },
  { descricao: 'Reaperto das conexões elétricas', periodicidade: 'semestral', tipos_aparelho: [] },
  { descricao: 'Limpeza completa (higienização) do conjunto', periodicidade: 'anual', tipos_aparelho: [] },
  { descricao: 'Verificação geral do estado do equipamento e recomendação de troca, se for o caso', periodicidade: 'anual', tipos_aparelho: [] },
];

// Perfil/Segmento (Etapa 8): escolhido uma vez no cadastro da empresa, só serve de atalho pra
// pré-preencher terminologia/tipos ativos — nunca trava nada, tudo editável depois pelo Super
// Admin. "Genérico" sempre disponível em qualquer perfil, pra quando nada específico encaixa.
const PERFIS_DISPONIVEIS = [
  {
    chave: 'prestadora_manutencao',
    nome: 'Prestadora de manutenção',
    segmentos: [
      { chave: 'refrigeracao_climatizacao', nome: 'Refrigeração/Climatização' },
      { chave: 'elevadores', nome: 'Elevadores' },
      { chave: 'geradores_nobreak', nome: 'Geradores/No-break' },
      { chave: 'automacao_cftv_seguranca', nome: 'Automação/CFTV/Segurança' },
      { chave: 'hidraulica_bombas', nome: 'Hidráulica/Bombas' },
      { chave: 'marcacao_gravacao', nome: 'Marcação/Gravação' },
      { chave: 'generico', nome: 'Genérico' },
    ],
  },
  {
    chave: 'industria_equipe_propria',
    nome: 'Indústria com equipe técnica própria',
    segmentos: [
      { chave: 'eletrica_industrial', nome: 'Elétrica industrial' },
      { chave: 'mecanica_industrial', nome: 'Mecânica industrial' },
      { chave: 'refrigeracao_climatizacao', nome: 'Refrigeração/Climatização' },
      { chave: 'hidraulica', nome: 'Hidráulica' },
      { chave: 'generico', nome: 'Genérico' },
    ],
  },
  {
    chave: 'autonomo',
    nome: 'Autônomo / prestador de serviço avulso',
    segmentos: [
      { chave: 'montagem_painel_eletrico', nome: 'Montagem de painel elétrico' },
      { chave: 'instalacao_eletrica', nome: 'Instalação elétrica' },
      { chave: 'generico', nome: 'Genérico' },
    ],
  },
  // pedido do usuário: franqueado com muitas lojas (ex. rede de restaurantes), cada uma com
  // técnico/gerente fixo, agrupadas em setores com coordenador técnico/consultor de mercado —
  // perfil reutilizável por qualquer rede multiunidade, não só alimentação.
  {
    chave: 'rede_multiunidade',
    nome: 'Rede com múltiplas unidades (franquia)',
    segmentos: [
      { chave: 'franquia_alimentacao', nome: 'Franquia de alimentação' },
      { chave: 'generico', nome: 'Genérico' },
    ],
  },
  // pedido do usuário: em vez de um perfil genérico com "Refrigeração/Climatização" enterrado
  // como um segmento entre vários outros (ver "prestadora_manutencao"/"industria_equipe_propria"
  // acima), uma empresa que já é especificamente desse ramo escolhe um perfil específico só pra
  // ela — "o ideal é criar um perfil específico pra cada tipo de serviço, pra não ficar muito
  // genérico". Primeiro de uma futura série (um por tipo de serviço); os perfis genéricos acima
  // continuam intocados por enquanto — ver app.js: perfil com um único segmento pula a pergunta
  // de segmento no cadastro (não pede um segundo clique à toa). Sem preset de terminologia/tipos
  // ainda (cai no "sem restrição" — ver presetPerfilSegmento); entra quando for pedido.
  {
    chave: 'refrigeracao',
    nome: 'Refrigeração e Climatização',
    segmentos: [
      { chave: 'generico', nome: 'Refrigeração e Climatização' },
    ],
  },
];
const CHAVES_PERFIS = PERFIS_DISPONIVEIS.map((p) => p.chave);

// listas completas de hoje (ver app.js: select "na-tipo" e tiposRelatorioManual()) — usadas como
// catálogo de validação e como "sem restrição" quando a empresa não tem preset/edição própria.
const TIPOS_OS_DISPONIVEIS = ['corretiva', 'preventiva', 'treinamento_online', 'treinamento_presencial', 'demonstracao_tecnica'];
const TIPOS_RELATORIO_DISPONIVEIS = ['completo', 'preventiva', 'preventiva2', 'corretiva', 'relatorio_tecnico', 'aceite_entrega', 'entrega_teste', 'promotor', 'devolutivo', 'levantamento_tecnico'];

// presets por "perfil:segmento" — só os que já têm conteúdo real aqui; qualquer combinação não
// listada (inclusive todo "Genérico") cai no preset "sem restrição" em presetPerfilSegmento, que
// reproduz exatamente o comportamento de hoje (nenhum tipo/terminologia reduzido por omissão).
const PRESETS_PERFIL_SEGMENTO = {
  'autonomo:montagem_painel_eletrico': {
    terminologia: { equipamento: 'Painel' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'corretiva', 'relatorio_tecnico'],
    escala_ativa: false,
  },
  'autonomo:instalacao_eletrica': {
    terminologia: {},
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'corretiva', 'relatorio_tecnico', 'aceite_entrega'],
    escala_ativa: false,
  },
  // pedido do usuário: "pesquisar modelos tipos de relatório que é compatível com cada
  // atividade de empresas" — presets por segmento real de manutenção técnica. Padrão: toda
  // "prestadora_manutencao" (atende cliente externo) ganha aceite_entrega (formaliza a entrega
  // do serviço pro cliente); toda "industria_equipe_propria" (manutenção interna, sem cliente
  // externo) fica só com os 4 tipos universais, sem aceite_entrega (não tem a quem "entregar").
  // "promotor"/"entrega_teste"/"devolutivo" (fluxo de demonstração/venda de equipamento) e
  // "preventiva2" (modelo de referência específico da PRO Marking) ficam de fora de todos —
  // são do negócio de marcação/gravação, não de manutenção em geral.
  'prestadora_manutencao:refrigeracao_climatizacao': {
    terminologia: { equipamento: 'Unidade' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico', 'aceite_entrega'],
  },
  'prestadora_manutencao:elevadores': {
    terminologia: { equipamento: 'Elevador' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico', 'aceite_entrega', 'levantamento_tecnico'],
  },
  'prestadora_manutencao:geradores_nobreak': {
    terminologia: { equipamento: 'Gerador' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico', 'aceite_entrega'],
  },
  'prestadora_manutencao:automacao_cftv_seguranca': {
    terminologia: { equipamento: 'Sistema' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico', 'aceite_entrega', 'levantamento_tecnico'],
  },
  'prestadora_manutencao:hidraulica_bombas': {
    terminologia: { equipamento: 'Bomba' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico', 'aceite_entrega'],
  },
  'industria_equipe_propria:eletrica_industrial': {
    terminologia: { equipamento: 'Quadro Elétrico' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico'],
  },
  'industria_equipe_propria:mecanica_industrial': {
    terminologia: { equipamento: 'Máquina' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico'],
  },
  'industria_equipe_propria:refrigeracao_climatizacao': {
    terminologia: { equipamento: 'Unidade' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico'],
  },
  'industria_equipe_propria:hidraulica': {
    terminologia: { equipamento: 'Bomba' },
    tipos_os_ativos: ['corretiva', 'preventiva'],
    tipos_relatorio_ativos: ['completo', 'preventiva', 'corretiva', 'relatorio_tecnico'],
  },
};
function presetPerfilSegmento(perfil, segmento) {
  const preset = PRESETS_PERFIL_SEGMENTO[`${perfil}:${segmento}`];
  return {
    terminologia: (preset && preset.terminologia) || {},
    tipos_os_ativos: (preset && preset.tipos_os_ativos) || null,
    tipos_relatorio_ativos: (preset && preset.tipos_relatorio_ativos) || null,
    escala_ativa: preset && preset.escala_ativa !== undefined ? preset.escala_ativa : true,
  };
}

// módulos padrão da versão "Manutenção" — o pacote que toda empresa migrada do sistema antigo
// (só a PRO Marking, por enquanto) já usa hoje.
const MODULOS_VERSAO_MANUTENCAO = ['os_chamados', 'smp_preventivas', 'biblioteca'];

// token do QR Code do equipamento (Fase 1 — versão Restaurantes) — string aleatória opaca, nunca
// o id sequencial (evitaria que alguém adivinhasse/enumerasse etiquetas de outro equipamento).
function gerarQrToken() {
  return crypto.randomBytes(16).toString('hex');
}

function moduloAtivo(data, empresaId, chave) {
  if (!CHAVES_MODULOS.includes(chave)) return false;
  const empresa = data.empresas.find((e) => e.id === empresaId);
  return !!empresa && Array.isArray(empresa.modulos_ativos) && empresa.modulos_ativos.includes(chave);
}

// categorias de plano (pedido do usuário: "ajude a criar categorias de plano. Ao selecionar já é
// selecionado automático o que é liberado até o plano em que todas as funções é liberada") — cada
// versão tem uma "ordem" (1 = mais básica) e só guarda em modulos_proprios os módulos que ELA
// introduz; o campo modulos (consumido por toda a troca-de-plano/PUT /api/meu-plano, que já
// existia antes dessa feature) é sempre recalculado aqui como a UNIÃO cumulativa de
// modulos_proprios dela com o de toda versão de ordem menor — então uma versão de ordem mais alta
// automaticamente carrega tudo que já foi liberado nas versões abaixo dela, até a versão de maior
// ordem acumular todos os módulos do catálogo. Chamar depois de qualquer criação/edição/exclusão
// de versão, porque mexer numa versão de ordem baixa também muda o acumulado das de ordem mais
// alta.
function recalcularModulosVersoes(data) {
  const ordenadas = [...data.versoes].sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  let acumulado = [];
  for (const v of ordenadas) {
    const proprios = Array.isArray(v.modulos_proprios) ? v.modulos_proprios : [];
    acumulado = [...new Set([...acumulado, ...proprios])];
    v.modulos = [...acumulado];
  }
}

// banco novo começa vazio — o primeiro acesso vem do bootstrap de admin master
// (ADMIN_EMAIL/ADMIN_SENHA) ou de um convite criado manualmente por quem tiver acesso ao banco.
function seed() {
  return {
    usuarios: [],
    clientes: [],
    equipamentos: [],
    agenda: [],
    visitas: [],
    registros: [],
    chamados: [],
    chamados_rr_index: 0,
    relatorios_manutencao: [],
    push_subscriptions: [],
    vapid: null,
    empresas: [],
    mensagens_internas: [],
    solicitacoes_rh: [],
    feriados: [],
    escala_folgas: [],
    prestacoes_contas: [],
    // despesas avulsas que o técnico justifica em campo (comprovante lido por IA ou preenchido na
    // mão) — pedido do usuário: "crie no menu técnico um menu justificar despesa". Mais simples que
    // prestacao_contas (sem categoria, um item por lançamento) e com campo de estabelecimento, que
    // prestacao_contas não tem. Vai pra aprovação do financeiro, mesmo padrão de status.
    despesas_justificadas: [],
    // leads/contatos (CRM nativo, passo 1) — prospect que ainda não é cliente oficial; ganha
    // convertido_cliente_id quando alguém usa o botão "Converter em cliente" (vira um registro de
    // verdade em `clientes`, igual sincronizarClienteDoRelatorio já faz a partir de um relatório).
    leads: [],
    // oportunidades (CRM nativo, passo 2) — funil comercial por estágio. Nasce manual (origem
    // 'manual') ou automática a partir de um Devolutivo que marcou
    // identificou_oportunidade_adicional (origem 'devolutivo', ver POST /api/relatorios-manutencao).
    // valor_estimado é texto livre (igual valor_agregado do Devolutivo já é hoje: "Descreva como
    // isso pode virar uma venda de maior valor" — nunca foi um número), não dá pra fingir que é.
    oportunidades: [],
    // propostas/orçamentos (CRM nativo, passo 3) — itens de linha de verdade (quantidade x valor
    // unitário, diferente do valor_estimado em texto livre da Oportunidade), abertas a partir da
    // tela da Oportunidade.
    propostas: [],
    // FMEA (RCM/SAP PM, Fase 1 passo 1): catálogo cadastrável pelo administrador, em cascata —
    // Componente (preso a um modelo do catálogo de equipamentos) → Modo de falha (com
    // severidade/ocorrência/detecção, 1-10, pra calcular RPN) → Causa → Efeito. Ainda não é usado
    // em nenhuma O.S./laudo (isso é o passo 3) — este passo só cria a fundação de dados.
    fmea_componentes: [],
    fmea_modos_falha: [],
    fmea_causas: [],
    fmea_efeitos: [],
    // versão "Restaurantes"/rede multiunidade (Fase 1 — Base): hierarquia setores → filiais →
    // áreas, abaixo da empresa (ver módulo "filiais" acima). Vazia até o módulo ser contratado e
    // alguém cadastrar a estrutura — não afeta nenhuma empresa que não usa esse módulo.
    setores: [],
    filiais: [],
    areas: [],
    // versão Restaurantes/rede multiunidade (Fase 2 — Operação): vistoria guiada por área (gera
    // uma O.S. por pendência) e pedido de apoio técnico entre setores (ver server.js).
    vistorias: [],
    vistoria_itens: [],
    apoios: [],
    // versão Restaurantes/rede multiunidade (Fase 3 — Peças): catálogo compartilhado entre
    // filiais (empresa_id, não filial_id) e solicitação de peça com cadeia de autorização.
    pecas_catalogo: [],
    solicitacoes_peca: [],
    // versão Restaurantes/rede multiunidade (Fase 4 — Compras): compra em atacado (consolidando
    // solicitações de várias lojas pelo mesmo código), estoque central/por loja e transferência
    // (central->loja ou entre filiais) — ver server.js.
    pedidos_compra: [],
    pedido_itens: [],
    estoque_central: [],
    estoque_loja: [],
    transferencias: [],
    // versão Restaurantes/rede multiunidade (Fase 5 — Gestão e comunicação): mural de avisos
    // (setor_id null = geral) e chat por canal (geral/setor/filial) — separado de propósito do
    // chat interno 1-pra-1 já existente (mensagens_internas), que fica intocado.
    avisos: [],
    mensagens_canal: [],
    // rascunho de relatório/laudo técnico espelhado do localStorage, um por usuário+chave — dá
    // pra recuperar o mesmo rascunho de qualquer aparelho logado com o mesmo usuário (ver
    // sincronizarRascunhoServidor em app.js).
    rascunhos: [],
    // registro de atividades diárias (pedido do usuário, empresa JBPA) — cliente com contrato
    // mensal, data + descrição do serviço + valor, pra gerar um PDF comparando o entregue com o
    // valor do contrato.
    atividades_diarias: [],
    // pedido do usuário: Ordens de Serviço do perfil "Refrigeração e Climatização" (ver
    // PERFIS_DISPONIVEIS acima) — menu novo, construído do zero, com seu próprio cadastro de
    // clientes (os_refrigeracao_clientes) separado da coleção `clientes` genérica do sistema, já
    // que os outros menus desse perfil (Orçamentos, Agenda, Clientes, PMOC, Financeiro) ainda vão
    // ser construídos um a um e podem evoluir pra um modelo próprio diferente do núcleo.
    os_refrigeracao_clientes: [],
    os_refrigeracao: [],
    // Orçamentos do mesmo perfil (atalho #3, ver os 6 atalhos do menu iClima) — reaproveita o
    // cadastro de clientes de os_refrigeracao_clientes (mesma base), mas é coleção própria porque
    // o fluxo é diferente: assinatura do técnico é opcional/posterior ("Assinar agora" na tela de
    // detalhe, não obrigatória na criação) e o status vira Aprovado quando o CLIENTE assina pelo
    // link público, não quando o técnico cria.
    os_refrigeracao_orcamentos: [],
    // Agenda do mesmo perfil (atalho #4) — uma config de disponibilidade POR TÉCNICO (dias de
    // atendimento, horário, pausa, duração do atendimento, máx por dia, datas bloqueadas — ver
    // POST/PUT /api/os-refrigeracao-agenda/config em server.js) e os agendamentos propriamente
    // ditos, feitos manualmente pelo técnico/administrador dentro dos horários livres gerados a
    // partir dessa config (ver gerarSlotsAgendaRefrigeracao). Diferente da O.S./Orçamento, não tem
    // cadastro de cliente vinculado — o agendamento guarda nome/telefone/endereço direto (mesmo
    // padrão do "Novo Agendamento Manual" do app de referência iClima).
    os_refrigeracao_agenda_config: [],
    os_refrigeracao_agendamentos: [],
    // Pacote "Climatização / PMOC" (módulo `pmoc`, ver MODULOS_DISPONIVEIS acima) — Fase 1
    // (Cadastro): local do cliente final (estabelecimento, 1 cliente pode ter vários — ver Lei
    // 13.589/2018), ambientes de cada local, aparelhos de climatização de cada ambiente, e o
    // responsável técnico (CREA/CFT) cadastrado pela empresa de Refrigeração. Pendurado em
    // os_refrigeracao_clientes (não na coleção `clientes` núcleo), mesma base de cliente já usada
    // por O.S./Orçamento/Agenda desse perfil.
    os_refrigeracao_pmoc_locais: [],
    os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [],
    os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    // Fase 2 (Plano e preventivas): Modelo de Checklist (lista editável por empresa — nasce vazia
    // e é populada com PMOC_CHECKLIST_PADRAO na primeira vez que a empresa acessa, ver
    // GET /api/pmoc/modelo-checklist) e Plano PMOC (1 por local — status rascunho/ativo/vencido,
    // com os itens de manutenção que esse local específico usa, que podem divergir do modelo da
    // empresa depois de criado). As visitas de preventiva GERADAS a partir do plano não ganham
    // coleção própria — entram em os_refrigeracao_agendamentos (a Agenda já construída no atalho
    // #4), com tecnico_id null e status 'pendente_designacao' até o administrador designar um
    // técnico (ver geração automática em server.js) — "entram na agenda geral sem técnico
    // definido" (pedido do usuário), reaproveitando a mesma grade/cota por técnico que já existe.
    os_refrigeracao_pmoc_modelo_checklist: [],
    os_refrigeracao_pmoc_planos: [],
    // Fase 4 (Documento PMOC e portal) — registro de análise da qualidade do ar POR LOCAL (item
    // 1.6 do pedido do usuário): data, laboratório, laudo em PDF anexado, temperatura/umidade/CO2,
    // observações. Pedido do usuário: "não codificar regras legais fixas" — não compara contra
    // nenhum valor de referência fixo no código (RE nº 9/2003 da Anvisa), só registra.
    os_refrigeracao_pmoc_qualidade_ar: [],
    // "versões" = pacotes prontos de módulos, escolhidos ao cadastrar uma empresa (ver
    // sincronizarEmpresaPadrao) — depois disso, módulo avulso pode ser ligado/desligado por
    // empresa independente da versão original (empresa.modulos_ativos).
    // preco_mensal (SaaS, passo 3): só exibição por enquanto — sem gateway de pagamento nenhum
    // integrado ainda (ver PUT /api/empresa/plano em server.js), igual plano_valor_mensal da
    // empresa já era antes disso.
    versoes: [{ id: 1, nome: 'Manutenção', ordem: 1, modulos_proprios: MODULOS_VERSAO_MANUTENCAO, modulos: MODULOS_VERSAO_MANUTENCAO, preco_mensal: null }],
    // empresas começa em 2: o id 1 é sempre a empresa dona da instalação (ver sincronizarEmpresaPadrao),
    // carimbado direto, nunca através de nextId — a plataforma só usa esse contador a partir da 2ª.
    _seq: { usuarios: 1, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, registros: 1, chamados: 1, relatorios_manutencao: 1, mensagens_internas: 1, solicitacoes_rh: 1, feriados: 1, escala_folgas: 1, prestacoes_contas: 1, despesas_justificadas: 1, leads: 1, oportunidades: 1, propostas: 1, fmea_componentes: 1, fmea_modos_falha: 1, fmea_causas: 1, fmea_efeitos: 1, setores: 1, filiais: 1, areas: 1, vistorias: 1, vistoria_itens: 1, apoios: 1, pecas_catalogo: 1, solicitacoes_peca: 1, pedidos_compra: 1, pedido_itens: 1, estoque_central: 1, estoque_loja: 1, transferencias: 1, avisos: 1, mensagens_canal: 1, rascunhos: 1, atividades_diarias: 1, os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1, os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1, os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1, os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1, os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1, os_refrigeracao_pmoc_qualidade_ar: 1, versoes: 2, empresas: 2 },
  };
}

// dados da empresa "dona" da instalação — hoje só existe a de id 1, mas já mora numa lista própria
// (com empresa_id nos demais registros) pra um dia dar pra ter mais de uma empresa usando o mesmo
// sistema sem redesenhar o banco. Configurável por variável de ambiente: uma instalação nova (outra
// empresa comprando o sistema) só precisa trocar as variáveis no hospedeiro, sem mexer em código.
// Roda a cada carregamento, então mudar a variável de ambiente reflete sem precisar apagar o banco.
function sincronizarEmpresaPadrao(data) {
  if (!data.empresas) data.empresas = [];
  let empresa = data.empresas.find((e) => e.id === 1);
  if (!empresa) {
    empresa = {
      id: 1,
      nome: 'PRO Marking',
      site: 'promarking.com.br',
      whatsapp: '12 99718-7506',
      telefone: '12 3902-3453',
      emails: ['suporte@promarking.com.br', 'atendimento@promarking.com.br', 'tecnico@promarking.com.br', 'posvenda@promarking.com.br'],
      cor_primaria: '#0A2647',
      cor_secundaria: '#0E7C86',
    };
    data.empresas.push(empresa);
  }
  // multiempresa: empresa 1 (PRO Marking) já usa o sistema hoje com os módulos da versão
  // Manutenção — isso também cobre quem já tinha essa empresa criada antes desses 3 campos
  // existirem (roda em todo boot, idempotente).
  if (empresa.versao_id === undefined) empresa.versao_id = 1;
  if (!Array.isArray(empresa.modulos_ativos)) empresa.modulos_ativos = [...MODULOS_VERSAO_MANUTENCAO];
  if (!empresa.terminologia || typeof empresa.terminologia !== 'object') empresa.terminologia = {};
  // subdomínio: identifica a empresa pela URL antes do login (ver resolverEmpresaPorRequisicao em
  // server.js). Fica null até alguém configurar — nesse caso toda requisição cai na empresa 1
  // (comportamento de hoje, preservado).
  if (empresa.subdominio === undefined) empresa.subdominio = null;
  // logo própria (Etapa 5/passo 1) — guardada como referência de foto (ver extrairFotosProfundo),
  // null até a empresa subir uma; sem logo própria o front usa a logo padrão do sistema.
  if (empresa.logo_url === undefined) empresa.logo_url = null;
  // pedido do usuário: "Devolva o logo da Promarking no relatório da empresa Promarking" — a
  // empresa 1 É a PRO Marking de verdade (ver objeto literal acima). O rebranding da plataforma
  // pra Nexor Connect trocou a logo PADRÃO do sistema (public/logo.png), mas a logo PRÓPRIA da PRO
  // Marking (este campo) tinha ficado null, então os relatórios dela passaram a cair na logo nova
  // da plataforma por engano. Só preenche se ainda estiver vazio — nunca sobrescreve um upload que
  // o admin já tenha feito em "Minha Empresa" — roda em todo boot, idempotente.
  if (empresa.id === 1 && !empresa.logo_url) empresa.logo_url = '/img/logo-pro-marking.png';
  // valores padrão que antes eram constante fixa no código (Etapa 5/passo 4) — toda empresa já
  // nasce com o mesmo valor de hoje, só editável a partir de agora pelo administrador/Super Admin.
  if (empresa.valor_bonus_viagem === undefined) empresa.valor_bonus_viagem = 200;
  if (empresa.limite_viagens_bonus_mes === undefined) empresa.limite_viagens_bonus_mes = 7;
  // cotas de plano (Etapa 6/passo 3) — null = sem limite (comportamento de hoje, preservado pra
  // quem já existia). Só o Super Admin define/edita (não é um dado da própria empresa, é o que
  // ela contratou) — ver PUT /api/plataforma/empresas/:id.
  if (empresa.limite_tecnicos === undefined) empresa.limite_tecnicos = null;
  if (empresa.limite_equipamentos === undefined) empresa.limite_equipamentos = null;
  // status (Etapa 7/passo 1): empresa 1 (instalação atual, já em uso de verdade) nasce "ativa" —
  // só empresa nova, cadastrada pelo Super Admin depois disso existir, começa "teste" (ver
  // POST /api/plataforma/empresas). "suspensa" bloqueia login e qualquer rota pra quem já estava
  // logado (ver resolverEmpresaPorRequisicao/dispatcher central em server.js).
  if (empresa.status === undefined) empresa.status = 'ativa';
  // plano e cobrança (Etapa 7/passo 2) — só exibição, sem integração de pagamento nesta etapa.
  if (empresa.plano_valor_mensal === undefined) empresa.plano_valor_mensal = null;
  if (empresa.plano_dia_vencimento === undefined) empresa.plano_dia_vencimento = null;
  // criado_em (SaaS, passo 1) — não existia antes do cadastro self-service; necessário pra medir
  // o trial (passo 2). Quem já existia ganha a data de hoje no backfill — não afeta ninguém porque
  // só habilita a contagem de trial daqui pra frente, e só empresa com status 'teste' é afetada
  // pela validade (empresa 'ativa'/'suspensa' nunca checa isso).
  if (empresa.criado_em === undefined) empresa.criado_em = new Date().toISOString();
  // Perfil/Segmento (Etapa 8): null = sem perfil escolhido (comportamento de hoje, preservado pra
  // quem já existia); tipos_os/relatorio_ativos null = "todos" (ver tiposOsAtivos/tiposRelatorioAtivos
  // em server.js, nunca lê o campo bruto direto); escala_ativa true = Escala de Folga visível, igual hoje.
  if (empresa.perfil === undefined) empresa.perfil = null;
  if (empresa.segmento === undefined) empresa.segmento = null;
  if (!Array.isArray(empresa.tipos_os_ativos)) empresa.tipos_os_ativos = null;
  if (!Array.isArray(empresa.tipos_relatorio_ativos)) empresa.tipos_relatorio_ativos = null;
  if (empresa.escala_ativa === undefined) empresa.escala_ativa = true;
  if (process.env.EMPRESA_NOME) empresa.nome = process.env.EMPRESA_NOME;
  if (process.env.EMPRESA_SITE) empresa.site = process.env.EMPRESA_SITE;
  if (process.env.EMPRESA_WHATSAPP) empresa.whatsapp = process.env.EMPRESA_WHATSAPP;
  if (process.env.EMPRESA_TELEFONE) empresa.telefone = process.env.EMPRESA_TELEFONE;
  if (process.env.EMPRESA_EMAILS) empresa.emails = process.env.EMPRESA_EMAILS.split(',').map((e) => e.trim()).filter(Boolean);
  if (process.env.EMPRESA_COR_PRIMARIA) empresa.cor_primaria = process.env.EMPRESA_COR_PRIMARIA;
  if (process.env.EMPRESA_COR_SECUNDARIA) empresa.cor_secundaria = process.env.EMPRESA_COR_SECUNDARIA;
  if (process.env.EMPRESA_SUBDOMINIO) empresa.subdominio = process.env.EMPRESA_SUBDOMINIO.trim().toLowerCase();
}

// se as variáveis de ambiente ADMIN_EMAIL/ADMIN_SENHA estiverem definidas e ainda não existir
// usuário com esse e-mail, cria um administrador ativo — assim a senha nunca precisa ficar
// escrita em código/commit, só no painel de variáveis de ambiente do hospedeiro (Render etc.).
// Roda a cada carregamento (idempotente: só cria uma vez). Devolve true se criou alguém.
function bootstrapAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  const senha = process.env.ADMIN_SENHA;
  if (!email || !senha) return false;
  if (data.usuarios.some((u) => u.email === email)) return false;
  const { salt, hash } = hashSenha(senha);
  data.usuarios.push({
    id: nextId(data, 'usuarios'),
    nome: 'Desenvolvedor', email, papel: 'administrador',
    cargo: '', setor: '', celular: '', foto_perfil: '', cliente_id: null,
    status: 'ativo', convite_token: null, salt, hash,
    protegido: true,
  });
  console.log(`[db] Conta master criada automaticamente: ${email}`);
  return true;
}

// garante que a conta master (e-mail em ADMIN_EMAIL) fique sempre marcada como protegida —
// cobre também quem já existia antes dessa flag existir, ou foi criado numa corrida em que
// bootstrapAdminMaster ainda não tinha essa marca. Roda a cada carregamento (idempotente).
function protegerAdminMaster(data) {
  const email = process.env.ADMIN_EMAIL;
  if (!email) return;
  const master = data.usuarios.find((u) => u.email === email);
  if (!master) return;
  if (master.nome === 'Administrador') master.nome = 'Desenvolvedor';
  master.protegido = true;
}

// dono da plataforma (não pertence a nenhuma empresa — empresa_id fica null de propósito, pra
// nunca ser confundido com a empresa 1 nem entrar em nenhum tenant.listar/buscar). Mesmo padrão
// de bootstrap do ADMIN_EMAIL/ADMIN_SENHA, com variáveis próprias — assim dá pra ter os dois tipos
// de conta master ativos ao mesmo tempo (o admin da PRO Marking e o super admin da plataforma).
function bootstrapSuperAdmin(data) {
  const email = process.env.SUPERADMIN_EMAIL;
  const senha = process.env.SUPERADMIN_SENHA;
  if (!email || !senha) return false;
  if (data.usuarios.some((u) => u.email === email)) return false;
  const { salt, hash } = hashSenha(senha);
  data.usuarios.push({
    id: nextId(data, 'usuarios'),
    nome: 'Super Admin', email, papel: 'super_admin', empresa_id: null,
    cargo: '', setor: '', celular: '', foto_perfil: '', cliente_id: null,
    status: 'ativo', convite_token: null, salt, hash,
    protegido: true,
  });
  console.log(`[db] Conta de super admin criada automaticamente: ${email}`);
  return true;
}

// migração leve: bancos criados antes destes campos existirem ganham valores padrão.
// Roda uma vez ao carregar (seja do arquivo ou do Postgres) — mutila e devolve o mesmo objeto.
function migrar(data) {
  if (!data.registros) data.registros = [];
  if (!data.push_subscriptions) data.push_subscriptions = [];
  // gera o par de chaves VAPID (push notification) uma única vez e guarda no próprio banco,
  // assim não depende de configurar variável de ambiente manualmente no hospedeiro
  if (!data.vapid) {
    const { publicKey, privateKey } = require('web-push').generateVAPIDKeys();
    data.vapid = { publicKey, privateKey };
  }
  if (!data.chamados) data.chamados = [];
  if (data.chamados_rr_index === undefined) data.chamados_rr_index = 0;
  if (!data.relatorios_manutencao) data.relatorios_manutencao = [];
  // Entrega para Teste ganhou um link público (token_publico) pro cliente preencher/assinar sem
  // login — relatórios desse tipo criados antes disso existir ficam sem o token; carimba um
  // agora e considera já concluídos (não tem como saber se estavam esperando o cliente ou não, e
  // reabrir o link de um relatório antigo sem controle nenhum seria pior do que só deixar como está).
  data.relatorios_manutencao.filter((r) => r.tipo === 'entrega_teste').forEach((r) => {
    if (!r.token_publico) r.token_publico = gerarTokenConvite();
    if (!r.status_preenchimento) r.status_preenchimento = 'concluido';
    if (r.concluido_em === undefined) r.concluido_em = r.status_preenchimento === 'concluido' ? (r.criado_em || null) : null;
  });
  if (!data.mensagens_internas) data.mensagens_internas = [];
  if (!data.solicitacoes_rh) data.solicitacoes_rh = [];
  if (!data._seq.solicitacoes_rh) data._seq.solicitacoes_rh = 1;
  // escala de folga: feriados (nacional/estadual/municipal, cadastrados pelo administrador — o
  // sistema não vem com nenhum pré-cadastrado, pra nunca arriscar uma data errada) e os dias
  // marcados de cada usuário (DSR, compensação de banco de horas, home office, férias).
  if (!data.feriados) data.feriados = [];
  if (!data._seq.feriados) data._seq.feriados = 1;
  if (!data.escala_folgas) data.escala_folgas = [];
  if (!data._seq.escala_folgas) data._seq.escala_folgas = 1;
  // justificativa de atividade não programada: pedido do usuário — num dia sem O.S./atendimento
  // e sem folga marcada, o técnico diz o que fez (uma ou mais atividades com início/fim), pra dar
  // ao administrador um relatório diário de ocupação por técnico (muito ou pouco serviço).
  if (!data.atividades_nao_programadas) data.atividades_nao_programadas = [];
  if (!data._seq.atividades_nao_programadas) data._seq.atividades_nao_programadas = 1;
  // prestação de contas (Etapa 6/passo 2 do plano white label) — despesas de viagem/campo que o
  // técnico lança pra aprovação do financeiro/administrador, além do bônus fixo por diária.
  if (!data.prestacoes_contas) data.prestacoes_contas = [];
  if (!data._seq.prestacoes_contas) data._seq.prestacoes_contas = 1;
  // despesa justificada (pedido do usuário: "crie no menu técnico um menu justificar despesa") —
  // comprovante único por lançamento, com leitura automática por IA ou preenchimento manual.
  if (!data.despesas_justificadas) data.despesas_justificadas = [];
  if (!data._seq.despesas_justificadas) data._seq.despesas_justificadas = 1;
  // pedido do usuário: "coloque opção de colocar mais de um recibo no mesmo justificativa" — o
  // campo vira array (fotos) em vez de string única (foto). Lançamentos antigos tinham no máximo
  // uma foto só; migra pra um array de 1 item (ou vazio) e mantém idempotente daqui pra frente.
  data.despesas_justificadas.forEach((d) => {
    if (!Array.isArray(d.fotos)) d.fotos = d.foto ? [d.foto] : [];
    delete d.foto;
  });
  // pedido do usuário: "o que for alimentação, coloque separado como subtotal... igual fatura de
  // cartão de crédito" — cada lançamento ganha uma categoria ('alimentacao' ou 'outros') pra
  // agrupar o subtotal na lista/PDF. Lançamentos antigos não tinham esse campo; como boa parte já
  // registrava "alimentação" na própria descrição/estabelecimento (hábito que motivou o pedido),
  // migra com esse mesmo texto como pista — o resto cai em 'outros', e dá pra corrigir editando.
  data.despesas_justificadas.forEach((d) => {
    if (d.categoria !== 'alimentacao' && d.categoria !== 'outros') {
      const pista = `${d.estabelecimento || ''} ${d.descricao || ''}`.toLowerCase();
      d.categoria = pista.includes('aliment') ? 'alimentacao' : 'outros';
    }
  });
  // leads/contatos (CRM nativo, passo 1) — menu "Comercial" novo, substitui o esqueleto "CRM".
  if (!data.leads) data.leads = [];
  if (!data._seq.leads) data._seq.leads = 1;
  // oportunidades (CRM nativo, passo 2) — funil comercial por estágio.
  if (!data.oportunidades) data.oportunidades = [];
  if (!data._seq.oportunidades) data._seq.oportunidades = 1;
  // propostas/orçamentos (CRM nativo, passo 3).
  if (!data.propostas) data.propostas = [];
  if (!data._seq.propostas) data._seq.propostas = 1;
  // criado_em entrou depois em oportunidades/propostas, pro Histórico Unificado (passo 4) poder
  // ordenar por data — quem já existia sem o campo ganha a data da migração (não tem como saber a
  // data real de criação retroativamente).
  for (const o of data.oportunidades) { if (!o.criado_em) o.criado_em = new Date().toISOString(); }
  for (const p of data.propostas) { if (!p.criado_em) p.criado_em = new Date().toISOString(); }
  // pedido do usuário: "gerador de orçamento profissional" — condições (pagamento/entrega/
  // garantia) entraram depois no PDF; quem já tinha orçamento sem o campo ganha string vazia.
  for (const p of data.propostas) { if (p.observacoes === undefined) p.observacoes = ''; }
  // FMEA (RCM/SAP PM, Fase 1 passo 1) — catálogo em cascata, cadastrado pelo administrador,
  // ainda sem nenhuma O.S./laudo usando (fundação de dados só).
  if (!data.fmea_componentes) data.fmea_componentes = [];
  if (!data._seq.fmea_componentes) data._seq.fmea_componentes = 1;
  if (!data.fmea_modos_falha) data.fmea_modos_falha = [];
  if (!data._seq.fmea_modos_falha) data._seq.fmea_modos_falha = 1;
  if (!data.fmea_causas) data.fmea_causas = [];
  if (!data._seq.fmea_causas) data._seq.fmea_causas = 1;
  if (!data.fmea_efeitos) data.fmea_efeitos = [];
  if (!data._seq.fmea_efeitos) data._seq.fmea_efeitos = 1;
  // multiempresa: bancos anteriores ao conceito de "versão" (pacote de módulos) ganham a versão
  // Manutenção, que é o que o sistema sempre ofereceu até agora.
  if (!data.versoes) data.versoes = [{ id: 1, nome: 'Manutenção', ordem: 1, modulos_proprios: MODULOS_VERSAO_MANUTENCAO, modulos: MODULOS_VERSAO_MANUTENCAO, preco_mensal: null }];
  if (!data._seq.versoes) data._seq.versoes = 2;
  // preco_mensal (SaaS, passo 3) — não existia antes; só exibição, sem gateway de pagamento.
  for (const v of data.versoes) { if (v.preco_mensal === undefined) v.preco_mensal = null; }
  // categorias de plano em cascata (pedido do usuário) — versão sem "ordem" ainda é a única que
  // existia antes dessa feature (nunca houve mais de uma na prática); ganha ordem 1 e
  // modulos_proprios = o próprio modulos que ela já tinha, pra não perder nada no recálculo
  // abaixo.
  let precisaRecalcularVersoes = false;
  data.versoes.forEach((v, indice) => {
    if (v.ordem === undefined) { v.ordem = indice + 1; precisaRecalcularVersoes = true; }
    if (!Array.isArray(v.modulos_proprios)) { v.modulos_proprios = Array.isArray(v.modulos) ? [...v.modulos] : []; precisaRecalcularVersoes = true; }
  });
  if (precisaRecalcularVersoes) recalcularModulosVersoes(data);
  // pedido do usuário: "crie automático planos com as suas funções inclusas... crie o nome dos
  // planos também" — até aqui só existia a versão "Manutenção" (os 3 módulos que o sistema sempre
  // ofereceu), sem nenhum plano de nível maior. Cria duas categorias a mais, UMA VEZ só (flag
  // abaixo), acima dela na cascata: "Profissional" (ordem 2) acrescenta o lado comercial/agenda,
  // "Completo" (ordem 3) acrescenta financeiro e o Assistente IA — fechando com os 8 módulos do
  // catálogo inteiro liberados. Continua tudo editável depois (nome, ordem, módulos, preço) na
  // tela Planos do Super Admin; a flag só evita recriar se o Super Admin apagar ou renomear.
  if (!data._migracaoPlanosPadraoV1) {
    const maiorOrdemAtual = data.versoes.reduce((max, v) => Math.max(max, v.ordem || 0), 0);
    data.versoes.push(
      { id: nextId(data, 'versoes'), nome: 'Profissional', ordem: maiorOrdemAtual + 1, modulos_proprios: ['comercial', 'prestacao_contas', 'agendamento'], modulos: [], preco_mensal: null },
      { id: nextId(data, 'versoes'), nome: 'Completo', ordem: maiorOrdemAtual + 2, modulos_proprios: ['financeiro', 'assistente_ia', 'filiais'], modulos: [], preco_mensal: null },
    );
    recalcularModulosVersoes(data);
    data._migracaoPlanosPadraoV1 = true;
  }
  // pedido do usuário: "nosso sistema deve ser do mais simples ao completo: orçamento é a base,
  // depois relatório... o plano básico precisa ser criar orçamento e relatório, intermediário
  // inclui o.s. etc" — a V1 acima não tinha esse chão (começava já em "Manutenção", que exige
  // O.S. completo). V2 corrige em cima do que já existir (seja V1 recém-criada ou já rodada em
  // produção antes deste pedido): cria/realinha "Autônomo" (ordem 1: comercial+relatórios, sem
  // O.S.), empurra "Manutenção" pra ordem 2 (ela acrescenta o O.S. completo) e funde o que o
  // "Profissional" acrescentava (prestação de contas, agendamento) dentro do "Completo" (ordem 3,
  // junto do novo módulo de equipe/escala) — "Profissional" deixa de existir como categoria
  // própria, porque sua combinação não corresponde a nenhum estágio da jornada descrita. Roda
  // uma vez só (flag); segue tudo editável depois pelo Super Admin.
  if (!data._migracaoPlanosPadraoV2) {
    // pedido do usuário (empresa JBPA): "coloque [Registro de Atividades] no plano básico" — entra
    // já no chão da cascata (ordem 1), junto do orçamento/relatório, pra TODO plano acima dele
    // herdar automaticamente (recalcularModulosVersoes é cumulativo por ordem).
    let autonomo = data.versoes.find((v) => v.nome === 'Autônomo');
    if (!autonomo) {
      autonomo = { id: nextId(data, 'versoes'), nome: 'Autônomo', ordem: 1, modulos_proprios: ['comercial', 'relatorios', 'atividades'], modulos: [], preco_mensal: null };
      data.versoes.push(autonomo);
    } else {
      autonomo.ordem = 1;
      autonomo.modulos_proprios = ['comercial', 'relatorios', 'atividades'];
    }
    const manutencao = data.versoes.find((v) => v.nome === 'Manutenção');
    if (manutencao) manutencao.ordem = 2;
    const completo = data.versoes.find((v) => v.nome === 'Completo');
    if (completo) {
      completo.ordem = 3;
      completo.modulos_proprios = [...new Set([...(Array.isArray(completo.modulos_proprios) ? completo.modulos_proprios : []), 'equipe_avancado', 'prestacao_contas', 'agendamento'])];
    }
    const profissional = data.versoes.find((v) => v.nome === 'Profissional');
    if (profissional) {
      if (completo) {
        for (const e of data.empresas) { if (e.versao_id === profissional.id) e.versao_id = completo.id; }
      }
      data.versoes = data.versoes.filter((v) => v.id !== profissional.id);
    }
    recalcularModulosVersoes(data);
    data._migracaoPlanosPadraoV2 = true;
  }
  // pedido do usuário: "não é plano autônomo é plano básico. Intermediário. Profissional e
  // completo" — renomeia os 3 planos da V2 pros 4 nomes corretos, dividindo o antigo "Completo"
  // (que acumulava equipe/escala JUNTO com financeiro/prestação de contas/agendamento) em dois
  // estágios: "Profissional" (ordem 3, só acrescenta equipe/escala — "quando a equipe aumenta")
  // e um "Completo" novo (ordem 4, acrescenta o resto — financeiro, prestação de contas,
  // agendamento, assistente IA), fechando com o catálogo inteiro liberado nele. Acha os planos
  // pelos nomes que a V2 já deixou (funciona tanto numa migração nova quanto numa já rodada em
  // produção antes deste pedido); se o Super Admin já tiver apagado/renomeado algum, só pula.
  if (!data._migracaoPlanosPadraoV3) {
    const autonomo = data.versoes.find((v) => v.nome === 'Autônomo');
    if (autonomo) autonomo.nome = 'Básico';
    const manutencao = data.versoes.find((v) => v.nome === 'Manutenção');
    if (manutencao) manutencao.nome = 'Intermediário';
    const completoAntigo = data.versoes.find((v) => v.nome === 'Completo');
    if (completoAntigo) {
      completoAntigo.nome = 'Profissional';
      const proprios = Array.isArray(completoAntigo.modulos_proprios) ? completoAntigo.modulos_proprios : [];
      const restante = proprios.filter((m) => m !== 'equipe_avancado');
      completoAntigo.modulos_proprios = proprios.filter((m) => m === 'equipe_avancado');
      const maiorOrdemAtual = data.versoes.reduce((max, v) => Math.max(max, v.ordem || 0), 0);
      data.versoes.push({
        id: nextId(data, 'versoes'), nome: 'Completo', ordem: maiorOrdemAtual + 1,
        modulos_proprios: restante.length ? restante : ['prestacao_contas', 'financeiro', 'assistente_ia', 'agendamento', 'filiais'],
        modulos: [], preco_mensal: null,
      });
    }
    recalcularModulosVersoes(data);
    data._migracaoPlanosPadraoV3 = true;
  }
  // empresa 1 (a dona da instalação) é sempre carimbada direto, nunca via nextId — o contador só
  // precisa existir a partir da 2ª empresa, que o painel da plataforma cria.
  if (!data._seq.empresas) data._seq.empresas = 2;
  sincronizarEmpresaPadrao(data);
  // divisão do módulo "os_chamados" em 3 (pedido do usuário, ver MODULOS_DISPONIVEIS acima): quem
  // já tinha "os_chamados" ativo hoje (toda empresa migrada até aqui) precisa continuar com
  // acesso a tudo que já usava — Relatório/Equipamentos/Assistente IA (agora "relatorios") e
  // Equipe/Escala/RH/KPIs/FMEA (agora "equipe_avancado") estavam dentro dele. Backfill uma vez
  // só; dali em diante os 3 módulos passam a ser controlados de forma independente pelo Super
  // Admin/plano de cada empresa. Roda DEPOIS de sincronizarEmpresaPadrao (acima), que é quem dá a
  // empresa 1 o modulos_ativos inicial — senão, no primeiro boot, essa empresa ainda não teria
  // "os_chamados" no momento desta checagem e ficaria de fora do backfill.
  if (!data._migracaoSplitOsChamadosV1) {
    for (const e of data.empresas) {
      if (Array.isArray(e.modulos_ativos) && e.modulos_ativos.includes('os_chamados')) {
        e.modulos_ativos = [...new Set([...e.modulos_ativos, 'relatorios', 'equipe_avancado'])];
      }
    }
    data._migracaoSplitOsChamadosV1 = true;
  }
  // bug real pós-deploy (versão Restaurantes/rede multiunidade): qualquer instalação que já tinha
  // rodado as migrações de plano acima ANTES de um módulo novo existir no código fica com a flag
  // (_migracaoPlanosPadraoV1/V2/V3) já marcada true pra sempre — os blocos acima nunca rodam de
  // novo, então nenhum plano dessa instalação ganha o módulo em modulos_proprios sozinho. E mesmo
  // que o Super Admin edite o plano depois (Painel da Plataforma > Planos) pra adicionar o módulo,
  // isso só atualiza versao.modulos — quem já tinha ESCOLHIDO aquele plano fica com
  // empresa.modulos_ativos congelado no retrato antigo (só PUT /api/meu-plano, a própria empresa
  // "trocando de plano" de novo, recalcula a partir de versao.modulos). Resultado: empresa continua
  // marcada no mesmo plano de sempre, mas nunca ganha o menu novo. Os dois helpers abaixo resolvem
  // isso achando o plano certo (nunca pelo nome, que o Super Admin pode ter mudado, e que um
  // fixture de teste qualquer pode coincidir de ter) e, uma vez só, dando o módulo de volta a ele
  // e a toda empresa que já estava num plano afetado — sem precisar reconfigurar nada manualmente.
  //
  // variante 1: módulo que entrou só no topo da cascata (plano "libera tudo") — acha o(s) plano(s)
  // que já liberam TODO o resto do catálogo, a marca inequívoca de "era o plano completo, só
  // faltou um módulo que não existia ainda".
  function desbloquearModuloNosPlanosCompletos(chaveModulo) {
    const outrosModulos = CHAVES_MODULOS_CASCATA_PADRAO.filter((chave) => chave !== chaveModulo);
    for (const versao of data.versoes) {
      const jaLiberaTudoMenosEsse = Array.isArray(versao.modulos) && outrosModulos.every((chave) => versao.modulos.includes(chave));
      if (!jaLiberaTudoMenosEsse) continue;
      const proprios = Array.isArray(versao.modulos_proprios) ? versao.modulos_proprios : [];
      if (!proprios.includes(chaveModulo)) versao.modulos_proprios = [...proprios, chaveModulo];
    }
    recalcularModulosVersoes(data);
    propagarModuloParaEmpresas(chaveModulo);
  }
  // variante 2: módulo que entrou no CHÃO da cascata (plano de ordem mais baixa) — sobe sozinho
  // pra todo plano acima dele (recalcularModulosVersoes é cumulativo por ordem), então basta dar
  // o módulo ao plano de ordem mais baixa pra TODA empresa, em qualquer plano, ganhar.
  function desbloquearModuloNoChaoDaCascata(chaveModulo) {
    const maisBaixo = data.versoes.reduce((menor, v) => (!menor || (v.ordem || 0) < (menor.ordem || 0)) ? v : menor, null);
    if (maisBaixo) {
      const proprios = Array.isArray(maisBaixo.modulos_proprios) ? maisBaixo.modulos_proprios : [];
      if (!proprios.includes(chaveModulo)) maisBaixo.modulos_proprios = [...proprios, chaveModulo];
    }
    recalcularModulosVersoes(data);
    propagarModuloParaEmpresas(chaveModulo);
  }
  function propagarModuloParaEmpresas(chaveModulo) {
    for (const empresa of data.empresas) {
      const versao = data.versoes.find((v) => v.id === empresa.versao_id);
      if (versao && Array.isArray(versao.modulos) && versao.modulos.includes(chaveModulo)
        && Array.isArray(empresa.modulos_ativos) && !empresa.modulos_ativos.includes(chaveModulo)) {
        empresa.modulos_ativos = [...empresa.modulos_ativos, chaveModulo];
      }
    }
  }
  if (!data._migracaoFiliaisDesbloqueioEmpresasV1) {
    desbloquearModuloNosPlanosCompletos('filiais');
    data._migracaoFiliaisDesbloqueioEmpresasV1 = true;
  }
  if (!data._migracaoAtividadesDesbloqueioEmpresasV1) {
    desbloquearModuloNosPlanosCompletos('atividades');
    data._migracaoAtividadesDesbloqueioEmpresasV1 = true;
  }
  // pedido do usuário (empresa JBPA): "coloque [Registro de Atividades] no plano básico" — desce
  // a entrada do módulo pro chão da cascata, que sobe automaticamente pra todo plano acima
  // (inclusive onde a variante 1 acima já tinha colocado, sem conflito — idempotente).
  if (!data._migracaoAtividadesNoBasicoV1) {
    desbloquearModuloNoChaoDaCascata('atividades');
    data._migracaoAtividadesNoBasicoV1 = true;
  }
  // bancos anteriores ao empresa_id (preparação pra multi-tenant) ganham empresa_id 1 — hoje só
  // existe essa empresa mesmo, então todo registro já criado pertence a ela.
  for (const lista of [data.usuarios, data.clientes, data.equipamentos, data.agenda, data.visitas, data.registros, data.chamados, data.relatorios_manutencao, data.solicitacoes_rh, data.mensagens_internas, data.feriados, data.escala_folgas]) {
    for (const item of lista) {
      if (item.empresa_id === undefined) item.empresa_id = 1;
    }
  }
  // "chamados" virou o atendimento por chat (IA -> técnico), unificando o que antes era
  // conversas_whatsapp (histórico solto por telefone) com o antigo chamado (só criado quando a
  // IA escalava). Bancos antigos que ainda tenham chamados no formato de antes do chat ganham os
  // campos novos com valor neutro, pra não quebrar a leitura.
  for (const c of data.chamados) {
    if (!Array.isArray(c.mensagens)) c.mensagens = [];
    if (c.status === undefined) c.status = 'aguardando_tecnico';
    if (c.telefone_whatsapp === undefined) c.telefone_whatsapp = null;
    if (c.origem === undefined) c.origem = 'app';
    if (c.tecnico_id === undefined) c.tecnico_id = null;
    if (c.os_id === undefined) c.os_id = null;
    if (c.prioridade === undefined) c.prioridade = 'normal';
    if (c.resolvido_por === undefined) c.resolvido_por = null;
    if (c.resolvido_em === undefined) c.resolvido_em = null;
    if (c.assumido_em === undefined) c.assumido_em = null;
    if (c.lida_tecnico === undefined) c.lida_tecnico = true;
    if (c.lida_cliente === undefined) c.lida_cliente = true;
    // resumo (primeira mensagem do cliente) usado na fila/lista sem precisar buscar o histórico
    // de mensagens (que agora mora numa tabela à parte — ver migrarMensagensParaTabelas)
    if (c.primeira_mensagem_cliente === undefined) c.primeira_mensagem_cliente = '';
  }
  if (!data._seq.registros) data._seq.registros = 1;
  if (!data._seq.chamados) data._seq.chamados = 1;
  if (!data._seq.relatorios_manutencao) data._seq.relatorios_manutencao = 1;
  if (!data._seq.mensagens_internas) data._seq.mensagens_internas = 1;
  for (const u of data.usuarios) {
    if (!u.status) u.status = 'ativo';
    if (u.convite_token === undefined) u.convite_token = null;
    if (u.cargo === undefined) u.cargo = '';
    if (u.setor === undefined) u.setor = '';
    // presença do técnico pra fila de atendimento (round-robin) — online_desde marca quando
    // ele ficou online pela última vez, e decide a ordem da fila entre quem está online agora
    if (u.online === undefined) u.online = false;
    if (u.online_desde === undefined) u.online_desde = null;
    // unificação dos papéis "Técnico" (campo) e "Setor Reparo" (interno) num único papel
    // "suporte" — o que cada um pode acessar agora é decidido por acesso_total/menus, não mais
    // por papéis separados. acesso_total=true preserva o acesso completo que já tinham antes
    // dessa mudança, pro admin restringir depois se quiser.
    if (u.papel === 'tecnico' || u.papel === 'reparo') u.papel = 'suporte';
    if (u.acesso_total === undefined) u.acesso_total = true;
    if (!Array.isArray(u.menus)) u.menus = [];
    // departamento de um administrador (Suporte/Pós-venda) — vazio (null) é o administrador geral,
    // que continua vendo e cadastrando todo mundo (é sempre o caso de quem já existia antes dessa
    // separação por departamento existir).
    if (u.departamento === undefined) u.departamento = null;
    // Estoque deixou de ser um departamento de administrador (só sobrou como tipo de acesso comum,
    // sem administrador dedicado) — quem já tinha esse departamento vira administrador geral,
    // preservando o acesso completo que já tinha (o admin geral reatribui/restringe se quiser).
    if (u.papel === 'administrador' && u.departamento === 'estoque') u.departamento = null;
  }
  for (const c of data.clientes) {
    for (const campo of ['setor', 'endereco', 'numero', 'bairro', 'cep', 'cidade', 'estado', 'email']) {
      if (c[campo] === undefined) c[campo] = '';
    }
  }
  for (const a of data.agenda) {
    if (a.email === undefined) a.email = '';
    if (a.criado_em === undefined) a.criado_em = a.data_hora_inicio || new Date().toISOString();
    // categoria sempre foi derivada do tipo (treinamento online e atendimento do chat não têm
    // deslocamento até o cliente) — recalcula sempre, não só quando ausente, porque O.S. criadas
    // antes dessa regra existir ficaram gravadas com 'inloco' mesmo sendo treinamento online
    a.categoria = (a.tipo === 'treinamento_online' || a.tipo === 'atendimento') ? 'online' : 'inloco';
    for (const campo of ['garantia', 'garantia_obs']) {
      if (a[campo] === undefined) a[campo] = '';
    }
    // SLA (nível de prioridade) — vem da IA no chat (antes de escalar) ou preenchido manualmente
    // na abertura da O.S.; fica null até ser definido
    for (const campo of ['sla_nivel', 'sla_pontuacao', 'sla_horas_atendimento', 'sla_dias_manutencao', 'sla_dias_visita_tecnica']) {
      if (a[campo] === undefined) a[campo] = null;
    }
    if (a.lida_tecnico === undefined) a.lida_tecnico = false;
    if (a.deslocamento_iniciado_em === undefined) a.deslocamento_iniciado_em = null;
    if (a.chegada_confirmada_em === undefined) {
      // mesma lógica do confirmado_cliente_em: O.S. que já tinham relatório enviado (ou já
      // finalizadas) antes desse controle existir já passaram desse ponto na prática — só as
      // que ainda estão a caminho, sem relatório, passam a exigir o registro da chegada.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const jaAvancou = a.finalizada || visitaDoItem;
      a.chegada_confirmada_em = jaAvancou ? (a.deslocamento_iniciado_em || a.criado_em || new Date().toISOString()) : null;
    }
    if (a.confirmado_cliente_em === undefined) {
      // O.S. que já tinham avançado (deslocamento, relatório ou já finalizadas) antes desse
      // controle existir claramente já passaram do aceite do cliente na prática — não faz
      // sentido bloquear elas retroativamente; só as que ainda nem começaram esperam a
      // confirmação a partir de agora.
      const jaAvancou = a.finalizada || a.deslocamento_iniciado_em || data.visitas.some((v) => v.agenda_id === a.id);
      a.confirmado_cliente_em = jaAvancou ? (a.criado_em || new Date().toISOString()) : null;
    }
    if (a.feedback_cliente_em === undefined) {
      // mesma lógica: O.S. que já estavam aprovadas (ou finalizadas) antes desse controle
      // existir já passaram desse ponto na prática — só as aprovações novas, a partir de
      // agora, exigem o registro explícito do feedback antes de finalizar.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.feedback_cliente_em = jaAprovado ? (a.finalizado_em || (visitaDoItem && visitaDoItem.data_aprovacao) || new Date().toISOString()) : null;
    }
    if (a.retrabalho === undefined) a.retrabalho = false;
    if (a.retorno_pendente_tecnico === undefined) a.retorno_pendente_tecnico = false;
    if (a.retorno_confirmado_cliente_em === undefined) a.retorno_confirmado_cliente_em = null;
    if (a.retorno_deslocamento_iniciado_em === undefined) a.retorno_deslocamento_iniciado_em = null;
    if (a.retorno_chegada_confirmada_em === undefined) a.retorno_chegada_confirmada_em = null;
    if (a.viagem_volta_iniciada_em === undefined) a.viagem_volta_iniciada_em = null;
    if (a.viagem_volta_chegada_em === undefined) a.viagem_volta_chegada_em = null;
    if (a.viagem_volta_destino_agenda_id === undefined) a.viagem_volta_destino_agenda_id = null;
    if (a.orcamento_aprovado_em === undefined) {
      // se o relatório já aprovado tinha peças fornecidas, mas esse controle de orçamento
      // ainda não existia, considera que o orçamento já foi tratado por fora do sistema —
      // não bloqueia O.S. antigas que já passaram desse ponto na prática.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      const temPecas = visitaDoItem && visitaDoItem.laudo && Array.isArray(visitaDoItem.laudo.pecas) && visitaDoItem.laudo.pecas.length > 0;
      const jaAprovado = a.finalizada || (visitaDoItem && visitaDoItem.status_aprovacao === 'aprovado');
      a.orcamento_aprovado_em = (temPecas && jaAprovado) ? (a.feedback_cliente_em || a.criado_em || new Date().toISOString()) : null;
    }
    if (a.orcamento_reprovado_em === undefined) a.orcamento_reprovado_em = null;
    if (a.concluida_em === undefined) {
      // O.S. que já estavam com status "concluida" antes desse campo existir — usa o envio do
      // relatório (visita) como estimativa de quando isso aconteceu, pra entrar no corte de 24h
      // do lembrete de "Iniciar retorno" (ver verificarLembretesRecorrentes em server.js) em vez
      // de ficar sem referência nenhuma e notificar pra sempre.
      const visitaDoItem = data.visitas.find((v) => v.agenda_id === a.id);
      a.concluida_em = a.status === 'concluida' ? (visitaDoItem ? (visitaDoItem.atualizado_em || visitaDoItem.criado_em) : a.criado_em) || new Date().toISOString() : null;
    }
    // fluxo de pós-venda/reparo (só usado em O.S. tipo "atendimento", nascidas de um chamado do
    // chat) — ver server.js, seção "pós-venda / setor reparo"
    if (a.fase_atendimento === undefined) a.fase_atendimento = null;
    if (a.motivo_pos_venda === undefined) a.motivo_pos_venda = null;
    if (a.encaminhado_pos_venda_em === undefined) a.encaminhado_pos_venda_em = null;
    if (a.equipamento_recebido_em === undefined) a.equipamento_recebido_em = null;
    if (a.pos_venda_orcamento_enviado_em === undefined) a.pos_venda_orcamento_enviado_em = null;
    if (a.pos_venda_decisao === undefined) a.pos_venda_decisao = null;
    if (a.pos_venda_decisao_em === undefined) a.pos_venda_decisao_em = null;
    if (a.tecnico_chat_id === undefined) a.tecnico_chat_id = null;
    // estoque (chegada/saída) e handoff pra O.S. de visita técnica — ver server.js
    if (a.estoque_recebido_em === undefined) a.estoque_recebido_em = null;
    if (a.equipamento_liberado_reparo_em === undefined) a.equipamento_liberado_reparo_em = null;
    if (a.estoque_saida_em === undefined) a.estoque_saida_em = null;
    if (a.os_criada_id === undefined) a.os_criada_id = null;
    // O.S. de atendimento criadas antes desse fluxo existir (fase_atendimento nunca foi
    // preenchida) entram agora em "em_atendimento" — do jeito que já estavam, só passam a
    // seguir a linha do tempo nova a partir daqui em vez da antiga (deslocamento/orçamento)
    if (a.tipo === 'atendimento' && !a.finalizada && !a.fase_atendimento) {
      a.fase_atendimento = 'em_atendimento';
      if (!a.tecnico_chat_id) a.tecnico_chat_id = a.tecnico_id;
    }
    // bônus de viagem (R$200/diária) — o administrador marca na O.S. quando ela dá direito ao
    // bônus (nem toda região paga) e informa o dia de início do deslocamento e o dia previsto de
    // retorno; conta 1 diária por dia corrido entre os dois, contra o limite de 7 diárias por
    // técnico/mês (ver diasBonusViagem/contarDiariasBonusMes em server.js). O.S. antigas que já
    // tinham bonus_viagem marcado (de quando era só 1 bônus fixo por O.S., sem diária) ganham
    // início = fim = o dia do atendimento, preservando o valor de 1 diária que já valiam.
    if (a.bonus_viagem === undefined) a.bonus_viagem = false;
    if (a.viagem_dia_inicio === undefined) a.viagem_dia_inicio = a.bonus_viagem ? String(a.data_hora_inicio || '').slice(0, 10) : '';
    if (a.viagem_dia_fim_previsto === undefined) a.viagem_dia_fim_previsto = a.bonus_viagem ? String(a.data_hora_inicio || '').slice(0, 10) : '';
    if (a.justificativa_limite_viagens === undefined) a.justificativa_limite_viagens = '';
    // marca se essa viagem foi escolhida fora da ordem do rodízio (ver motivoExigeJustificativaViagem
    // em server.js) — O.S. antigas, de antes desse controle existir, não têm como saber, então
    // entram como false (não conta pro selo do painel de acompanhamento).
    if (a.fora_de_ordem_viagem === undefined) a.fora_de_ordem_viagem = false;
    // conflito com a escala de folga (DSR ou compensação de banco de horas do técnico no dia da
    // O.S. — férias bloqueia direto, não chega a salvar) — ver conflitoEscalaTecnico em server.js
    if (a.escala_conflito_tipo === undefined) a.escala_conflito_tipo = null;
    if (a.justificativa_escala_conflito === undefined) a.justificativa_escala_conflito = '';
  }
  for (const e of data.equipamentos) {
    if (e.cliente_id === undefined) e.cliente_id = null;
    if (e.data_fabricacao === undefined) e.data_fabricacao = '';
    // contrato de manutenção preventiva (RCM/SAP PM, Fase 1, passo 10/11) — só faz sentido numa
    // unidade atrelada a um cliente. Tri-estado: null = ainda não informado por ninguém, true/false
    // = já definido (trava — ver aplicarContratoDoValor em server.js). Pode ser preenchido em 3
    // lugares (Atrelar/Editar equipamento, abertura da O.S., pergunta "plano_preventiva_ativo" do
    // questionário de SLA) — quem preenche primeiro trava os outros dois; só o Atrelar/Editar
    // equipamento (admin) pode mudar depois de travado.
    if (e.tem_contrato_manutencao === undefined) e.tem_contrato_manutencao = null;
  }
  // passo 11: equipamentos migrados pelo passo 10 ganharam tem_contrato_manutencao = false por
  // padrão, sem que ninguém tivesse de fato confirmado isso — com a trava nova, esse "false" não
  // confirmado passaria a bloquear pra sempre as 3 telas achando que já está definido. Converte
  // esses de volta pra "não informado" (null) uma única vez (flag abaixo evita repetir isso em
  // todo boot, o que destruiria uma escolha real de "sem contrato" feita depois deste ponto).
  if (!data._migracaoContratoNaoInformadoV1) {
    for (const e of data.equipamentos) {
      if (e.tem_contrato_manutencao === false) e.tem_contrato_manutencao = null;
    }
    data._migracaoContratoNaoInformadoV1 = true;
  }
  // catalogo_id (RCM/FMEA Fase 1, passo 2): liga cada unidade atrelada (cliente_id preenchido) de
  // volta ao item do catálogo (cliente_id null) de onde ela nasceu — hoje esse vínculo só existe
  // por texto solto (tipo+modelo repetidos, sem referência nenhuma), o que deixa o FMEA "por
  // modelo de equipamento" frágil (um nome digitado diferente quebra o casamento). Unidades
  // atreladas a partir de agora (ver POST /api/equipamentos/:id/atrelar) já nascem com o id certo,
  // carimbado direto; as que já existiam antes desse campo existir ganham aqui um casamento de
  // melhor esforço por tipo+modelo (case-insensitive, pega o primeiro catálogo que bater — se
  // houver mais de um catálogo com o mesmo tipo+modelo, tanto faz qual, são o mesmo modelo pro
  // FMEA) — quando não acha nenhum (nome diferente ou catálogo já apagado), fica null, sem travar
  // nada: o FMEA só não encontra os componentes daquela unidade específica até o administrador
  // recadastrar.
  for (const e of data.equipamentos) {
    if (e.catalogo_id !== undefined) continue;
    if (e.cliente_id === null) { e.catalogo_id = null; continue; }
    const catalogo = data.equipamentos.find((c) => c.empresa_id === e.empresa_id && c.cliente_id === null
      && String(c.tipo || '').trim().toLowerCase() === String(e.tipo || '').trim().toLowerCase()
      && String(c.modelo || '').trim().toLowerCase() === String(e.modelo || '').trim().toLowerCase());
    e.catalogo_id = catalogo ? catalogo.id : null;
  }
  for (const v of data.visitas) {
    if (v.lida_tecnico === undefined) v.lida_tecnico = false;
    if (v.rodada === undefined) v.rodada = 1;
  }
  // relatórios de manutenção criados antes do e-mail do técnico ser buscado corretamente
  // ficaram com esse campo em branco — preenche retroativamente a partir do cadastro atual
  for (const r of data.relatorios_manutencao) {
    if (!r.tecnico_email) {
      const autor = data.usuarios.find((u) => u.id === r.autor_id);
      if (autor && autor.email) r.tecnico_email = autor.email;
    }
    // relatórios criados antes da "ficha de equipamento" (leitura automática de etiqueta) existir
    // são todos do tipo "completo" (o formulário manual de sempre).
    if (!r.tipo) r.tipo = 'completo';
    if (!Array.isArray(r.campos)) r.campos = [];
    if (r.mtbf_encontrado === undefined) r.mtbf_encontrado = '';
    if (r.resultado_ensaio === undefined) r.resultado_ensaio = '';
    if (!Array.isArray(r.ciclos)) r.ciclos = [];
    if (r.conclusao_ensaio === undefined) r.conclusao_ensaio = '';
    if (r.tecnico_cargo === undefined) r.tecnico_cargo = '';
    if (r.tecnico_setor === undefined) r.tecnico_setor = '';
  }
  // backfill: relatórios criados antes do cruzamento automático com Clientes/Equipamentos existir
  // (ver sincronizarClienteDoRelatorio em server.js) passam por aqui uma vez, na ordem em que
  // foram criados, pra alimentar a lista com o que já tinha sido reportado em campo e ficou de
  // fora até agora. Mesma regra de sempre — idempotente, roda de novo a cada boot sem duplicar:
  // nome de empresa repetido (mesmo em caixa diferente) não cria outro cliente, só completa o que
  // estava vazio; nº de série repetido não duplica o equipamento.
  const relatoriosOrdenados = [...data.relatorios_manutencao].sort((a, b) => (a.criado_em || '').localeCompare(b.criado_em || ''));
  for (const r of relatoriosOrdenados) {
    const nomeEmpresa = String(r.empresa || '').trim();
    if (!nomeEmpresa) continue;
    const empresaId = r.empresa_id;
    const clientesDaEmpresa = data.clientes.filter((c) => c.empresa_id === empresaId);
    let cliente = clientesDaEmpresa.find((c) => String(c.nome_empresa || '').trim().toLowerCase() === nomeEmpresa.toLowerCase());
    if (cliente) {
      const preencheSeVazio = (campo, valor) => { if (!cliente[campo] && valor) cliente[campo] = valor; };
      preencheSeVazio('contato', r.contato);
      preencheSeVazio('telefone', r.telefone);
      preencheSeVazio('endereco', r.endereco);
      preencheSeVazio('numero', r.numero);
      preencheSeVazio('bairro', r.bairro);
      preencheSeVazio('cep', r.cep);
      preencheSeVazio('cidade', r.cidade);
      preencheSeVazio('estado', r.estado);
    } else {
      cliente = {
        id: nextId(data, 'clientes'), empresa_id: empresaId,
        nome_empresa: nomeEmpresa,
        contato: r.contato || '', telefone: r.telefone || '', email: '',
        nivel_acesso: 'completo', setor: '',
        endereco: r.endereco || '', numero: r.numero || '', bairro: r.bairro || '',
        cep: r.cep || '', cidade: r.cidade || '', estado: r.estado || '',
      };
      data.clientes.push(cliente);
    }

    const numeroSerie = String(r.numero_serie || '').trim();
    if (!numeroSerie) continue;
    const equipamentosDaEmpresa = data.equipamentos.filter((e) => e.empresa_id === empresaId);
    const existente = equipamentosDaEmpresa.find((e) => String(e.numero_serie || '').trim().toLowerCase() === numeroSerie.toLowerCase());
    if (!existente) {
      const descricao = String(r.modelo_maquina || r.equipamento || r.equipamento_demonstrado || '').trim();
      data.equipamentos.push({
        id: nextId(data, 'equipamentos'), empresa_id: empresaId,
        cliente_id: cliente.id,
        tipo: descricao || 'Equipamento',
        modelo: String(r.marca || '').trim(),
        numero_serie: numeroSerie,
        data_fabricacao: r.data_fabricacao || '',
        localizacao: '',
      });
    } else if (existente.cliente_id === null) {
      existente.cliente_id = cliente.id;
    }
  }
  // ficha cadastral (menu Equipe > Cadastros): foto de perfil opcional — sem ela, o front mostra
  // uma silhueta padrão, então aqui só garante que o campo exista (string vazia) em vez de undefined.
  data.usuarios.forEach((u) => { if (u.foto_perfil === undefined) u.foto_perfil = ''; });
  // menu Agendamentos (pedido do usuário: "como conectar minha agenda do outlook, quero criar um
  // menu agendamentos, e puxar tudo que tem na agenda do outlook") — cada técnico/administrador
  // conecta a própria conta Microsoft (OAuth2, ver outlook.js); só guarda o refresh_token (nunca o
  // access_token, de vida curta) e o e-mail conectado, pra mostrar "conectado como fulano@...".
  data.usuarios.forEach((u) => {
    if (u.outlook_conectado === undefined) u.outlook_conectado = false;
    if (u.outlook_email === undefined) u.outlook_email = null;
    if (u.outlook_refresh_token === undefined) u.outlook_refresh_token = null;
  });
  // pedido do usuário: "a conta do e-mail já é logada no notebook, não tenho a senha... fiz um
  // e-mail em cópia... pode usar o e-mail em cópia" — alternativa ao login Microsoft acima pra
  // quem não tem a senha da própria conta: conecta (usuário+senha comuns, via IMAP) numa caixa
  // diferente que já recebe cópia dos convites (ver agenda-email.js). A senha de app fica
  // cifrada (auth.cifrar), nunca em texto puro no banco.
  data.usuarios.forEach((u) => {
    if (u.agenda_email_conectado === undefined) u.agenda_email_conectado = false;
    if (u.agenda_email_endereco === undefined) u.agenda_email_endereco = null;
    if (u.agenda_email_senha_cifrada === undefined) u.agenda_email_senha_cifrada = null;
    if (u.agenda_email_host === undefined) u.agenda_email_host = null;
    if (u.agenda_email_porta === undefined) u.agenda_email_porta = null;
  });
  // ficha cadastral ampliada: certificados (arquivo + validade), integrações com empresas-cliente
  // (acesso/credencial pra atuar nelas, com validade) e competências (nível de conhecimento num
  // tipo de equipamento) — cada uma é uma coleção própria, um registro por item, presa ao técnico
  // dono (usuario_id) e à empresa (empresa_id, como tudo mais no sistema).
  if (!data.certificados_colaborador) data.certificados_colaborador = [];
  if (!data._seq.certificados_colaborador) data._seq.certificados_colaborador = 1;
  if (!data.integracoes_colaborador) data.integracoes_colaborador = [];
  if (!data._seq.integracoes_colaborador) data._seq.integracoes_colaborador = 1;
  if (!data.competencias_colaborador) data.competencias_colaborador = [];
  if (!data._seq.competencias_colaborador) data._seq.competencias_colaborador = 1;
  // versão "Restaurantes"/rede multiunidade (Fase 1 — Base, pedido do usuário) — hierarquia nova
  // setores/filiais/áreas (ver seed()) e campos novos em equipamentos/usuários pra ela. Tudo
  // opcional/null por padrão: nenhuma empresa que não usa o módulo "filiais" é afetada.
  if (!Array.isArray(data.setores)) data.setores = [];
  if (!Array.isArray(data.filiais)) data.filiais = [];
  if (!Array.isArray(data.areas)) data.areas = [];
  if (!data._seq.setores) data._seq.setores = 1;
  if (!data._seq.filiais) data._seq.filiais = 1;
  if (!data._seq.areas) data._seq.areas = 1;
  // Fase 2 — Operação: vistoria e apoio entre setores (mesma ideia aditiva da Fase 1 acima).
  if (!Array.isArray(data.vistorias)) data.vistorias = [];
  if (!Array.isArray(data.vistoria_itens)) data.vistoria_itens = [];
  if (!Array.isArray(data.apoios)) data.apoios = [];
  if (!data._seq.vistorias) data._seq.vistorias = 1;
  if (!data._seq.vistoria_itens) data._seq.vistoria_itens = 1;
  if (!data._seq.apoios) data._seq.apoios = 1;
  // Fase 3 — Peças: catálogo compartilhado + solicitação de peça com cadeia de autorização.
  if (!Array.isArray(data.pecas_catalogo)) data.pecas_catalogo = [];
  if (!Array.isArray(data.solicitacoes_peca)) data.solicitacoes_peca = [];
  if (!data._seq.pecas_catalogo) data._seq.pecas_catalogo = 1;
  if (!data._seq.solicitacoes_peca) data._seq.solicitacoes_peca = 1;
  // Fase 4 — Compras: pedido em atacado, estoque central/por loja e transferências.
  if (!Array.isArray(data.pedidos_compra)) data.pedidos_compra = [];
  if (!Array.isArray(data.pedido_itens)) data.pedido_itens = [];
  if (!Array.isArray(data.estoque_central)) data.estoque_central = [];
  if (!Array.isArray(data.estoque_loja)) data.estoque_loja = [];
  if (!Array.isArray(data.transferencias)) data.transferencias = [];
  if (!data._seq.pedidos_compra) data._seq.pedidos_compra = 1;
  if (!data._seq.pedido_itens) data._seq.pedido_itens = 1;
  if (!data._seq.estoque_central) data._seq.estoque_central = 1;
  if (!data._seq.estoque_loja) data._seq.estoque_loja = 1;
  if (!data._seq.transferencias) data._seq.transferencias = 1;
  // Fase 5 — Gestão e comunicação: mural de avisos e chat por canal.
  if (!Array.isArray(data.avisos)) data.avisos = [];
  if (!Array.isArray(data.mensagens_canal)) data.mensagens_canal = [];
  if (!data._seq.avisos) data._seq.avisos = 1;
  if (!data._seq.mensagens_canal) data._seq.mensagens_canal = 1;
  // pedido do usuário: rascunho de relatório/laudo técnico salvo só no localStorage do aparelho
  // não aparecia em outro dispositivo (ex.: começou no celular, quis continuar no PC) — este
  // "espelho" no servidor, um por usuário+chave (a mesma chave que já identifica o rascunho no
  // localStorage, ver chaveRascunho*/chaveRascunhoManual em app.js), deixa qualquer rascunho
  // recuperável de qualquer aparelho logado com o mesmo usuário. O localStorage continua sendo a
  // fonte instantânea (zero espera, funciona offline); o servidor só entra pra sincronizar entre
  // aparelhos (ver sincronizarRascunhoServidor em app.js).
  if (!Array.isArray(data.rascunhos)) data.rascunhos = [];
  if (!data._seq.rascunhos) data._seq.rascunhos = 1;
  // pedido do usuário (empresa JBPA): registro de atividades diárias pra cliente com contrato
  // mensal — data + descrição do serviço + valor, pra depois gerar um PDF mostrando o que foi
  // entregue no período (ver POST/GET /api/atividades-diarias em server.js).
  if (!Array.isArray(data.atividades_diarias)) data.atividades_diarias = [];
  if (!data._seq.atividades_diarias) data._seq.atividades_diarias = 1;
  // pedido do usuário: Ordens de Serviço do perfil "Refrigeração e Climatização" — menu do zero,
  // com cadastro de clientes próprio (ver comentário acima em os_refrigeracao_clientes).
  if (!Array.isArray(data.os_refrigeracao_clientes)) data.os_refrigeracao_clientes = [];
  if (!data._seq.os_refrigeracao_clientes) data._seq.os_refrigeracao_clientes = 1;
  if (!Array.isArray(data.os_refrigeracao)) data.os_refrigeracao = [];
  if (!data._seq.os_refrigeracao) data._seq.os_refrigeracao = 1;
  // pedido do usuário: status da O.S. (Concluída/Pendente/Cancelada, ver menu "⋮" no detalhe —
  // PUT /api/os-refrigeracao/:id/status em server.js) — toda O.S. já nascia "Concluída" até aqui
  // (implícito, sem campo), então o backfill é só pra não deixar undefined numa O.S. criada antes
  // deste campo existir.
  for (const o of data.os_refrigeracao) { if (o.status === undefined) o.status = 'concluida'; }
  // Orçamentos do mesmo perfil (atalho #3) — reaproveita os_refrigeracao_clientes, coleção
  // própria porque o status nasce "rascunho" (nunca "concluida" como a O.S.) e só vira "aprovado"
  // quando o CLIENTE assina pelo link público (ver PUT status e rota pública em server.js).
  if (!Array.isArray(data.os_refrigeracao_orcamentos)) data.os_refrigeracao_orcamentos = [];
  if (!data._seq.os_refrigeracao_orcamentos) data._seq.os_refrigeracao_orcamentos = 1;
  for (const o of data.os_refrigeracao_orcamentos) { if (o.status === undefined) o.status = 'rascunho'; }
  // Agenda do mesmo perfil (atalho #4) — config de disponibilidade por técnico + agendamentos.
  if (!Array.isArray(data.os_refrigeracao_agenda_config)) data.os_refrigeracao_agenda_config = [];
  if (!data._seq.os_refrigeracao_agenda_config) data._seq.os_refrigeracao_agenda_config = 1;
  if (!Array.isArray(data.os_refrigeracao_agendamentos)) data.os_refrigeracao_agendamentos = [];
  if (!data._seq.os_refrigeracao_agendamentos) data._seq.os_refrigeracao_agendamentos = 1;
  for (const a of data.os_refrigeracao_agendamentos) { if (a.status === undefined) a.status = 'agendado'; }
  // Pacote "Climatização / PMOC" (módulo `pmoc`, ver comentário acima em MODULOS_DISPONIVEIS) —
  // Fase 1 (Cadastro): local → ambiente → aparelho, mais o responsável técnico.
  if (!Array.isArray(data.os_refrigeracao_pmoc_locais)) data.os_refrigeracao_pmoc_locais = [];
  if (!data._seq.os_refrigeracao_pmoc_locais) data._seq.os_refrigeracao_pmoc_locais = 1;
  if (!Array.isArray(data.os_refrigeracao_pmoc_ambientes)) data.os_refrigeracao_pmoc_ambientes = [];
  if (!data._seq.os_refrigeracao_pmoc_ambientes) data._seq.os_refrigeracao_pmoc_ambientes = 1;
  if (!Array.isArray(data.os_refrigeracao_pmoc_aparelhos)) data.os_refrigeracao_pmoc_aparelhos = [];
  if (!data._seq.os_refrigeracao_pmoc_aparelhos) data._seq.os_refrigeracao_pmoc_aparelhos = 1;
  if (!Array.isArray(data.os_refrigeracao_pmoc_responsaveis_tecnicos)) data.os_refrigeracao_pmoc_responsaveis_tecnicos = [];
  if (!data._seq.os_refrigeracao_pmoc_responsaveis_tecnicos) data._seq.os_refrigeracao_pmoc_responsaveis_tecnicos = 1;
  // Fase 2 (Plano e preventivas) — Modelo de Checklist (por empresa) e Plano PMOC (por local).
  // Fase 4 (Documento PMOC e portal) — portal do cliente final: paralelo ao `cliente_id` núcleo,
  // um usuário papel "cliente" pode apontar pra um registro de os_refrigeracao_clientes (perfil
  // Refrigeração) em vez de `clientes` — ver POST /api/login e rotas /api/pmoc/portal/* em server.js.
  for (const u of data.usuarios) { if (u.os_refrigeracao_cliente_id === undefined) u.os_refrigeracao_cliente_id = null; }
  if (!Array.isArray(data.os_refrigeracao_pmoc_modelo_checklist)) data.os_refrigeracao_pmoc_modelo_checklist = [];
  if (!data._seq.os_refrigeracao_pmoc_modelo_checklist) data._seq.os_refrigeracao_pmoc_modelo_checklist = 1;
  if (!Array.isArray(data.os_refrigeracao_pmoc_planos)) data.os_refrigeracao_pmoc_planos = [];
  if (!data._seq.os_refrigeracao_pmoc_planos) data._seq.os_refrigeracao_pmoc_planos = 1;
  if (!Array.isArray(data.os_refrigeracao_pmoc_qualidade_ar)) data.os_refrigeracao_pmoc_qualidade_ar = [];
  if (!data._seq.os_refrigeracao_pmoc_qualidade_ar) data._seq.os_refrigeracao_pmoc_qualidade_ar = 1;
  // valor do contrato mensal do cliente — opcional, só usado como referência no PDF de atividades
  // acima (o técnico/administrador compara o que foi entregue no período com esse valor).
  for (const c of data.clientes) { if (c.valor_contrato_mensal === undefined) c.valor_contrato_mensal = null; }
  // pedido do usuário (referência: app concorrente iClima) — onboarding do administrador do
  // perfil "Refrigeração e Climatização" (especialidades, anos de experiência, foto de perfil,
  // termos de uso — ver POST /api/me/onboarding-refrigeracao em server.js). `termos_aceitos_em`
  // null/ausente = onboarding pendente (ver onboardingRefrigeracaoPendente em app.js, roda de novo
  // a cada login até ser preenchido). PRECISA ser com flag (só roda uma vez) — um backfill sem
  // flag rodaria de novo em TODO load() futuro, inclusive pra usuário novo criado depois (cujo
  // termos_aceitos_em nasce ausente de propósito, pra ficar pendente) — marcaria ele como "já
  // concluído" sozinho antes de ele nunca ter visto o assistente. Com flag, só quem já existia no
  // momento desta migração (nunca deve ver o assistente aparecer do nada) é marcado como concluído.
  if (!data._migracaoOnboardingRefrigeracaoV1) {
    for (const u of data.usuarios) {
      if (u.especialidades === undefined) u.especialidades = [];
      if (u.anos_experiencia === undefined) u.anos_experiencia = null;
      if (u.termos_aceitos_em === undefined) u.termos_aceitos_em = u.criado_em || new Date().toISOString();
    }
    data._migracaoOnboardingRefrigeracaoV1 = true;
  }
  if (!data._migracaoFiliaisV1) {
    for (const e of data.equipamentos) {
      if (e.filial_id === undefined) e.filial_id = null;
      if (e.area_id === undefined) e.area_id = null;
      if (e.qr_token === undefined) e.qr_token = null;
      if (e.codigo_interno === undefined) e.codigo_interno = null;
      if (e.status_operacional === undefined) e.status_operacional = 'operando';
      if (e.garantia_ate === undefined) e.garantia_ate = null;
      if (e.fornecedor_assistencia === undefined) e.fornecedor_assistencia = null;
    }
    for (const u of data.usuarios) {
      if (u.filial_id === undefined) u.filial_id = null;
      if (u.setor_id === undefined) u.setor_id = null;
    }
    data._migracaoFiliaisV1 = true;
  }
  protegerAdminMaster(data);
  return data;
}

// ---------- modo arquivo (padrão, sem DATABASE_URL) ----------

function carregarDoArquivo() {
  if (!fs.existsSync(DB_PATH)) {
    const data = seed();
    bootstrapAdminMaster(data);
    bootstrapSuperAdmin(data);
    sincronizarEmpresaPadrao(data);
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return data;
  }
  const bruto = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // no modo arquivo, carregarDoArquivo() roda de novo em TODO load() (não guarda cache em
  // memória como o modo Postgres) — então uma migração que converte um valor existente (não só
  // completa campo ausente) só pode ficar de pé se for gravada no disco já nessa primeira vez;
  // senão a próxima leitura parte do arquivo original de novo e desfaz uma escolha real feita
  // depois (ver _migracaoContratoNaoInformadoV1 em migrar()).
  const tinhaFlagContrato = !!bruto._migracaoContratoNaoInformadoV1;
  const tinhaFlagPlanosPadrao = !!bruto._migracaoPlanosPadraoV1;
  const tinhaFlagPlanosPadraoV2 = !!bruto._migracaoPlanosPadraoV2;
  const tinhaFlagPlanosPadraoV3 = !!bruto._migracaoPlanosPadraoV3;
  const tinhaFlagSplitOsChamados = !!bruto._migracaoSplitOsChamadosV1;
  const data = migrar(bruto);
  const criouAlguem = bootstrapAdminMaster(data) | bootstrapSuperAdmin(data);
  if (
    criouAlguem
    || (!tinhaFlagContrato && data._migracaoContratoNaoInformadoV1)
    || (!tinhaFlagPlanosPadrao && data._migracaoPlanosPadraoV1)
    || (!tinhaFlagPlanosPadraoV2 && data._migracaoPlanosPadraoV2)
    || (!tinhaFlagPlanosPadraoV3 && data._migracaoPlanosPadraoV3)
    || (!tinhaFlagSplitOsChamados && data._migracaoSplitOsChamadosV1)
  ) salvarNoArquivo(data);
  return data;
}

function salvarNoArquivo(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------- modo Postgres (opcional, via DATABASE_URL) ----------
// Guarda tudo como um único registro JSONB — mantém load()/save() síncronos com um cache em
// memória (populado uma vez no boot), pra não precisar tornar todo o server.js assíncrono.

let pool = null;
function obterPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  }
  return pool;
}

let cache = null;

// ---------- Etapa 4 (briefing white label) — tabelas indexadas por empresa, fase 1 ----------
// Fase "segura": cria as tabelas (vazias) e deixa prontas pra receber os dados via script de
// migração (scripts/migrar-para-tabelas.js) — o app continua lendo/escrevendo pelo blob JSONB
// de sempre (app_state), sem nenhuma mudança de comportamento. Nada aqui é lido pelo resto do
// sistema ainda; é só a fundação. O corte de verdade (tenant.js passar a consultar essas tabelas
// em vez do array em memória) é um trabalho grande à parte — torna as consultas assíncronas,
// o que mexe em centenas de pontos de server.js — e fica pra uma etapa futura, feita aos poucos.
//
// Cada linha guarda o registro inteiro em `dados` (JSONB) — mais simples e resistente a ficar
// desatualizado que replicar campo por campo numa coluna própria, já que o schema de cada
// coleção ainda muda com frequência do lado do db.js/server.js. `empresa_id` (e, pra agenda,
// também técnico/data) viram colunas de verdade, indexadas — é isso que dá a consulta rápida por
// empresa (e por empresa+técnico+data na agenda) que o diagnóstico apontou como faltando, e é
// o que permite ligar Row Level Security depois (cada empresa só enxerga suas próprias linhas no
// nível do próprio banco — hoje impossível, porque tudo mora numa linha JSONB só).
// 'agenda' entra na lista por completude (pro script de migração saber que ela também tem tabela
// própria), mas é criada à parte logo abaixo, com as colunas extras de técnico/data.
const COLECOES_EM_TABELA = ['usuarios', 'clientes', 'equipamentos', 'agenda', 'visitas', 'relatorios_manutencao', 'chamados', 'registros'];
const COLECOES_SEM_COLUNAS_EXTRAS = COLECOES_EM_TABELA.filter((c) => c !== 'agenda');

async function inicializarTabelasMultiempresa(p) {
  for (const colecao of COLECOES_SEM_COLUNAS_EXTRAS) {
    await p.query(`CREATE TABLE IF NOT EXISTS t_${colecao} (
      id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, dados JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_t_${colecao}_empresa ON t_${colecao} (empresa_id)`);
  }
  // agenda: além de empresa_id, técnico + data — é a combinação mais consultada do sistema
  // (agenda do técnico, calendário geral do mês)
  await p.query(`CREATE TABLE IF NOT EXISTS t_agenda (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, tecnico_id INTEGER, data_hora_inicio TEXT,
    dados JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_agenda_empresa_tecnico_data ON t_agenda (empresa_id, tecnico_id, data_hora_inicio)');
  // busca de texto na biblioteca técnica (registros) e nos relatórios — gerada automaticamente a
  // partir do próprio JSON (mais simples que listar campo por campo e manter isso sincronizado
  // manualmente; o tokenizador do Postgres já ignora a pontuação/estrutura do JSON sozinho)
  await p.query(`ALTER TABLE t_registros ADD COLUMN IF NOT EXISTS busca_texto TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('portuguese', dados::text)) STORED`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_registros_busca ON t_registros USING GIN (busca_texto)');
  await p.query(`ALTER TABLE t_relatorios_manutencao ADD COLUMN IF NOT EXISTS busca_texto TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('portuguese', dados::text)) STORED`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_t_relatorios_manutencao_busca ON t_relatorios_manutencao USING GIN (busca_texto)');
}

async function inicializarPostgres() {
  const p = obterPool();
  await p.query('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL)');
  await p.query('CREATE TABLE IF NOT EXISTS fotos (id TEXT PRIMARY KEY, dados TEXT NOT NULL, criado_em TIMESTAMPTZ DEFAULT now())');
  // empresa_id nullable de propósito: fotos já existentes antes desse campo existir ficam com
  // null (continuam abrindo normalmente — carregarFoto não usa esse campo pra nada ainda, é só
  // fundação pra uma futura conta de espaço usado por empresa — ver Etapa 4/passo 5 do plano).
  await p.query('ALTER TABLE fotos ADD COLUMN IF NOT EXISTS empresa_id INTEGER');
  await p.query('CREATE INDEX IF NOT EXISTS idx_fotos_empresa ON fotos (empresa_id)');
  await p.query(`CREATE TABLE IF NOT EXISTS mensagens_chamado (
    id SERIAL PRIMARY KEY, chamado_id INTEGER NOT NULL, autor TEXT NOT NULL, texto TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_mensagens_chamado_chamado_id ON mensagens_chamado (chamado_id)');
  await p.query(`CREATE TABLE IF NOT EXISTS mensagens_internas_tbl (
    id SERIAL PRIMARY KEY, remetente_id INTEGER NOT NULL, destinatario_id INTEGER NOT NULL,
    texto TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), lida BOOLEAN NOT NULL DEFAULT false
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS idx_mensagens_internas_par ON mensagens_internas_tbl (remetente_id, destinatario_id)');
  await inicializarTabelasMultiempresa(p);
  const r = await p.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length === 0) {
    const data = seed();
    bootstrapAdminMaster(data);
    bootstrapSuperAdmin(data);
    sincronizarEmpresaPadrao(data);
    await p.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(data)]);
    cache = data;
  } else {
    const bruto = r.rows[0].data;
    // modo Postgres cacheia em memória depois desse boot (variável `cache` abaixo), então uma
    // migração que só roda UMA VEZ (flag) só fica de pé se for persistida já aqui — senão o
    // próximo restart do processo lê o registro antigo de novo do Postgres e repete a migração
    // (no caso dos planos automáticos abaixo, duplicando os planos a cada reinício).
    const tinhaFlagContrato = !!bruto._migracaoContratoNaoInformadoV1;
    const tinhaFlagPlanosPadrao = !!bruto._migracaoPlanosPadraoV1;
    const tinhaFlagPlanosPadraoV2 = !!bruto._migracaoPlanosPadraoV2;
    const tinhaFlagPlanosPadraoV3 = !!bruto._migracaoPlanosPadraoV3;
    const tinhaFlagSplitOsChamados = !!bruto._migracaoSplitOsChamadosV1;
    const data = migrar(bruto);
    const criouAlguem = bootstrapAdminMaster(data) | bootstrapSuperAdmin(data);
    if (
      criouAlguem
      || (!tinhaFlagContrato && data._migracaoContratoNaoInformadoV1)
      || (!tinhaFlagPlanosPadrao && data._migracaoPlanosPadraoV1)
      || (!tinhaFlagPlanosPadraoV2 && data._migracaoPlanosPadraoV2)
      || (!tinhaFlagPlanosPadraoV3 && data._migracaoPlanosPadraoV3)
      || (!tinhaFlagSplitOsChamados && data._migracaoSplitOsChamadosV1)
    ) {
      await p.query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)]);
    }
    cache = data;
  }
  console.log('Conectado ao Postgres — os dados persistem entre reinícios.');
}

// server.js aguarda essa promise antes de abrir a porta. No modo arquivo, resolve na hora.
// Se a conexão com o Postgres falhar, cai pro arquivo local em vez de derrubar o servidor.
const pronto = (usaPostgres
  ? inicializarPostgres().catch((e) => {
      console.error('Falha ao conectar no Postgres — usando o arquivo local como reserva:', e.message);
      cache = null;
    })
  : Promise.resolve()
).then(() => migrarMensagensSeNecessario());

function load() {
  if (usaPostgres && cache) return cache;
  return carregarDoArquivo();
}

function save(data) {
  if (usaPostgres && cache) {
    cache = data;
    obterPool()
      .query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)])
      .catch((e) => console.error('Erro ao salvar no Postgres:', e.message));
    return;
  }
  salvarNoArquivo(data);
}

function nextId(data, tabela) {
  const id = data._seq[tabela]++;
  return id;
}

function estaUsandoPostgres() {
  return usaPostgres && !!cache;
}

// ---------- fotos (guardadas à parte do bloco principal — antes ficavam dentro do mesmo JSON
// que fica sempre carregado na memória, e isso foi o que estourou o limite de RAM do plano
// gratuito do Render conforme foram se acumulando; agora só uma referência pequena fica no bloco
// principal, e a foto de verdade só é buscada quando alguém realmente precisa dela) ----------
//
// Com SUPABASE_URL + SUPABASE_SERVICE_KEY configuradas, fotos NOVAS vão pro Supabase Storage (um
// serviço de arquivo de verdade, fora do processo do servidor — sobrevive a redeploy, diferente do
// disco local do modo arquivo) em vez da tabela/pasta antiga. A referência vira a própria URL
// pública da foto (em vez de um id curto), então carregarFoto reconhece isso e devolve na hora, sem
// precisar buscar em lugar nenhum. Fotos antigas continuam exatamente onde estavam — nada migra
// sozinho (ver scripts/migrar-fotos-supabase.js pra mover as existentes quando quiser).
const FOTOS_DIR = path.join(__dirname, 'fotos');
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'fotos';

function supabaseStorageConfigurado() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

async function salvarFotoSupabase(dadosBase64) {
  const texto = dadosBase64.trim();
  // só o prefixo precisa bater com a regex (sem precisar alcançar o fim da string) — extrair o
  // base64 por posição do "," é mais resistente a essa string vir com espaço/quebra de linha
  // sobrando na ponta (ex.: uma foto antiga lida de um arquivo) do que tentar casar tudo de uma vez.
  const m = /^data:([^;]+);base64,/.exec(texto);
  const mime = m ? m[1] : 'application/octet-stream';
  const base64 = m ? texto.slice(m[0].length) : texto;
  const buffer = Buffer.from(base64, 'base64');
  const extensao = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg');
  const nome = `${crypto.randomBytes(12).toString('hex')}.${extensao}`;
  const resp = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${nome}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': mime },
    body: buffer,
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Supabase Storage respondeu ${resp.status}: ${detalhe}`);
  }
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${nome}`;
}

// lê uma foto do backend ANTIGO (Postgres ou disco local), ignorando o Supabase mesmo que esteja
// configurado — usado pelo script de migração, que precisa ler de onde a foto já está antes de
// subir pro Supabase; o carregarFoto "normal" abaixo não serve pra isso porque, com Supabase
// configurado, uma referência nova (URL) nunca chega até aqui.
async function carregarFotoAntiga(id) {
  if (!id) return null;
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT dados FROM fotos WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].dados : null;
  }
  const caminho = path.join(FOTOS_DIR, String(id));
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : null;
}

// empresaId é opcional (quem chama sem saber a empresa, ex. código antigo, continua funcionando
// igual) — quando informado, fica guardado junto da foto: na própria linha da tabela em modo
// Postgres, ou num arquivo `<id>.empresa` ao lado da foto em modo arquivo (nunca dentro do
// arquivo da foto em si, pra nunca arriscar corromper uma foto já existente). Só metadado, não é
// lido por carregarFoto nem em nenhum fluxo do dia a dia ainda — fundação pra uma futura conta de
// espaço usado por empresa (ver Etapa 4/passo 5 do plano).
async function salvarFoto(dadosBase64, empresaId) {
  if (supabaseStorageConfigurado()) return salvarFotoSupabase(dadosBase64);
  const id = crypto.randomBytes(12).toString('hex');
  if (estaUsandoPostgres()) {
    await obterPool().query('INSERT INTO fotos (id, dados, empresa_id) VALUES ($1, $2, $3)', [id, dadosBase64, empresaId || null]);
  } else {
    if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(FOTOS_DIR, id), dadosBase64);
    if (empresaId) fs.writeFileSync(path.join(FOTOS_DIR, `${id}.empresa`), String(empresaId));
  }
  return id;
}

// só pra teste/auditoria (ver salvarFoto) — não é usado em nenhuma rota ainda.
async function empresaIdDaFoto(id) {
  if (!id) return null;
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT empresa_id FROM fotos WHERE id = $1', [id]);
    return r.rows.length ? r.rows[0].empresa_id : null;
  }
  const caminho = path.join(FOTOS_DIR, `${id}.empresa`);
  return fs.existsSync(caminho) ? Number(fs.readFileSync(caminho, 'utf8')) : null;
}

async function carregarFoto(id) {
  if (!id) return null;
  // referência do Supabase Storage já é a própria URL pública — nada pra buscar
  if (typeof id === 'string' && /^https?:\/\//.test(id)) return id;
  return carregarFotoAntiga(id);
}

// ---------- mensagens de chat (atendimento por chamado + chat interno da equipe) — mesma ideia
// das fotos: antes ficavam embutidas dentro do bloco principal (chamados[].mensagens e o array
// mensagens_internas), e como são a parte que mais cresce e mais escreve (uma mensagem nova
// reescrevia o banco inteiro), agora moram à parte. Só uma migração automática (abaixo) move o
// que já existia de dado antigo pra cá, uma única vez.

const MENSAGENS_CHAMADO_PATH = path.join(__dirname, 'mensagens_chamado.json');
const MENSAGENS_INTERNAS_PATH = path.join(__dirname, 'mensagens_internas.json');

function carregarMensagensChamadoArquivo() {
  if (!fs.existsSync(MENSAGENS_CHAMADO_PATH)) return [];
  return JSON.parse(fs.readFileSync(MENSAGENS_CHAMADO_PATH, 'utf8'));
}
function salvarMensagensChamadoArquivo(lista) {
  fs.writeFileSync(MENSAGENS_CHAMADO_PATH, JSON.stringify(lista));
}
function carregarMensagensInternasArquivo() {
  if (!fs.existsSync(MENSAGENS_INTERNAS_PATH)) return [];
  return JSON.parse(fs.readFileSync(MENSAGENS_INTERNAS_PATH, 'utf8'));
}
function salvarMensagensInternasArquivo(lista) {
  fs.writeFileSync(MENSAGENS_INTERNAS_PATH, JSON.stringify(lista));
}

// o driver do Postgres devolve TIMESTAMPTZ como objeto Date — o resto do sistema sempre trabalha
// com string ISO (comparação, fmtData no front, etc.), então converte de volta na leitura.
function isoDe(valor) {
  return valor instanceof Date ? valor.toISOString() : valor;
}

async function salvarMensagemChamado(chamadoId, msg) {
  const autor = msg.autor;
  const texto = msg.texto;
  const criado_em = msg.criado_em || new Date().toISOString();
  if (estaUsandoPostgres()) {
    await obterPool().query('INSERT INTO mensagens_chamado (chamado_id, autor, texto, criado_em) VALUES ($1, $2, $3, $4)', [chamadoId, autor, texto, criado_em]);
  } else {
    const lista = carregarMensagensChamadoArquivo();
    lista.push({ chamado_id: chamadoId, autor, texto, criado_em });
    salvarMensagensChamadoArquivo(lista);
  }
  return { autor, texto, criado_em };
}

async function carregarMensagensChamado(chamadoId) {
  if (estaUsandoPostgres()) {
    const r = await obterPool().query('SELECT autor, texto, criado_em FROM mensagens_chamado WHERE chamado_id = $1 ORDER BY id ASC', [chamadoId]);
    return r.rows.map((row) => ({ autor: row.autor, texto: row.texto, criado_em: isoDe(row.criado_em) }));
  }
  return carregarMensagensChamadoArquivo()
    .filter((m) => m.chamado_id === chamadoId)
    .map((m) => ({ autor: m.autor, texto: m.texto, criado_em: m.criado_em }));
}

async function salvarMensagemInterna({ remetente_id, destinatario_id, texto }) {
  const criado_em = new Date().toISOString();
  if (estaUsandoPostgres()) {
    const r = await obterPool().query(
      'INSERT INTO mensagens_internas_tbl (remetente_id, destinatario_id, texto, criado_em, lida) VALUES ($1, $2, $3, $4, false) RETURNING id',
      [remetente_id, destinatario_id, texto, criado_em]
    );
    return { id: r.rows[0].id, remetente_id, destinatario_id, texto, criado_em, lida: false };
  }
  const lista = carregarMensagensInternasArquivo();
  const id = lista.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  const msg = { id, remetente_id, destinatario_id, texto, criado_em, lida: false };
  lista.push(msg);
  salvarMensagensInternasArquivo(lista);
  return msg;
}

async function carregarMensagensInternas(usuarioId, outroId) {
  if (estaUsandoPostgres()) {
    const r = await obterPool().query(
      `SELECT id, remetente_id, destinatario_id, texto, criado_em, lida FROM mensagens_internas_tbl
       WHERE (remetente_id = $1 AND destinatario_id = $2) OR (remetente_id = $2 AND destinatario_id = $1)
       ORDER BY id ASC`,
      [usuarioId, outroId]
    );
    return r.rows.map((row) => ({ ...row, criado_em: isoDe(row.criado_em) }));
  }
  return carregarMensagensInternasArquivo()
    .filter((m) => (m.remetente_id === usuarioId && m.destinatario_id === outroId) || (m.remetente_id === outroId && m.destinatario_id === usuarioId))
    .sort((a, b) => a.id - b.id);
}

async function marcarMensagensInternasLidas(usuarioId, outroId) {
  if (estaUsandoPostgres()) {
    await obterPool().query(
      'UPDATE mensagens_internas_tbl SET lida = true WHERE destinatario_id = $1 AND remetente_id = $2 AND lida = false',
      [usuarioId, outroId]
    );
    return;
  }
  const lista = carregarMensagensInternasArquivo();
  let mudou = false;
  for (const m of lista) {
    if (m.destinatario_id === usuarioId && m.remetente_id === outroId && !m.lida) { m.lida = true; mudou = true; }
  }
  if (mudou) salvarMensagensInternasArquivo(lista);
}

// resumo de uma conversa (última mensagem + não lidas) — usado pra montar a lista de contatos
// do chat interno sem carregar o histórico inteiro de todo mundo em memória a cada 15s.
async function resumoContatoInterno(usuarioId, outroId) {
  const conversa = await carregarMensagensInternas(usuarioId, outroId);
  if (!conversa.length) return { ultima_mensagem_texto: null, ultima_mensagem_em: null, ultima_mensagem_propria: false, nao_lidas: 0 };
  const ultima = conversa[conversa.length - 1];
  const nao_lidas = conversa.filter((m) => m.destinatario_id === usuarioId && m.remetente_id === outroId && !m.lida).length;
  return {
    ultima_mensagem_texto: ultima.texto,
    ultima_mensagem_em: ultima.criado_em,
    ultima_mensagem_propria: ultima.remetente_id === usuarioId,
    nao_lidas,
  };
}

// migração única (idempotente): move qualquer mensagem que ainda esteja embutida no bloco
// principal (banco de antes dessa mudança existir) pra cá, preservando texto/autor/data/lida
// originais. Depois da primeira vez os arrays ficam vazios, então não faz nada nas próximas.
async function migrarMensagensParaTabelas(data) {
  let mudou = false;
  for (const c of data.chamados) {
    if (Array.isArray(c.mensagens) && c.mensagens.length) {
      if (estaUsandoPostgres()) {
        for (const m of c.mensagens) {
          await obterPool().query('INSERT INTO mensagens_chamado (chamado_id, autor, texto, criado_em) VALUES ($1, $2, $3, $4)', [c.id, m.autor, m.texto, m.criado_em]);
        }
      } else {
        const lista = carregarMensagensChamadoArquivo();
        for (const m of c.mensagens) lista.push({ chamado_id: c.id, autor: m.autor, texto: m.texto, criado_em: m.criado_em });
        salvarMensagensChamadoArquivo(lista);
      }
      if (!c.primeira_mensagem_cliente) {
        const primeira = c.mensagens.find((m) => m.autor === 'cliente');
        c.primeira_mensagem_cliente = primeira ? primeira.texto : '';
      }
      c.mensagens = [];
      mudou = true;
    }
  }
  if (Array.isArray(data.mensagens_internas) && data.mensagens_internas.length) {
    if (estaUsandoPostgres()) {
      for (const m of data.mensagens_internas) {
        await obterPool().query(
          'INSERT INTO mensagens_internas_tbl (remetente_id, destinatario_id, texto, criado_em, lida) VALUES ($1, $2, $3, $4, $5)',
          [m.remetente_id, m.destinatario_id, m.texto, m.criado_em, !!m.lida]
        );
      }
    } else {
      const lista = carregarMensagensInternasArquivo();
      let proximoId = lista.reduce((max, m) => Math.max(max, m.id), 0);
      for (const m of data.mensagens_internas) {
        proximoId += 1;
        lista.push({ id: proximoId, remetente_id: m.remetente_id, destinatario_id: m.destinatario_id, texto: m.texto, criado_em: m.criado_em, lida: !!m.lida });
      }
      salvarMensagensInternasArquivo(lista);
    }
    data.mensagens_internas = [];
    mudou = true;
  }
  return mudou;
}

// roda uma vez no boot (via `pronto`, antes de qualquer rota aceitar requisição) — nunca faz
// parte do load()/save() de cada requisição, pra não tornar o caminho normal assíncrono.
async function migrarMensagensSeNecessario() {
  const data = usaPostgres && cache ? cache : carregarDoArquivo();
  const mudou = await migrarMensagensParaTabelas(data);
  if (mudou) save(data);
}

module.exports = {
  load, save, nextId, hashSenha, conferirSenha, gerarTokenConvite, DB_PATH, pronto, estaUsandoPostgres, salvarFoto, carregarFoto,
  supabaseStorageConfigurado, salvarFotoSupabase, carregarFotoAntiga, empresaIdDaFoto,
  salvarMensagemChamado, carregarMensagensChamado,
  salvarMensagemInterna, carregarMensagensInternas, marcarMensagensInternasLidas, resumoContatoInterno,
  MODULOS_DISPONIVEIS, CHAVES_MODULOS, CHAVES_MODULOS_CASCATA_PADRAO, moduloAtivo, migrar, recalcularModulosVersoes,
  PMOC_PERIODICIDADES, CHAVES_PMOC_PERIODICIDADES, PMOC_CHECKLIST_PADRAO,
  PERFIS_DISPONIVEIS, CHAVES_PERFIS, TIPOS_OS_DISPONIVEIS, TIPOS_RELATORIO_DISPONIVEIS, presetPerfilSegmento, PRESETS_PERFIL_SEGMENTO,
  gerarQrToken,
  obterPool, COLECOES_EM_TABELA,
};
