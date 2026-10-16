// auth.js — autenticação sem pacotes externos.
// Implementa um token assinado (HMAC-SHA256) equivalente em espírito a um JWT simples.

const crypto = require('crypto');

// sem PROCONECTA_SECRET configurado, gera um segredo aleatório só pra esse processo — nunca um
// valor fixo escrito no código, que qualquer um que leia o repositório (ele é público) saberia e
// poderia usar pra forjar um token válido pra qualquer usuário. É pior que travar o servidor? Não:
// com o segredo sorteado, continua dando pra testar/rodar local sem configurar nada, só que todo
// reinício do processo derruba as sessões abertas (nisso mesmo está o aviso: se isso acontecer em
// produção, o esquecimento fica visível na hora, em vez de ficar um buraco silencioso).
const SEGREDO = process.env.PROCONECTA_SECRET || (() => {
  console.warn('[auth] PROCONECTA_SECRET não configurado — usando um segredo aleatório só para este processo. Configure essa variável de ambiente antes de ir para produção (ver README), senão todo reinício do servidor derruba as sessões abertas.');
  return crypto.randomBytes(32).toString('hex');
})();
const VALIDADE_MS = 12 * 60 * 60 * 1000; // 12 horas

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function gerarToken(payload) {
  const corpo = { ...payload, exp: Date.now() + VALIDADE_MS };
  const corpoStr = base64url(JSON.stringify(corpo));
  const assinatura = crypto.createHmac('sha256', SEGREDO).update(corpoStr).digest('hex');
  return `${corpoStr}.${assinatura}`;
}

function verificarToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [corpoStr, assinatura] = token.split('.');
  const esperada = crypto.createHmac('sha256', SEGREDO).update(corpoStr).digest('hex');
  const a = Buffer.from(assinatura, 'hex');
  const b = Buffer.from(esperada, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(base64urlDecode(corpoStr));
  if (payload.exp < Date.now()) return null;
  return payload;
}

// cifrar/decifrar — AES-256-GCM com chave derivada do mesmo PROCONECTA_SECRET, pra guardar no
// banco um segredo que precisa voltar em texto puro depois (ex.: a senha de app do e-mail de
// cópia em agenda-email.js — diferente de senha de usuário, que só precisa ser CONFERIDA
// (hashSenha/conferirSenha em db.js), essa aqui precisa ser USADA de novo pra logar num IMAP).
const CHAVE_CIFRA = crypto.createHash('sha256').update(SEGREDO).digest();

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', CHAVE_CIFRA, iv);
  const corpo = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return Buffer.concat([iv, tag, corpo]).toString('base64');
}

function decifrar(textoCifrado) {
  const buf = Buffer.from(textoCifrado, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const corpo = buf.subarray(28);
  const decifra = crypto.createDecipheriv('aes-256-gcm', CHAVE_CIFRA, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(corpo), decifra.final()]).toString('utf8');
}

module.exports = { gerarToken, verificarToken, cifrar, decifrar };
