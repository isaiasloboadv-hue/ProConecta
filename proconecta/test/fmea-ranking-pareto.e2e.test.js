// RCM/FMEA Fase 1, passo 5: ranking RPN (catálogo enriquecido com ocorrências reais) e Pareto de
// falhas por componente/equipamento. Prova, pela API HTTP de verdade: (1) GET /api/fmea/modos-falha
// vem com componente_nome/catalogo_tipo/catalogo_modelo/ocorrencias_reais resolvidos; (2)
// ocorrencias_reais conta certo quantas visitas de verdade usaram aquele modo de falha; (3) o
// Pareto agrupado por componente soma e ordena certo, com percentual e percentual acumulado
// corretos; (4) o mesmo agrupado por equipamento distingue unidades diferentes do mesmo modelo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashSenha } = require('../db.js');

function dados() {
  const senha = hashSenha('senha1234');
  const agora = new Date().toISOString();
  return {
    usuarios: [
      { id: 1, nome: 'Admin', email: 'admin@x.com', papel: 'administrador', status: 'ativo', empresa_id: 1, ...senha },
    ],
    clientes: [],
    equipamentos: [
      { id: 1, empresa_id: 1, cliente_id: null, catalogo_id: null, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: '', data_fabricacao: '', localizacao: '' },
      // duas unidades DIFERENTES do mesmo modelo — pra distinguir agrupamento por equipamento vs. por componente
      { id: 2, empresa_id: 1, cliente_id: null, catalogo_id: 1, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: 'SN-001', data_fabricacao: '', localizacao: '' },
      { id: 3, empresa_id: 1, cliente_id: null, catalogo_id: 1, tipo: 'Gravadora a Laser', modelo: 'X200', numero_serie: 'SN-002', data_fabricacao: '', localizacao: '' },
    ],
    agenda: [],
    visitas: [
      // 2 ocorrências do componente "Fonte de alimentação" (modo_falha 1) — em UNIDADES diferentes (2 e 3)
      { id: 1, empresa_id: 1, agenda_id: 1, tecnico_id: 1, equipamento_id: 2, rodada: 1, criado_em: agora, analise: '', causa: '', correcao: '', resultado: 'solucionado', relevante_biblioteca: false, relatorio: null, relatorio_simples: null, status_aprovacao: 'pendente', aprovado_por: null, data_aprovacao: null, solicitacao_reabertura: null, lida_tecnico: false,
        laudo: { componente_id: 1, componente_nome: 'Fonte de alimentação', modo_falha_id: 1, modo_falha_nome: 'Queima do capacitor', causa_id: null, causa_nome: '', efeito_id: null, efeito_nome: '' } },
      { id: 2, empresa_id: 1, agenda_id: 2, tecnico_id: 1, equipamento_id: 3, rodada: 1, criado_em: agora, analise: '', causa: '', correcao: '', resultado: 'solucionado', relevante_biblioteca: false, relatorio: null, relatorio_simples: null, status_aprovacao: 'pendente', aprovado_por: null, data_aprovacao: null, solicitacao_reabertura: null, lida_tecnico: false,
        laudo: { componente_id: 1, componente_nome: 'Fonte de alimentação', modo_falha_id: 1, modo_falha_nome: 'Queima do capacitor', causa_id: null, causa_nome: '', efeito_id: null, efeito_nome: '' } },
      // 1 ocorrência de outro componente ("Motor de passo"), na mesma unidade 2
      { id: 3, empresa_id: 1, agenda_id: 3, tecnico_id: 1, equipamento_id: 2, rodada: 1, criado_em: agora, analise: '', causa: '', correcao: '', resultado: 'solucionado', relevante_biblioteca: false, relatorio: null, relatorio_simples: null, status_aprovacao: 'pendente', aprovado_por: null, data_aprovacao: null, solicitacao_reabertura: null, lida_tecnico: false,
        laudo: { componente_id: 2, componente_nome: 'Motor de passo', modo_falha_id: 2, modo_falha_nome: 'Desalinhamento', causa_id: null, causa_nome: '', efeito_id: null, efeito_nome: '' } },
      // visita sem FMEA nenhum (fluxo de sempre) — não deve entrar em nenhuma contagem
      { id: 4, empresa_id: 1, agenda_id: 4, tecnico_id: 1, equipamento_id: 2, rodada: 1, criado_em: agora, analise: '', causa: 'texto livre', correcao: '', resultado: 'solucionado', relevante_biblioteca: false, relatorio: null, relatorio_simples: null, status_aprovacao: 'pendente', aprovado_por: null, data_aprovacao: null, solicitacao_reabertura: null, lida_tecnico: false,
        laudo: { laudo_tecnico: 'x', servico_realizado: 'y' } },
    ],
    fmea_componentes: [
      { id: 1, empresa_id: 1, catalogo_id: 1, nome: 'Fonte de alimentação', criado_em: agora },
      { id: 2, empresa_id: 1, catalogo_id: 1, nome: 'Motor de passo', criado_em: agora },
    ],
    fmea_modos_falha: [
      { id: 1, empresa_id: 1, componente_id: 1, nome: 'Queima do capacitor', severidade: 8, ocorrencia: 5, deteccao: 3, rpn: 120, criado_em: agora },
      { id: 2, empresa_id: 1, componente_id: 2, nome: 'Desalinhamento', severidade: 9, ocorrencia: 2, deteccao: 7, rpn: 126, criado_em: agora },
      { id: 3, empresa_id: 1, componente_id: 1, nome: 'Modo nunca usado', severidade: 1, ocorrencia: 1, deteccao: 1, rpn: 1, criado_em: agora },
    ],
    fmea_causas: [], fmea_efeitos: [],
    _seq: { usuarios: 2, clientes: 1, equipamentos: 4, agenda: 5, visitas: 5, fmea_componentes: 3, fmea_modos_falha: 4, fmea_causas: 1, fmea_efeitos: 1 },
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

test('FMEA passo 5: ranking RPN com ocorrências reais e Pareto por componente/equipamento', async () => {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-fmea-pareto-${Date.now()}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 44200 + Math.floor(Math.random() * 900);

  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '' },
    stdio: 'ignore',
  });

  try {
    await aguardarServidorSubir(porta);
    const base = `http://localhost:${porta}`;
    const r = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@x.com', senha: 'senha1234' }),
    });
    const token = (await r.json()).token;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ranking RPN: lista enriquecida, ordenável no cliente por rpn — aqui só confere os campos
    const { modos_falha } = await (await fetch(`${base}/api/fmea/modos-falha`, { headers: auth })).json();
    assert.equal(modos_falha.length, 3);
    const capacitor = modos_falha.find((m) => m.id === 1);
    assert.equal(capacitor.componente_nome, 'Fonte de alimentação');
    assert.equal(capacitor.catalogo_tipo, 'Gravadora a Laser');
    assert.equal(capacitor.catalogo_modelo, 'X200');
    assert.equal(capacitor.ocorrencias_reais, 2);
    const desalinhamento = modos_falha.find((m) => m.id === 2);
    assert.equal(desalinhamento.ocorrencias_reais, 1);
    const nuncaUsado = modos_falha.find((m) => m.id === 3);
    assert.equal(nuncaUsado.ocorrencias_reais, 0);

    // Pareto por componente: Fonte de alimentação (2) na frente de Motor de passo (1)
    const porComponente = await (await fetch(`${base}/api/fmea/pareto?agrupar_por=componente`, { headers: auth })).json();
    assert.equal(porComponente.total, 3);
    assert.equal(porComponente.pareto.length, 2);
    assert.equal(porComponente.pareto[0].label, 'Fonte de alimentação');
    assert.equal(porComponente.pareto[0].qtd, 2);
    assert.equal(porComponente.pareto[0].percentual, 66.7);
    assert.equal(porComponente.pareto[0].percentual_acumulado, 66.7);
    assert.equal(porComponente.pareto[1].label, 'Motor de passo');
    assert.equal(porComponente.pareto[1].qtd, 1);
    assert.equal(porComponente.pareto[1].percentual_acumulado, 100);

    // Pareto por equipamento: 2 unidades diferentes (SN-001 com 1 falha, SN-002 com 1 falha) —
    // a unidade 2 (SN-001) recebeu componente 1 E componente 2 (2 visitas), a unidade 3 (SN-002) só 1
    const porEquipamento = await (await fetch(`${base}/api/fmea/pareto?agrupar_por=equipamento`, { headers: auth })).json();
    assert.equal(porEquipamento.total, 3);
    assert.equal(porEquipamento.pareto.length, 2);
    assert.equal(porEquipamento.pareto[0].label, 'Gravadora a Laser X200 (SN-001)');
    assert.equal(porEquipamento.pareto[0].qtd, 2);
    assert.equal(porEquipamento.pareto[1].label, 'Gravadora a Laser X200 (SN-002)');
    assert.equal(porEquipamento.pareto[1].qtd, 1);
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
});
