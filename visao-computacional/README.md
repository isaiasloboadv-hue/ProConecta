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

## Por que assim

Sem framework, sem `npm install`, um único arquivo — só a biblioteca jsQR
carregada via CDN (mesmo padrão de dependência via `<script>` usado no
`proconecta/`). O objetivo aqui é aprender/testar rápido, não construir um
produto ainda: dá pra evoluir depois — por exemplo, plugar um modelo de
IA/visão mais preciso (TensorFlow.js ou uma API de visão na nuvem) no lugar
do processamento local, ou vincular o QR Code lido a um cadastro real de
equipamento/peça.
