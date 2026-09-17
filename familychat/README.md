# FamilyChat

Um mini WhatsApp caseiro, só pra conversar com a família — sem cadastro em
serviço nenhum, sem depender do WhatsApp de verdade. Backend próprio em
Node.js puro (sem framework, sem pacote nenhum) e frontend simples com
atualização automática (a cada 2-4s).

## Como rodar

```
cd familychat
node server.js
```

Abra **http://localhost:3001** no navegador. Cada pessoa da família cria a
própria conta (nome + telefone + senha) na aba "Criar conta" e já aparece na
lista de contatos de quem já estiver cadastrado.

Pra rodar em rede local (todo mundo em casa no mesmo Wi-Fi acessando do
celular), descubra o IP do computador que está rodando o servidor (ex.:
`192.168.0.10`) e cada um acessa `http://192.168.0.10:3001` no navegador do
celular.

## O que já funciona

- Criar conta e entrar (senha com hash + salt, token de sessão assinado —
  mesma abordagem usada no Pro Conecta)
- Conversa individual com qualquer outro cadastrado
- Grupo com nome e vários membros
- Lista de conversas ordenada pela mais recente, com prévia da última
  mensagem e contador de não lidas
- Atualização automática (a lista de conversas a cada 4s, a conversa aberta
  a cada 2s) — não é "tempo real" via WebSocket, mas dá a sensação de chat
  vivo sem precisar de nenhuma dependência extra

## Onde ficam os dados

Tudo em `data.json` (gerado automaticamente na primeira execução, e
ignorado pelo git). Pra zerar tudo, apague o arquivo e rode `node server.js`
de novo.

## Estrutura

```
familychat/
├── server.js       servidor HTTP e rotas da API
├── db.js           acesso ao "banco" (arquivo data.json)
├── auth.js         hash de senha e token de sessão
├── data.json        dados salvos (gerado automaticamente)
└── public/          frontend
    ├── index.html
    ├── style.css     visual estilo WhatsApp
    └── app.js        lógica de tela + polling
```

## Possíveis próximos passos

- Enviar fotos/áudio (hoje só texto)
- Notificação sonora/desktop quando chega mensagem nova
- WebSocket pra atualização de verdade em tempo real, em vez de polling
- Indicador de "digitando..." e confirmação de leitura (✓✓)
