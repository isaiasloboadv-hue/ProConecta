// escopo.js — camada de escopo de acesso dentro da estrutura de filiais (versão Restaurantes/rede
// multiunidade, Fase 1 — Base). Não substitui tenant.js (isolamento entre EMPRESAS continua sendo
// só dele) — este arquivo filtra DENTRO de uma empresa já isolada, pelo nível que cada papel tem
// na hierarquia setores → filiais: administrador vê o grupo todo, coordenador_tecnico/
// consultor_mercado veem só o próprio setor, gerente_loja só a própria filial, e suporte (técnico)
// vê todas (pode atender/pedir peça em qualquer loja), com a própria loja base em destaque — ver
// seção 3 do pedido do usuário.
//
// Só entra em jogo pra empresas com o módulo "filiais" ativo — quem não usa esse módulo nunca
// chama nada daqui.

const tenant = require('./tenant.js');

const PAPEIS_ESTRUTURA_FILIAIS = ['gerente_loja', 'coordenador_tecnico', 'consultor_mercado'];

// nível de acesso do usuário dentro da estrutura de filiais da própria empresa.
//   'grupo'  -> vê tudo (administrador, supervisor)
//   'setor'  -> só as filiais do setor_id do usuário (coordenador_tecnico, consultor_mercado)
//   'filial' -> só a própria filial_id (gerente_loja)
//   'tecnico'-> vê todas as filiais, mas a própria filial_id (loja base) vem em destaque (suporte)
function escopoAcesso(user) {
  if (!user) return { nivel: 'nenhum' };
  if (user.papel === 'coordenador_tecnico' || user.papel === 'consultor_mercado') {
    return { nivel: 'setor', setor_id: user.setor_id || null, filial_id: null };
  }
  if (user.papel === 'gerente_loja') {
    return { nivel: 'filial', setor_id: null, filial_id: user.filial_id || null };
  }
  if (user.papel === 'suporte') {
    return { nivel: 'tecnico', setor_id: null, filial_id: user.filial_id || null };
  }
  // administrador, supervisor e qualquer outro papel existente (financeiro, comercial etc. não
  // participam da estrutura de filiais) veem o grupo todo, igual sempre viram a empresa toda.
  return { nivel: 'grupo', setor_id: null, filial_id: null };
}

// filiais da empresa que o usuário pode ver, já considerando o escopo dele.
function filiaisVisiveis(data, empresaId, user) {
  const todas = tenant.listar(data, 'filiais', empresaId);
  const escopo = escopoAcesso(user);
  if (escopo.nivel === 'setor') return todas.filter((f) => f.setor_id === escopo.setor_id);
  if (escopo.nivel === 'filial') return todas.filter((f) => f.id === escopo.filial_id);
  return todas; // 'grupo' e 'tecnico' veem todas
}

// uma filial específica está dentro do escopo do usuário? (pra checar em POST/PUT antes de
// aceitar um filial_id vindo do corpo da requisição)
function filialNoEscopo(data, empresaId, user, filialId) {
  if (!filialId) return false;
  return filiaisVisiveis(data, empresaId, user).some((f) => f.id === Number(filialId));
}

module.exports = { PAPEIS_ESTRUTURA_FILIAIS, escopoAcesso, filiaisVisiveis, filialNoEscopo };
