// CRM nativo, passo 4 (Histórico Unificado por Cliente) — agrega agenda, relatórios (por
// agenda_id ou por nome, já que relatorios_manutencao não tem cliente_id nenhum), chamados,
// equipamentos, oportunidades e propostas numa timeline só. Prova pela API HTTP de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosComHistorico() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PRO', email: 'admin@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin BRB', email: 'admin@brb.com.br', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [
      { id: 1, nome_empresa: 'Cliente Alfa', empresa_id: 1, contato: '', telefone: '', email: '' },
      { id: 2, nome_empresa: 'Cliente Beta', empresa_id: 2, contato: '', telefone: '', email: '' },
    ],
    equipamentos: [
      { id: 1, cliente_id: 1, empresa_id: 1, tipo: 'Marcador a laser', modelo: 'X', numero_serie: 'ABC1', localizacao: '' },
    ],
    agenda: [
      { id: 1, empresa_id: 1, numero_os: 'OS-0001', tecnico_id: null, cliente_id: 1, equipamento_id: 1,
        tipo: 'corretiva', categoria: 'inloco', status: 'concluida', finalizada: true,
        data_hora_inicio: '2026-01-10T10:00', data_hora_fim: '2026-01-10T11:00',
        contato: '', telefone: '', email: '', criado_em: '2026-01-01T09:00:00.000Z' },
    ],
    visitas: [],
    relatorios_manutencao: [
      // via agenda_id
      { id: 1, empresa_id: 1, tipo: 'corretiva', agenda_id: 1, empresa: 'outro nome qualquer', autor_id: 1 },
      // via nome (sem agenda_id) — igual sincronizarClienteDoRelatorio já reconcilia
      { id: 2, empresa_id: 1, tipo: 'ficha', agenda_id: null, empresa: 'Cliente Alfa', autor_id: 1 },
      // não deve aparecer: nem agenda_id nem nome batem
      { id: 3, empresa_id: 1, tipo: 'ficha', agenda_id: null, empresa: 'Outro Cliente', autor_id: 1 },
    ],
    chamados: [
      { id: 1, empresa_id: 1, cliente_id: 1, status: 'encerrado', mensagens: [], origem: 'app', tecnico_id: null, os_id: null, prioridade: 'normal' },
    ],
    leads: [],
    oportunidades: [
      { id: 1, empresa_id: 1, titulo: 'Retrofit', cliente_id: 1, lead_id: null, estagio: 'proposta', valor_estimado: '', descricao: '', observacoes: '', origem: 'manual', devolutivo_id: null, criado_em: '2026-02-01T00:00:00.000Z' },
    ],
    propostas: [
      { id: 1, empresa_id: 1, oportunidade_id: 1, itens: [{ descricao: 'x', quantidade: 1, valor_unitario: 100 }], valor_total: 100, validade: '', status: 'rascunho', criado_em: '2026-02-05T00:00:00.000Z' },
    ],
    _seq: { usuarios: 3, clientes: 3, equipamentos: 2, agenda: 2, visitas: 1, relatorios_manutencao: 4, leads: 1, oportunidades: 2, propostas: 2 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial'], terminologia: {} },
      { id: 2, nome: 'BRB', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#333', cor_secundaria: '#666', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados', 'smp_preventivas', 'biblioteca'] }],
  };
}

async function aguardarServidorSubir(porta) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${porta}/api/empresa`);
      if (r.ok) return;
    } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não subiu a tempo');
}

test('histórico unificado do cliente: agrega agenda/relatórios (por agenda_id e por nome)/chamados/equipamentos/oportunidades/propostas, isolado por empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-historico-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComHistorico()));
  const porta = 38700 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const login = async (email) => {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: 'senha1234' }),
      });
      return (await r.json()).token;
    };
    const tokenPro = await login('admin@promarking.com.br');
    const tokenBrb = await login('admin@brb.com.br');
    const authPro = { Authorization: `Bearer ${tokenPro}` };
    const authBrb = { Authorization: `Bearer ${tokenBrb}` };

    const r = await fetch(`${base}/api/clientes/1/historico`, { headers: authPro });
    assert.equal(r.status, 200);
    const historico = await r.json();

    assert.equal(historico.agenda.length, 1);
    assert.equal(historico.agenda[0].numero_os, 'OS-0001');

    assert.equal(historico.relatorios.length, 2);
    assert.deepEqual(historico.relatorios.map((x) => x.id).sort(), [1, 2]);

    assert.equal(historico.chamados.length, 1);
    assert.equal(historico.equipamentos.length, 1);
    assert.equal(historico.oportunidades.length, 1);
    assert.equal(historico.propostas.length, 1);
    assert.equal(historico.propostas[0].valor_total, 100);

    // cliente de outra empresa: 404 (tenant.buscar nunca devolve registro de fora)
    const outraEmpresa = await fetch(`${base}/api/clientes/2/historico`, { headers: authPro });
    assert.equal(outraEmpresa.status, 404);

    // BRB vendo o próprio cliente 2: vazio (sem nenhum dado vinculado)
    const brb = await fetch(`${base}/api/clientes/2/historico`, { headers: authBrb });
    assert.equal(brb.status, 200);
    const historicoBrb = await brb.json();
    assert.equal(historicoBrb.agenda.length, 0);
    assert.equal(historicoBrb.oportunidades.length, 0);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
