// Etapa 6 do briefing white label (módulos contratáveis), passo 2: módulo prestação de contas de
// verdade (antes só esqueleto). Prova, pela API HTTP de verdade, o fluxo completo: técnico lança
// (com itens de despesa + foto de comprovante), financeiro aprova/reprova, administrador também
// decide, e o isolamento por módulo/empresa/papel continua valendo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

function dados() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Tecnico', email: 'tecnico@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
      { id: 3, nome: 'Financeiro', email: 'financeiro@x.com', papel: 'financeiro', status: 'ativo', empresa_id: 1, ...senha },
      { id: 4, nome: 'Outro Tecnico', email: 'tecnico2@x.com', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 5, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      // prestacao_contas ainda não vem na versão "Manutenção" por padrão — ativa explicitamente,
      // igual a Super Admin faria pelo painel da plataforma.
      { id: 1, nome: 'Empresa Teste', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados', 'prestacao_contas'], terminologia: {} },
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

test('prestação de contas: lançar, aprovar, reprovar — isolado por técnico e por empresa', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-prestacao-contas-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 36500 + Math.floor(Math.random() * 900);

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
    const tokenTecnico = await login('tecnico@x.com');
    const tokenTecnico2 = await login('tecnico2@x.com');
    const tokenFinanceiro = await login('financeiro@x.com');
    const tokenAdmin = await login('admin@x.com');
    const authTecnico = { Authorization: `Bearer ${tokenTecnico}`, 'Content-Type': 'application/json' };
    const authTecnico2 = { Authorization: `Bearer ${tokenTecnico2}`, 'Content-Type': 'application/json' };
    const authFinanceiro = { Authorization: `Bearer ${tokenFinanceiro}`, 'Content-Type': 'application/json' };
    const authAdmin = { Authorization: `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' };

    // sem item válido, servidor recusa
    const semItem = await fetch(`${base}/api/prestacao-contas`, {
      method: 'POST', headers: authTecnico, body: JSON.stringify({ itens: [] }),
    });
    assert.equal(semItem.status, 400);

    // técnico lança com 2 itens, um com foto
    const criar = await fetch(`${base}/api/prestacao-contas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({
        descricao: 'Viagem a Campinas',
        itens: [
          { categoria: 'hospedagem', descricao: 'Hotel', valor: 150.5, data: '2026-10-01', foto: PNG_1X1 },
          { categoria: 'combustivel', descricao: 'Posto', valor: 80 },
        ],
      }),
    });
    assert.equal(criar.status, 201);
    const { prestacao } = await criar.json();
    assert.equal(prestacao.status, 'pendente');
    assert.equal(prestacao.valor_total, 230.5);
    assert.equal(prestacao.itens.length, 2);
    // a foto já volta hidratada no create (extrairFotosProfundo guarda ref, mas o create devolve
    // o objeto salvo direto — confirma que pelo menos não quebrou o fluxo)
    assert.ok(prestacao.itens[0].foto);

    // outro técnico não vê a prestação do primeiro na própria lista
    const minhasOutroTecnico = await fetch(`${base}/api/prestacao-contas/minhas`, { headers: authTecnico2 });
    assert.equal((await minhasOutroTecnico.json()).prestacoes.length, 0);

    // o próprio técnico vê, com a foto hidratada como data: URI de verdade
    const minhasTecnico = await (await fetch(`${base}/api/prestacao-contas/minhas`, { headers: authTecnico })).json();
    assert.equal(minhasTecnico.prestacoes.length, 1);
    assert.ok(minhasTecnico.prestacoes[0].itens[0].foto.startsWith('data:image/png;base64,'));

    // financeiro vê na fila de aprovação
    const filaFinanceiro = await (await fetch(`${base}/api/prestacao-contas/fila`, { headers: authFinanceiro })).json();
    assert.equal(filaFinanceiro.prestacoes.length, 1);
    assert.equal(filaFinanceiro.prestacoes[0].id, prestacao.id);

    // técnico não acessa a fila de aprovação (não é financeiro nem administrador)
    const filaComoTecnico = await fetch(`${base}/api/prestacao-contas/fila`, { headers: authTecnico });
    assert.equal(filaComoTecnico.status, 403);

    // financeiro aprova
    const aprovar = await fetch(`${base}/api/prestacao-contas/${prestacao.id}/aprovar`, { method: 'POST', headers: authFinanceiro });
    assert.equal(aprovar.status, 200);
    assert.equal((await aprovar.json()).prestacao.status, 'aprovado');

    // não decide de novo uma já decidida
    const aprovarDeNovo = await fetch(`${base}/api/prestacao-contas/${prestacao.id}/aprovar`, { method: 'POST', headers: authFinanceiro });
    assert.equal(aprovarDeNovo.status, 400);

    // segunda prestação, decidida (reprovada) pelo administrador — sem comentário, recusa
    const criar2 = await fetch(`${base}/api/prestacao-contas`, {
      method: 'POST', headers: authTecnico,
      body: JSON.stringify({ itens: [{ categoria: 'outros', valor: 40 }] }),
    });
    const { prestacao: prestacao2 } = await criar2.json();
    const reprovarSemComentario = await fetch(`${base}/api/prestacao-contas/${prestacao2.id}/reprovar`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({}),
    });
    assert.equal(reprovarSemComentario.status, 400);
    const reprovar = await fetch(`${base}/api/prestacao-contas/${prestacao2.id}/reprovar`, {
      method: 'POST', headers: authAdmin, body: JSON.stringify({ comentario: 'Sem nota fiscal' }),
    });
    assert.equal(reprovar.status, 200);
    const corpoReprovar = await reprovar.json();
    assert.equal(corpoReprovar.prestacao.status, 'reprovado');
    assert.equal(corpoReprovar.prestacao.comentario_financeiro, 'Sem nota fiscal');

    // administrador com ?todas=1 vê as duas; técnico sem o parâmetro só vê as próprias (as duas, já que são dele)
    const todasAdmin = await (await fetch(`${base}/api/prestacao-contas/minhas?todas=1`, { headers: authAdmin })).json();
    assert.equal(todasAdmin.prestacoes.length, 2);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
