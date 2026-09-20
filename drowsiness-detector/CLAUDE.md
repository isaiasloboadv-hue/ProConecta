# drowsiness-detector

Sistema de detecção de sonolência do motorista em tempo real (Python +
OpenCV + MediaPipe Face Mesh). Lê a especificação completa no `README.md`
deste diretório antes de alterar o pipeline de detecção.

## Pontos importantes

- `src/drowsiness/landmarks.py` tenta primeiro `mp.solutions.face_mesh`
  (API legada) e cai para a Tasks API (`FaceLandmarker`) quando
  `mp.solutions` não existe na versão instalada do MediaPipe — isso é
  esperado a partir do MediaPipe 1.x. A Tasks API baixa e cacheia um
  modelo `.task` em `~/.cache/drowsiness-detector/`.
- Nenhum limiar/duração deve ser hardcoded no código: tudo vem de
  `config.yaml` via `src/drowsiness/config.py`.
- `tests/` não pode depender de câmera nem de MediaPipe — só testam
  `metrics.py`, `head_pose.py` e `detector.py`, que são puros e recebem
  dados sintéticos.
- Ambiente de desenvolvimento: `python3 -m venv .venv && source
  .venv/bin/activate && pip install -r requirements.txt`. Rodar testes com
  `pytest`.
