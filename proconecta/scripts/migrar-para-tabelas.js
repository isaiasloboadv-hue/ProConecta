#!/usr/bin/env node
// scripts/migrar-para-tabelas.js — Etapa 4 do briefing white label, fase 2: copia os dados das
// coleções que já têm tabela própria (t_usuarios, t_clientes, ... — ver COLECOES_EM_TABELA em
// db.js) do blob JSONB (app_state) pras tabelas novas, indexadas por empresa.
//
// NÃO apaga nem modifica o blob original — o app continua lendo/escrevendo nele normalmente até
// a etapa de corte (tenant.js passar a consultar essas tabelas de verdade, ainda não feita)
// acontecer. Esse script só preenche um retrato dos dados de agora; rodar de novo mais tarde
// atualiza o retrato (idempotente — cada linha é sobrescrita por id, nunca duplicada).
//
// Só funciona em modo Postgres (as tabelas não existem no modo arquivo).
//
// Uso: DATABASE_URL=... node scripts/migrar-para-tabelas.js

const db = require('../db.js');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Este script só funciona em modo Postgres — configure DATABASE_URL.');
    process.exit(1);
  }
  await db.pronto;
  if (!db.estaUsandoPostgres()) {
    console.error('DATABASE_URL configurada, mas a conexão com o Postgres falhou (ver log acima) — nada foi migrado.');
    process.exit(1);
  }
  const data = db.load();
  const pool = db.obterPool();

  for (const colecao of db.COLECOES_EM_TABELA) {
    const registros = data[colecao] || [];
    let ok = 0;
    let semEmpresa = 0;
    for (const r of registros) {
      if (!r.empresa_id) { semEmpresa++; continue; }
      if (colecao === 'agenda') {
        await pool.query(
          `INSERT INTO t_agenda (id, empresa_id, tecnico_id, data_hora_inicio, dados, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (id) DO UPDATE SET empresa_id = $2, tecnico_id = $3, data_hora_inicio = $4, dados = $5, atualizado_em = now()`,
          [r.id, r.empresa_id, r.tecnico_id || null, r.data_hora_inicio || null, JSON.stringify(r)]
        );
      } else {
        await pool.query(
          `INSERT INTO t_${colecao} (id, empresa_id, dados, atualizado_em)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET empresa_id = $2, dados = $3, atualizado_em = now()`,
          [r.id, r.empresa_id, JSON.stringify(r)]
        );
      }
      ok++;
    }
    console.log(`${colecao}: ${ok} migrados${semEmpresa ? `, ${semEmpresa} ignorados (sem empresa_id — ex.: super_admin)` : ''}`);
  }

  console.log('\nValidando contagens (blob vs. tabela)...');
  let tudoOk = true;
  for (const colecao of db.COLECOES_EM_TABELA) {
    const esperado = (data[colecao] || []).filter((r) => r.empresa_id).length;
    const r = await pool.query(`SELECT COUNT(*) FROM t_${colecao}`);
    const real = Number(r.rows[0].count);
    const bate = real === esperado;
    if (!bate) tudoOk = false;
    console.log(`  ${colecao}: blob=${esperado} tabela=${real} ${bate ? 'OK' : '!! DIVERGENTE'}`);
  }
  console.log(tudoOk ? '\nTudo bateu certo. Nada foi apagado do blob original.' : '\nALGUMA COLEÇÃO FICOU DIVERGENTE — confira antes de seguir.');
  process.exit(tudoOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
