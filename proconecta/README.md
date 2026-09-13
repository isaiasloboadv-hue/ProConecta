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
- **Agenda geral em calendário** (administrador): calendário mensal completo, com cada dia mostrando uma bolinha com a quantidade de O.S. agendada. Clicar num dia abre, logo abaixo, um card compacto para cada O.S. daquele dia, com: tarja de status (Agendado em verde — dia do atendimento ainda não chegou; Pendente em âmbar — dia chegou mas o técnico não concluiu ou o relatório aguarda aprovação do administrador; Concluído em azul — relatório aprovado), tipo de serviço e técnico designado no topo, nome da empresa, número da O.S., contato, e-mail e telefone do cliente, vencimento (data do atendimento) e quantidade de dias desde a abertura da O.S. Técnico continua vendo a própria agenda em lista.
- **Ordem de Serviço** (antes "Aprovação de visitas"): mostra todos os cards de O.S. do mês selecionado (com a mesma navegação ‹ mês › do calendário), não só as pendentes de aprovação. Clicar em qualquer card — aqui ou no calendário da Agenda geral, mesmo sem relatório ainda — abre um painel com tudo o que já foi feito até o momento: dados completos do atendimento, o relatório/laudo enviado pelo técnico (se houver, numa área própria e destacada) e uma **linha do tempo** com a data de abertura da O.S., quando o relatório foi preenchido e enviado para análise, e quando foi aprovado ou reprovado. Aprovar/Reprovar/Reabrir/Excluir continuam disponíveis no próprio card, sem precisar fechar o detalhe. Solicitações de reabertura enviadas pelo técnico aparecem destacadas no topo, independente do mês. Os cards ficam lado a lado num grid compacto (4 a 5 por linha em telas largas, menos em telas menores), ordenados por data, todos com a mesma altura. Cada tipo de serviço tem uma cor própria na tag do topo (Corretiva em vermelho, Preventiva em verde, Treinamento online em azul, Treinamento presencial em âmbar, Demonstração Técnica em laranja), com nomes abreviados quando necessário pra caber ao lado da tag do técnico, que fica sempre na mesma posição.
- **Nova Ordem de Serviço** (administrador, botão disponível tanto na Agenda geral quanto na Ordem de Serviço): formulário organizado na ordem tipo de serviço → dados do cliente → dados do equipamento → data e horário → técnico designado. A empresa é digitada com autocomplete (não um menu de seleção) e, ao escolher uma sugestão, filtra automaticamente os equipamentos disponíveis e pré-preenche os dados de contato. O endereço só aparece e é exigido para tipos que exigem deslocamento até o cliente — Treinamento online não pede endereço, só contato/telefone/e-mail/setor. Para Corretiva e Preventiva, também pede número de série, data de fabricação (MM/AAAA) e se o equipamento está na garantia (Sim/Não/N/A, com campo pra especificar o motivo do N/A) — esses dados ficam travados (somente leitura) pro técnico no Laudo Técnico, igual aos demais dados do atendimento.
- **Agenda**: administrador cria atividade escolhendo técnico e equipamento; técnico só vê a própria agenda
- **Diário técnico**: técnico registra causa/correção/resultado de uma atividade preventiva/treinamento; ela fica "pendente" até o administrador aprovar. Se marcada como relevante para a Biblioteca de Defeitos/Falhas, o caso já entra na fila de aprovação da Biblioteca (status "Em análise") assim que o técnico envia o relatório — aparece tanto na tela Biblioteca > Aprovação quanto no sino de notificações do administrador — independente de a O.S. em si já ter sido aprovada ou não.
- **5 tipos de OS na agenda**: Corretiva, Preventiva, Treinamento online, Treinamento presencial e Demonstração Técnica. O tipo escolhido pelo administrador ao criar a atividade decide qual formulário o técnico preenche ao executá-la:
  - **Laudo Técnico** (Corretiva e Preventiva): dados do cliente/atendimento pré-preenchidos a partir do que o administrador já cadastrou na agenda, dados do equipamento (marca, data de fabricação, garantia, acessórios recebidos, defeito informado), datas de entrada/conclusão com período de reparo calculado automaticamente, laudo técnico e serviço realizado (texto livre), lista de peças fornecidas, relatório fotográfico (obrigatório ao menos 1 foto) e observações — sem checklist, aceite, avaliação ou assinatura. O rascunho é salvo automaticamente no navegador. Ao concluir: um PDF do laudo é gerado e baixado na hora, e a visita segue para aprovação do administrador — com a opção de marcar como relevante para a Biblioteca de Defeitos/Falhas.
  - **Termo de Aceite** (por enquanto, só Treinamento presencial — modelo específico a confirmar): dados do atendimento pré-preenchidos, checklist de 16 itens (Sim/Não/N-A + observação), observações, aceite do cliente, avaliação de desempenho (estrelas), assinatura de cliente e técnico (desenhada na tela, funciona com o dedo no celular) e lista de e-mails para envio de cópia. Ao concluir: PDF gerado e baixado na hora, enviado por e-mail aos destinatários informados (via `email.js`), e a visita segue para aprovação do administrador.
  - **Relatório simples** (Treinamento online e Demonstração Técnica): dados do cliente e do equipamento (nº de série obrigatório só no treinamento online) + observações, sem checklist/assinatura/PDF.
  - **Excluir e reabrir**: o administrador pode excluir um relatório já concluído (removendo também o caso da biblioteca, se houver) ou reabri-lo diretamente para o técnico corrigir e reenviar. O técnico pode solicitar a reabertura de um relatório aprovado (com motivo); o administrador aprova (reabre) ou recusa o pedido na tela de Ordem de Serviço. Reabrir edita o mesmo relatório em vez de criar um duplicado, reaproveitando o que já tinha sido preenchido.
  - **Dados do atendimento definidos pelo administrador**: ao abrir a OS, o administrador preenche contato, telefone, setor e endereço completo do cliente para aquele atendimento específico (pré-preenchidos a partir do cadastro do cliente ao escolher o equipamento, mas ajustáveis — por exemplo, uma pessoa de contato diferente nesse dia). Esses dados, junto com equipamento, datas e técnico designado, aparecem **bloqueados** (somente leitura) no relatório do técnico — ele só preenche a parte operacional (checklist, observações, aceite, avaliação, assinatura). O servidor nunca aceita esses campos vindos do técnico: eles são sempre derivados da agenda, mesmo que a chamada à API seja feita diretamente.
  - **Abrir relatório antes de aprovar**: na fila de aprovação, cada visita pendente ou já concluída tem um botão "Abrir relatório" que expande o conteúdo completo (dados do atendimento, checklist item a item, observações, aceite, avaliação e as assinaturas do cliente e do técnico) direto na tela, sem precisar sair da fila. Quando o técnico marcou o atendimento como relevante para a biblioteca, isso fica destacado ali e o botão de aprovar já avisa "Aprovar e incluir na biblioteca".
- **Biblioteca técnica (Manual de Procedimentos e Defeitos/Falhas)**: técnico ou administrador envia um registro → fica "Em análise" → administrador **aprova** (publica) ou **sugere alteração** (comentário obrigatório, volta pro autor com status "Alteração sugerida" até ser corrigido e reenviado). Procedimentos têm passo a passo numerado com uma ou mais fotos por etapa. Biblioteca pesquisável por equipamento, palavra-chave e (nos defeitos) número de série. Cada caso mostra o autor no rodapé, e há um **ranking de técnicos** (submenu da Biblioteca) com quem mais contribuiu com casos e procedimentos aprovados.
- **Cadastro de usuários por convite**: administrador cadastra nome/cargo/setor/e-mail/papel — o sistema gera um link de primeiro acesso (`/ativar.html?token=...`) onde a pessoa define a própria senha e ativa a conta (status "convite enviado" → "ativo"). Sem provedor de e-mail configurado, o link fica visível na tela para o admin copiar/repassar; veja `email.js` para plugar um provedor real.
- **Abertura de chamado**: cliente escolhe tipo de serviço, equipamento e descreve o problema; fica com status "Aberto" e aparece na lista dos próprios chamados.
- **Notificações (sino no cabeçalho)**: técnico é avisado quando o administrador sugere alteração num dos seus registros; administrador vê quantos itens aguardam aprovação. Clicar num item leva direto para a tela correspondente.
- **Menu em cascata** na lateral, com os caminhos certos abrindo automaticamente (ex.: ao clicar numa notificação).
- **Clientes**: tela de cadastro de novas empresas-cliente (nome, contato, telefone, e-mail, setor, endereço) — sem ela não havia como abrir uma O.S. pra um cliente novo, já que o campo "Empresa" na Nova OS e no cadastro de usuário exige digitar o nome de um cliente já cadastrado.
- **Equipamentos** (submenu com duas telas): **Cadastrar equipamento** cria um item de catálogo (só tipo/modelo, sem cliente ainda); **Atrelar equipamento** vincula um item do catálogo a um cliente específico — aqui os campos Cliente e Equipamento são menus suspensos (não digitação), e nº de série/data de fabricação/localização são digitados manualmente na hora de atrelar. Um mesmo item de catálogo pode ser atrelado a vários clientes, cada vínculo virando uma unidade física própria com seu próprio nº de série. Ao selecionar um cliente na Nova OS, só aparecem os equipamentos já atrelados a ele, com nº de série e data de fabricação pré-preenchidos e bloqueados (vêm do cadastro, não são digitados na OS). Histórico (agenda + visitas) por unidade atrelada.
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
