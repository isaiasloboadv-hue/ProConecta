const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

// formato de um data.json de antes do conceito de multiempresa/módulos existir: já tem as
// coleções normais (com dados de verdade, empresa_id 1 em tudo) mas nenhuma das coleções ou
// campos novos (versoes, empresa.modulos_ativos, empresa.terminologia).
function dadosAntigos() {
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1 },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Antigo', empresa_id: 1 }],
    equipamentos: [{ id: 1, nome: 'Equipamento X', empresa_id: 1 }],
    agenda: [{ id: 1, numero_os: 'OS-000001', tipo: 'corretiva', empresa_id: 1 }],
    visitas: [],
    // de antes do multiempresa: essas duas coleções não passavam pelo backfill de empresa_id
    // (só entraram nele quando a Etapa 4 achou o buraco) — sem isso, tenant.listar/buscar nunca
    // devolveria esses registros pra ninguém.
    solicitacoes_rh: [{ id: 1, tecnico_id: 1, tipo: 'folga', status: 'pendente' }],
    mensagens_internas: [{ remetente_id: 1, destinatario_id: 1, texto: 'oi' }],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 2, agenda: 2, visitas: 1, solicitacoes_rh: 2 },
    empresas: [
      {
        id: 1, nome: 'PRO Marking', site: 'promarking.com.br',
        whatsapp: '12 99718-7506', telefone: '12 3902-3453',
        emails: ['suporte@promarking.com.br'], cor_primaria: '#0A2647', cor_secundaria: '#0E7C86',
        // sem versao_id, modulos_ativos, terminologia — é exatamente o que faltava antes
      },
    ],
  };
}

test('migrar preserva todos os dados que já existiam', () => {
  const antes = dadosAntigos();
  const depois = db.migrar(dadosAntigos());
  assert.equal(depois.usuarios.length, antes.usuarios.length);
  assert.equal(depois.usuarios[0].email, 'admin@promarking.com.br');
  assert.equal(depois.clientes[0].nome_empresa, 'Cliente Antigo');
  assert.equal(depois.equipamentos[0].nome, 'Equipamento X');
  assert.equal(depois.agenda[0].numero_os, 'OS-000001');
  assert.equal(depois.empresas[0].nome, 'PRO Marking');
});

test('migrar cria a versão Intermediário (legado "Manutenção") pra quem não tinha versoes', () => {
  const data = db.migrar(dadosAntigos());
  assert.ok(Array.isArray(data.versoes));
  // pedido do usuário: "não é plano autônomo é plano básico. Intermediário. Profissional e
  // completo" — a versão que o sistema sempre ofereceu (id 1) acaba renomeada "Intermediário"
  // pela migração dos planos padrão (ver db.js, V3); o id continua 1, só o nome muda.
  const intermediario = data.versoes.find((v) => v.id === 1);
  assert.ok(intermediario);
  assert.equal(intermediario.nome, 'Intermediário');
  // "modulos" é o campo cumulativo (ver recalcularModulosVersoes) — Intermediário, de ordem 2,
  // herda comercial+relatorios do plano "Básico" (ordem 1) além do que ela mesma acrescenta.
  assert.deepEqual(intermediario.modulos.sort(), ['biblioteca', 'comercial', 'os_chamados', 'relatorios', 'smp_preventivas'].sort());
});

test('migrar dá empresa 1 os módulos da versão Intermediário (legado "Manutenção") ativos', () => {
  const data = db.migrar(dadosAntigos());
  const empresa = data.empresas.find((e) => e.id === 1);
  // empresa.modulos_ativos (diferente de versao.modulos) só ganha exatamente
  // MODULOS_VERSAO_MANUTENCAO na sincronização inicial — "relatorios"/"equipe_avancado" entram
  // depois, pela migração de divisão de os_chamados (ver teste dedicado mais abaixo), não por
  // esta sincronização.
  assert.deepEqual(empresa.modulos_ativos.sort(), ['biblioteca', 'equipe_avancado', 'os_chamados', 'relatorios', 'smp_preventivas'].sort());
  assert.equal(empresa.versao_id, 1);
  assert.deepEqual(empresa.terminologia, {});
});

test('migrar não sobrescreve modulos_ativos de empresa que já tinha sido migrada/customizada', () => {
  const data = dadosAntigos();
  data.empresas[0].versao_id = 1;
  data.empresas[0].modulos_ativos = ['os_chamados', 'comercial']; // admin já desativou/ativou módulos avulsos
  data.empresas[0].terminologia = { equipamento: 'Paciente' };
  const depois = db.migrar(data);
  // a sincronização em si não sobrescreve o array customizado (continua tendo exatamente
  // "os_chamados"+"comercial" como base) — o que muda é a extensão separada da divisão de
  // os_chamados, que dá relatorios/equipe_avancado a quem já tinha os_chamados (ver teste
  // dedicado "migrar dá relatorios e equipe_avancado..." mais abaixo); nada é removido.
  assert.deepEqual(depois.empresas[0].modulos_ativos.sort(), ['comercial', 'equipe_avancado', 'os_chamados', 'relatorios'].sort());
  assert.equal(depois.empresas[0].terminologia.equipamento, 'Paciente');
});

test('migrar é idempotente: rodar duas vezes não muda nada na segunda', () => {
  const uma = db.migrar(dadosAntigos());
  const duas = db.migrar(JSON.parse(JSON.stringify(uma)));
  assert.deepEqual(duas.versoes, uma.versoes);
  assert.deepEqual(duas.empresas[0].modulos_ativos, uma.empresas[0].modulos_ativos);
});

test('migrar backfilla empresa_id em coleções que ficaram de fora do multiempresa (solicitacoes_rh, mensagens_internas)', () => {
  const data = db.migrar(dadosAntigos());
  assert.equal(data.solicitacoes_rh[0].empresa_id, 1);
  assert.equal(data.mensagens_internas[0].empresa_id, 1);
});

test('migrar dá à empresa 1 perfil/segmento/tipos ativos "sem restrição nenhuma" (Etapa 8)', () => {
  const data = db.migrar(dadosAntigos());
  const empresa = data.empresas.find((e) => e.id === 1);
  assert.equal(empresa.perfil, null);
  assert.equal(empresa.segmento, null);
  assert.equal(empresa.tipos_os_ativos, null);
  assert.equal(empresa.tipos_relatorio_ativos, null);
  assert.equal(empresa.escala_ativa, true);
});

test('migrar não sobrescreve perfil/segmento/tipos ativos já customizados', () => {
  const data = dadosAntigos();
  data.empresas[0].perfil = 'autonomo';
  data.empresas[0].segmento = 'montagem_painel_eletrico';
  data.empresas[0].tipos_os_ativos = ['corretiva'];
  data.empresas[0].escala_ativa = false;
  const depois = db.migrar(data);
  assert.equal(depois.empresas[0].perfil, 'autonomo');
  assert.equal(depois.empresas[0].segmento, 'montagem_painel_eletrico');
  assert.deepEqual(depois.empresas[0].tipos_os_ativos, ['corretiva']);
  assert.equal(depois.empresas[0].escala_ativa, false);
});

test('depois de migrar, os módulos da empresa 1 ficam ativos de acordo com moduloAtivo', () => {
  const data = db.migrar(dadosAntigos());
  assert.equal(db.moduloAtivo(data, 1, 'os_chamados'), true);
  assert.equal(db.moduloAtivo(data, 1, 'smp_preventivas'), true);
  assert.equal(db.moduloAtivo(data, 1, 'biblioteca'), true);
  assert.equal(db.moduloAtivo(data, 1, 'comercial'), false);
  assert.equal(db.moduloAtivo(data, 1, 'financeiro'), false);
});

// pedido do usuário: "não é plano autônomo é plano básico. Intermediário. Profissional e
// completo" — a migração cria 4 categorias em cascata: "Básico" (comercial+relatórios, sem
// O.S.), "Intermediário" (+ O.S. completo), "Profissional" (+ equipe/escala, "quando a equipe
// aumenta") e "Completo" (+ financeiro/prestação de contas/agendamento/assistente IA — o resto
// do catálogo).
test('migrar cria automaticamente os 4 planos em cascata: Básico, Intermediário, Profissional, Completo', () => {
  const data = db.migrar(dadosAntigos());
  const nomes = data.versoes.map((v) => v.nome).sort();
  assert.deepEqual(nomes, ['Básico', 'Completo', 'Intermediário', 'Profissional'].sort());

  const basico = data.versoes.find((v) => v.nome === 'Básico');
  const intermediario = data.versoes.find((v) => v.nome === 'Intermediário');
  const profissional = data.versoes.find((v) => v.nome === 'Profissional');
  const completo = data.versoes.find((v) => v.nome === 'Completo');

  assert.ok(intermediario.ordem > basico.ordem);
  assert.ok(profissional.ordem > intermediario.ordem);
  assert.ok(completo.ordem > profissional.ordem);

  // "Básico" é o chão da cascata: só orçamento (comercial) + relatório, nada de O.S.
  assert.deepEqual([...basico.modulos].sort(), ['comercial', 'relatorios'].sort());
  assert.ok(!basico.modulos.includes('os_chamados'));

  // cascata: Intermediário acumula tudo do Básico + o que ele mesmo acrescenta (O.S. completo)
  for (const chave of basico.modulos) assert.ok(intermediario.modulos.includes(chave));
  assert.ok(intermediario.modulos.includes('os_chamados'));

  // Profissional acumula tudo do Intermediário + equipe/escala
  for (const chave of intermediario.modulos) assert.ok(profissional.modulos.includes(chave));
  assert.ok(profissional.modulos.includes('equipe_avancado'));

  // Completo libera o catálogo inteiro — "até o plano em que todas as funções é liberada"
  assert.deepEqual([...completo.modulos].sort(), [...db.CHAVES_MODULOS].sort());
});

test('migrar dos planos automáticos é idempotente: rodar de novo não duplica nem recria o que foi apagado', () => {
  const uma = db.migrar(dadosAntigos());
  assert.equal(uma.versoes.length, 4);
  const duas = db.migrar(JSON.parse(JSON.stringify(uma)));
  assert.equal(duas.versoes.length, 4);
  assert.deepEqual(duas.versoes, uma.versoes);

  // Super Admin apaga o "Básico" — rodar a migração de novo não deve recriá-lo (a flag impede,
  // senão apagar um plano automático seria impossível de verdade)
  const semBasico = JSON.parse(JSON.stringify(uma));
  semBasico.versoes = semBasico.versoes.filter((v) => v.nome !== 'Básico');
  const depoisDeApagar = db.migrar(semBasico);
  assert.equal(depoisDeApagar.versoes.find((v) => v.nome === 'Básico'), undefined);
  assert.equal(depoisDeApagar.versoes.length, 3);
});

// backward-compat crítico: quem já tinha "os_chamados" ativo (ex. PRO Marking, migrada do sistema
// antigo) não pode perder nenhuma função com a divisão desse módulo em 3 — "relatorios" e
// "equipe_avancado" têm que vir ligados automaticamente pra quem já tinha "os_chamados".
test('migrar dá relatorios e equipe_avancado a quem já tinha os_chamados ativo (não perde nada na divisão)', () => {
  const data = db.migrar(dadosAntigos());
  const empresa = data.empresas.find((e) => e.id === 1);
  assert.ok(empresa.modulos_ativos.includes('os_chamados'));
  assert.ok(empresa.modulos_ativos.includes('relatorios'));
  assert.ok(empresa.modulos_ativos.includes('equipe_avancado'));
});

test('migrar da divisão de os_chamados é idempotente e não dá os módulos novos a quem nunca teve os_chamados', () => {
  const uma = db.migrar(dadosAntigos());
  const duas = db.migrar(JSON.parse(JSON.stringify(uma)));
  assert.deepEqual(duas.empresas[0].modulos_ativos.sort(), uma.empresas[0].modulos_ativos.sort());

  const semOsChamados = dadosAntigos();
  semOsChamados.empresas[0].versao_id = 1;
  semOsChamados.empresas[0].modulos_ativos = ['comercial'];
  const depois = db.migrar(semOsChamados);
  assert.deepEqual(depois.empresas.find((e) => e.id === 1).modulos_ativos.sort(), ['comercial'].sort());
});

// bug real pós-deploy (versão Restaurantes/rede multiunidade): instalação que já tinha rodado as
// migrações de plano (V1/V2/V3, flags já true) ANTES do módulo "filiais" existir no código fica
// com o plano "Completo" congelado sem ele pra sempre — e uma empresa que já estava nesse plano
// continua marcada "Completo" (plano atual) mas nunca ganha o menu "Rede e Filiais", porque
// empresa.modulos_ativos só é recalculado quando a própria empresa troca de plano de novo (ver
// PUT /api/meu-plano). A migração nova (_migracaoFiliaisDesbloqueioEmpresasV1) resgata os dois:
// o plano em si e quem já estava nele.
test('migrar resgata "filiais" pro plano Completo e pra quem já estava nele, de uma instalação anterior a esse módulo existir', () => {
  const jaMigrada = db.migrar(dadosAntigos());
  const completo = jaMigrada.versoes.find((v) => v.nome === 'Completo');
  // volta no tempo: tira "filiais" do plano, igual uma instalação migrada antes desse módulo
  // existir (as flags de migração de plano continuam true — elas não rodam de novo sozinhas).
  completo.modulos_proprios = completo.modulos_proprios.filter((m) => m !== 'filiais');
  completo.modulos = completo.modulos.filter((m) => m !== 'filiais');
  const empresa = jaMigrada.empresas.find((e) => e.id === 1);
  empresa.versao_id = completo.id;
  empresa.modulos_ativos = [...completo.modulos]; // já sem "filiais", igual o plano na época
  delete jaMigrada._migracaoFiliaisDesbloqueioEmpresasV1; // só essa migração (nova) ainda não rodou

  const depois = db.migrar(jaMigrada);
  const completoDepois = depois.versoes.find((v) => v.nome === 'Completo');
  assert.ok(completoDepois.modulos_proprios.includes('filiais'));
  assert.ok(completoDepois.modulos.includes('filiais'));
  const empresaDepois = depois.empresas.find((e) => e.id === 1);
  assert.ok(empresaDepois.modulos_ativos.includes('filiais'));
});

test('migrar do resgate de "filiais" é idempotente e não mexe em empresa de plano que nunca teve "filiais"', () => {
  const data = dadosAntigos();
  data.empresas[0].versao_id = 1; // "Intermediário" (legado "Manutenção") nunca libera "filiais"
  const uma = db.migrar(data);
  assert.ok(!uma.empresas[0].modulos_ativos.includes('filiais'));
  const duas = db.migrar(JSON.parse(JSON.stringify(uma)));
  assert.deepEqual(duas.empresas[0].modulos_ativos.sort(), uma.empresas[0].modulos_ativos.sort());
});
