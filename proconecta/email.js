// email.js — envio do e-mail de primeiro acesso.
//
// Sem credenciais configuradas, o link do convite só é registrado no console
// e devolvido na resposta da API (o admin pode copiá-lo e repassar manualmente) —
// suficiente para testar o fluxo de ponta a ponta sem depender de um provedor.
//
// Para enviar e-mail de verdade, defina as variáveis de ambiente:
//   RESEND_API_KEY   (crie uma conta grátis em resend.com)
//   EMAIL_REMETENTE  (ex: "Pro Conecta <onboarding@seudominio.com.br>")
// Nenhuma outra mudança é necessária — enviarConvite() passa a usar a API do Resend.

const REMETENTE = process.env.EMAIL_REMETENTE || 'Pro Conecta <onboarding@proconecta.com.br>';

async function enviarConvite({ nome, email, link }) {
  const assunto = 'Seu acesso ao Pro Conecta';
  const corpoHtml = `
    <p>Olá, ${nome}.</p>
    <p>Você foi cadastrado(a) no <b>Pro Conecta</b>. Para ativar sua conta e definir sua senha, acesse o link abaixo:</p>
    <p><a href="${link}">${link}</a></p>
    <p>Se você não esperava este e-mail, pode ignorá-lo.</p>
  `;

  if (!process.env.RESEND_API_KEY) {
    console.log('\n[email] Nenhum provedor configurado (RESEND_API_KEY ausente) — link de convite gerado:');
    console.log(`[email] Para: ${email} — ${link}\n`);
    return { enviado: false, modo: 'simulado', link };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: REMETENTE, to: [email], subject: assunto, html: corpoHtml }),
  });
  if (!resp.ok) {
    const detalhe = await resp.text().catch(() => '');
    console.error('[email] Falha ao enviar via Resend:', resp.status, detalhe);
    return { enviado: false, modo: 'erro', link };
  }
  return { enviado: true, modo: 'resend', link };
}

module.exports = { enviarConvite };
