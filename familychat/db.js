// db.js — "banco de dados" em arquivo JSON local (sem dependências externas).

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const CORES_AVATAR = ['#25D366', '#128C7E', '#34B7F1', '#ECE5DD', '#FF7A59', '#8E44AD', '#E67E22', '#16A085'];

function dadosIniciais() {
  return {
    usuarios: [],
    conversas: [],
    mensagens: [],
    _seq: { usuarios: 1, conversas: 1, mensagens: 1 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  if (fs.existsSync(DB_PATH)) {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    cache = dadosIniciais();
    save(cache);
  }
  return cache;
}

function save(data) {
  cache = data;
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function nextId(data, tabela) {
  return data._seq[tabela]++;
}

function corParaId(id) {
  return CORES_AVATAR[id % CORES_AVATAR.length];
}

module.exports = { load, save, nextId, corParaId, DB_PATH };
