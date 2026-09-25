const test = require('node:test');
const assert = require('node:assert/strict');
const { moduloDaRota } = require('../rotas-modulo.js');

test('rotas de login/empresa/convite/whatsapp são públicas (sem checagem nenhuma)', () => {
  assert.equal(moduloDaRota(/^\/api\/login$/), 'publico');
  assert.equal(moduloDaRota(/^\/api\/empresa$/), 'publico');
  assert.equal(moduloDaRota(/^\/api\/convite\/([a-f0-9]+)$/), 'publico');
  assert.equal(moduloDaRota(/^\/api\/convite\/([a-f0-9]+)\/ativar$/), 'publico');
  assert.equal(moduloDaRota(/^\/api\/whatsapp\/webhook$/), 'publico');
});

test('rotas de núcleo exigem login mas não módulo específico', () => {
  assert.equal(moduloDaRota(/^\/api\/me$/), 'nucleo');
  assert.equal(moduloDaRota(/^\/api\/clientes$/), 'nucleo');
  assert.equal(moduloDaRota(/^\/api\/usuarios\/(\d+)$/), 'nucleo');
  assert.equal(moduloDaRota(/^\/api\/notificacoes$/), 'nucleo');
  assert.equal(moduloDaRota(/^\/api\/chat-interno\/contatos$/), 'nucleo');
});

test('rotas de agenda/visitas/chamados/equipamentos pertencem a os_chamados', () => {
  assert.equal(moduloDaRota(/^\/api\/agenda$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/agenda\/(\d+)\/finalizar$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/visitas\/(\d+)\/aprovar$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/chamados\/(\d+)\/assumir$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/equipamentos\/buscar-por-serie$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/solicitacoes-rh$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/tecnicos\/viagens$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/tecnico\/online$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/relatorios-manutencao\/(\d+)$/), 'os_chamados');
});

test('rotas de registros pertencem a biblioteca', () => {
  assert.equal(moduloDaRota(/^\/api\/registros$/), 'biblioteca');
  assert.equal(moduloDaRota(/^\/api\/registros\/(\d+)\/aprovar$/), 'biblioteca');
  assert.equal(moduloDaRota(/^\/api\/registros\/ranking$/), 'biblioteca');
});

test('rota nova sem prefixo conhecido cai em núcleo por padrão', () => {
  assert.equal(moduloDaRota(/^\/api\/algo-que-nao-existe$/), 'nucleo');
});

test('rotas dos módulos novos (crm, agendamento, financeiro, prestação de contas)', () => {
  assert.equal(moduloDaRota(/^\/api\/crm\/status$/), 'crm');
  assert.equal(moduloDaRota(/^\/api\/agendamento\/status$/), 'agendamento');
  assert.equal(moduloDaRota(/^\/api\/financeiro\/status$/), 'financeiro');
  assert.equal(moduloDaRota(/^\/api\/prestacao-contas\/status$/), 'prestacao_contas');
});

// regressão: "/api/agendamento" é prefixo de string de "/api/agenda" só ao contrário (agenda é
// prefixo de agendamento) — um startsWith ingênuo prendia rota de agendamento no módulo
// os_chamados por engano. bateComPrefixo (interno) exige que o próximo caractere seja "/" ou fim
// de string, não só que a string comece igual.
test('agenda e agendamento não se confundem (prefixo de string não é prefixo de caminho)', () => {
  assert.equal(moduloDaRota(/^\/api\/agenda$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/agenda\/(\d+)$/), 'os_chamados');
  assert.equal(moduloDaRota(/^\/api\/agendamento\/status$/), 'agendamento');
  assert.notEqual(moduloDaRota(/^\/api\/agendamento\/status$/), 'os_chamados');
});
