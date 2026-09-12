// auth.js — autenticação sem pacotes externos.
// Implementa um token assinado (HMAC-SHA256) equivalente em espírito a um JWT simples.

const crypto = require('crypto');

const SEGREDO = process.env.PROCONECTA_SECRET || 'troque-este-segredo-em-producao';
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
