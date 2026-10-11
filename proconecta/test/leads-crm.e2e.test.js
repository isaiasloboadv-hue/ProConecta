// CRM nativo, passo 1 (Leads/Contatos) — menu "Comercial" novo, no lugar do esqueleto "CRM"
// removido (ver plano aprovado: "o menu CRM é praticamente o que meu sistema já faz... vamos
// implementar os menus do que falta"). Prova pela API HTTP de verdade: administrador/comercial
// cadastram e editam leads, outros papéis são recusados, a conversão em cliente cria um registro
// de verdade em `clientes` (igual sincronizarClienteDoRelatorio já faz a partir de um relatório),
// e tudo isso fica isolado por empresa (tenant.js).
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
      { id: 3, nome: 'Suporte PRO', email: 'suporte@promarking.com.br', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 4, nome: 'Comercial BRB', email: 'comercial@brb.com.br', papel: 'comercial', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], leads: [],
    _seq: { usuarios: 5, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, leads: 1 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca', 'comercial'], terminologia: {} },
      { id: 2, nome: 'BRB', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial'], terminologia: {} },
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

test('leads/contatos: CRUD por papel autorizado, 403 pra quem não é, conversão em cliente, isolamento por empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-leads-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresas()));
  const porta = 37900 + Math.floor(Math.random() * 900);

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
    const tokenAdminPro = await login('admin@promarking.com.br');
    const tokenComercialPro = await login('comercial@promarking.com.br');
    const tokenSuportePro = await login('suporte@promarking.com.br');
    const tokenComercialBrb = await login('comercial@brb.com.br');
    const authAdminPro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAdminPro}` };
    const authComercialPro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenComercialPro}` };
    const authSuportePro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSuportePro}` };
    const authComercialBrb = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenComercialBrb}` };

    // suporte não acessa leads (nem leitura)
    const negado = await fetch(`${base}/api/leads`, { headers: authSuportePro });
    assert.equal(negado.status, 403);

    // comercial da PRO Marking cadastra um lead
    const criar = await fetch(`${base}/api/leads`, {
      method: 'POST', headers: authComercialPro,
      body: JSON.stringify({ nome_empresa: 'Prospect XYZ', contato: 'Fulano', telefone: '12999990000', origem: 'Indicação' }),
    });
    assert.equal(criar.status, 201);
    const leadCriado = (await criar.json()).lead;
    assert.equal(leadCriado.estagio, 'novo');
    assert.equal(leadCriado.convertido_cliente_id, null);

    // administrador da mesma empresa vê o lead
    const listaAdmin = await fetch(`${base}/api/leads`, { headers: authAdminPro });
    assert.equal(listaAdmin.status, 200);
    assert.equal((await listaAdmin.json()).leads.length, 1);

    // isolamento: comercial da BRB (empresa 2) não vê o lead da PRO Marking
    const listaBrb = await fetch(`${base}/api/leads`, { headers: authComercialBrb });
    assert.equal(listaBrb.status, 200);
    assert.equal((await listaBrb.json()).leads.length, 0);

    // editar estágio
    const editar = await fetch(`${base}/api/leads/${leadCriado.id}`, {
      method: 'PUT', headers: authAdminPro,
      body: JSON.stringify({ nome_empresa: 'Prospect XYZ', estagio: 'contatado' }),
    });
    assert.equal(editar.status, 200);
    assert.equal((await editar.json()).lead.estagio, 'contatado');

    // converter em cliente: cria um registro de verdade em clientes e marca convertido_cliente_id
    const converter = await fetch(`${base}/api/leads/${leadCriado.id}/converter`, { method: 'POST', headers: authComercialPro });
    assert.equal(converter.status, 200);
    const { lead: leadConvertido, cliente } = await converter.json();
    assert.equal(leadConvertido.convertido_cliente_id, cliente.id);
    assert.equal(cliente.nome_empresa, 'Prospect XYZ');

    const clientesPro = await fetch(`${base}/api/clientes`, { headers: authAdminPro });
    assert.equal((await clientesPro.json()).clientes.some((c) => c.id === cliente.id), true);

    // não converte de novo
    const converterDeNovo = await fetch(`${base}/api/leads/${leadCriado.id}/converter`, { method: 'POST', headers: authComercialPro });
    assert.equal(converterDeNovo.status, 400);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
