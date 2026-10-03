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

test('migrar cria a versão Manutenção pra quem não tinha versoes', () => {
  const data = db.migrar(dadosAntigos());
  assert.ok(Array.isArray(data.versoes));
  const manutencao = data.versoes.find((v) => v.nome === 'Manutenção');
  assert.ok(manutencao);
  assert.deepEqual(manutencao.modulos.sort(), ['biblioteca', 'os_chamados', 'smp_preventivas'].sort());
});

test('migrar dá empresa 1 os módulos da versão Manutenção ativos', () => {
  const data = db.migrar(dadosAntigos());
  const empresa = data.empresas.find((e) => e.id === 1);
  assert.deepEqual(empresa.modulos_ativos.sort(), ['biblioteca', 'os_chamados', 'smp_preventivas'].sort());
  assert.equal(empresa.versao_id, 1);
  assert.deepEqual(empresa.terminologia, {});
});

test('migrar não sobrescreve modulos_ativos de empresa que já tinha sido migrada/customizada', () => {
  const data = dadosAntigos();
  data.empresas[0].versao_id = 1;
  data.empresas[0].modulos_ativos = ['os_chamados', 'crm']; // admin já desativou/ativou módulos avulsos
  data.empresas[0].terminologia = { equipamento: 'Paciente' };
  const depois = db.migrar(data);
  assert.deepEqual(depois.empresas[0].modulos_ativos.sort(), ['crm', 'os_chamados'].sort());
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

test('depois de migrar, os módulos da empresa 1 ficam ativos de acordo com moduloAtivo', () => {
  const data = db.migrar(dadosAntigos());
  assert.equal(db.moduloAtivo(data, 1, 'os_chamados'), true);
  assert.equal(db.moduloAtivo(data, 1, 'smp_preventivas'), true);
  assert.equal(db.moduloAtivo(data, 1, 'biblioteca'), true);
  assert.equal(db.moduloAtivo(data, 1, 'crm'), false);
  assert.equal(db.moduloAtivo(data, 1, 'financeiro'), false);
});
