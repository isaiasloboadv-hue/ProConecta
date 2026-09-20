"""Captura de vídeo a partir de webcam ou arquivo, com timestamp por frame."""

from __future__ import annotations

import time
from typing import NamedTuple, Optional

import cv2
import numpy as np


class Frame(NamedTuple):
    """Um frame capturado junto do timestamp em segundos."""

    image: np.ndarray
    timestamp_s: float
    index: int


class VideoCapture:
    """Wrapper sobre cv2.VideoCapture que entrega (frame, timestamp, índice).

    Para webcam, o timestamp usa ``time.monotonic()``. Para arquivo de
    vídeo, o timestamp é derivado de ``frame_idx / fps`` para que o
    processamento seja determinístico independente da velocidade de leitura.
    """

    def __init__(self, source: str | int) -> None:
        self._is_file = isinstance(source, str) and not source.isdigit()
        cv2_source: str | int = source
        if isinstance(source, str) and source.isdigit():
            cv2_source = int(source)
            self._is_file = False

        self._cap = cv2.VideoCapture(cv2_source)
        if not self._cap.isOpened():
            kind = "arquivo de vídeo" if self._is_file else "webcam"
            raise RuntimeError(
                f"Não foi possível abrir a fonte de vídeo ({kind}): {source!r}. "
                "Verifique se o caminho está correto ou se a câmera está "
                "conectada e não está sendo usada por outro programa."
            )

        self._fps = self._cap.get(cv2.CAP_PROP_FPS) or 30.0
        self._frame_idx = 0
        self._start_time = time.monotonic()

    @property
    def fps(self) -> float:
        """FPS reportado pela fonte (usado para timestamps de arquivo)."""
        return self._fps

    @property
    def frame_width(self) -> int:
        """Largura dos frames reportada pela fonte de vídeo."""
        return int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))

    @property
    def frame_height(self) -> int:
        """Altura dos frames reportada pela fonte de vídeo."""
        return int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    @property
    def is_file(self) -> bool:
        """True quando a fonte é um arquivo de vídeo, False para webcam."""
        return self._is_file

    def read(self) -> Optional[Frame]:
        """Lê o próximo frame. Retorna None ao final do vídeo/erro de leitura."""
        ok, image = self._cap.read()
        if not ok:
            return None

        if self._is_file:
            timestamp_s = self._frame_idx / self._fps
        else:
            timestamp_s = time.monotonic()

        frame = Frame(image=image, timestamp_s=timestamp_s, index=self._frame_idx)
        self._frame_idx += 1
        return frame

    def release(self) -> None:
        """Libera o dispositivo/arquivo de vídeo."""
        self._cap.release()

    def __enter__(self) -> "VideoCapture":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.release()
