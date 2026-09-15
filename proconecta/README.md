# Pro Conecta — Fase 1 (backend real)

Sistema real (não é mais protótipo clicável): login de verdade, banco de dados
que persiste em disco, e as regras de permissão por papel realmente aplicadas
no servidor.

## Como rodar

Só precisa ter o **Node.js** instalado (download em https://nodejs.org — versão
18 ou mais recente). No modo padrão (arquivo `data.json` local) não precisa de
nenhum pacote extra — só se for usar um banco Postgres de verdade (veja
"Banco de dados persistente" abaixo) é que entra o `npm install`.

```
cd proconecta
node server.js
```

Abra **http://localhost:3000** no navegador.

O banco começa **vazio** (sem usuários de exemplo) — veja "Primeiro acesso"
logo abaixo para criar a conta de administrador inicial.

## Primeiro acesso (conta de administrador master)

Como o banco começa vazio, ninguém consegue logar até existir ao menos um
usuário. Pra criar automaticamente uma conta de administrador no primeiro
boot, defina duas variáveis de ambiente antes de rodar o servidor:

```
ADMIN_EMAIL="seu@email.com.br" ADMIN_SENHA="uma-senha-forte" node server.js
```

(no Render, adicione as duas em **Environment**, igual à `DATABASE_URL`). O
sistema cria essa conta só na primeira vez — depois disso pode remover as
variáveis sem problema, ou deixar configuradas (elas não recriam a conta se
o e-mail já existir). Essa conta ("Desenvolvedor") fica marcada como
**protegida**: nenhum outro administrador consegue editá-la ou excluí-la
pela tela de Usuários (nem forçando a chamada à API diretamente) — só ela
mesma pode editar os próprios dados. A partir desse primeiro login, o
próprio administrador cadastra os demais usuários pela tela **Usuários**
(convite de primeiro acesso por e-mail — veja "E-mail de convite de
verdade" abaixo).

## O que já funciona de verdade

- **Login** com senha (hash + salt, sem senha em texto puro) e sessão por token assinado
- **Permissões reais**: o servidor recusa (403) uma ação fora do papel do usuário — ex.: técnico não consegue criar atividade, cliente não consegue cadastrar equipamento
- **Agenda geral em calendário** (administrador): calendário mensal completo, com cada dia mostrando uma bolinha com a quantidade de O.S. agendada. Clicar num dia substitui o calendário por uma **tela separada** só com os cards de O.S. daquele dia (com botão "‹ Voltar ao calendário"): tarja de status (Agendado em verde — dia do atendimento ainda não chegou; Pendente em âmbar — dia chegou mas o técnico não concluiu ou o relatório aguarda aprovação do administrador; Concluído em azul — relatório aprovado), tipo de serviço e técnico designado no topo, nome da empresa, número da O.S., contato, e-mail e telefone do cliente, vencimento (data do atendimento) e quantidade de dias desde a abertura da O.S., e um botão "Abrir" (o card fechado não mostra nenhuma ação além desse). Clicar no card ou no botão substitui essa lista por outra tela separada, só com o detalhe completo daquela O.S. e as mesmas ações disponíveis na tela de Ordem de Serviço (Aprovar, Aprovar e incluir na biblioteca, Sugerir edição, Reprovar, Reabrir/Excluir relatório, Editar/Excluir a O.S.) — ver detalhes em Ordem de Serviço, abaixo (botão "‹ Voltar para o dia"). Técnico continua vendo a própria agenda em lista.
- **Ordem de Serviço** (antes "Aprovação de visitas"): mostra todos os cards de O.S. do mês selecionado (com a mesma navegação ‹ mês › do calendário), não só as pendentes de aprovação — trocar de mês (ex.: ir pra Outubro) mostra só os cards daquele mês. Cada card fechado mostra só um botão **Abrir** — nenhuma ação aparece ali. Clicar no card ou no botão, mesmo sem relatório ainda, abre uma **tela separada** só com aquela O.S. (com botão "‹ Voltar" pra grade do mês): dados completos do atendimento, o relatório/laudo enviado pelo técnico (se houver, numa área própria e destacada), uma **linha do tempo** com a data de abertura da O.S., quando o relatório foi preenchido e enviado para análise, e quando foi aprovado ou reprovado, e as ações disponíveis pra essa O.S. Enquanto o relatório está pendente de aprovação, o administrador tem quatro opções: **Aprovar** (aprova só a O.S.), **Aprovar e incluir na biblioteca** (só aparece quando o técnico marcou o atendimento como relevante — aprova a O.S. e o registro de biblioteca vinculado de uma vez só, sem precisar ir em Biblioteca > Aprovação separadamente), **Sugerir edição** (pede um comentário obrigatório do que precisa ser corrigido, e a O.S. volta a ficar pendente pro técnico refazer e reenviar, reaproveitando o que já tinha preenchido) e **Reprovar**. Depois de aprovado, aparecem Reabrir/Excluir relatório; Editar/Excluir a própria O.S. ficam sempre disponíveis. Esse mesmo padrão (card fechado só com "Abrir", ações completas na tela de detalhe) e as mesmas ações valem também pro calendário da Agenda geral — cada ação volta pra tela de onde foi disparada (Ordem de Serviço ou o calendário), sem misturar as duas navegações. O técnico é notificado no sino sempre que o administrador aprova, reprova ou pede uma correção no relatório de uma O.S. dele. Solicitações de reabertura enviadas pelo técnico aparecem destacadas no topo, independente do mês. Os cards ficam lado a lado num grid compacto (4 a 5 por linha em telas largas, menos em telas menores), ordenados por data, todos com a mesma altura. Cada tipo de serviço tem uma cor própria na tag do topo (Corretiva em vermelho, Preventiva em verde, Treinamento online em azul, Treinamento presencial em âmbar, Demonstração Técnica em laranja), com nomes abreviados quando necessário pra caber ao lado da tag do técnico, que fica sempre na mesma posição.
- **Nova Ordem de Serviço** (administrador, botão disponível tanto na Agenda geral quanto na Ordem de Serviço): formulário organizado na ordem tipo de serviço → dados do cliente → dados do equipamento → data e horário → técnico designado. A empresa usa um menu suspenso pesquisável (não digitação livre): clicar no campo mostra todas as empresas cadastradas em ordem alfabética, e digitar filtra pelas que começam com o texto digitado; ao escolher uma da lista, filtra automaticamente os equipamentos disponíveis e pré-preenche os dados de contato. O endereço só aparece e é exigido para tipos que exigem deslocamento até o cliente — Treinamento online não pede endereço, só contato/telefone/e-mail/setor. Para Corretiva e Preventiva, também pede número de série, data de fabricação (MM/AAAA) e se o equipamento está na garantia (Sim/Não/N/A, com campo pra especificar o motivo do N/A) — esses dados ficam travados (somente leitura) pro técnico no Laudo Técnico, igual aos demais dados do atendimento.
- **Agenda**: administrador cria atividade escolhendo técnico e equipamento; técnico só vê a própria agenda ("Minha agenda"), com o status de cada O.S. refletindo o ciclo completo: "Pendente" (ainda não executada) → "Em análise" (relatório enviado, aguardando o administrador aprovar) → "Concluída" (aprovado) ou "Reprovado". A opção de solicitar reabertura só aparece depois que o relatório foi de fato aprovado.
- **Diário técnico**: técnico registra causa/correção/resultado de uma atividade preventiva/treinamento; ela fica "pendente" até o administrador aprovar. Se marcada como relevante para a Biblioteca de Defeitos/Falhas, o caso já entra na fila de aprovação da Biblioteca (status "Em análise") assim que o técnico envia o relatório — aparece tanto na tela Biblioteca > Aprovação quanto no sino de notificações do administrador — independente de a O.S. em si já ter sido aprovada ou não.
- **5 tipos de OS na agenda**: Corretiva, Preventiva, Treinamento online, Treinamento presencial e Demonstração Técnica. O tipo escolhido pelo administrador ao criar a atividade decide qual formulário o técnico preenche ao executá-la (ao finalizar qualquer um deles, aparece um **modal de confirmação** — ícone de check num círculo verde e botão "Ok" — em vez de um aviso discreto de canto de tela):
  - **Laudo Técnico** (Corretiva e Preventiva): dados do cliente/atendimento pré-preenchidos a partir do que o administrador já cadastrou na agenda — o equipamento aparece num único campo "Equipamento" (tipo — modelo), igual ao que o administrador escolhe na Nova OS —, dados do equipamento (o painel "Dados do equipamento" também mostra o mesmo campo "Equipamento" travado, em vez de um campo de marca digitável, além de data de fabricação, garantia, acessórios recebidos e defeito informado), **data de início e data de conclusão com data e hora** (a data de início vem do horário agendado da OS; a de conclusão pré-preenche com o momento atual) com período de reparo calculado automaticamente em dias e horas — a maioria dos atendimentos termina no mesmo dia, então o cálculo mostra as horas, não só "0 dias" —, laudo técnico e serviço realizado (texto livre), lista de peças fornecidas, relatório fotográfico (obrigatório ao menos 1 foto) e observações — sem checklist, aceite, avaliação ou assinatura. O rascunho é salvo automaticamente no navegador. A garantia é definida pelo administrador na abertura da OS — se ele não preencheu, o técnico não fica bloqueado ao finalizar. Ao clicar em "Finalizar", o laudo é enviado para aprovação do administrador (sem gerar PDF ainda); só depois de aprovado é que o botão "Gerar relatório (PDF)" aparece no detalhe da O.S. — com a opção de marcar como relevante para a Biblioteca de Defeitos/Falhas.
  - **Termo de Aceite** (por enquanto, só Treinamento presencial — modelo específico a confirmar): dados do atendimento pré-preenchidos, checklist de 16 itens (Sim/Não/N-A + observação), observações, aceite do cliente, avaliação de desempenho (estrelas), assinatura de cliente e técnico (desenhada na tela, funciona com o dedo no celular) e lista de e-mails para envio de cópia. Ao concluir: PDF gerado e baixado na hora, enviado por e-mail aos destinatários informados (via `email.js`), e a visita segue para aprovação do administrador.
  - **Relatório simples** (Treinamento online e Demonstração Técnica): dados do cliente e do equipamento (nº de série obrigatório só no treinamento online) + observações, sem checklist/assinatura/PDF.
  - **Excluir e reabrir**: o administrador pode excluir um relatório já concluído (removendo também o caso da biblioteca, se houver) ou reabri-lo diretamente para o técnico corrigir e reenviar. O técnico pode solicitar a reabertura de um relatório aprovado (com motivo); o administrador aprova (reabre) ou recusa o pedido na tela de Ordem de Serviço. Reabrir edita o mesmo relatório em vez de criar um duplicado, reaproveitando o que já tinha sido preenchido.
  - **Dados do atendimento definidos pelo administrador**: ao abrir a OS, o administrador preenche contato, telefone, setor e endereço completo do cliente para aquele atendimento específico (pré-preenchidos a partir do cadastro do cliente ao escolher o equipamento, mas ajustáveis — por exemplo, uma pessoa de contato diferente nesse dia). Esses dados, junto com equipamento, datas e técnico designado, aparecem **bloqueados** (somente leitura) no relatório do técnico — ele só preenche a parte operacional (checklist, observações, aceite, avaliação, assinatura). O servidor nunca aceita esses campos vindos do técnico: eles são sempre derivados da agenda, mesmo que a chamada à API seja feita diretamente.
  - **Ver relatório antes de aprovar**: na tela Ordem de Serviço, clicar num card abre o conteúdo completo (dados do atendimento, checklist item a item, observações, aceite, avaliação e as assinaturas do cliente e do técnico). Quando o técnico marcou o atendimento como relevante para a biblioteca, isso fica destacado ali e aparece a opção "Aprovar e incluir na biblioteca" — ver detalhes em Ordem de Serviço, acima.
- **Biblioteca técnica (Manual de Procedimentos e Defeitos/Falhas)**: técnico ou administrador envia um registro → fica "Em análise". Na fila de aprovação, cada item pendente aparece fechado, mostrando só um botão **Abrir** — clicar nele expande o conteúdo completo (nos procedimentos, com as fotos de cada etapa, não só a contagem) e três ações: **Aprovar** (publica), **Excluir** (remove definitivamente) ou **Sugerir edição** (comentário obrigatório, volta pro autor com status "Alteração sugerida" até ser corrigido e reenviado). Procedimentos têm passo a passo numerado com uma ou mais fotos por etapa. Cada caso mostra o autor no rodapé, e há um **ranking de técnicos** (submenu da Biblioteca) com quem mais contribuiu com casos e procedimentos aprovados.
- **Acessar biblioteca (busca primeiro)**: tanto em Defeitos/Falhas quanto em Manual de Procedimentos, a tela abre só com os campos de pesquisa (equipamento, palavra-chave e, nos defeitos, número de série) — nenhum resultado aparece antes de preencher algo e clicar em **Buscar**. Depois de buscar, aparece uma lista compacta (apenas título, equipamento e, nos defeitos, número de série); clicar num item abre uma **tela separada** com a informação individual completa (nos defeitos: sintoma/causa/solução; nos procedimentos: precauções, ferramentas e o passo a passo com as fotos de cada etapa). O botão "‹ Voltar" retorna pra lista mantendo o filtro preenchido. Quando um caso de Defeitos/Falhas é criado a partir de um Laudo Técnico aprovado ("Aprovar e incluir na biblioteca"), as fotos do relatório fotográfico do laudo agora acompanham o caso e aparecem na tela de detalhe. Na lista compacta, o administrador também vê um botão **Excluir** ao lado do "Abrir" (remove o caso definitivamente, sem precisar abrir o detalhe) — técnico e cliente veem só o "Abrir".
  - **Abrir PDF**: em ambas as telas, gera na hora (com `jsPDF`, no navegador) uma ficha técnica ilustrada de duas colunas com a identidade visual do Pro Conecta — faixa de cabeçalho azul-marinho com o logo e o nome "Pro Conecta" e uma tag colorida (vermelha para defeito, verde para procedimento); coluna esquerda tintada com foto de destaque, ferramentas/periodicidade (procedimento) ou nº de série (defeito), e a **última atualização** (data e quem atualizou); coluna direita com o conteúdo completo, títulos de seção com o mesmo azul da marca e as fotos de cada etapa/relatório fotográfico. Abre numa nova aba.
  - **Editar / Solicitar edição**: o administrador vê um botão **Editar** ao lado do "Abrir PDF" — altera o caso já publicado diretamente, sem passar pela fila de aprovação, e atualiza a data/autor da última atualização (mostrada no PDF). Qualquer técnico, por não ser dono do caso, vê em vez disso um botão **Solicitar edição** — descreve o que precisa ser corrigido e o administrador é notificado no sino; a tela **Biblioteca > Solicitações de edição** (só administrador) lista os pedidos pendentes com o comentário de quem pediu, e abrir um deles já mostra o botão Editar com o pedido destacado.
- **Cadastro de usuários por convite**: administrador cadastra nome/cargo/setor/e-mail/papel — o sistema gera um link de primeiro acesso (`/ativar.html?token=...`) onde a pessoa define a própria senha e ativa a conta (status "convite enviado" → "ativo"). Sem provedor de e-mail configurado, o link fica visível na tela para o admin copiar/repassar; veja `email.js` para plugar um provedor real.
- **Abertura de chamado**: cliente escolhe tipo de serviço, equipamento e descreve o problema; fica com status "Aberto" e aparece na lista dos próprios chamados.
- **Notificações (sino no cabeçalho)**: técnico é avisado quando uma O.S. é atribuída a ele (nova ou reatribuída num edição), quando o administrador sugere alteração num dos seus registros de biblioteca, e quando o administrador decide sobre o Laudo Técnico de uma O.S. sua — aprova (é aí que o PDF fica disponível), reprova, ou pede uma correção (nesse caso a mensagem já mostra o comentário do administrador e a O.S. volta pendente pro técnico refazer); administrador vê quantos itens de biblioteca aguardam aprovação e também quantos relatórios de O.S. o técnico já enviou e ainda não foram aprovados/reprovados/têm edição pendente. Clicar num item leva direto para a tela correspondente.
- **Menu em cascata** na lateral, com os caminhos certos abrindo automaticamente (ex.: ao clicar numa notificação).
- **Clientes**: tela de cadastro de novas empresas-cliente (nome, contato, telefone, e-mail, setor, endereço) — sem ela não havia como abrir uma O.S. pra um cliente novo, já que o campo "Empresa" na Nova OS e no cadastro de usuário só permite escolher um cliente já cadastrado no menu suspenso. Cada cliente tem botões **Editar** e **Excluir** — excluir é bloqueado se existirem usuários, ordens de serviço ou equipamentos vinculados a ele.
- **Equipamentos** (submenu com duas telas): **Cadastrar equipamento** cria um item de catálogo (só tipo/modelo, sem cliente ainda); **Atrelar equipamento** vincula um item do catálogo a um cliente específico — aqui os campos Cliente e Equipamento são menus suspensos (não digitação), e nº de série/data de fabricação/localização são digitados manualmente na hora de atrelar. Um mesmo item de catálogo pode ser atrelado a vários clientes, cada vínculo virando uma unidade física própria com seu próprio nº de série. Ao selecionar um cliente na Nova OS, só aparecem os equipamentos já atrelados a ele, com nº de série e data de fabricação pré-preenchidos e bloqueados (vêm do cadastro, não são digitados na OS). Histórico (agenda + visitas) por unidade atrelada. Cada item (catálogo ou atrelado) tem **Editar** e **Excluir** — excluir é bloqueado se houver O.S. vinculadas a esse equipamento.
- **Usuários**: administrador cadastra novos técnicos/perfis, e pode **Editar** ou **Excluir** qualquer usuário (exceto a si mesmo).
- **Ordem de Serviço**: além de aprovar/reprovar/reabrir o relatório, o administrador pode **Editar** (reabre o mesmo formulário da Nova OS, pré-preenchido, para corrigir cliente, equipamento, datas, técnico ou dados do atendimento) ou **Excluir** a O.S. inteira — excluir remove também o relatório e o registro de biblioteca vinculados, se houver.

Tudo isso é validado no servidor, não só na tela — se você abrir o DevTools do
navegador e tentar chamar a API diretamente sem permissão, o servidor recusa
do mesmo jeito.

## Onde ficam os dados

Tudo fica em `data.json`, criado automaticamente (vazio, ou já com a conta
master se `ADMIN_EMAIL`/`ADMIN_SENHA` estiverem definidas) na primeira vez que
você roda o servidor. Para começar do zero, apague esse arquivo e rode
`node server.js` de novo.

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
5. Configuração: **Runtime = Node**, **Build Command** = `npm install`,
   **Start Command** = `node server.js`
6. Clique em **Deploy** — em alguns minutos você recebe um link tipo
   `https://proconecta.onrender.com` que funciona de qualquer lugar

**Importante sobre o plano grátis do Render:** ele não tem "disco
persistente" — ou seja, sem um banco externo configurado (veja a seção
abaixo), o arquivo `data.json` (onde ficam salvos os usuários, agenda etc.)
é resetado sempre que o serviço reinicia — o que acontece a cada
atualização de código e também sozinho depois de 15 minutos sem uso (o
plano grátis "dorme" e demora uns 30-60 segundos pra acordar no primeiro
acesso seguinte — depois disso funciona normal).

Alternativas parecidas, também sem cartão: **Railway** (railway.app) e
**Fly.io** (fly.io) — o processo de deploy é bem parecido.

## Banco de dados persistente (pra não perder os dados a cada reinício)

Por padrão o sistema guarda tudo em `data.json`, que some sempre que o Render
reinicia (ver acima). Pra resolver isso de graça, o `db.js` já vem pronto pra
usar um banco **Postgres** de verdade (por exemplo, o gratuito do
[supabase.com](https://supabase.com)) — sem mudar mais nada no resto do
sistema.

1. Crie um projeto grátis no Supabase e pegue a **connection string** do
   modo **Session pooler** (funciona em rede IPv4, que é o que o Render usa —
   o modo "Direct connection" pede um complemento pago pra isso)
2. No painel do Render, vá em **Environment** e adicione uma variável:
   - Nome: `DATABASE_URL`
   - Valor: a connection string do Supabase, com a senha do banco já no lugar
     de `[YOUR-PASSWORD]` (se a senha tiver caracteres especiais como `/` ou
     `?`, eles precisam estar "percent-encoded" — ex.: `/` vira `%2F`)
3. Salve — o Render reinicia o serviço sozinho com a variável nova

A partir daí, os dados ficam no Supabase e sobrevivem a qualquer reinício,
atualização de código ou período de inatividade. Se a variável `DATABASE_URL`
não estiver definida, ou se a conexão falhar por qualquer motivo, o sistema
cai automaticamente de volta pro arquivo local — nunca fica fora do ar por
causa disso.

Pra rodar localmente com o mesmo banco (opcional, só se quiser testar antes
de configurar no Render):
```
cd proconecta
npm install
DATABASE_URL="sua-connection-string-aqui" node server.js
```

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

## Atendimento por chat (IA de 1º nível -> fila -> técnico)

O cliente inicia um atendimento pelo chat dentro do Pro Conecta (menu **Atendimento**) ou
mandando mensagem no WhatsApp da empresa — os dois caem no mesmo "chamado" e na mesma conversa.
Um assistente de IA responde primeiro, consultando a Biblioteca de Defeitos/Falhas e
Procedimentos já aprovada no sistema (nunca inventa solução fora dela — ver `ia.js`); se não
resolver, o atendimento cai na **Fila de Atendimento** do técnico, que assume a conversa — isso já
abre uma Ordem de Serviço automaticamente, com os dados do cliente pré-preenchidos. O
administrador acompanha os números do dia (total, resolvidos pela IA, por técnico, tempo médio)
no menu **Atendimentos**.

A parte da IA liga sozinha, sem depender do WhatsApp, assim que a variável abaixo existir:

```
ANTHROPIC_API_KEY=sua_chave_da_api_da_anthropic
node server.js
```

- `ANTHROPIC_API_KEY`: crie em [console.anthropic.com](https://console.anthropic.com).
- `ANTHROPIC_MODEL` (opcional): sobrescreve o modelo padrão usado.

Sem essa variável, o chat dentro do app continua funcionando normalmente — só que sem o primeiro
atendimento automático: a conversa já cai direto na fila do técnico.

### Canal WhatsApp (opcional, além do chat do app)

Pra também receber mensagens pelo WhatsApp Business e a IA responder por lá (ver `whatsapp.js`),
defina também:

```
WHATSAPP_TOKEN=token_de_acesso_do_numero_do_whatsapp_business
WHATSAPP_PHONE_ID=phone_number_id_do_meta_for_developers
WHATSAPP_VERIFY_TOKEN=uma_frase_secreta_qualquer_que_voce_inventa
```

- `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_ID`: vêm do painel do app em
  [developers.facebook.com](https://developers.facebook.com), produto WhatsApp → Configuração da
  API → aba de teste (token temporário) ou, em produção, um token de **System User** permanente.
- `WHATSAPP_VERIFY_TOKEN`: você inventa qualquer texto — só precisa ser o mesmo valor colocado
  aqui e no campo "Verify token" quando configurar a URL do webhook no painel da Meta (a URL é
  `https://seu-dominio/api/whatsapp/webhook`).

Sem essas três variáveis, o webhook do WhatsApp não faz nada — o chat dentro do app funciona
normalmente do mesmo jeito.

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
