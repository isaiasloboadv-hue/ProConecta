// SaaS, passo 3 (Trocar de plano pela própria empresa) — a própria empresa troca de versão sem
// precisar do Super Admin, aplicando módulos/cotas na hora, sem gateway de pagamento nenhum
// envolvido ("terreno pronto"). Prova pela API HTTP de verdade: listagem com preço, troca aplica
// módulos/cotas, validações, isolamento entre empresas, e — crítico — que a rota NÃO herdou
// "publico" por prefixo com /api/empresa (o que anularia o passo 2, suspensa/trial expirado).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dadosComVersoes() {
  const senha = hashSenha('senha1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin PRO', email: 'admin@promarking.com.br', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
      { id: 2, nome: 'Admin BRB', email: 'admin@brb.com.br', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senha },
      { id: 3, nome: 'Suporte PRO', email: 'suporte@promarking.com.br', papel: 'suporte', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 4, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1, versoes: 3 },
    empresas: [
      { id: 1, nome: 'PRO Marking', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#000', cor_secundaria: '#000', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, status: 'ativa' },
      { id: 2, nome: 'BRB', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#333', cor_secundaria: '#666', versao_id: 1, modulos_ativos: ['os_chamados'], terminologia: {}, status: 'ativa' },
    ],
    versoes: [
      { id: 1, nome: 'Básico', modulos: ['os_chamados'], preco_mensal: 199, limite_tecnicos: 3, limite_equipamentos: null },
      { id: 2, nome: 'Completo', modulos: ['os_chamados', 'biblioteca', 'comercial', 'smp_preventivas'], preco_mensal: 499, limite_tecnicos: null, limite_equipamentos: null },
    ],
    // este teste usa suas próprias 2 versões (Básico/Completo) pra testar só a troca de plano —
    // as flags evitam que a criação automática dos planos padrão (Autônomo/Manutenção/Completo,
    // ver test/migracao.test.js) ou o backfill de relatorios/equipe_avancado colidam com esse
    // fixture, já que "Completo" coincide de nome com o plano que o Super Admin cria de verdade.
    _migracaoPlanosPadraoV1: true,
    _migracaoPlanosPadraoV2: true,
    _migracaoSplitOsChamadosV1: true,
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

test('meu plano: lista com preço, troca aplica módulos/cotas, validações, papel errado recusa, isolamento entre empresas', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-meuplano-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosComVersoes()));
  const porta = 39300 + Math.floor(Math.random() * 900);

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
    const tokenAdminBrb = await login('admin@brb.com.br');
    const tokenSuportePro = await login('suporte@promarking.com.br');
    const authAdminPro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAdminPro}` };
    const authAdminBrb = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAdminBrb}` };
    const authSuportePro = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSuportePro}` };

    // listagem mostra as versões com preço e qual é a atual
    const lista = await fetch(`${base}/api/meu-plano/versoes`, { headers: authAdminPro });
    assert.equal(lista.status, 200);
    const corpoLista = await lista.json();
    assert.equal(corpoLista.versao_id_atual, 1);
    assert.equal(corpoLista.versoes.find((v) => v.id === 2).preco_mensal, 499);

    // suporte (não administrador) não pode trocar
    const negado = await fetch(`${base}/api/meu-plano`, { method: 'PUT', headers: authSuportePro, body: JSON.stringify({ versao_id: 2 }) });
    assert.equal(negado.status, 403);

    // versão inexistente é recusada
    const versaoInvalida = await fetch(`${base}/api/meu-plano`, { method: 'PUT', headers: authAdminPro, body: JSON.stringify({ versao_id: 999 }) });
    assert.equal(versaoInvalida.status, 400);

    // troca válida: aplica módulos e cotas da nova versão na hora
    const trocar = await fetch(`${base}/api/meu-plano`, { method: 'PUT', headers: authAdminPro, body: JSON.stringify({ versao_id: 2 }) });
    assert.equal(trocar.status, 200);
    const { empresa } = await trocar.json();
    assert.equal(empresa.versao_id, 2);
    assert.deepEqual(empresa.modulos_ativos.sort(), ['biblioteca', 'comercial', 'os_chamados', 'smp_preventivas'].sort());
    assert.equal(empresa.limite_tecnicos, null);

    // o módulo novo (comercial) já está ativo de verdade — confirma via rota real do módulo
    const leadsAgora = await fetch(`${base}/api/leads`, { headers: authAdminPro });
    assert.equal(leadsAgora.status, 200);

    // isolamento: a troca da PRO Marking não afeta a BRB
    const listaBrb = await fetch(`${base}/api/meu-plano/versoes`, { headers: authAdminBrb });
    assert.equal((await listaBrb.json()).versao_id_atual, 1);

    // crítico: /api/meu-plano NÃO herdou "publico" do prefixo /api/empresa. Se tivesse herdado, a
    // checagem central (que dá 401 pra toda rota não-pública sem token, antes de chamar o
    // handler) seria pulada, e só a checagem manual dentro do handler (403) sobraria. Receber 401
    // aqui confirma que passou pela checagem central — exatamente o ponto que fecha o buraco que
    // anularia o passo 2 (suspensa/trial expirado) nesta rota.
    const semToken = await fetch(`${base}/api/meu-plano/versoes`);
    assert.equal(semToken.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
