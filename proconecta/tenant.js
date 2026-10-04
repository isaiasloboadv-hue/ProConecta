// tenant.js — camada central de isolamento multiempresa.
//
// O banco continua sendo um único blob (ver db.js) com todas as empresas misturadas nas mesmas
// coleções (usuarios, clientes, agenda, ...) — cada registro carrega empresa_id. Esse arquivo é o
// ÚNICO jeito permitido de ler ou criar registros dessas coleções: em vez de cada rota em
// server.js filtrar por empresa_id na mão (arriscado — um `.find` esquecido devolve dado de
// outra empresa), a regra de isolamento mora aqui, uma vez só, e todo o resto do código usa.
//
// Não filtra por "só o que o usuário pode ver dentro da empresa" (isso continua sendo
// responsabilidade de cada rota, como sempre foi) — só garante que nenhuma consulta atravessa
// pra dados de uma empresa diferente da do usuário autenticado.

const { nextId } = require('./db.js');

// todos os registros da coleção que pertencem à empresa
function listar(data, colecao, empresaId) {
  return data[colecao].filter((r) => r.empresa_id === empresaId);
}

// um registro específico por id — devolve null tanto se o id não existe quanto se existe mas é
// de outra empresa (do ponto de vista de quem chama, os dois casos são "não encontrado")
function buscar(data, colecao, id, empresaId) {
  const r = data[colecao].find((r) => r.id === id && r.empresa_id === empresaId);
  return r || null;
}

// cria um registro novo já com id sequencial e empresa_id carimbados — nunca deixa o chamador
// esquecer de marcar a empresa dona do registro
function criar(data, colecao, empresaId, registro) {
  const item = { ...registro, id: nextId(data, colecao), empresa_id: empresaId };
  data[colecao].push(item);
  return item;
}

module.exports = { listar, buscar, criar };
