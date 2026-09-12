# Pro Conecta — Fase 1 (backend real)

Sistema real (não é mais protótipo clicável): login de verdade, banco de dados
que persiste em disco, e as regras de permissão por papel realmente aplicadas
no servidor.

## Como rodar

Só precisa ter o **Node.js** instalado (download em https://nodejs.org — versão
18 ou mais recente). Não precisa instalar nenhum pacote extra: o projeto não
usa `npm install`.

```
cd proconecta
node server.js
```

Abra **http://localhost:3000** no navegador.

Contas de teste (senha para todas: `123456`):

| Papel | E-mail |
|---|---|
| Administrador | admin@proconecta.com.br |
| Técnico | isaias@proconecta.com.br |
| Cliente | cliente@abc.com.br |

## O que já funciona de verdade

- **Login** com senha (hash + salt, sem senha em texto puro) e sessão por token assinado
- **Permissões reais**: o servidor recusa (403) uma ação fora do papel do usuário — ex.: técnico não consegue criar atividade, cliente não consegue cadastrar equipamento
- **Agenda**: administrador cria atividade escolhendo técnico e equipamento; técnico só vê a própria agenda
- **Diário técnico**: técnico registra causa/correção/resultado de uma atividade preventiva/treinamento; ela fica "pendente" até o administrador aprovar (e, se marcada como relevante, já entra aprovada na Biblioteca de Defeitos/Falhas)
- **5 tipos de OS na agenda**: Corretiva, Preventiva, Treinamento online, Treinamento presencial e Demonstração Técnica. O tipo escolhido pelo administrador ao criar a atividade decide qual formulário o técnico preenche ao executá-la:
  - **Relatório técnico completo** (Corretiva, Preventiva, Treinamento presencial): dados do cliente/atendimento pré-preenchidos a partir do que o administrador já cadastrou na agenda, checklist de 16 itens (Sim/Não/N-A + observação), observações, aceite do cliente, avaliação de desempenho (estrelas), assinatura de cliente e técnico (desenhada na tela, funciona com o dedo no celular) e lista de e-mails para envio de cópia. O rascunho é salvo automaticamente no navegador enquanto o técnico preenche. Ao concluir: um PDF do relatório é gerado e baixado na hora, enviado por e-mail aos destinatários informados (via `email.js`), e a visita segue para aprovação do administrador — com a opção de marcar como relevante para a Biblioteca de Defeitos/Falhas.
  - **Relatório simples** (Treinamento online e Demonstração Técnica): dados do cliente e do equipamento (nº de série obrigatório só no treinamento online) + observações, sem checklist/assinatura/PDF.
  - **Excluir e reabrir**: o administrador pode excluir um relatório já concluído (removendo também o caso da biblioteca, se houver) ou reabri-lo diretamente para o técnico corrigir e reenviar. O técnico pode solicitar a reabertura de um relatório aprovado (com motivo); o administrador aprova (reabre) ou recusa o pedido na tela de Aprovação de visitas. Reabrir edita o mesmo relatório em vez de criar um duplicado, reaproveitando o que já tinha sido preenchido.
- **Biblioteca técnica (Manual de Procedimentos e Defeitos/Falhas)**: técnico ou administrador envia um registro → fica "Em análise" → administrador **aprova** (publica) ou **sugere alteração** (comentário obrigatório, volta pro autor com status "Alteração sugerida" até ser corrigido e reenviado). Procedimentos têm passo a passo numerado com uma ou mais fotos por etapa. Biblioteca pesquisável por equipamento, palavra-chave e (nos defeitos) número de série. Cada caso mostra o autor no rodapé, e há um **ranking de técnicos** (submenu da Biblioteca) com quem mais contribuiu com casos e procedimentos aprovados.
- **Cadastro de usuários por convite**: administrador cadastra nome/cargo/setor/e-mail/papel — o sistema gera um link de primeiro acesso (`/ativar.html?token=...`) onde a pessoa define a própria senha e ativa a conta (status "convite enviado" → "ativo"). Sem provedor de e-mail configurado, o link fica visível na tela para o admin copiar/repassar; veja `email.js` para plugar um provedor real.
- **Abertura de chamado**: cliente escolhe tipo de serviço, equipamento e descreve o problema; fica com status "Aberto" e aparece na lista dos próprios chamados.
- **Notificações (sino no cabeçalho)**: técnico é avisado quando o administrador sugere alteração num dos seus registros; administrador vê quantos itens aguardam aprovação. Clicar num item leva direto para a tela correspondente.
- **Menu em cascata** na lateral, com os caminhos certos abrindo automaticamente (ex.: ao clicar numa notificação).
- **Equipamentos**: cadastro e histórico (agenda + visitas) por equipamento
- **Usuários**: administrador cadastra novos técnicos/perfis

Tudo isso é validado no servidor, não só na tela — se você abrir o DevTools do
navegador e tentar chamar a API diretamente sem permissão, o servidor recusa
do mesmo jeito.

## Onde ficam os dados

Tudo fica em `data.json`, criado automaticamente na primeira vez que você roda
o servidor (com os dados de teste acima). Para começar do zero, apague esse
arquivo e rode `node server.js` de novo.

## Estrutura do projeto

```
proconecta/
├── server.js       servidor HTTP e todas as rotas da API
├── db.js           acesso ao "banco de dados" (arquivo data.json)
├── auth.js         hash de senha e token de sessão
├── email.js        envio do e-mail de primeiro acesso (simulado por padrão)
├── data.json        os dados salvos (gerado automaticamente)
└── public/          o que o navegador carrega
    ├── index.html
    ├── ativar.html   tela pública de ativação de conta (link do convite)
    ├── style.css
    └── app.js        toda a lógica de tela, chamando a API real
```

## Por que sem framework (Express) e sem SQLite?

Rodei este protótipo em um ambiente sem acesso à internet, então não consegui
baixar pacotes do npm (`express`, `sqlite3`, `jsonwebtoken` etc.). Por isso
escrevi tudo só com os módulos que já vêm dentro do Node.js — funciona igual,
só que sem instalação nenhuma. É só trocar de lugar quando quiser evoluir:

- Trocar `data.json` por Postgres/SQLite de verdade: só mexe em `db.js`,
  o resto do código não muda.
- Trocar o roteamento manual por Express: só mexe em `server.js`.

## Colocar no ar de graça (sem precisar deixar seu computador ligado)

A opção mais simples sem cartão de crédito é o **Render** (render.com):

1. Crie uma conta grátis no **GitHub** (github.com) se ainda não tiver
2. Crie um repositório novo e suba esta pasta `proconecta` nele (pelo site
   mesmo dá pra arrastar os arquivos, não precisa saber usar Git por linha de
   comando)
3. Crie uma conta grátis no **Render** (render.com) — não pede cartão
4. No painel do Render: **New +** → **Web Service** → conecte esse repositório
5. Configuração: **Runtime = Node**, **Build Command** deixe em branco,
   **Start Command** = `node server.js`
6. Clique em **Deploy** — em alguns minutos você recebe um link tipo
   `https://proconecta.onrender.com` que funciona de qualquer lugar

**Importante sobre o plano grátis do Render:** ele não tem "disco
persistente" — ou seja, o arquivo `data.json` (onde ficam salvos os
usuários, agenda, etc.) pode ser resetado sempre que você atualizar o
código. Ótimo pra testar e mostrar pra outras pessoas; quando for para uso
real do dia a dia, aí sim vale migrar para um banco de dados de verdade
(Postgres, que o próprio Render oferece com um plano pago barato) — troca só
em `db.js`, o resto do sistema não muda. O plano grátis também "dorme" depois
de 15 minutos sem uso e demora uns 30-60 segundos pra acordar no primeiro
acesso seguinte — depois disso funciona normal.

Alternativas parecidas, também sem cartão: **Railway** (railway.app) e
**Fly.io** (fly.io) — o processo de deploy é bem parecido.

## E-mail de convite de verdade

Sem configuração, o link de primeiro acesso só aparece na tela do
administrador e no log do servidor. Para enviar por e-mail de verdade, crie
uma conta grátis em [resend.com](https://resend.com) e defina as variáveis de
ambiente antes de rodar o servidor:

```
RESEND_API_KEY=sua_chave_aqui
EMAIL_REMETENTE="Pro Conecta <onboarding@seudominio.com.br>"
APP_URL=https://seu-dominio-em-producao.com.br
node server.js
```

Nenhuma outra mudança é necessária — veja `email.js`.

## Referências do projeto

A pasta `docs/` (na raiz do repositório) guarda o briefing original do
projeto e o protótipo estático de referência (`biblioteca.html`) que
inspirou o layout e o comportamento da Biblioteca técnica.

## Próximos passos (Fase 2 do documento de especificação)

- Perfis Supervisor e Financeiro
- Cotas de técnico por mês
- Prestação de contas com upload de nota fiscal
- Notificação por e-mail/WhatsApp além do sino
- Fluxo de chamado com orçamento (cliente aprova ou não)
- Upload de fotos em armazenamento de arquivos (S3/Supabase Storage) em vez de base64
- Agenda técnica / calendário do administrador
