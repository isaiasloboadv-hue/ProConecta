// Etapa 6 do briefing white label (módulos contratáveis), passo 3: cotas de plano — limite de
// técnicos e de equipamentos contratado por empresa. Prova, pela API HTTP de verdade, que: (1)
// sem limite configurado (null, comportamento de hoje) nada muda; (2) com limite configurado, o
// servidor recusa passar da cota em todos os pontos de criação (POST /api/usuarios papel=suporte,
// POST /api/equipamentos, POST /api/equipamentos/:id/atrelar); (3) o Super Admin edita a cota
// (inclusive voltando pra "sem limite") pela rota de edição de empresa.
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
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico 1', email: 'tecnico1@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Super Admin', email: 'super@x.com', papel: 'super_admin', empresa_id: null, status: 'ativo', ...senha },
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Teste', empresa_id: 1, contato: '', telefone: '', email: '' }],
    equipamentos: [{ id: 1, empresa_id: 1, cliente_id: null, tipo: 'Impressora', modelo: 'X', numero_serie: '', data_fabricacao: '', localizacao: '' }],
    agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 2, equipamentos: 2, agenda: 1, visitas: 1 },
    empresas: [
      // limite_tecnicos: 1 (já tem 1 suporte) e limite_equipamentos: 1 (já tem 1) — qualquer
      // tentativa de passar disso deve ser recusada até o Super Admin ampliar.
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, limite_tecnicos: 1, limite_equipamentos: 1 },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: ['os_chamados'] }],
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

test('cotas de plano: limite de técnicos e de equipamentos bloqueia além da cota, editável pelo Super Admin', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-cotas-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 35500 + Math.floor(Math.random() * 900);

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
    const tokenAdmin = await login('admin@x.com');
    const tokenSuper = await login('super@x.com');
    const authAdmin = { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' };
    const authSuper = { Authorization: `Bearer ${tokenSuper}`, 'Content-Type': 'application/json' };

    // já no limite (1 técnico, 1 equipamento) — as duas criações são recusadas
    const criarTecnico = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Tecnico 2', email: 'tecnico2@x.com', papel: 'suporte' }),
    });
    assert.equal(criarTecnico.status, 400);
    assert.match((await criarTecnico.json()).erro, /[Ll]imite de técnicos/);

    const criarEquipamento = await fetch(`${base}/api/equipamentos`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ tipo: 'Gravadora', modelo: 'Y' }),
    });
    assert.equal(criarEquipamento.status, 400);
    assert.match((await criarEquipamento.json()).erro, /[Ll]imite de equipamentos/);

    const atrelarEquipamento = await fetch(`${base}/api/equipamentos/1/atrelar`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ cliente_id: 1, numero_serie: 'SN-001' }),
    });
    assert.equal(atrelarEquipamento.status, 400);
    assert.match((await atrelarEquipamento.json()).erro, /[Ll]imite de equipamentos/);

    // outro papel que não "suporte" não é afetado pelo limite de técnicos
    const criarAdministrador = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Outro Admin', email: 'outroadmin@x.com', papel: 'administrador' }),
    });
    assert.equal(criarAdministrador.status, 201);

    // Super Admin amplia a cota de técnicos pra 2 — a criação que falhava agora funciona
    const ampliar = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', limite_tecnicos: 2 }),
    });
    assert.equal(ampliar.status, 200);
    assert.equal((await ampliar.json()).empresa.limite_tecnicos, 2);

    const criarTecnicoDeNovo = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Tecnico 2', email: 'tecnico2@x.com', papel: 'suporte' }),
    });
    assert.equal(criarTecnicoDeNovo.status, 201);

    // Super Admin remove o limite (null) — volta a aceitar sem checar cota nenhuma
    const semLimite = await fetch(`${base}/api/plataforma/empresas/1`, {
      method: 'PUT', headers: authSuper,
      body: JSON.stringify({ nome: 'Empresa Teste', limite_tecnicos: null }),
    });
    assert.equal(semLimite.status, 200);
    assert.equal((await semLimite.json()).empresa.limite_tecnicos, null);

    const criarTecnico3 = await fetch(`${base}/api/usuarios`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ nome: 'Tecnico 3', email: 'tecnico3@x.com', papel: 'suporte' }),
    });
    assert.equal(criarTecnico3.status, 201);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
