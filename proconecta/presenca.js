// presenca.js — fila virtual de técnicos online: distribui os atendimentos que precisam de um
// humano em round-robin entre quem está online agora, respeitando a ordem em que cada um ficou
// online (o primeiro a ficar online recebe o primeiro atendimento; o segundo recebe o segundo;
// se aparecer um terceiro atendimento com só 2 técnicos online, volta pro primeiro). Usado tanto
// pelo chat do app (server.js) quanto pelo webhook do WhatsApp (whatsapp.js).

function proximoTecnicoOnline(data) {
  const online = (data.usuarios || [])
    .filter((u) => u.papel === 'suporte' && u.online)
    .sort((a, b) => (a.online_desde || '').localeCompare(b.online_desde || ''));
  if (!online.length) return null;
  data.chamados_rr_index = data.chamados_rr_index || 0;
  const escolhido = online[data.chamados_rr_index % online.length];
  data.chamados_rr_index += 1;
  return escolhido;
}

module.exports = { proximoTecnicoOnline };
