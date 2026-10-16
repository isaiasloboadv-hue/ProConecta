// pedido do usuário: rascunho de relatório/laudo técnico era salvo só no localStorage do
// aparelho — começar no celular e continuar no PC era impossível (ver conversa). Prova pela API
// HTTP de verdade: GET/PUT/DELETE /api/rascunhos fazem upsert por usuário+chave, nunca vazam
// rascunho de um usuário pra outro (nem entre empresas), e a rede de segurança contra payload
// grande (foto que não deveria ter sido mandada) recusa com 400.
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
      { id: 1, nome: 'Tecnico A', email: 'tecA@empresa1.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico B', email: 'tecB@empresa1.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Admin Outra Empresa', email: 'admin@empresa2.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [], rascunhos: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, rascunhos: 1 },
    empresas: [
      { id: 1, nome: 'Empresa 1', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
      { id: 2, nome: 'Empresa 2', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {} },
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

test('GET/PUT/DELETE /api/rascunhos: upsert por usuário+chave, isolado por usuário e por empresa, recusa payload grande', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-rascunhos-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 40200 + Math.floor(Math.random() * 900);

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
    const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const tokenA = await login('tecA@empresa1.com');
    const tokenB = await login('tecB@empresa1.com');
    const tokenOutraEmpresa = await login('admin@empresa2.com');
    const authA = auth(tokenA);

    // sem rascunho ainda: GET devolve null
    const vazio = await fetch(`${base}/api/rascunhos/pc_rascunho_relatorio_1`, { headers: authA });
    assert.equal(vazio.status, 200);
    assert.deepEqual((await vazio.json()).rascunho, null);

    // cria (PUT)
    const draft1 = { servico: 'Troca de resistência', observacoes: 'Equipamento liga mas não aquece' };
    const rCriar = await fetch(`${base}/api/rascunhos`, {
      method: 'PUT', headers: authA, body: JSON.stringify({ chave: 'pc_rascunho_relatorio_1', draft: draft1 }),
    });
    assert.equal(rCriar.status, 200);
    const corpoCriar = await rCriar.json();
    assert.deepEqual(corpoCriar.rascunho.draft, draft1);
    assert.ok(corpoCriar.rascunho.atualizado_em);

    // GET devolve o que foi salvo
    const rGet = await fetch(`${base}/api/rascunhos/pc_rascunho_relatorio_1`, { headers: authA });
    assert.deepEqual((await rGet.json()).rascunho.draft, draft1);

    // PUT de novo com a MESMA chave substitui (upsert), não duplica
    const draft2 = { ...draft1, observacoes: 'Atualizado — já trocou a resistência' };
    await fetch(`${base}/api/rascunhos`, {
      method: 'PUT', headers: authA, body: JSON.stringify({ chave: 'pc_rascunho_relatorio_1', draft: draft2 }),
    });
    const { rascunhos: listaA } = await (await fetch(`${base}/api/rascunhos`, { headers: authA })).json();
    assert.equal(listaA.length, 1);
    assert.deepEqual(listaA[0].draft, draft2);

    // outro usuário da MESMA empresa, mesma chave (coincidência de agenda_id, por exemplo) —
    // rascunho é pessoal, não aparece pro colega
    const { rascunhos: listaB } = await (await fetch(`${base}/api/rascunhos`, { headers: auth(tokenB) })).json();
    assert.equal(listaB.length, 0);
    const getB = await fetch(`${base}/api/rascunhos/pc_rascunho_relatorio_1`, { headers: auth(tokenB) });
    assert.deepEqual((await getB.json()).rascunho, null);

    // usuário de OUTRA empresa também não vê nada
    const { rascunhos: listaOutraEmpresa } = await (await fetch(`${base}/api/rascunhos`, { headers: auth(tokenOutraEmpresa) })).json();
    assert.equal(listaOutraEmpresa.length, 0);

    // sem autenticação: 401
    const semAuth = await fetch(`${base}/api/rascunhos`);
    assert.equal(semAuth.status, 401);

    // PUT sem chave: 400
    const semChave = await fetch(`${base}/api/rascunhos`, { method: 'PUT', headers: authA, body: JSON.stringify({ draft: {} }) });
    assert.equal(semChave.status, 400);

    // payload grande demais (ex.: alguém esqueceu de tirar a foto antes de sincronizar) — recusa
    const draftGigante = { observacoes: 'x'.repeat(250 * 1024) };
    const rGigante = await fetch(`${base}/api/rascunhos`, {
      method: 'PUT', headers: authA, body: JSON.stringify({ chave: 'pc_rascunho_relatorio_2', draft: draftGigante }),
    });
    assert.equal(rGigante.status, 400);

    // DELETE remove — some da lista e do GET individual
    const rDelete = await fetch(`${base}/api/rascunhos/pc_rascunho_relatorio_1`, { method: 'DELETE', headers: authA });
    assert.equal(rDelete.status, 200);
    const depoisDelete = await fetch(`${base}/api/rascunhos/pc_rascunho_relatorio_1`, { headers: authA });
    assert.deepEqual((await depoisDelete.json()).rascunho, null);
    const { rascunhos: listaDepois } = await (await fetch(`${base}/api/rascunhos`, { headers: authA })).json();
    assert.equal(listaDepois.length, 0);

    // chave com caracteres especiais (ex.: retorno de laudo) sobrevive ao round-trip pela URL
    const chaveComplexa = 'pc_rascunho_laudo_17_retorno';
    await fetch(`${base}/api/rascunhos`, {
      method: 'PUT', headers: authA, body: JSON.stringify({ chave: chaveComplexa, draft: { laudo_tecnico: 'ok' } }),
    });
    const rComplexa = await fetch(`${base}/api/rascunhos/${encodeURIComponent(chaveComplexa)}`, { headers: authA });
    assert.equal((await rComplexa.json()).rascunho.chave, chaveComplexa);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
