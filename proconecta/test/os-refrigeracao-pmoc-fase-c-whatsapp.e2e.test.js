// pedido do usuário: pacote "Climatização / PMOC", Fase C (análise de concorrentes) — alertas
// automáticos também por WhatsApp, reaproveitando a API do WhatsApp Business já usada no
// atendimento (whatsapp.js). Prova pela API HTTP de verdade: com as credenciais configuradas
// (WHATSAPP_TOKEN/WHATSAPP_PHONE_ID) e o administrador com celular cadastrado, o sininho
// continua funcionando normalmente (o envio por WhatsApp é "melhor esforço", em paralelo, nunca
// bloqueia nem quebra a resposta — mesmo raciocínio já aplicado ao e-mail na Fase 5) — e sem as
// credenciais configuradas, o comportamento é idêntico ao de antes (nenhuma mudança visível).
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
      { id: 1, nome: 'Admin Fase C', email: 'admin@pmocC.com', papel: 'administrador', status: 'ativo', empresa_id: 1, celular: '12988887777', ...senha },
    ],
    clientes: [], equipamentos: [], agenda: [], visitas: [],
    os_refrigeracao_clientes: [], os_refrigeracao: [], os_refrigeracao_orcamentos: [],
    os_refrigeracao_agenda_config: [], os_refrigeracao_agendamentos: [],
    os_refrigeracao_pmoc_locais: [], os_refrigeracao_pmoc_ambientes: [],
    os_refrigeracao_pmoc_aparelhos: [], os_refrigeracao_pmoc_responsaveis_tecnicos: [],
    os_refrigeracao_pmoc_modelo_checklist: [], os_refrigeracao_pmoc_planos: [],
    os_refrigeracao_pmoc_qualidade_ar: [], os_refrigeracao_pmoc_config: [],
    os_refrigeracao_pmoc_gas_registros: [], os_refrigeracao_pmoc_faturas: [],
    _seq: {
      usuarios: 2, clientes: 1, equipamentos: 1, agenda: 1, visitas: 1,
      os_refrigeracao_clientes: 1, os_refrigeracao: 1, os_refrigeracao_orcamentos: 1,
      os_refrigeracao_agenda_config: 1, os_refrigeracao_agendamentos: 1,
      os_refrigeracao_pmoc_locais: 1, os_refrigeracao_pmoc_ambientes: 1,
      os_refrigeracao_pmoc_aparelhos: 1, os_refrigeracao_pmoc_responsaveis_tecnicos: 1,
      os_refrigeracao_pmoc_modelo_checklist: 1, os_refrigeracao_pmoc_planos: 1,
      os_refrigeracao_pmoc_qualidade_ar: 1, os_refrigeracao_pmoc_config: 1,
      os_refrigeracao_pmoc_gas_registros: 1, os_refrigeracao_pmoc_faturas: 1,
    },
    empresas: [
      { id: 1, nome: 'Clima Certa C', site: '', whatsapp: '', telefone: '', emails: ['contato@climacertac.com'], cor_primaria: '#000', cor_secundaria: '#000', versao_id: null, modulos_ativos: ['pmoc'], terminologia: {}, perfil: 'refrigeracao' },
    ],
    versoes: [{ id: 1, nome: 'Manutenção', modulos: [] }],
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

async function rodarComCredenciais(envExtra) {
  const dbTemp = path.join(os.tmpdir(), `proconecta-teste-pmoc-faseC-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(dbTemp, JSON.stringify(dados()));
  const porta = 45100 + Math.floor(Math.random() * 900);
  const servidor = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH_ARQUIVO: dbTemp, PORT: String(porta), ADMIN_EMAIL: '', ADMIN_SENHA: '', ...envExtra },
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
    const authAdmin = { 'Content-Type': 'application/json', Authorization: `Bearer ${await login('admin@pmocC.com')}` };

    // local com plano ativo bem atrasado — garante pelo menos 1 ocorrência de alerta pra testar
    // o disparo (dedup novo, nunca enviado antes).
    const cliente = (await (await fetch(`${base}/api/os-refrigeracao-clientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ nome: 'Cliente Fase C' }) })).json()).cliente;
    const local = (await (await fetch(`${base}/api/pmoc/locais`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ cliente_id: cliente.id, nome: 'Local Fase C', tipo_atividade: 'loja' }) })).json()).local;
    const ambiente = (await (await fetch(`${base}/api/pmoc/ambientes`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, nome: 'Sala Fase C' }) })).json()).ambiente;
    await fetch(`${base}/api/pmoc/aparelhos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ ambiente_id: ambiente.id, tipo: 'split' }) });
    const plano = (await (await fetch(`${base}/api/pmoc/planos`, { method: 'POST', headers: authAdmin, body: JSON.stringify({ local_id: local.id, data_inicio: '2000-01-10', itens: [{ descricao: 'Item', periodicidade: 'mensal', tipos_aparelho: [] }] }) })).json()).plano;
    await fetch(`${base}/api/pmoc/planos/${plano.id}/ativar?hoje=2000-01-10`, { method: 'PUT', headers: authAdmin });

    // o sininho precisa continuar respondendo normalmente (200, com o alerta de atraso presente),
    // nunca travar nem quebrar por causa do envio por WhatsApp (configurado ou não).
    const rNotif = await fetch(`${base}/api/notificacoes`, { headers: authAdmin });
    const corpo = await rNotif.json();
    return { status: rNotif.status, temAlertaAtrasada: corpo.notificacoes.some((n) => n.tipo === 'pmoc_preventiva_atrasada') };
  } finally {
    servidor.kill();
    fs.rmSync(dbTemp, { force: true });
  }
}

test('PMOC (Fase C — análise de concorrentes): alertas por WhatsApp não bloqueiam nem quebram o sininho, com ou sem credenciais configuradas', async () => {
  // sem WHATSAPP_TOKEN/WHATSAPP_PHONE_ID configurados (cenário mais comum) — comportamento
  // idêntico ao de antes desta fase.
  const semCredenciais = await rodarComCredenciais({ WHATSAPP_TOKEN: '', WHATSAPP_PHONE_ID: '', WHATSAPP_VERIFY_TOKEN: '' });
  assert.equal(semCredenciais.status, 200);
  assert.equal(semCredenciais.temAlertaAtrasada, true);

  // com credenciais "configuradas" (falsas, só pra ligar o envioAtivo()) — o envio por WhatsApp é
  // best-effort em paralelo (fetch real pro Graph API vai falhar com essas credenciais falsas,
  // mas isso nunca pode travar nem derrubar a resposta do sininho).
  const comCredenciais = await rodarComCredenciais({ WHATSAPP_TOKEN: 'token-de-teste', WHATSAPP_PHONE_ID: '000000000000000' });
  assert.equal(comCredenciais.status, 200);
  assert.equal(comCredenciais.temAlertaAtrasada, true);
});
