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

## Segredo do token de login (PROCONECTA_SECRET)

O token que mantém o usuário logado é assinado com uma chave secreta. Antes
de colocar em produção, defina:

```
PROCONECTA_SECRET="uma-string-longa-e-aleatória-só-sua"
```

(no Render, adicione em **Environment**, igual à `DATABASE_URL`). Sem essa
variável configurada, o sistema roda normalmente (gera uma chave aleatória
sozinho a cada vez que o processo sobe — dá pra testar local sem configurar
nada), mas **todo reinício do servidor derruba as sessões abertas**, já que
a chave muda a cada boot. Configure essa variável antes de ir pra produção
pra evitar isso — e nunca reaproveite uma chave que já apareceu em algum
lugar público (um commit antigo, um chat, etc.).

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
├── email.js        envio de e-mail (convite de acesso, cópia de relatório) — simulado por padrão
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

## Armazenamento de fotos (Supabase Storage)

Por padrão, as fotos enviadas pelos técnicos (fotos de relatório, assinaturas)
ficam numa tabela à parte no Postgres, ou numa pasta local (`fotos/`) no modo
arquivo. A pasta local **some a cada redeploy** em hospedeiros sem disco
persistente (como o Render) — pra evitar perder fotos, configure o Supabase
Storage (mesmo projeto do banco acima, se já estiver usando):

1. No painel do Supabase, vá em **Storage** e crie um bucket novo, marcado
   como **Public** (leitura pública — as fotos continuam exigindo login pra
   aparecer dentro do sistema, só o arquivo em si fica acessível por link
   direto, como qualquer imagem de site)
2. Em **Settings → API**, copie a **Project URL** e a **service_role key**
   (não é a `anon` key — essa aqui tem permissão de escrita)
3. No painel do Render, adicione em **Environment**:
   - `SUPABASE_URL`: a Project URL
   - `SUPABASE_SERVICE_KEY`: a service_role key
   - `SUPABASE_STORAGE_BUCKET`: o nome do bucket criado no passo 1 (se
     omitir, usa `fotos`)

A partir daí, toda foto **nova** vai pro Supabase Storage. Fotos que já
existiam continuam no lugar antigo (Postgres ou pasta local) e continuam
funcionando normalmente — nada quebra por não migrar. Pra mover as fotos
antigas também, rode uma vez (com as 3 variáveis acima configuradas, mais
`DATABASE_URL` se estiver em modo Postgres):

```
node scripts/migrar-fotos-supabase.js
```

O script só copia — nunca apaga nada do lugar antigo. Confirme que as fotos
abrem certo antes de limpar manualmente a tabela/pasta antiga, se quiser.

## Identificação da empresa por subdomínio

Cada empresa cadastrada no painel da Plataforma (Super Admin) pode ter um
**subdomínio** próprio (ex.: `clinica-x` em `clinica-x.proconecta.com.br`).
Quando a requisição chega por um host cujo primeiro rótulo bate com o
subdomínio de alguma empresa, o sistema usa os dados (marca, cores) e o
login daquela empresa; sem bater com nenhum subdomínio cadastrado (host
"nu", `localhost`, IP, ou simplesmente nenhuma empresa configurou
subdomínio ainda), tudo continua caindo na empresa 1 (a instalação de
origem) e o login busca o e-mail em qualquer empresa — exatamente o
comportamento de sempre, então nenhuma instalação existente precisa
configurar nada pra continuar funcionando igual.

Isso resolve o caso de duas empresas diferentes terem usuário com o mesmo
e-mail: uma vez que cada uma tenha seu subdomínio configurado (e o DNS/proxy
de fato apontando os dois hosts pro mesmo servidor), o login de cada uma
passa a ser isolado pelo host da requisição, mesmo com e-mail repetido.

Configurar o subdomínio da empresa 1 por variável de ambiente (sem precisar
do painel):

```
EMPRESA_SUBDOMINIO=promarking
```

As demais empresas configuram o subdomínio pelo próprio painel da
Plataforma (campo "Subdomínio" no cadastro/edição da empresa).

## Marca e configurações por empresa

Cada empresa tem sua própria logo, cores, dados de contato e dois valores
que antes eram fixos no código (valor do bônus de viagem por diária e o
limite de diárias/mês antes de exigir justificativa do administrador).

- **Administrador**: edita tudo isso da própria empresa no menu **Minha
  Empresa** (`PUT /api/empresa`) — nome, site, WhatsApp, telefone, cores,
  logo (upload direto, guardada do mesmo jeito que as outras fotos do
  sistema) e os dois valores de bônus de viagem.
- **Super Admin**: edita os mesmos campos de qualquer empresa pelo painel
  da Plataforma.

Sem logo própria configurada, o sistema usa a logo padrão (`/logo.png`) em
todo lugar — tela de login, cabeçalho e PDFs gerados. A logo só é
trocada de verdade quando a empresa sobe uma.

O nome que aparece como remetente nos e-mails (convite de acesso, cópia de
relatório) também já reflete o nome de cada empresa — a caixa de e-mail
técnica continua sendo a mesma configurada em `EMAIL_SMTP_USER`/
`RESEND_API_KEY` (decisão deliberada: isolar caixa de e-mail por empresa
exigiria guardar credencial de e-mail por empresa, um dado sensível a mais
pra administrar).

## Papéis supervisor e financeiro

Dois papéis novos, cadastráveis só pelo administrador geral (menu
**Usuários**):

- **Supervisor**: acesso de leitura às mesmas telas do administrador —
  Agenda geral, Relatório, Biblioteca, Clientes, Equipamentos, Usuários e
  Equipe (viagens/bônus, escala de folga, solicitações). O servidor libera
  essas rotas pra esse papel só em `GET`; toda rota de escrita continua
  exigindo `administrador`, então qualquer botão de criar/editar/excluir
  que apareça nessas telas reaproveitadas falha com 403 — a restrição é
  garantida no servidor, não só por esconder o botão.
- **Financeiro**: aprova a prestação de contas — ver seção abaixo.

## Módulo Prestação de Contas

Módulo contratável (`prestacao_contas` em `MODULOS_DISPONIVEIS`, ativado
pelo Super Admin no painel da Plataforma — não vem na versão "Manutenção"
por padrão). Despesas de viagem/campo lançadas pelo técnico (hospedagem,
alimentação, combustível, pedágio, outros), uma a uma, cada item com
descrição, valor e foto de comprovante opcional — complementa o bônus fixo
por diária (R$/diária configurável, ver "Marca e configurações por
empresa") com despesas reais e variáveis.

- **Técnico/administrador** (menu "Prestação de Contas"): lança uma
  prestação nova com um ou mais itens; acompanha o status das próprias
  (pendente/aprovado/reprovado, com o motivo quando reprovado).
- **Financeiro/administrador** (mesmo menu, fila de aprovação): vê as
  pendentes da empresa e aprova ou reprova (reprovar exige um comentário).
- **Supervisor**: lê todas (próprias telas, só leitura — ver seção acima).

Rotas: `POST /api/prestacao-contas`, `GET /api/prestacao-contas/minhas`
(`?todas=1` pra administrador/financeiro/supervisor verem de todo mundo),
`GET /api/prestacao-contas/fila`, `POST /api/prestacao-contas/:id/aprovar`,
`POST /api/prestacao-contas/:id/reprovar`.

## Cotas de plano (limite de técnicos e de equipamentos)

O Super Admin pode definir, por empresa (painel da Plataforma), um limite
de quantos usuários com papel "suporte" (técnico) e quantos equipamentos
(catálogo + unidades atreladas, juntos) aquela empresa pode cadastrar —
reflexo do plano contratado. Sem limite definido (campo vazio = `null`,
o padrão pra toda empresa existente), nada muda — é assim que o sistema
sempre funcionou.

Com um limite configurado, o servidor recusa passar da cota em qualquer
ponto de criação (`POST /api/usuarios` com `papel: "suporte"`,
`POST /api/equipamentos`, `POST /api/equipamentos/:id/atrelar`), com uma
mensagem clara pedindo pra falar com o suporte pra ampliar. Uma empresa
nova, cadastrada a partir de uma versão/pacote que já tenha
`limite_tecnicos`/`limite_equipamentos` definidos, herda esse limite —
editável depois por empresa, independente da versão original (mesmo
padrão de `modulos_ativos`).

## Painel do Super Admin: organização em dashboard → lista → tela individual

A tela "Plataforma" (menu do Super Admin) é um dashboard com 2 widgets —
"Nova empresa" e "Cadastros" — no mesmo padrão já usado em Equipe/Cadastros
de técnicos. "Cadastros" abre uma lista com um card por empresa (nome,
badge de status, contagem de administradores); clicar num card abre a
tela individual daquela empresa, com todo o formulário de edição (status e
cobrança, dados, administradores, módulos, terminologia). Antes disso,
todas as empresas cadastradas apareciam empilhadas numa página só, o que
ficava enorme e difícil de navegar com mais de uma ou duas empresas.

## Status e plano da empresa (painel do Super Admin)

Cada empresa tem um `status`: `teste` (toda empresa nova, cadastrada pelo
Super Admin a partir de agora), `ativa` (padrão de toda empresa já
existente, inclusive a instalação atual) ou `suspensa`. Suspender bloqueia
o acesso na hora: login novo recebe 403, e qualquer requisição de quem já
estava logado (o token continua "válido" por até 12h) também passa a ser
recusada no próprio despachante central de rotas — não é preciso esperar o
token expirar nem forçar logout manual. A instalação atual (empresa 1)
nunca pode ser suspensa, nem pela rota nem pelo painel (mesma trava que já
existia pra exclusão de empresa). O `super_admin` nunca é afetado, porque
não pertence a nenhuma empresa.

O painel da Plataforma também guarda, por empresa, `plano_valor_mensal` e
`plano_dia_vencimento` — só exibição, sem nenhuma integração de cobrança
nesta etapa. Os dois campos aceitam ficar em branco (`null`, o padrão de
toda empresa).

No front, qualquer resposta da API com `codigo: "empresa_suspensa"` (não só
a de login) dispara logout automático e mostra o aviso na tela de login —
isso cobre também as chamadas silenciosas em segundo plano (sino de
notificações a cada 15s, chat interno), que nunca mostravam erro nenhum
pro usuário antes dessa checagem central em `api()`.

## Tabelas indexadas por empresa (fundação multiempresa, em andamento)

Em modo Postgres, além do `app_state` (o blob JSONB de sempre, que continua
sendo a fonte de verdade que o app lê e escreve), o sistema já cria tabelas
próprias — `t_usuarios`, `t_clientes`, `t_equipamentos`, `t_agenda`,
`t_visitas`, `t_relatorios_manutencao`, `t_chamados`, `t_registros` — com
`empresa_id` indexado em todas (e também técnico + data em `t_agenda`, e
busca de texto em `t_registros`/`t_relatorios_manutencao`). É o primeiro
passo pra sair de "tudo numa linha JSONB só" pra um banco de verdade,
indexado — **ainda não é o caminho que o app usa pra ler/escrever no dia a
dia** (isso é um trabalho maior, à parte, feito aos poucos).

Pra preencher essas tabelas com um retrato dos dados de agora (não
apaga nem muda o `app_state` original — só copia):

```
DATABASE_URL="..." node scripts/migrar-para-tabelas.js
```

Pode rodar de novo quando quiser, pra atualizar o retrato — idempotente,
nunca duplica linha. O script também confere, ao final, se a contagem de
cada coleção bate entre o blob e a tabela nova.

Toda foto nova (em modo Postgres ou arquivo, sem precisar de Supabase
Storage configurado) também já guarda a empresa a que pertence — coluna
`empresa_id` na tabela `fotos`, ou um arquivo `<id>.empresa` ao lado da
foto em modo arquivo. Fotos antigas ficam com esse campo vazio (não é
usado em nenhuma rota ainda — só fundação pra uma futura conta de espaço
usado por empresa).

## E-mail de verdade (convite de acesso e cópia de relatórios)

Sem configuração, o link de primeiro acesso só aparece na tela do
administrador e no log do servidor, e o "enviar por e-mail" do relatório só é
simulado (registrado no log). Para enviar de verdade usando uma conta Gmail
ou Hotmail/Outlook comum — sem precisar de domínio próprio — defina as
variáveis de ambiente antes de rodar o servidor:

```
EMAIL_SMTP_USER=seuemail@hotmail.com
EMAIL_SMTP_SENHA=a_senha_de_app_gerada_abaixo
APP_URL=https://seu-dominio-em-producao.com.br
node server.js
```

O provedor (Gmail ou Hotmail/Outlook) é adivinhado a partir do domínio do
`EMAIL_SMTP_USER`; pra usar um domínio diferente (Google Workspace com domínio
próprio, por exemplo), defina `EMAIL_SMTP_PROVEDOR=gmail` ou `hotmail`
explicitamente.

**Importante — `EMAIL_SMTP_SENHA` não é a senha normal de login da conta.**
É uma "senha de app", específica pra esse tipo de acesso, que precisa ser
gerada separadamente:

- **Gmail**: a conta precisa ter a verificação em duas etapas ativada
  (myaccount.google.com → Segurança). Depois, em
  [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
  crie uma senha de app (qualquer nome, ex: "Pro Conecta") — copie os 16
  caracteres gerados, sem espaços.
- **Hotmail/Outlook**: em
  [account.microsoft.com/security](https://account.microsoft.com/security) →
  "Opções de segurança avançadas" → "Senhas de aplicativo" → "Criar uma nova
  senha de aplicativo". Se a conta ainda não tem verificação em duas etapas,
  o site pede pra ativar primeiro.

Alternativa (mantida por compatibilidade): `RESEND_API_KEY` +
`EMAIL_REMETENTE`, caso prefira usar o [resend.com](https://resend.com) em
vez de uma conta Gmail/Hotmail — mas esse exige domínio próprio verificado.
Se `EMAIL_SMTP_USER` estiver configurado, ele tem prioridade sobre o Resend.

Nenhuma outra mudança é necessária — veja `email.js`.

## FMEA — catálogo de falhas por modelo de equipamento (RCM/SAP PM, Fase 1 em andamento)

Primeiro passo da evolução de "registro" pra "análise de manutenção"
(aprovada depois de um relatório de impacto próprio — branch
`feature/rcm-fmea`). Fundação de dados só, ainda sem tela nem uso em
nenhuma O.S./laudo: 4 coleções novas, cadastráveis pelo administrador em
cascata —

```
Componente (preso a um modelo do catálogo de equipamentos)
  → Modo de falha (severidade/ocorrência/detecção, 1-10 — RPN = S×O×D)
    → Causa
      → Efeito
```

"Modelo do catálogo" é o mesmo conceito que já existe em Equipamentos: um
item com `cliente_id` nulo (o catálogo reutilizável, não uma unidade já
atrelada a um cliente específico). Qualquer autenticado da empresa lê
(`GET /api/fmea/componentes`, `/modos-falha`, `/causas`, `/efeitos`, cada
um filtrável pelo pai via query string — `?catalogo_id=`, `?componente_id=`
etc.); só o administrador cadastra/edita/exclui. Exclusão é bloqueada
quando já existe filho cadastrado embaixo (mesmo padrão de proteção já
usado em Equipamentos/O.S.). RPN é sempre recalculado no servidor, nunca
confiado ao que o cliente manda.

Teste: `fmea-catalogo.e2e.test.js`.

### Passo 2: `catalogo_id` nas unidades de equipamento

Até aqui, uma unidade atrelada a um cliente (`equipamentos.cliente_id`
preenchido) só sabia de qual modelo do catálogo ela veio por texto solto
— `tipo`+`modelo` copiados na hora de atrelar, sem nenhuma referência de
volta. Isso deixava o FMEA "por modelo de equipamento" frágil: um nome
digitado diferente (ou editado depois) quebrava silenciosamente o
casamento. Agora `POST /api/equipamentos/:id/atrelar` carimba
`catalogo_id` direto, com o id de verdade do catálogo de origem — e uma
migração de melhor esforço (idempotente, roda uma vez por registro) casa
as unidades que já existiam antes desse campo existir, por `tipo`+`modelo`
(sem diferenciar maiúsculas/minúsculas); quando não acha correspondência,
fica `null` sem travar nada — a unidade simplesmente não aparece
vinculada a um modelo específico até o administrador recadastrar.

Teste: `equipamentos-catalogo-id.e2e.test.js`.

### Passo 3: cascata no Laudo Técnico

A cascata Componente→Modo de falha→Causa→Efeito chegou no formulário que
o técnico preenche pra corretiva/preventiva/atendimento (o "Laudo
Técnico", tipos listados em `TIPOS_LAUDO_TECNICO`) — **100% opcional**: o
fluxo de sempre (laudo em texto livre, sem classificar nada) continua
funcionando exatamente como antes, nada foi tornado obrigatório.

- A tela só mostra os 4 selects quando o equipamento da O.S. está
  vinculado a um modelo do catálogo (`catalogo_id`, passo 2); sem isso,
  aparece um aviso explicando o motivo em vez dos campos.
- Cada nível só habilita depois que o de cima foi escolhido (não dá pra
  escolher uma Causa sem escolher o Modo de falha antes), e trocar um
  nível de cima limpa os de baixo.
- O servidor (`resolverCascataFmea` em `server.js`) valida de novo tudo
  isso na hora de salvar — nunca confia só na validação da tela — e
  resolve id **e** nome de cada nível escolhido, gravando os dois
  (denormalizado, mesmo padrão já usado em todo o sistema pra exibir sem
  precisar buscar o catálogo de novo).
- A classificação aparece na tela de detalhe/aprovação da O.S. (entre
  "Laudo técnico" e "Serviço realizado") e no PDF do laudo, só quando
  preenchida — relatórios antigos (ou novos sem classificação) continuam
  idênticos a como sempre foram.
- Ficou de fora, por decisão já registrada no relatório de impacto: o
  `relatorios_manutencao` (coleção paralela, sem `agenda_id`) e a
  Biblioteca de Defeitos/Falhas, que continuam com `causa` em texto livre.

Teste: `fmea-laudo-tecnico.e2e.test.js`.

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
