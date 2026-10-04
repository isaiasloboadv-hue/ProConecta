// RCM/FMEA Fase 1, passo 2: liga cada unidade de equipamento atrelada (cliente_id preenchido) de
// volta ao item do catálogo (cliente_id null) de onde ela nasceu, via catalogo_id — hoje esse
// vínculo só existia por texto solto (tipo+modelo repetidos). Prova, pela API HTTP de verdade:
// (1) atrelar uma unidade nova carimba catalogo_id certo direto, sem depender de casamento por
// texto; (2) migração de unidades antigas (sem catalogo_id, de antes desse campo existir) casa por
// tipo+modelo (case-insensitive); (3) quando não acha nenhum catálogo correspondente, fica null,
// sem travar a subida do servidor nem quebrar a leitura de Equipamentos.
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
    ],
    clientes: [{ id: 1, nome_empresa: 'Cliente Teste', empresa_id: 1, contato: '', telefone: '', email: '' }],
    agenda: [], visitas: [],
    equipamentos: [
      // catálogo de verdade (sem catalogo_id ainda — simula banco de antes deste campo existir)
      { id: 1, empresa_id: 1, cliente_id: null, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: '', data_fabricacao: '', localizacao: '' },
      // unidade antiga, atrelada antes do catalogo_id existir, tipo+modelo bate (com caixa diferente de propósito)
      { id: 2, empresa_id: 1, cliente_id: 1, tipo: 'gravadora a laser', modelo: 'x200', numero_serie: 'SN-001', data_fabricacao: '', localizacao: '' },
      // unidade antiga cujo tipo+modelo não bate com nenhum catálogo (fica null, sem travar nada)
      { id: 3, empresa_id: 1, cliente_id: 1, tipo: 'Equipamento descontinuado', modelo: 'Antigo', numero_serie: 'SN-002', data_fabricacao: '', localizacao: '' },
    ],
    _seq: { usuarios: 2, clientes: 2, equipamentos: 4, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
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

test('catalogo_id: migração casa unidades antigas por tipo+modelo, e atrelar novo carimba direto', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-catalogo-id-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 41500 + Math.floor(Math.random() * 900);

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
    const authAdmin = { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' };

    const { equipamentos } = await (await fetch(`${base}/api/equipamentos`, { headers: authAdmin })).json();
    const catalogo = equipamentos.find((e) => e.id === 1);
    const unidadeCasada = equipamentos.find((e) => e.id === 2);
    const unidadeSemCatalogo = equipamentos.find((e) => e.id === 3);

    // catálogo em si não referencia outro catálogo
    assert.equal(catalogo.catalogo_id, null);
    // migração casou a unidade antiga (tipo+modelo em caixa diferente) com o catálogo certo
    assert.equal(unidadeCasada.catalogo_id, 1);
    // unidade sem correspondência fica null, sem travar nada
    assert.equal(unidadeSemCatalogo.catalogo_id, null);

    // atrelar uma unidade NOVA carimba catalogo_id direto, sem depender de casamento por texto
    const atrelar = await fetch(`${base}/api/equipamentos/${catalogo.id}/atrelar`, {
      method: 'POST', headers: authAdmin,
      body: JSON.stringify({ cliente_id: 1, numero_serie: 'SN-003' }),
    });
    assert.equal(atrelar.status, 201);
    const { equipamento: novaUnidade } = await atrelar.json();
    assert.equal(novaUnidade.catalogo_id, catalogo.id);

    // Equipamentos continua funcionando normalmente (nada quebrou na leitura)
    const listaFinal = await (await fetch(`${base}/api/equipamentos`, { headers: authAdmin })).json();
    assert.equal(listaFinal.equipamentos.length, 4);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
