// agenda-email.js — alternativa ao outlook.js (Microsoft Graph/OAuth2) pra quem não tem a senha
// da própria conta Microsoft (ex.: notebook que já entra sozinho, sem o técnico nunca ter
// digitado a senha). Pedido do usuário: "A conta do e-mail já é logada no notebook, não tenho a
// senha. Eu fiz um e-mail em cópia e toda vez que recebo um e-mail no técnico9 recebi uma cópia
// ... só queria que as agendas fosse enviada pro meu sistema pode usar o e-mail em cópia" — em
// vez de login OAuth na conta do Outlook, conecta (via IMAP, usuário+senha comuns) numa CAIXA
// DIFERENTE que já recebe cópia dos convites de reunião, lê os anexos .ics desses e-mails e
// monta a mesma lista de compromissos que o outlook.js montaria via API.
//
// Importante (ver README): isso só funciona com contas que ainda permitem login IMAP por
// usuário+senha — a Microsoft vem desativando isso por padrão pra contas corporativas
// (Microsoft 365 "básico"), mas contas pessoais (Gmail, Outlook.com/Hotmail pessoal) continuam
// aceitando, desde que seja uma "senha de app" (não a senha normal de login, se a conta tiver
// verificação em duas etapas).

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// mesmos provedores já usados em email.js (envio) — aqui pro IMAP (leitura). Hosts diferentes
// dos de SMTP, mesma ideia de detectar pelo domínio do e-mail informado.
const PROVEDORES_IMAP = {
  gmail: { host: 'imap.gmail.com', port: 993 },
  // serve tanto Outlook.com/Hotmail pessoal quanto Microsoft 365 corporativo (quando o IT da
  // empresa não desativou login IMAP básico — ver aviso acima).
  outlook: { host: 'outlook.office365.com', port: 993 },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
};

function detectarProvedor(enderecoEmail) {
  const dominio = (enderecoEmail || '').split('@')[1] || '';
  if (dominio.includes('gmail')) return 'gmail';
  if (dominio.includes('outlook') || dominio.includes('hotmail') || dominio.includes('live') || dominio.includes('msn')) return 'outlook';
  if (dominio.includes('yahoo')) return 'yahoo';
  return null;
}

// testa a conexão (chamado ao salvar a conexão — pedido do usuário implícito: avisar na hora se
// a senha/host estiver errado, não só na primeira vez que for buscar eventos).
// a biblioteca espera até 90s por padrão pra desistir de conectar — tempo longo demais pra uma
// pessoa parada esperando resposta na tela (ver conectarAgendaEmail em app.js); 20s já é tempo
// de sobra pra uma conexão de verdade, e devolve erro rápido se o host/porta estiver errado ou
// a rede estiver bloqueando a porta do IMAP.
const TIMEOUT_CONEXAO_MS = 20000;

// o imapflow joga fora o texto de verdade que o servidor IMAP devolveu (ex.: "Application-
// specific password required", "IMAP access is disabled for your account") e só propaga um erro
// genérico tipo "Command failed" — o texto real fica guardado à parte, em err.responseText. Sem
// isso, a pessoa só vê "não consegui conectar" sem nenhuma pista do que corrigir.
function mensagemClara(e) {
  return (e && e.responseText) || (e && e.message) || 'Erro desconhecido.';
}

async function testarConexao({ host, port, email, senha }) {
  const client = new ImapFlow({ host, port, secure: true, auth: { user: email, pass: senha }, logger: false, connectionTimeout: TIMEOUT_CONEXAO_MS });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(mensagemClara(e));
  } finally {
    try { await client.logout(); } catch (e) { client.close(); }
  }
}

// ---------- parser de iCalendar (.ics) — só os campos que a tela usa, sem pretender cobrir o
// RFC5545 inteiro (sem expansão de recorrência RRULE, por exemplo — convite real de reunião
// vem como uma ocorrência específica, que é o caso que importa aqui). ----------

function desdobrarLinhas(texto) {
  // RFC5545: uma linha pode ser "dobrada" em várias, cada continuação começa com espaço ou tab.
  return texto.replace(/\r\n/g, '\n').split('\n').reduce((linhas, linha) => {
    if ((linha.startsWith(' ') || linha.startsWith('\t')) && linhas.length) {
      linhas[linhas.length - 1] += linha.slice(1);
    } else if (linha.trim()) {
      linhas.push(linha);
    }
    return linhas;
  }, []);
}

function desescaparTexto(valor) {
  return String(valor || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// DTSTART/DTEND podem vir como "20261007T080000Z" (UTC), "20261007T080000" (hora local — ver
// TZID abaixo) ou "20261007" (dia inteiro, com VALUE=DATE). Sem base de fuso horário embutida,
// assume América/São_Paulo pra qualquer hora "local" — razoável aqui (empresa brasileira, sem
// horário de verão desde 2019 → UTC-3 fixo); se um dia precisar de outro fuso, isso vira a
// próxima correção pontual, não trava o resto.
function parseDataIcs(valor, ehDiaInteiro) {
  if (ehDiaInteiro) {
    const ano = valor.slice(0, 4), mes = valor.slice(4, 6), dia = valor.slice(6, 8);
    return { iso: `${ano}-${mes}-${dia}T00:00:00`, diaTodo: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(valor);
  if (!m) return null;
  const [, ano, mes, dia, hora, min, seg, z] = m;
  const offset = z ? 'Z' : '-03:00';
  return { iso: `${ano}-${mes}-${dia}T${hora}:${min}:${seg}${offset}`, diaTodo: false };
}

// devolve os VEVENTs de um texto .ics, já com os campos que a tela usa. `metodo` (REQUEST/
// CANCEL/REPLY, propriedade de nível do VCALENDAR) decide se o evento deve ser tratado como
// cancelado — não dá pra saber só pelo VEVENT isoladamente.
function parseIcs(textoIcs) {
  const linhas = desdobrarLinhas(textoIcs);
  let metodo = '';
  const eventos = [];
  let atual = null;
  for (const linhaCrua of linhas) {
    const idx = linhaCrua.indexOf(':');
    if (idx < 0) continue;
    const chaveCompleta = linhaCrua.slice(0, idx);
    const valor = linhaCrua.slice(idx + 1);
    const [nome, ...params] = chaveCompleta.split(';');
    const nomeNorm = nome.toUpperCase();
    if (nomeNorm === 'METHOD') { metodo = valor.trim().toUpperCase(); continue; }
    if (nomeNorm === 'BEGIN' && valor.trim().toUpperCase() === 'VEVENT') { atual = {}; continue; }
    if (nomeNorm === 'END' && valor.trim().toUpperCase() === 'VEVENT') { if (atual) eventos.push(atual); atual = null; continue; }
    if (!atual) continue;
    if (nomeNorm === 'UID') atual.uid = valor.trim();
    else if (nomeNorm === 'SUMMARY') atual.assunto = desescaparTexto(valor);
    else if (nomeNorm === 'LOCATION') atual.local = desescaparTexto(valor);
    else if (nomeNorm === 'STATUS') atual.status = valor.trim().toUpperCase();
    else if (nomeNorm === 'SEQUENCE') atual.sequencia = Number(valor.trim()) || 0;
    else if (nomeNorm === 'ORGANIZER') {
      const cn = params.find((p) => p.toUpperCase().startsWith('CN='));
      atual.organizador = cn ? desescaparTexto(cn.slice(3).replace(/^"|"$/g, '')) : valor.replace(/^mailto:/i, '');
    } else if (nomeNorm === 'DTSTART' || nomeNorm === 'DTEND') {
      const ehDiaInteiro = params.some((p) => p.toUpperCase() === 'VALUE=DATE');
      const d = parseDataIcs(valor.trim(), ehDiaInteiro);
      if (d) {
        if (nomeNorm === 'DTSTART') { atual.inicio = d.iso; atual.diaTodo = d.diaTodo; }
        else atual.fim = d.iso;
      }
    }
  }
  return eventos
    .filter((ev) => ev.uid && ev.inicio)
    .map((ev) => ({
      uid: ev.uid,
      sequencia: ev.sequencia || 0,
      cancelado: metodo === 'CANCEL' || ev.status === 'CANCELLED',
      assunto: ev.assunto || '(sem título)',
      inicio: ev.inicio,
      fim: ev.fim || ev.inicio,
      diaTodo: !!ev.diaTodo,
      local: ev.local || '',
      organizador: ev.organizador || '',
    }));
}

// extrai o(s) VEVENT(s) de uma mensagem de e-mail já parseada pelo mailparser — o convite vem
// como um anexo/parte "text/calendar" (nomeado "invite.ics" ou sem nome, tanto faz).
function eventosDoEmail(parsed) {
  const partesCalendario = (parsed.attachments || []).filter((a) =>
    (a.contentType || '').toLowerCase().includes('text/calendar') || /\.ics$/i.test(a.filename || ''));
  const eventos = [];
  for (const parte of partesCalendario) {
    try { eventos.push(...parseIcs(parte.content.toString('utf8'))); } catch (e) { /* .ics ilegível — ignora esse e-mail, segue pros outros */ }
  }
  return eventos;
}

// pedido do usuário: "puxar tudo que tem na agenda" — varre a caixa de entrada (só leitura,
// nunca marca como lida nem move nada) atrás de convites recebidos nos últimos `janelaDias`
// dias, e devolve os compromissos cujo INÍCIO cai dentro de [inicioISO, fimISO] (não o que a
// tela pediu bate com a DATA DO E-MAIL — o convite pode ter chegado semanas antes da reunião).
async function buscarEventos({ host, port, email, senha }, inicioISO, fimISO, janelaDias = 120) {
  const client = new ImapFlow({ host, port, secure: true, auth: { user: email, pass: senha }, logger: false, connectionTimeout: TIMEOUT_CONEXAO_MS });
  const porUid = new Map();
  try {
    await client.connect();
  } catch (e) {
    throw new Error(mensagemClara(e));
  }
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const desde = new Date(Date.now() - janelaDias * 24 * 60 * 60 * 1000);
    for await (const msg of client.fetch({ since: desde }, { source: true })) {
      let parsed;
      try { parsed = await simpleParser(msg.source); } catch (e) { continue; }
      for (const ev of eventosDoEmail(parsed)) {
        // uma reunião pode ter várias versões (SEQUENCE sobe a cada edição, e o cancelamento
        // chega como um e-mail à parte) — só fica a versão mais recente de cada UID.
        const anterior = porUid.get(ev.uid);
        if (!anterior || ev.sequencia >= anterior.sequencia) porUid.set(ev.uid, ev);
      }
    }
  } finally {
    try { await client.logout(); } catch (e) { client.close(); }
  }
  return [...porUid.values()]
    .filter((ev) => !ev.cancelado && ev.inicio >= inicioISO && ev.inicio <= `${fimISO}T23:59:59`)
    .sort((a, b) => a.inicio.localeCompare(b.inicio))
    .map((ev) => ({ assunto: ev.assunto, inicio: ev.inicio, fim: ev.fim, diaTodo: ev.diaTodo, local: ev.local, organizador: ev.organizador, link: '', status: '' }));
}

module.exports = { PROVEDORES_IMAP, detectarProvedor, testarConexao, buscarEventos, parseIcs };
