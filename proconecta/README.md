# Pro Conecta — Fase 1 (backend real, com banco Postgres)

Sistema real: login de verdade, banco de dados Postgres (fica salvo pra
sempre, não reseta), e as regras de permissão por papel aplicadas no
servidor.

## Passo 1 — criar o banco de dados grátis (Neon)

1. Acesse **neon.tech** e crie uma conta grátis (não pede cartão)
2. Crie um projeto novo (pode chamar de "proconecta")
3. No painel do projeto, procure o botão **"Connection string"** (ou
   "Connect") e copie a linha que começa com `postgresql://...`
4. Guarde essa linha — é a `DATABASE_URL`

## Passo 2 — rodar no seu computador (opcional, pra testar antes)

Precisa do **Node.js** instalado (nodejs.org, versão 18+) e de internet na
hora de instalar o pacote do banco.

```
cd proconecta
npm install
cp .env.example .env
```

Abra o arquivo `.env` e cole sua `DATABASE_URL` do Neon no lugar do exemplo.
Depois:

```
node server.js
```

Abra **http://localhost:3000**. Na primeira vez, o sistema cria as tabelas e
os usuários de teste sozinho — você vai ver no terminal "Banco vazio —
inserindo dados de teste...".

Contas de teste (senha para todas: `123456`):

| Papel | E-mail |
|---|---|
| Administrador | admin@proconecta.com.br |
| Técnico | isaias@proconecta.com.br |
| Cliente | cliente@abc.com.br |

## Passo 3 — colocar no ar (Render)

1. Suba a pasta `proconecta` pro seu repositório no GitHub (o `.env` não vai
   junto — ele está no `.gitignore` de propósito, por segurança)
2. Crie uma conta grátis no **Render** (render.com) — não pede cartão
3. **New +** → **Web Service** → conecte o repositório
4. Runtime: **Node** · Build Command: `npm install` · Start Command:
   `node server.js`
5. Antes de clicar em Deploy, vá em **Environment** e adicione a variável
   `DATABASE_URL` colando a mesma connection string do Neon
6. Deploy — em alguns minutos você tem um link tipo
   `https://proconecta.onrender.com`

Como os dados agora vivem no Neon (não no Render), **atualizar o código no
Render não apaga nada** — pode fazer deploy quantas vezes quiser.

O plano grátis do Render "dorme" depois de 15 minutos sem uso e demora uns
30-60 segundos pra acordar no primeiro acesso seguinte — depois disso
funciona normal. O Neon free tier é permanente (não expira), até 0,5 GB de
dados, mais do que suficiente pra começar.

## O que já funciona de verdade

- **Login** com senha (hash + salt, sem senha em texto puro) e sessão por token assinado
- **Permissões reais**: o servidor recusa (403) uma ação fora do papel do usuário — ex.: técnico não consegue criar atividade, cliente não consegue cadastrar equipamento
- **Agenda**: administrador cria atividade escolhendo técnico e equipamento; técnico só vê a própria agenda
- **Diário técnico**: técnico registra causa/correção/resultado de uma atividade; ela fica "pendente" até o administrador aprovar
- **Aprovações**: administrador aprova ou reprova; ao aprovar, o caso entra automaticamente na Biblioteca
- **Biblioteca de Defeitos e Soluções**: pesquisável por equipamento/sintoma/causa/solução
- **Equipamentos**: cadastro e histórico (agenda + visitas) por equipamento
- **Usuários**: administrador cadastra novos técnicos/perfis

## Estrutura do projeto

```
proconecta/
├── server.js       servidor HTTP e todas as rotas da API
├── db.js           acesso ao banco Postgres (schema, seed, consultas)
├── auth.js         hash de senha e token de sessão
├── package.json    lista o único pacote externo usado ("pg")
├── .env.example     modelo do arquivo de configuração local
└── public/          o que o navegador carrega
    ├── index.html
    ├── style.css
    └── app.js        toda a lógica de tela, chamando a API real
```

## Aviso importante sobre esta versão

Este código foi escrito num ambiente sem acesso à internet, então não deu
pra testar contra um Postgres de verdade antes de te entregar — só validei
que a sintaxe de todos os arquivos está correta. As consultas seguem o
padrão normal do pacote `pg`, mas se aparecer algum erro na primeira vez que
você rodar, me manda a mensagem que apareceu no terminal que eu ajusto.

## Próximos passos (Fase 2 do documento de especificação)

- Perfis Supervisor e Financeiro
- Cotas de técnico por mês
- Prestação de contas com upload de nota fiscal
- Notificações (sino no app + e-mail/WhatsApp)
- Biblioteca de Procedimentos Preventivos e Documentação Técnica
- Chamados abertos pelo cliente com fluxo de orçamento
