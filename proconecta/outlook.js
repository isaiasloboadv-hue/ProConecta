// outlook.js — integração de LEITURA com o Microsoft Outlook/Microsoft 365 via Microsoft Graph.
// Pedido do usuário: "como conectar minha agenda do outlook, quero criar um menu agendamentos, e
// puxar tudo que tem na agenda do outlook" — cada técnico/administrador conecta a própria conta
// Microsoft (OAuth2, e-mail corporativo onde recebe/aceita os convites de reunião — ver print do
// usuário), o sistema só LÊ (escopo Calendars.Read), nunca cria/edita/apaga nada no Outlook dele.
//
// Variáveis de ambiente necessárias (ver README):
//   MICROSOFT_CLIENT_ID      — "Application (client) ID" do app registrado no Azure AD
//   MICROSOFT_CLIENT_SECRET  — "Client secret" (o VALOR do segredo, não o ID dele) desse app
// Sem essas duas, a integração fica desativada (ver ativa()) — o menu mostra uma mensagem
// explicando isso, sem quebrar o resto do sistema.

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
// endpoint multi-tenant "common": aceita tanto contas corporativas (Microsoft 365 de qualquer
// empresa-cliente da plataforma) quanto contas pessoais (@outlook.com, @hotmail.com) — cada
// técnico loga com a própria conta, não precisa restringir a um Tenant ID de uma empresa só.
const AUTORIDADE = 'https://login.microsoftonline.com/common';
const ESCOPOS = 'offline_access openid profile User.Read Calendars.Read';

function ativa() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function urlAutorizacao(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: ESCOPOS,
    state,
    prompt: 'select_account',
  });
  return `${AUTORIDADE}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function pedirToken(params) {
  const resp = await fetch(`${AUTORIDADE}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(dados.error_description || 'Não consegui validar a conexão com a Microsoft.');
    // o texto de error_description muda a cada chamada (tem Trace ID/Correlation ID/timestamp
    // únicos) — quem decide "esse refresh_token morreu, peça pra reconectar" tem que olhar o
    // campo curto "error" (ex.: "invalid_grant"), não tentar casar um texto que nunca repete.
    erro.codigo = dados.error || '';
    throw erro;
  }
  return dados; // { access_token, refresh_token, expires_in, ... }
}

function trocarCodigoPorToken(code, redirectUri) {
  return pedirToken(new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, scope: ESCOPOS,
  }));
}

// o refresh_token da Microsoft tem validade longa, mas pode ser revogado (usuário trocou a
// senha, desconectou o app no portal da conta etc.) — quem chama isso trata o erro marcando a
// conexão como caída e pedindo pra reconectar (ver GET /api/outlook/eventos em server.js).
function renovarToken(refreshToken) {
  return pedirToken(new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
    refresh_token: refreshToken, scope: ESCOPOS,
  }));
}

async function buscarPerfil(accessToken) {
  const resp = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error('Não consegui ler o perfil da conta Microsoft.');
  const dados = await resp.json();
  return dados.mail || dados.userPrincipalName || '';
}

// pedido do usuário: "puxar tudo que tem na agenda" — usa calendarView (expande eventos
// recorrentes em ocorrências individuais dentro do período), diferente de /events (devolveria a
// série inteira como um item só, sem dizer quando cada ocorrência realmente cai).
async function buscarEventos(accessToken, inicioISO, fimISO) {
  const params = new URLSearchParams({
    startDateTime: inicioISO, endDateTime: fimISO,
    $orderby: 'start/dateTime', $top: '150',
    $select: 'subject,start,end,location,isAllDay,organizer,webLink,showAs',
  });
  const resp = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="America/Sao_Paulo"' },
  });
  if (!resp.ok) {
    const corpo = await resp.json().catch(() => ({}));
    const erro = new Error((corpo.error && corpo.error.message) || 'Não consegui buscar os compromissos no Outlook.');
    erro.status = resp.status;
    throw erro;
  }
  const dados = await resp.json();
  return (dados.value || []).map((ev) => ({
    assunto: ev.subject || '(sem título)',
    inicio: ev.start && ev.start.dateTime,
    fim: ev.end && ev.end.dateTime,
    diaTodo: !!ev.isAllDay,
    local: (ev.location && ev.location.displayName) || '',
    organizador: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || '',
    link: ev.webLink || '',
    status: ev.showAs || '',
  }));
}

module.exports = { ativa, urlAutorizacao, trocarCodigoPorToken, renovarToken, buscarPerfil, buscarEventos };
