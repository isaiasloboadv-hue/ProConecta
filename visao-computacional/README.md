# Visão Computacional — ferramenta de estudo

Protótipo **independente**, sem nenhum vínculo com o app `proconecta/` —
um arquivo HTML único para experimentar o que dá pra fazer com visão
computacional direto no navegador, sem backend e sem enviar nenhuma foto
para fora do seu dispositivo.

O que já funciona:

- **Contagem de peças + identificação de cor**: tira uma foto (ou usa a
  câmera ao vivo) de peças espalhadas sobre uma superfície e conta quantas
  tem, marcando cada uma com um número e a cor mais próxima detectada.
  Funciona por processamento de imagem local — limiar de
  [Otsu](https://pt.wikipedia.org/wiki/M%C3%A9todo_de_Otsu) pra separar
  peça de fundo, e rotulagem de componentes conexos pra contar cada mancha
  isolada. Funciona melhor com peças bem separadas (sem encostar umas nas
  outras), sobre uma superfície lisa e de cor contrastante, com boa
  iluminação.
- **Leitura de QR Code**: escaneia com a câmera ao vivo (biblioteca
  [jsQR](https://github.com/cozmo/jsQR)) ou lê o código de uma imagem
  enviada. Por enquanto só decodifica e mostra o conteúdo (copiar / abrir
  link) — sem vínculo com cadastro de equipamento ainda; é o próximo passo
  se isso evoluir.
- **Reconhecimento facial**: detecta rostos na câmera (biblioteca
  [face-api.js](https://github.com/justadudewhohacks/face-api.js), que roda
  modelos de detecção/reconhecimento facial via TensorFlow.js), desenha um
  quadrado em volta de cada rosto e avisa se aquele rosto já tinha
  aparecido antes nesta câmera/navegador ("Pessoa #N · visto 3x") ou se é
  novo. Cada rosto novo vira um "descritor facial" (128 números que
  representam o rosto, não uma foto) guardado no `localStorage` do
  navegador — só neste dispositivo, nada sai pra nenhum servidor. O botão
  "Limpar rostos salvos" apaga essa lista. **Atenção**: isso é
  reconhecimento facial de verdade (dado biométrico) — tudo bem pra testar
  em você mesmo ou com consentimento de quem aparecer na câmera, mas evite
  usar em pessoas que não sabem/não concordam com isso, especialmente se
  esse protótipo evoluir pra algo usado fora de teste pessoal (no Brasil,
  dado biométrico é dado sensível pela LGPD).

## Como rodar

É um arquivo único (`index.html`), sem dependências pra instalar. Duas formas:

1. **Abrir direto no navegador** — funciona para testar com upload de foto,
   mas em alguns navegadores o acesso à câmera só é liberado em um
   "contexto seguro" (https ou localhost), então pode não pedir permissão
   de câmera ao abrir como `file://`.
2. **Servir localmente** (recomendado, libera a câmera sem restrição):
   ```
   cd visao-computacional
   python3 -m http.server 8080
   ```
   Abra **http://localhost:8080** no navegador (funciona no celular também,
   acessando o IP do computador na mesma rede — nesse caso alguns
   navegadores ainda vão exigir HTTPS para a câmera; o upload de foto
   sempre funciona como alternativa).

## Testando com diferentes câmeras

- **Webcam do notebook**: abra `http://localhost:8080` no próprio notebook
  (veja "Como rodar" acima) — `localhost` já é um "contexto seguro", então
  o navegador libera a câmera direto, sem configuração extra.
- **Webcam + câmera USB externa no mesmo notebook**: ao ligar a câmera, se
  o navegador detectar mais de um dispositivo de vídeo aparece um seletor
  do lado do botão "Ligar câmera" — escolha ali qual usar. (Os nomes só
  aparecem depois que você autoriza o acesso à câmera pela primeira vez.)
- **Câmera do celular**: o desafio aqui é que a maioria dos navegadores só
  libera a câmera em HTTPS (ou `localhost` — e o celular não é o
  `localhost` do seu notebook). Duas formas de contornar isso, sem custo:
  1. **Túnel temporário (mais rápido, só pra testar agora)**: com o
     servidor local rodando (`python3 -m http.server 8080`), abra outro
     terminal e rode:
     ```
     npx localtunnel --port 8080
     ```
     Isso devolve um link tipo `https://algo-aleatorio.loca.lt` — abra
     esse link no navegador do celular (ele pode pedir pra confirmar que
     você quer acessar; é normal). Fecha sozinho quando você encerra o
     comando.
  2. **Publicar de vez (link fixo, sempre em HTTPS)**: suba esta pasta
     `visao-computacional/` no GitHub Pages, Netlify ou Vercel (arrastar
     os 2 arquivos já é suficiente, não tem build) — você recebe uma URL
     `https://...` fixa, sempre com câmera liberada, tanto no notebook
     quanto no celular.
  - Em ambos os casos, o "Virar câmera" alterna frontal/traseira no
    celular; no computador, é o seletor de dispositivo que decide qual
    câmera usar.
  - Se preferir não mexer com rede agora, o **upload de foto** ("Enviar
    foto"/"Enviar imagem") sempre funciona em qualquer navegador, sem
    precisar de HTTPS — tira a foto com a câmera nativa do celular e
    depois escolhe o arquivo na ferramenta.

## Por que assim

Sem framework, sem `npm install`, um único arquivo — só a biblioteca jsQR
carregada via CDN (mesmo padrão de dependência via `<script>` usado no
`proconecta/`). O objetivo aqui é aprender/testar rápido, não construir um
produto ainda: dá pra evoluir depois — por exemplo, plugar um modelo de
IA/visão mais preciso (TensorFlow.js ou uma API de visão na nuvem) no lugar
do processamento local, ou vincular o QR Code lido a um cadastro real de
equipamento/peça.
