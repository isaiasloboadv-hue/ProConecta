// CRM nativo, passo 2 (Funil de Oportunidades) — prova pela API HTTP de verdade: cadastro manual,
// movimento de estágio ("Mover para →"), e a criação automática a partir de um Devolutivo que
// marcou identificou_oportunidade_adicional (em vez de ficar presa só dentro do relatório — ver
// POST /api/relatorios-manutencao em server.js). Tudo isolado por empresa via tenant.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosDuasEmpresas() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PRO', email: 'admin@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Comercial PRO', email: 'comercial@promarking.com.br', papel: 'comercial', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin BRB', email: 'admin@brb.com.br', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Devolutivo', empresa_id: 1, contato: '', telefone: '', email: '' }],
    equipamentos: [], agenda: [], visitas: [], leads: [], oportunidades: [],
    relatorios_manutencao: [],
    _seq: { usuarios: 4, clientes: 2, equipamentos: 1, agenda: 1, visitas: 1, leads: 1, oportunidades: 1, relatorios_manutencao: 1 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca', 'comercial'], terminologia: {} },
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

test('funil de oportunidades: cadastro manual, mover estágio, nascimento automático a partir do Devolutivo, isolamento por empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-oportunidades-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresas()));
  const porta = 38200 + Math.floor(Math.random() * 900);

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
    const tokenComercialPro = await login('comercial@promarking.com.br');
    const tokenAdminBrb = await login('admin@brb.com.br');
    const authComercialPro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenComercialPro}` };
    const authAdminBrb = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAdminBrb}` };

    // cadastro manual
    const criar = await fetch(`${base}/api/oportunidades`, {
      method: 'POST', headers: authComercialPro,
      body: JSON.stringify({ titulo: 'Retrofit linha 2', cliente_id: 1, valor_estimado: '~R$ 50.000' }),
    });
    assert.equal(criar.status, 201);
    const manual = (await criar.json()).oportunidade;
    assert.equal(manual.estagio, 'novo');
    assert.equal(manual.origem, 'manual');

    // mover estágio
    const mover = await fetch(`${base}/api/oportunidades/${manual.id}`, {
      method: 'PUT', headers: authComercialPro, body: JSON.stringify({ estagio: 'contato' }),
    });
    assert.equal(mover.status, 200);
    assert.equal((await mover.json()).oportunidade.estagio, 'contato');

    // estágio inválido é recusado
    const estagioInvalido = await fetch(`${base}/api/oportunidades/${manual.id}`, {
      method: 'PUT', headers: authComercialPro, body: JSON.stringify({ estagio: 'inventado' }),
    });
    assert.equal(estagioInvalido.status, 400);

    // Devolutivo com identificou_oportunidade_adicional cria Oportunidade automaticamente
    const devolutivo = await fetch(`${base}/api/relatorios-manutencao`, {
      method: 'POST', headers: authComercialPro,
      body: JSON.stringify({
        tipo: 'devolutivo',
        empresa: 'Cliente Devolutivo', data_visita: '2026-10-10', promotor: 'Fulano',
        equipamento_demonstrado: 'Marcador a laser X', feedback_cliente: 'Gostou muito',
        resultado_demonstracao: 'aprovado',
        identificou_oportunidade_adicional: true,
        tipo_oportunidade: ['automacao'],
        descricao_oportunidade: 'Cliente quer integrar com esteira',
        valor_agregado: 'Pode virar uma venda de retrofit completo',
      }),
    });
    assert.equal(devolutivo.status, 201);

    const listaPro = await fetch(`${base}/api/oportunidades`, { headers: authComercialPro });
    const oportunidadesPro = (await listaPro.json()).oportunidades;
    assert.equal(oportunidadesPro.length, 2);
    const automatica = oportunidadesPro.find((o) => o.origem === 'devolutivo');
    assert.ok(automatica, 'a oportunidade automática existe');
    assert.equal(automatica.cliente_id, 1);
    assert.equal(automatica.valor_estimado, 'Pode virar uma venda de retrofit completo');
    assert.equal(automatica.descricao, 'Cliente quer integrar com esteira');
    assert.equal(automatica.estagio, 'novo');

    // isolamento: BRB não vê nenhuma oportunidade da PRO Marking
    const listaBrb = await fetch(`${base}/api/oportunidades`, { headers: authAdminBrb });
    assert.equal((await listaBrb.json()).oportunidades.length, 0);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
