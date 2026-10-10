// testa o catálogo de Perfil/Segmento e o preset lookup (Etapa 8 — ver db.js) usados pra
// pré-preencher terminologia/tipos ativos no cadastro de empresa nova, sem travar nada depois.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

test('catálogo de perfis sempre tem "Genérico" em todo segmento', () => {
  for (const perfil of db.PERFIS_DISPONIVEIS) {
    assert.ok(perfil.segmentos.some((s) => s.chave === 'generico'), `perfil ${perfil.chave} sem segmento genérico`);
  }
});

test('CHAVES_PERFIS reflete exatamente os perfis do catálogo', () => {
  assert.deepEqual(db.CHAVES_PERFIS.sort(), db.PERFIS_DISPONIVEIS.map((p) => p.chave).sort());
});

test('presetPerfilSegmento devolve "sem restrição" pra combinação não detalhada (inclusive genérico)', () => {
  const preset = db.presetPerfilSegmento('prestadora_manutencao', 'generico');
  assert.deepEqual(preset.terminologia, {});
  assert.equal(preset.tipos_os_ativos, null);
  assert.equal(preset.tipos_relatorio_ativos, null);
  assert.equal(preset.escala_ativa, true);
});

test('presetPerfilSegmento devolve "sem restrição" pra perfil/segmento inexistente (nulls)', () => {
  const preset = db.presetPerfilSegmento(null, null);
  assert.deepEqual(preset.terminologia, {});
  assert.equal(preset.tipos_os_ativos, null);
  assert.equal(preset.tipos_relatorio_ativos, null);
  assert.equal(preset.escala_ativa, true);
});

test('presetPerfilSegmento devolve o conteúdo real configurado pra autonomo:montagem_painel_eletrico', () => {
  const preset = db.presetPerfilSegmento('autonomo', 'montagem_painel_eletrico');
  assert.equal(preset.terminologia.equipamento, 'Painel');
  assert.deepEqual(preset.tipos_os_ativos, ['corretiva', 'preventiva']);
  assert.equal(preset.escala_ativa, false);
});

test('todo tipo_os/tipo_relatorio usado nos presets existe nas listas disponíveis', () => {
  const preset = db.presetPerfilSegmento('autonomo', 'montagem_painel_eletrico');
  for (const t of preset.tipos_os_ativos) assert.ok(db.TIPOS_OS_DISPONIVEIS.includes(t), `tipo de O.S. desconhecido: ${t}`);
  for (const t of preset.tipos_relatorio_ativos) assert.ok(db.TIPOS_RELATORIO_DISPONIVEIS.includes(t), `tipo de relatório desconhecido: ${t}`);
});
