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

test('todo tipo_os/tipo_relatorio usado em qualquer preset existe nas listas disponíveis, e todo perfil:segmento é um par de verdade do catálogo', () => {
  for (const [chave, preset] of Object.entries(db.PRESETS_PERFIL_SEGMENTO)) {
    const [perfilChave, segmentoChave] = chave.split(':');
    const perfil = db.PERFIS_DISPONIVEIS.find((p) => p.chave === perfilChave);
    assert.ok(perfil, `preset "${chave}" usa um perfil que não existe no catálogo`);
    assert.ok(perfil.segmentos.some((s) => s.chave === segmentoChave), `preset "${chave}" usa um segmento que não pertence a esse perfil`);
    for (const t of preset.tipos_os_ativos || []) assert.ok(db.TIPOS_OS_DISPONIVEIS.includes(t), `preset "${chave}": tipo de O.S. desconhecido: ${t}`);
    for (const t of preset.tipos_relatorio_ativos || []) assert.ok(db.TIPOS_RELATORIO_DISPONIVEIS.includes(t), `preset "${chave}": tipo de relatório desconhecido: ${t}`);
  }
});

test('prestadora_manutencao:elevadores tem aceite_entrega e levantamento_tecnico (entrega formal + vistoria)', () => {
  const preset = db.presetPerfilSegmento('prestadora_manutencao', 'elevadores');
  assert.equal(preset.terminologia.equipamento, 'Elevador');
  assert.ok(preset.tipos_relatorio_ativos.includes('aceite_entrega'));
  assert.ok(preset.tipos_relatorio_ativos.includes('levantamento_tecnico'));
});

test('industria_equipe_propria (manutenção interna, sem cliente externo) nunca tem aceite_entrega nem tipos de venda/demonstração', () => {
  for (const [chave, preset] of Object.entries(db.PRESETS_PERFIL_SEGMENTO)) {
    if (!chave.startsWith('industria_equipe_propria:')) continue;
    for (const tipoVenda of ['aceite_entrega', 'entrega_teste', 'promotor', 'devolutivo', 'treinamento_online', 'treinamento_presencial', 'demonstracao_tecnica']) {
      assert.ok(!(preset.tipos_relatorio_ativos || []).includes(tipoVenda), `preset "${chave}" não devia ter ${tipoVenda}`);
      assert.ok(!(preset.tipos_os_ativos || []).includes(tipoVenda), `preset "${chave}" não devia ter ${tipoVenda}`);
    }
  }
});
