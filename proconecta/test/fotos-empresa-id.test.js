// Etapa 4 (base multiempresa), passo 5 do plano: empresa_id nas fotos. Aditivo e reversível — só
// adiciona um metadado novo (coluna/arquivo), nunca muda o conteúdo da foto em si nem o
// comportamento de quem chama salvarFoto/carregarFoto sem informar empresaId (continua
// funcionando exatamente como antes). Testa os dois modos (arquivo e Postgres, quando disponível)
// contra uma instância isolada de db.js por modo, igual ao padrão do resto do projeto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function carregarDbIsolado(env) {
  delete require.cache[require.resolve('../db.js')];
  const anteriores = {};
  for (const [k, v] of Object.entries(env)) { anteriores[k] = process.env[k]; process.env[k] = v; }
  const db = require('../db.js');
  return { db, restaurar: () => { for (const [k, v] of Object.entries(anteriores)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test('modo arquivo: salvarFoto grava empresa_id num arquivo irmão, sem tocar na foto original', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-fotos-empresa-${Date.now()}.json`);
  const { db, restaurar } = carregarDbIsolado({ DB_PATH_ARQUIVO: dbTemp, DATABASE_URL: '' });
  try {
    await db.pronto;
    const fotoBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

    // sem empresaId (chamada antiga) continua funcionando igual, sem gravar metadado nenhum
    const idSemEmpresa = await db.salvarFoto(fotoBase64);
    assert.equal(await db.carregarFoto(idSemEmpresa), fotoBase64);
    assert.equal(await db.empresaIdDaFoto(idSemEmpresa), null);

    // com empresaId, a foto abre exatamente igual, e o metadado novo fica disponível à parte
    const idComEmpresa = await db.salvarFoto(fotoBase64, 7);
    assert.equal(await db.carregarFoto(idComEmpresa), fotoBase64);
    assert.equal(await db.empresaIdDaFoto(idComEmpresa), 7);
  } finally {
    restaurar();
    fs.rmSync(dbTemp, { force: true });
    fs.rmSync(path.join(__dirname, '..', 'fotos'), { recursive: true, force: true });
  }
});

test('modo Postgres: coluna empresa_id em "fotos" aceita null (fotos antigas) e valor novo', async (t) => {
  if (!process.env.DATABASE_URL_TESTE_LOCAL) {
    t.skip('defina DATABASE_URL_TESTE_LOCAL pra rodar este teste contra um Postgres local');
    return;
  }
  const { db, restaurar } = carregarDbIsolado({ DATABASE_URL: process.env.DATABASE_URL_TESTE_LOCAL, DB_PATH_ARQUIVO: '' });
  try {
    await db.pronto;
    assert.ok(db.estaUsandoPostgres(), 'esperava conectar no Postgres local de teste');
    const fotoBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==';

    const idSemEmpresa = await db.salvarFoto(fotoBase64);
    assert.equal(await db.empresaIdDaFoto(idSemEmpresa), null);

    const idComEmpresa = await db.salvarFoto(fotoBase64, 3);
    assert.equal(await db.carregarFoto(idComEmpresa), fotoBase64);
    assert.equal(await db.empresaIdDaFoto(idComEmpresa), 3);
  } finally {
    restaurar();
  }
});
