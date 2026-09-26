// email.js — envio de e-mail (convite de primeiro acesso e cópia de relatórios).
//
// Sem credenciais configuradas, o e-mail só é registrado no console e devolvido
// na resposta da API (o admin pode copiar/repassar manualmente) — suficiente
// pra testar o fluxo de ponta a ponta sem depender de um provedor.
//
// Pra enviar e-mail de verdade usando uma conta Gmail ou Hotmail/Outlook comum
// (sem precisar de domínio próprio nem conta em provedor de e-mail transacional),
// defina as variáveis de ambiente:
//   EMAIL_SMTP_USER     (o endereço completo, ex: contato@hotmail.com)
//   EMAIL_SMTP_SENHA     (a "senha de app" dessa conta — NÃO é a senha normal de login,
//                         veja o passo a passo no README)
//   EMAIL_SMTP_PROVEDOR  (opcional — "gmail" ou "hotmail"; se não definir, é
//                         adivinhado a partir do domínio do EMAIL_SMTP_USER)
//   EMAIL_REMETENTE      (opcional — nome que aparece pro destinatário, ex:
//                         "Pro Conecta <contato@hotmail.com>"; usa o próprio
//                         EMAIL_SMTP_USER se não definir)
//   APP_URL              (ex: "https://proconecta.onrender.com" — sem isso o link do
//                         convite/ativação aponta pro endereço interno do servidor,
//                         que ninguém de fora consegue abrir)
//
// Alternativa (mantida por compatibilidade): RESEND_API_KEY, se preferir usar o
// Resend (resend.com) em vez de uma conta Gmail/Hotmail — exige domínio próprio
// verificado. Se EMAIL_SMTP_USER estiver configurado, ele tem prioridade sobre o Resend.

const nodemailer = require('nodemailer');
const dns = require('dns').promises;

const PROVEDORES_SMTP = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  hotmail: { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true },
};

function detectarProvedor(userEmail) {
  const explicito = (process.env.EMAIL_SMTP_PROVEDOR || '').toLowerCase().trim();
  if (explicito === 'gmail') return 'gmail';
  if (explicito === 'hotmail' || explicito === 'outlook') return 'hotmail';
  const dominio = (userEmail || '').split('@')[1] || '';
  if (dominio.includes('gmail')) return 'gmail';
  if (dominio.includes('hotmail') || dominio.includes('outlook') || dominio.includes('live')) return 'hotmail';
  return null;
}

let transporteCache = null;
async function obterTransporte() {
  const user = process.env.EMAIL_SMTP_USER;
  const senha = process.env.EMAIL_SMTP_SENHA;
  if (!user || !senha) return null;
  if (transporteCache) return transporteCache;

  const provedor = detectarProvedor(user);
  const config = PROVEDORES_SMTP[provedor];
  if (!config) {
    console.error(`[email] EMAIL_SMTP_USER "${user}" não é Gmail nem Hotmail/Outlook — defina EMAIL_SMTP_PROVEDOR=gmail ou hotmail explicitamente.`);
    return null;
  }

  // muitos PaaS (Render incluso) não têm rota de saída IPv6, mas o Gmail e o Outlook
  // anunciam endereço IPv6 pro próprio domínio SMTP, e o nodemailer às vezes escolhe
  // esse endereço e a conexão morre na hora com ENETUNREACH. Resolve pra IPv4 na mão e
  // conecta direto no IP — o hostname original vira só o "servername" do TLS, senão o
  // certificado do provedor (emitido pro hostname, não pro IP) não bate na validação.
  let hostConectar = config.host;
  try {
    const enderecos = await dns.resolve4(config.host);
    if (enderecos && enderecos.length) hostConectar = enderecos[0];
  } catch (e) {
    console.error(`[email] Não deu pra resolver IPv4 de ${config.host} (${e.message}) — tentando pelo hostname mesmo.`);
  }

  transporteCache = nodemailer.createTransport({
    ...config,
    host: hostConectar,
    tls: { servername: config.host },
    auth: { user, pass: senha },
    // sem isso, um provedor fora do ar ou bloqueado pela rede trava a requisição
    // (criação de usuário / envio de relatório) esperando indefinidamente
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  return transporteCache;
}

function remetente() {
  return process.env.EMAIL_REMETENTE || process.env.EMAIL_SMTP_USER || 'Pro Conecta <onboarding@proconecta.com.br>';
}

// limite duro além dos timeouts do próprio nodemailer — em algumas redes uma conexão
// bloqueada nem chega a "recusar" (fica muda), o que pode escapar do connectionTimeout;
// isso garante que a rota HTTP que chamou enviarConvite/enviarRelatorio nunca fica travada
function comLimiteDeTempo(promessa, ms) {
  promessa.catch(() => {}); // evita "unhandled rejection" quando o timeout vence a corrida
  return Promise.race([
    promessa,
    new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error(`tempo esgotado (${ms}ms)`)), ms)),
  ]);
}

async function enviarViaSmtp({ to, assunto, corpoHtml, attachments }) {
  const transporte = await obterTransporte();
  if (!transporte) return null; // sem SMTP configurado — quem chamou decide o próximo provedor/fallback
  await comLimiteDeTempo(
    transporte.sendMail({ from: remetente(), to, subject: assunto, html: corpoHtml, attachments }),
    15000
  );
  return { enviado: true, modo: 'smtp' };
}

async function enviarViaResend({ to, assunto, corpoHtml, attachments }) {
  if (!process.env.RESEND_API_KEY) return null;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: remetente(), to, subject: assunto, html: corpoHtml,
      ...(attachments ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}),
    }),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    throw new Error(`Resend respondeu ${resp.status}: ${detalhe}`);
  }
  return { enviado: true, modo: 'resend' };
}

// tenta SMTP (Gmail/Hotmail) primeiro; se estiver configurado mas falhar (provedor fora do
// ar, rede bloqueando a porta, credencial errada), cai pro Resend em vez de desistir — os
// dois podem estar configurados ao mesmo tempo, e nesse caso o Resend serve de rede de
// segurança. Só desiste (modo 'erro') se os dois estiverem configurados e os dois falharem;
// se nenhum estiver configurado, só loga no console (modo simulado, usado em desenvolvimento).
async function enviar({ to, assunto, corpoHtml, attachments, logSimulado }) {
  let houveFalha = false;

  try {
    const viaSmtp = await enviarViaSmtp({ to, assunto, corpoHtml, attachments });
    if (viaSmtp) return viaSmtp;
  } catch (e) {
    console.error('[email] Falha ao enviar via SMTP:', e.message);
    houveFalha = true;
  }

  try {
    const viaResend = await enviarViaResend({ to, assunto, corpoHtml, attachments });
    if (viaResend) return viaResend;
  } catch (e) {
    console.error('[email] Falha ao enviar via Resend:', e.message);
    houveFalha = true;
  }

  // pelo menos um provedor estava configurado e a tentativa falhou de verdade —
  // diferente de "nenhum provedor configurado" (modo simulado)
  if (houveFalha) return { enviado: false, modo: 'erro' };
  console.log('\n[email] Nenhum provedor configurado (EMAIL_SMTP_USER/EMAIL_SMTP_SENHA ou RESEND_API_KEY ausentes).');
  logSimulado();
  return { enviado: false, modo: 'simulado' };
}

async function enviarConvite({ nome, email, link }) {
  const assunto = 'Seu acesso ao Pro Conecta';
  const corpoHtml = `
    <p>Olá, ${nome}.</p>
    <p>Você foi cadastrado(a) no <b>Pro Conecta</b>. Para ativar sua conta e definir sua senha, acesse o link abaixo:</p>
    <p><a href="${link}">${link}</a></p>
    <p>Se você não esperava este e-mail, pode ignorá-lo.</p>
  `;
  const resultado = await enviar({
    to: [email], assunto, corpoHtml,
    logSimulado: () => console.log(`[email] Para: ${email} — ${link}\n`),
  });
  return { ...resultado, link };
}

async function enviarRelatorio({ emails, pdfBase64, nomeArquivo }) {
  const assunto = 'Relatório técnico — Pro Conecta';
  const corpoHtml = `<p>Segue em anexo o relatório técnico do atendimento realizado.</p>`;
  const resultado = await enviar({
    to: emails, assunto, corpoHtml,
    attachments: [{ filename: nomeArquivo, content: Buffer.from(pdfBase64, 'base64') }],
    logSimulado: () => console.log(`[email] Relatório "${nomeArquivo}" seria enviado para: ${emails.join(', ')}\n`),
  });
  return { ...resultado, destinatarios: emails };
}

module.exports = { enviarConvite, enviarRelatorio };
