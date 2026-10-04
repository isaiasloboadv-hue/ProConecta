// Etapa 4 (base multiempresa) do briefing white label — resolução de empresa pelo subdomínio.
// Prova, pela API HTTP de verdade, que: (1) GET /api/empresa devolve a marca certa conforme o
// Host da requisição; (2) duas empresas podem ter usuário com o MESMO e-mail sem conflito, desde
// que cada uma tenha subdomínio configurado e o login chegue pelo Host certo — isso resolve o
// CONFLITO #1 do diagnóstico (duplicidade de e-mail entre empresas). Mesmo padrão de
// test/isolamento-multiempresa.e2e.test.js (sobe server.js de verdade contra um data.json
// descartável).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

// o fetch global (undici) trata "Host" como cabeçalho proibido e sempre manda o host real da
// conexão, ignorando o que a gente passa — por isso esse teste precisa do http.request puro
// (que escreve o cabeçalho na requisição sem essa restrição) pra simular de verdade um proxy/DNS
// de subdomínio mandando um Host diferente do host:porta da conexão TCP.
function requisicaoComHost(porta, { method = 'GET', path: caminho, host, body }) {
  return new Promise((resolve, reject) => {
    const dadosBody = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port: porta, path: caminho, method,
      headers: {
        Host: host,
        ...(dadosBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dadosBody) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: () => JSON.parse(texto) });
      });
    });
    req.on('error', reject);
    if (dadosBody) req.write(dadosBody);
    req.end();
  });
}

function dadosDuasEmpresasComMesmoEmail() {
  const senhaA = hashSenha('senhaA1234');
  const senhaB = hashSenha('senhaB1234');
  return {
    usuarios: [
      { id: 1, nome: 'Admin Empresa A', email: 'admin@mesmoprovedor.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senhaA },
      { id: 2, nome: 'Admin Empresa B', email: 'admin@mesmoprovedor.com', papel: 'administrador', status: 'ativo', empresa_id: 2, ...senhaB },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    _seq: { usuarios: 3, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1 },
    empresas: [
      { id: 1, nome: 'Empresa A', subdominio: 'empresa-a', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#111', cor_secundaria: '#111', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca'], terminologia: {} },
      { id: 2, nome: 'Empresa B', subdominio: 'empresa-b', site: '', whatsapp: '', telefone: '', emails: [], cor_primaria: '#222', cor_secundaria: '#222', versao_id: 1, modulos_ativos: ['os_chamados', 'biblioteca'], terminologia: {} },
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

test('resolução por subdomínio: marca certa por Host e login sem conflito de e-mail entre empresas', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-subdominio-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dadosDuasEmpresasComMesmoEmail()));
  const porta = 39000 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;

    // GET /api/empresa: Host com subdomínio "empresa-b" devolve a marca da Empresa B, mesmo que a
    // instalação continue rodando normalmente em localhost/porta (nenhum DNS de verdade envolvido
    // no teste — só o cabeçalho Host, que é o que o servidor usa pra resolver).
    const empresaViaHostB = await (await requisicaoComHost(porta, { path: '/api/empresa', host: 'empresa-b.proconecta.com.br' })).json();
    assert.equal(empresaViaHostB.empresa.nome, 'Empresa B');

    const empresaViaHostA = await (await requisicaoComHost(porta, { path: '/api/empresa', host: 'empresa-a.proconecta.com.br' })).json();
    assert.equal(empresaViaHostA.empresa.nome, 'Empresa A');

    // sem subdomínio no Host (localhost, IP, domínio nu) cai na empresa 1 — comportamento de hoje,
    // preservado pra quem não configurou subdomínio nenhum.
    const empresaSemSubdominio = await (await requisicaoComHost(porta, { path: '/api/empresa', host: 'localhost' })).json();
    assert.equal(empresaSemSubdominio.empresa.nome, 'Empresa A');

    // login: mesmo e-mail nas duas empresas, mas cada Host resolve pro usuário certo.
    const loginComoB = await requisicaoComHost(porta, {
      method: 'POST', path: '/api/login', host: 'empresa-b.proconecta.com.br',
      body: { email: 'admin@mesmoprovedor.com', senha: 'senhaB1234' },
    });
    assert.equal(loginComoB.status, 200);
    const corpoB = loginComoB.json();
    assert.equal(corpoB.usuario.empresa.nome, 'Empresa B');

    const loginComoA = await requisicaoComHost(porta, {
      method: 'POST', path: '/api/login', host: 'empresa-a.proconecta.com.br',
      body: { email: 'admin@mesmoprovedor.com', senha: 'senhaA1234' },
    });
    assert.equal(loginComoA.status, 200);
    const corpoA = loginComoA.json();
    assert.equal(corpoA.usuario.empresa.nome, 'Empresa A');

    // a senha da empresa B não bate pra entrar na empresa A, mesmo e-mail igual nas duas
    const senhaErradaNaEmpresaCerta = await requisicaoComHost(porta, {
      method: 'POST', path: '/api/login', host: 'empresa-a.proconecta.com.br',
      body: { email: 'admin@mesmoprovedor.com', senha: 'senhaB1234' },
    });
    assert.equal(senhaErradaNaEmpresaCerta.status, 401);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
