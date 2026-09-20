"""Calibração de limiares por pessoa: baseline de EAR/MAR/pitch/yaw."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from .config import Config

_BLINK_FILTER_RATIO = 0.8


@dataclass(frozen=True)
class Baseline:
    """Valores de referência da pessoa calibrada."""

    ear: float
    mar: float
    pitch: float
    yaw: float
    ear_closed_threshold: float


class Calibrator:
    """Coleta amostras de EAR/MAR/pitch/yaw por ``calibration_seconds``.

    A mediana de cada métrica vira o baseline da pessoa. Frames de piscada
    (EAR bem abaixo da mediana bruta) são descartados antes de recalcular
    a mediana final de EAR, para que o baseline reflita o olho aberto.
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._ear_samples: List[float] = []
        self._mar_samples: List[float] = []
        self._pitch_samples: List[float] = []
        self._yaw_samples: List[float] = []
        self._start_time: Optional[float] = None
        self._baseline: Optional[Baseline] = None

    @property
    def is_done(self) -> bool:
        """True quando a calibração já produziu um baseline."""
        return self._baseline is not None

    @property
    def baseline(self) -> Optional[Baseline]:
        """Baseline calculado, ou None enquanto a calibração está em curso."""
        return self._baseline

    def progress(self, timestamp_s: float) -> float:
        """Percentual (0-100) de progresso da janela de calibração."""
        if self._start_time is None:
            return 0.0
        elapsed = timestamp_s - self._start_time
        return max(0.0, min(100.0, 100.0 * elapsed / self._config.calibration_seconds))

    def update(
        self, timestamp_s: float, ear: float, mar: float, pitch: float, yaw: float
    ) -> None:
        """Adiciona uma amostra com rosto detectado; finaliza automaticamente."""
        if self.is_done:
            return
        if self._start_time is None:
            self._start_time = timestamp_s
        self._ear_samples.append(ear)
        self._mar_samples.append(mar)
        self._pitch_samples.append(pitch)
        self._yaw_samples.append(yaw)
        if timestamp_s - self._start_time >= self._config.calibration_seconds:
            self._finalize()

    def _finalize(self) -> None:
        raw_ear_median = float(np.median(self._ear_samples))
        non_blink = [
            e for e in self._ear_samples if e >= raw_ear_median * _BLINK_FILTER_RATIO
        ]
        ear_baseline = float(np.median(non_blink)) if non_blink else raw_ear_median
        mar_baseline = float(np.median(self._mar_samples))
        pitch_baseline = float(np.median(self._pitch_samples))
        yaw_baseline = float(np.median(self._yaw_samples))

        self._baseline = Baseline(
            ear=ear_baseline,
            mar=mar_baseline,
            pitch=pitch_baseline,
            yaw=yaw_baseline,
            ear_closed_threshold=ear_baseline * self._config.ear_closed_ratio,
        )

    @staticmethod
    def default_baseline(config: Config) -> Baseline:
        """Baseline usado quando a calibração é pulada (``--no-calibrate``)."""
        ear_reference = config.ear_default_threshold / config.ear_closed_ratio
        return Baseline(
            ear=ear_reference,
            mar=0.0,
            pitch=0.0,
            yaw=0.0,
            ear_closed_threshold=config.ear_default_threshold,
        )
