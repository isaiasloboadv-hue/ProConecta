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

module.exports = { gerarToken, verificarToken };
