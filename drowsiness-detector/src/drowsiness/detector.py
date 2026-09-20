"""Detector de sonolência: janela temporal, PERCLOS e máquina de estados."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import Deque, Optional

from .calibration import Baseline
from .config import Config


class DriverState(Enum):
    """Estados da máquina de sonolência, em ordem crescente de severidade."""

    AWAKE = "AWAKE"
    WARNING = "WARNING"
    DROWSY = "DROWSY"
    MICROSLEEP = "MICROSLEEP"


_SEVERITY = {
    DriverState.AWAKE: 0,
    DriverState.WARNING: 1,
    DriverState.DROWSY: 2,
    DriverState.MICROSLEEP: 3,
}


@dataclass(frozen=True)
class Sample:
    """Uma amostra do buffer temporal do detector."""

    timestamp_s: float
    ear: float
    mar: float
    pitch: float
    yaw: float
    eye_closed: bool


@dataclass(frozen=True)
class DetectionResult:
    """Saída de um frame processado pelo detector."""

    state: DriverState
    perclos: float
    eye_closed: bool
    microsleep_active: bool
    yawn_active: bool
    head_down_active: bool
    distracted_active: bool
    face_lost_active: bool


class DrowsinessDetector:
    """Acumula amostras e decide o estado de sonolência do motorista.

    A janela usada no PERCLOS é baseada em tempo (segundos), não em número
    de frames, para não depender do FPS da câmera. A máquina de estados
    (AWAKE → WARNING → DROWSY → MICROSLEEP) sobe de severidade
    imediatamente, mas só desce depois de ``hysteresis_s`` segundos
    contínuos abaixo do limiar, evitando tremulação do alerta.
    """

    def __init__(self, config: Config, baseline: Baseline) -> None:
        self._config = config
        self._baseline = baseline
        self._buffer: Deque[Sample] = deque()

        self._eye_closed_since: Optional[float] = None
        self._yawn_since: Optional[float] = None
        self._head_down_since: Optional[float] = None
        self._distracted_since: Optional[float] = None
        self._face_lost_since: Optional[float] = None

        self._reported_state = DriverState.AWAKE
        self._below_since: Optional[float] = None

    def set_baseline(self, baseline: Baseline) -> None:
        """Atualiza o baseline usado (ex.: após recalibrar com ``c``)."""
        self._baseline = baseline

    def update(
        self,
        timestamp_s: float,
        ear: Optional[float],
        mar: Optional[float],
        pitch: Optional[float],
        yaw: Optional[float],
    ) -> DetectionResult:
        """Processa uma nova amostra (ou a ausência de rosto) e retorna o estado."""
        self._trim_buffer(timestamp_s)
        face_detected = ear is not None

        face_lost_active = self._update_face_lost(timestamp_s, face_detected)

        if face_detected:
            assert mar is not None and pitch is not None and yaw is not None
            eye_closed = ear < self._baseline.ear_closed_threshold
            self._buffer.append(Sample(timestamp_s, ear, mar, pitch, yaw, eye_closed))

            microsleep_active = self._update_condition(
                "_eye_closed_since", timestamp_s, eye_closed, self._config.microsleep_s
            )
            yawn_active = self._update_condition(
                "_yawn_since",
                timestamp_s,
                mar > self._config.mar_yawn,
                self._config.yawn_s,
            )
            head_down_active = self._update_condition(
                "_head_down_since",
                timestamp_s,
                abs(pitch - self._baseline.pitch) > self._config.pitch_delta_deg,
                self._config.pitch_s,
            )
            distracted_active = self._update_condition(
                "_distracted_since",
                timestamp_s,
                abs(yaw - self._baseline.yaw) > self._config.yaw_delta_deg,
                self._config.yaw_s,
            )
        else:
            eye_closed = False
            self._eye_closed_since = None
            self._yawn_since = None
            self._head_down_since = None
            self._distracted_since = None
            microsleep_active = False
            yawn_active = False
            head_down_active = False
            distracted_active = False

        perclos = self._compute_perclos()
        drowsy_active = perclos >= self._config.perclos_drowsy

        if microsleep_active:
            raw_state = DriverState.MICROSLEEP
        elif drowsy_active:
            raw_state = DriverState.DROWSY
        elif yawn_active or head_down_active or distracted_active or face_lost_active:
            raw_state = DriverState.WARNING
        else:
            raw_state = DriverState.AWAKE

        reported_state = self._apply_hysteresis(timestamp_s, raw_state)

        return DetectionResult(
            state=reported_state,
            perclos=perclos,
            eye_closed=eye_closed,
            microsleep_active=microsleep_active,
            yawn_active=yawn_active,
            head_down_active=head_down_active,
            distracted_active=distracted_active,
            face_lost_active=face_lost_active,
        )

    def _update_face_lost(self, timestamp_s: float, face_detected: bool) -> bool:
        if face_detected:
            self._face_lost_since = None
            return False
        if self._face_lost_since is None:
            self._face_lost_since = timestamp_s
        return timestamp_s - self._face_lost_since >= self._config.face_lost_s

    def _update_condition(
        self, since_attr: str, timestamp_s: float, active_now: bool, duration_s: float
    ) -> bool:
        since = getattr(self, since_attr)
        if active_now:
            if since is None:
                since = timestamp_s
                setattr(self, since_attr, since)
            return timestamp_s - since >= duration_s
        setattr(self, since_attr, None)
        return False

    def _apply_hysteresis(self, timestamp_s: float, raw_state: DriverState) -> DriverState:
        if _SEVERITY[raw_state] >= _SEVERITY[self._reported_state]:
            self._reported_state = raw_state
            self._below_since = None
            return self._reported_state

        if self._below_since is None:
            self._below_since = timestamp_s
        elif timestamp_s - self._below_since >= self._config.hysteresis_s:
            self._reported_state = raw_state
            self._below_since = None
        return self._reported_state

    def _trim_buffer(self, timestamp_s: float) -> None:
        window_start = timestamp_s - self._config.perclos_window_s
        while self._buffer and self._buffer[0].timestamp_s < window_start:
            self._buffer.popleft()

    def _compute_perclos(self) -> float:
        """Fração do tempo, na janela ``perclos_window_s``, com olho fechado.

        Cada intervalo entre duas amostras consecutivas é ponderado pelo
        estado (aberto/fechado) da amostra mais recente do par.
        """
        if len(self._buffer) < 2:
            return 0.0
        samples = list(self._buffer)
        closed_time = 0.0
        total_time = 0.0
        for prev, curr in zip(samples, samples[1:]):
            dt = curr.timestamp_s - prev.timestamp_s
            if dt <= 0:
                continue
            total_time += dt
            if curr.eye_closed:
                closed_time += dt
        if total_time <= 0:
            return 0.0
        return closed_time / total_time
