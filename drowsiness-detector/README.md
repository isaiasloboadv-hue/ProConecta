# Sistema de Detecção de Sonolência do Motorista

Sistema em Python que detecta, em tempo real, sonolência, microsono,
bocejo e queda/desvio de cabeça a partir de uma câmera (webcam ou arquivo
de vídeo), exibindo um HUD com telemetria e disparando alarmes sonoros.

## Instalação

Requer Python 3.10–3.12.

```bash
cd drowsiness-detector
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Em máquinas sem placa de som (servidores, containers) os alertas sonoros
simplesmente não tocam — o sistema detecta a falha de inicialização do
áudio e segue funcionando normalmente (visualmente), sem travar.

Em ambientes headless (sem X11/GUI), troque `opencv-python` por
`opencv-python-headless` no `requirements.txt` e use sempre `--headless`.

## Uso

```bash
# Webcam padrão, com janela interativa
python -m drowsiness --source 0

# Processar um arquivo de vídeo e salvar o resultado, sem abrir janela
python -m drowsiness --source video.mp4 --output saida.mp4 --headless
```

### Flags

| Flag               | Descrição                                                          |
|---------------------|----------------------------------------------------------------------|
| `--source`          | Índice da webcam (ex.: `0`) ou caminho de um arquivo de vídeo.       |
| `--config`           | Caminho do `config.yaml` (padrão: `config.yaml`).                   |
| `--no-calibrate`     | Pula a calibração inicial e usa os valores padrão do `config.yaml`.  |
| `--mute`             | Desliga o áudio dos alertas.                                        |
| `--headless`         | Não abre janela (útil para processar vídeo e gerar `--output`).      |
| `--output PATH`      | Salva o vídeo processado (com HUD) nesse caminho.                    |
| `--show-landmarks`   | Desenha todos os landmarks faciais, além dos contornos de olho/boca. |
| `--events-output`    | Caminho do log JSONL de transições de estado (padrão: `events.jsonl`).|

### Teclas (janela interativa)

- `q` ou `ESC`: encerra o programa.
- `c`: reinicia a calibração.
- `m`: liga/desliga o áudio dos alertas.

## Calibração

Nos primeiros `calibration_seconds` (padrão 15s, ver `config.yaml`) com o
rosto detectado e olhos abertos normalmente, o sistema coleta EAR, MAR e
pitch/yaw da cabeça e calcula a mediana de cada um como baseline da
pessoa. O limiar de "olho fechado" vira `baseline_ear * ear_closed_ratio`.
Isso é importante porque o formato dos olhos e a proporção do rosto
variam bastante de pessoa para pessoa — usar sempre o mesmo limiar fixo
gera falsos positivos ou negativos dependendo de quem está dirigindo.

Durante a calibração o HUD mostra "CALIBRANDO... n%" e os alertas ficam
suspensos. Para pular a calibração (ex.: testes rápidos) use
`--no-calibrate`, que usa `ear_default_threshold` do `config.yaml`
diretamente como limiar de olho fechado.

## Ajustando os limiares (`config.yaml`)

| Campo                  | O que controla                                                         |
|--------------------------|---------------------------------------------------------------------|
| `calibration_seconds`    | Duração da calibração inicial.                                     |
| `ear_default_threshold`  | Limiar de olho fechado quando a calibração é pulada.                |
| `ear_closed_ratio`       | Fração do EAR de baseline considerada "olho fechado".               |
| `mar_yawn`               | MAR acima do qual a boca é considerada aberta (bocejo).             |
| `perclos_window_s`       | Janela de tempo usada para calcular o PERCLOS.                      |
| `perclos_drowsy`         | PERCLOS mínimo para o estado DROWSY.                                |
| `microsleep_s`           | Duração mínima de olho fechado contínuo para virar microsono.       |
| `yawn_s`                 | Duração mínima de boca aberta contínua para contar como bocejo.     |
| `pitch_delta_deg`        | Desvio de pitch (graus) da baseline para "cabeça caída".            |
| `pitch_s`                | Duração mínima do desvio de pitch para disparar o alerta.           |
| `yaw_delta_deg`          | Desvio de yaw (graus) da baseline para "distração".                 |
| `yaw_s`                  | Duração mínima do desvio de yaw para disparar o alerta.             |
| `face_lost_s`            | Tempo sem detectar rosto até o alerta "FACE NOT DETECTED".          |
| `hysteresis_s`           | Tempo que o estado precisa ficar "melhor" antes de baixar de nível. |
| `alert_cooldown_s`       | Intervalo mínimo entre repetições do mesmo alerta sonoro.           |

Se os alertas de sonolência estiverem disparando cedo/tarde demais para
uma pessoa específica, o primeiro ajuste é recalibrar (tecla `c` ou
reiniciar o programa); só depois mexa nos limiares do `config.yaml`.

## Testes

```bash
pytest
```

Os testes (`tests/test_metrics.py`, `tests/test_head_pose.py`,
`tests/test_detector.py`) usam apenas dados sintéticos — não abrem
câmera nem carregam o MediaPipe, então rodam em qualquer máquina/CI.

## Arquitetura

```
src/drowsiness/
├── capture.py     # captura de vídeo (webcam/arquivo) com timestamp por frame
├── landmarks.py   # wrapper do MediaPipe Face Mesh (com fallback pra Tasks API)
├── metrics.py      # EAR e MAR (funções puras)
├── head_pose.py    # pose da cabeça via solvePnP, com normalização de ângulo
├── calibration.py  # baseline por pessoa
├── detector.py      # janela temporal, PERCLOS, máquina de estados
├── overlay.py       # HUD desenhado com OpenCV
├── alerts.py         # beep sintético (numpy + pygame), com cooldown
└── events.py          # log JSONL de transições de estado
```

## Limitações

- **Óculos escuros, reflexos e pouca luz** reduzem bastante a precisão da
  detecção de landmarks e do EAR/MAR. Para uso real (carro à noite),
  recomenda-se uma câmera com iluminação infravermelha dedicada — câmeras
  RGB comuns não são confiáveis nessas condições.
- Os limiares variam de pessoa para pessoa (formato do olho, uso de
  óculos, etc.), por isso a calibração inicial é importante; pular a
  calibração (`--no-calibrate`) usa valores genéricos que podem não se
  ajustar bem a todo mundo.
- Este sistema é uma **ajuda ao motorista**, não substitui descanso
  adequado nem é um dispositivo de segurança certificado. Ele não deve
  ser o único mecanismo de prevenção de acidentes por fadiga.
