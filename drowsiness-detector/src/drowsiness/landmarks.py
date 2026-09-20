"""Wrapper do MediaPipe Face Mesh para extrair landmarks faciais em pixels.

Índices de landmarks usados pelo restante do pipeline (topologia padrão do
MediaPipe Face Mesh, igual entre a API legada e a Tasks API):

- Olho esquerdo: 362, 385, 387, 263, 373, 380
- Olho direito: 33, 160, 158, 133, 153, 144
- Boca (pares verticais internos): (81, 178), (13, 14), (311, 402)
- Boca (largura): (78, 308)
- Pose da cabeça: nariz 1, queixo 152, canto externo olho esq. 263,
  canto externo olho dir. 33, canto boca esq. 291, canto boca dir. 61
"""

from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import mediapipe as mp

    _HAS_SOLUTIONS = hasattr(mp, "solutions")
except ImportError:  # pragma: no cover - dependência opcional para runtime
    mp = None
    _HAS_SOLUTIONS = False

LEFT_EYE = (362, 385, 387, 263, 373, 380)
RIGHT_EYE = (33, 160, 158, 133, 153, 144)
MOUTH_VERTICAL_PAIRS = ((81, 178), (13, 14), (311, 402))
MOUTH_WIDTH_PAIR = (78, 308)
POSE_LANDMARKS = {
    "nose": 1,
    "chin": 152,
    "left_eye_outer": 263,
    "right_eye_outer": 33,
    "mouth_left": 291,
    "mouth_right": 61,
}

_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
_MODEL_CACHE = Path.home() / ".cache" / "drowsiness-detector" / "face_landmarker.task"


class FaceMeshLandmarker:
    """Detecta os landmarks faciais (468+ pontos) do primeiro rosto do frame.

    Usa a API legada ``mp.solutions.face_mesh`` quando disponível
    (``refine_landmarks=True``, inclui íris). Em versões do MediaPipe que
    não expõem mais ``mp.solutions``, cai para a Tasks API
    (``mediapipe.tasks.python.vision.FaceLandmarker``), que usa a mesma
    topologia de 478 pontos.
    """

    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
    ) -> None:
        if mp is None:
            raise RuntimeError(
                "mediapipe não está instalado. Rode: pip install -r requirements.txt"
            )
        self._backend = "solutions" if _HAS_SOLUTIONS else "tasks"
        if self._backend == "solutions":
            self._impl = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=min_detection_confidence,
                min_tracking_confidence=min_tracking_confidence,
            )
        else:
            self._impl = _build_tasks_landmarker(
                min_detection_confidence, min_tracking_confidence
            )
        self._frame_timestamp_ms = 0

    def detect(self, image_bgr: np.ndarray) -> Optional[np.ndarray]:
        """Retorna landmarks ``(N, 3)`` em pixels do primeiro rosto, ou None."""
        height, width = image_bgr.shape[:2]
        image_rgb = np.ascontiguousarray(image_bgr[:, :, ::-1])

        if self._backend == "solutions":
            result = self._impl.process(image_rgb)
            if not result.multi_face_landmarks:
                return None
            raw_landmarks = result.multi_face_landmarks[0].landmark
        else:
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
            self._frame_timestamp_ms += 33
            result = self._impl.detect_for_video(mp_image, self._frame_timestamp_ms)
            if not result.face_landmarks:
                return None
            raw_landmarks = result.face_landmarks[0]

        return np.array(
            [(lm.x * width, lm.y * height, lm.z * width) for lm in raw_landmarks],
            dtype=np.float64,
        )

    def close(self) -> None:
        """Libera os recursos do detector subjacente."""
        self._impl.close()

    def __enter__(self) -> "FaceMeshLandmarker":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()


def _build_tasks_landmarker(
    min_detection_confidence: float, min_tracking_confidence: float
):
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python import vision

    model_path = _ensure_model_downloaded()
    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=min_detection_confidence,
        min_tracking_confidence=min_tracking_confidence,
    )
    return vision.FaceLandmarker.create_from_options(options)


def _ensure_model_downloaded() -> Path:
    if _MODEL_CACHE.exists():
        return _MODEL_CACHE
    _MODEL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(_MODEL_URL, _MODEL_CACHE)
    except OSError as exc:
        raise RuntimeError(
            "Não foi possível baixar o modelo do MediaPipe FaceLandmarker "
            f"({_MODEL_URL}). Baixe manualmente e salve em {_MODEL_CACHE}."
        ) from exc
    return _MODEL_CACHE
