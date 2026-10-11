// pedido do usuário: "o perfil comercial é quando já é uma empresa grande e já é dividido em
// vários departamento comercial, financeiro, etc" — alinhado ao estágio de departamentalização
// (Greiner, "Growth through Direction"): login PRÓPRIO de Comercial/Financeiro (separado do
// administrador) só pode ser criado/trocado numa empresa que já tem o módulo "equipe_avancado"
// (o mesmo que marca "a equipe cresceu" nos planos). Prova pela API HTTP de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin Pequena', email: 'admin@pequena.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin Grande', email: 'admin@grande.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
      { id: 3, nome: 'Já Comercial', email: 'comercial@grande.com', papel: 'comercial', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      // empresa pequena: plano de entrada, sem "equipe_avancado" (como uma autônoma/pequena)
      { id: 1, nome: 'Empresa Pequena', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['comercial', 'relatorios'], terminologia: {} },
      // empresa grande: já tem "equipe_avancado" (já dividida em departamentos)
      { id: 2, nome: 'Empresa Grande', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'comercial', 'relatorios', 'equipe_avancado'], terminologia: {} },
    ],
    versoes: [{ id: 1, nome: 'Básico', modulos: ['comercial', 'relatorios'] }],
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

test('perfil comercial/financeiro exige empresa já departamentalizada (módulo equipe_avancado)', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-papel-depto-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 36300 + Math.floor(Math.random() * 900);

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
    const tokenPequena = await login('admin@pequena.com');
    const tokenGrande = await login('admin@grande.com');
    const authPequena = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenPequena}` };
    const authGrande = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenGrande}` };

    // --- empresa pequena (sem equipe_avancado): recusa criar comercial OU financeiro ---
    const negadoComercial = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authPequena,
      body: JSON.stringify({ nome: 'Fulano', email: 'fulano@pequena.com', papel: 'comercial' }),
    });
    assert.equal(negadoComercial.status, 400);
    const negadoFinanceiro = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authPequena,
      body: JSON.stringify({ nome: 'Beltrana', email: 'beltrana@pequena.com', papel: 'financeiro' }),
    });
    assert.equal(negadoFinanceiro.status, 400);

    // mas continua podendo criar um suporte (técnico) normalmente — a regra é só pra
    // comercial/financeiro, não trava o resto do cadastro
    const suportePermitido = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authPequena,
      body: JSON.stringify({ nome: 'Técnico', email: 'tecnico@pequena.com', papel: 'suporte' }),
    });
    assert.equal(suportePermitido.status, 201);

    // --- empresa grande (com equipe_avancado): cria comercial e financeiro normalmente ---
    const criaComercial = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authGrande,
      body: JSON.stringify({ nome: 'Vendedor', email: 'vendedor@grande.com', papel: 'comercial' }),
    });
    assert.equal(criaComercial.status, 201);
    const criaFinanceiro = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authGrande,
      body: JSON.stringify({ nome: 'Contador', email: 'contador@grande.com', papel: 'financeiro' }),
    });
    assert.equal(criaFinanceiro.status, 201);

    // --- editar quem JÁ é comercial (empresa grande) sem trocar o papel: sempre permitido ---
    const editaSemTrocarPapel = await fetch(`${base}/api/usuarios/3`, {
      method: 'PUT', headers: authGrande,
      body: JSON.stringify({ nome: 'Já Comercial Editado', email: 'comercial@grande.com', papel: 'comercial' }),
    });
    assert.equal(editaSemTrocarPapel.status, 200);

    // --- trocar o papel de um usuário existente PRA comercial na empresa pequena: recusado ---
    const trocaParaComercial = await fetch(`${base}/api/usuarios/4`, {
      method: 'PUT', headers: authPequena,
      body: JSON.stringify({ nome: 'Técnico', email: 'tecnico@pequena.com', papel: 'comercial' }),
    });
    assert.equal(trocaParaComercial.status, 400);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
