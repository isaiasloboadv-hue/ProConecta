#!/usr/bin/env node
// scripts/migrar-fotos-supabase.js — move fotos já existentes (tabela Postgres `fotos` ou pasta
// local `fotos/`) pro Supabase Storage, depois de configurar SUPABASE_URL/SUPABASE_SERVICE_KEY.
//
// NÃO apaga nada do lugar antigo — só copia pro Supabase e troca a referência no banco pra apontar
// pra URL nova. Seguro rodar mais de uma vez: uma referência que já é URL é pulada.
//
// Uso (mesmas variáveis do servidor — DATABASE_URL ou DB_PATH_ARQUIVO pra achar o banco certo):
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... node scripts/migrar-fotos-supabase.js

const db = require('../db.js');

async function migrarRefs(valor, contador) {
  if (valor && typeof valor === 'object' && !Array.isArray(valor) && typeof valor.__foto_ref === 'string' && Object.keys(valor).length === 1) {
    const ref = valor.__foto_ref;
    if (/^https?:\/\//.test(ref)) { contador.jaMigradas++; return valor; }
    const bytes = await db.carregarFotoAntiga(ref);
    if (!bytes) { contador.semDados++; return valor; }
    try {
      const novaUrl = await db.salvarFotoSupabase(bytes);
      contador.migradas++;
      return { __foto_ref: novaUrl };
    } catch (e) {
      console.error(`Falha ao migrar foto ${ref}: ${e.message}`);
      contador.falhas++;
      return valor;
    }
  }
  if (Array.isArray(valor)) {
    const novo = [];
    for (const item of valor) novo.push(await migrarRefs(item, contador));
    return novo;
  }
  if (valor && typeof valor === 'object') {
    const novo = {};
    for (const [k, v] of Object.entries(valor)) novo[k] = await migrarRefs(v, contador);
    return novo;
  }
  return valor;
}

async function main() {
  if (!db.supabaseStorageConfigurado()) {
    console.error('Configure SUPABASE_URL e SUPABASE_SERVICE_KEY antes de rodar este script.');
    process.exit(1);
  }
  await db.pronto;
  const data = db.load();
  const contador = { migradas: 0, jaMigradas: 0, semDados: 0, falhas: 0 };
  console.log('Migrando fotos pro Supabase Storage...');
  const novoData = await migrarRefs(data, contador);
  db.save(novoData);
  console.log(`Concluído: ${contador.migradas} migradas, ${contador.jaMigradas} já estavam no Supabase, ${contador.semDados} sem dado pra migrar (referência quebrada), ${contador.falhas} falharam.`);
  if (contador.falhas > 0) console.log('As que falharam continuam apontando pro lugar antigo — rode de novo depois de corrigir o problema.');
  console.log('Nada foi apagado do armazenamento antigo — confirme que as fotos abrem certo antes de limpar manualmente.');
}

main().catch((e) => { console.error(e); process.exit(1); });
