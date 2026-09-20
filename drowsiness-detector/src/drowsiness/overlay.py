"""HUD desenhado com OpenCV: título, FPS, contornos faciais e telemetria."""

from __future__ import annotations

from collections import deque
from typing import Deque, List, Optional, Tuple

import cv2
import numpy as np

from .calibration import Baseline
from .config import Config
from .detector import DetectionResult, DriverState
from .head_pose import HeadPose
from .landmarks import LEFT_EYE, MOUTH_VERTICAL_PAIRS, MOUTH_WIDTH_PAIR, RIGHT_EYE

TITLE = "AI DRIVER MONITORING SYSTEM"

# Janela de exibição do waveform (não é um limiar de detecção, só de UI).
_WAVEFORM_SECONDS = 10.0

_COLOR_TITLE = (255, 255, 255)
_COLOR_EYE = (0, 255, 255)  # amarelo (BGR)
_COLOR_MOUTH = (255, 255, 0)  # ciano (BGR)
_COLOR_GREEN = (0, 200, 0)
_COLOR_YELLOW = (0, 215, 255)
_COLOR_RED = (0, 0, 255)
_COLOR_PANEL_BG = (30, 30, 30)


def draw_header(frame: np.ndarray, fps: float, frame_idx: int) -> None:
    """Desenha o título do sistema, o FPS e o índice do frame atual."""
    cv2.putText(
        frame, TITLE, (16, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, _COLOR_TITLE, 2, cv2.LINE_AA
    )
    cv2.putText(
        frame,
        f"FPS: {fps:5.1f}   FRAME: {frame_idx}",
        (16, 52),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        _COLOR_TITLE,
        1,
        cv2.LINE_AA,
    )


def draw_eye_contours(frame: np.ndarray, landmarks: np.ndarray) -> None:
    """Desenha o contorno amarelo dos dois olhos a partir dos landmarks."""
    for eye_indices in (LEFT_EYE, RIGHT_EYE):
        points = landmarks[list(eye_indices), :2].astype(np.int32)
        cv2.polylines(frame, [points], isClosed=True, color=_COLOR_EYE, thickness=1)


def draw_mouth_contour(frame: np.ndarray, landmarks: np.ndarray) -> None:
    """Desenha o contorno ciano da boca a partir dos pontos verticais/largura."""
    indices = [MOUTH_WIDTH_PAIR[0]]
    for top, _bottom in MOUTH_VERTICAL_PAIRS:
        indices.append(top)
    indices.append(MOUTH_WIDTH_PAIR[1])
    for _top, bottom in reversed(MOUTH_VERTICAL_PAIRS):
        indices.append(bottom)
    points = landmarks[indices, :2].astype(np.int32)
    cv2.polylines(frame, [points], isClosed=True, color=_COLOR_MOUTH, thickness=1)


def draw_all_landmarks(frame: np.ndarray, landmarks: np.ndarray) -> None:
    """Desenha todos os landmarks faciais (flag ``--show-landmarks``)."""
    for x, y in landmarks[:, :2].astype(np.int32):
        cv2.circle(frame, (x, y), 1, (0, 180, 0), -1)


def draw_head_pose_axes(frame: np.ndarray, head_pose: HeadPose) -> None:
    """Desenha os eixos de pose da cabeça saindo do nariz (X=vermelho, Y=verde, Z=azul)."""
    cv2.line(frame, head_pose.nose_point, head_pose.axis_x, (0, 0, 255), 2)
    cv2.line(frame, head_pose.nose_point, head_pose.axis_y, (0, 255, 0), 2)
    cv2.line(frame, head_pose.nose_point, head_pose.axis_z, (255, 0, 0), 2)


def draw_calibration_progress(frame: np.ndarray, percent: float) -> None:
    """Mostra o progresso da calibração inicial no centro do frame."""
    height, width = frame.shape[:2]
    text = f"CALIBRANDO... {percent:.0f}%"
    (text_w, text_h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 1.0, 2)
    origin = ((width - text_w) // 2, (height + text_h) // 2)
    cv2.putText(
        frame, text, origin, cv2.FONT_HERSHEY_SIMPLEX, 1.0, _COLOR_YELLOW, 2, cv2.LINE_AA
    )


def draw_face_not_found(frame: np.ndarray) -> None:
    """Aviso leve enquanto nenhum rosto é detectado (antes de virar alerta)."""
    cv2.putText(
        frame,
        "NENHUM ROSTO DETECTADO",
        (16, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        _COLOR_RED,
        2,
        cv2.LINE_AA,
    )


def banner_text(result: DetectionResult) -> Optional[str]:
    """Texto do banner de alerta para o estado/eventos atuais, ou None se tudo ok."""
    if result.face_lost_active:
        return "FACE NOT DETECTED"
    if result.state == DriverState.MICROSLEEP:
        return "DROWSINESS ALERT! MICROSLEEP"
    if result.state == DriverState.DROWSY:
        return "DROWSINESS ALERT! HIGH PERCLOS"
    if result.state == DriverState.WARNING:
        reasons = []
        if result.yawn_active:
            reasons.append("YAWNING")
        if result.head_down_active:
            reasons.append("HEAD DOWN")
        if result.distracted_active:
            reasons.append("DISTRACTED")
        return "ALERT! " + " + ".join(reasons) if reasons else "ALERT!"
    return None


def draw_banner(frame: np.ndarray, text: str) -> None:
    """Desenha a faixa vermelha de alerta com o texto do estado atual."""
    height, width = frame.shape[:2]
    top, bottom = 60, 104
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, top), (width, bottom), _COLOR_RED, -1)
    cv2.addWeighted(overlay, 0.85, frame, 0.15, 0, frame)
    (text_w, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
    origin = ((width - text_w) // 2, bottom - 14)
    cv2.putText(
        frame, text, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA
    )


def _severity_color(ratio: float) -> Tuple[int, int, int]:
    ratio = max(0.0, min(1.0, ratio))
    if ratio < 0.5:
        return _COLOR_GREEN
    if ratio < 0.85:
        return _COLOR_YELLOW
    return _COLOR_RED


def _draw_bar(
    frame: np.ndarray,
    origin: Tuple[int, int],
    size: Tuple[int, int],
    ratio: float,
    label: str,
) -> None:
    x, y = origin
    w, h = size
    ratio = max(0.0, min(1.0, ratio))
    cv2.putText(
        frame, label, (x, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (220, 220, 220), 1, cv2.LINE_AA
    )
    cv2.rectangle(frame, (x, y), (x + w, y + h), (90, 90, 90), 1)
    fill_w = int(w * ratio)
    if fill_w > 0:
        cv2.rectangle(frame, (x, y), (x + fill_w, y + h), _severity_color(ratio), -1)


def draw_telemetry_panel(
    frame: np.ndarray,
    ear: Optional[float],
    mar: Optional[float],
    perclos: float,
    head_pose: Optional[HeadPose],
    baseline: Baseline,
    config: Config,
) -> None:
    """Painel "BIOMETRIC TELEMETRY": barras de EAR, MAR, PERCLOS e pose da cabeça."""
    height, width = frame.shape[:2]
    panel_w, panel_h = 240, 190
    # y0 fica abaixo da faixa reservada para o banner de alerta (60-104px),
    # para o painel não mudar de lugar quando o banner aparece/some.
    x0, y0 = width - panel_w - 12, 116
    overlay = frame.copy()
    cv2.rectangle(overlay, (x0, y0), (x0 + panel_w, y0 + panel_h), _COLOR_PANEL_BG, -1)
    cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)
    cv2.putText(
        frame,
        "BIOMETRIC TELEMETRY",
        (x0 + 10, y0 + 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        _COLOR_TITLE,
        1,
        cv2.LINE_AA,
    )

    bar_x = x0 + 10
    bar_w = panel_w - 20
    bar_h = 12
    rows_y = [y0 + 44, y0 + 78, y0 + 112, y0 + 146, y0 + 180]

    ear_ratio = 1.0 - (ear / baseline.ear if ear is not None and baseline.ear > 0 else 1.0)
    _draw_bar(
        frame,
        (bar_x, rows_y[0]),
        (bar_w, bar_h),
        ear_ratio,
        f"EAR: {ear:.3f}" if ear is not None else "EAR: --",
    )

    mar_ratio = (mar / config.mar_yawn) if mar is not None and config.mar_yawn > 0 else 0.0
    _draw_bar(
        frame,
        (bar_x, rows_y[1]),
        (bar_w, bar_h),
        mar_ratio,
        f"MAR: {mar:.3f}" if mar is not None else "MAR: --",
    )

    perclos_ratio = perclos / config.perclos_drowsy if config.perclos_drowsy > 0 else 0.0
    _draw_bar(
        frame,
        (bar_x, rows_y[2]),
        (bar_w, bar_h),
        perclos_ratio,
        f"PERCLOS: {perclos * 100:.0f}%",
    )

    pitch_text = f"{head_pose.pitch:+.1f}deg" if head_pose else "--"
    pitch_ratio = (
        abs(head_pose.pitch - baseline.pitch) / config.pitch_delta_deg
        if head_pose and config.pitch_delta_deg > 0
        else 0.0
    )
    _draw_bar(
        frame, (bar_x, rows_y[3]), (bar_w, bar_h), pitch_ratio, f"HEAD PITCH: {pitch_text}"
    )

    yaw_text = f"{head_pose.yaw:+.1f}deg" if head_pose else "--"
    yaw_ratio = (
        abs(head_pose.yaw - baseline.yaw) / config.yaw_delta_deg
        if head_pose and config.yaw_delta_deg > 0
        else 0.0
    )
    _draw_bar(frame, (bar_x, rows_y[4]), (bar_w, bar_h), yaw_ratio, f"HEAD YAW: {yaw_text}")


class TelemetryHistory:
    """Buffer deslizante (~10s) de EAR/MAR usado para desenhar o waveform do HUD."""

    def __init__(self, window_s: float = _WAVEFORM_SECONDS) -> None:
        self._window_s = window_s
        self._samples: Deque[Tuple[float, Optional[float], Optional[float]]] = deque()

    def add(self, timestamp_s: float, ear: Optional[float], mar: Optional[float]) -> None:
        self._samples.append((timestamp_s, ear, mar))
        window_start = timestamp_s - self._window_s
        while self._samples and self._samples[0][0] < window_start:
            self._samples.popleft()

    @property
    def samples(self) -> List[Tuple[float, Optional[float], Optional[float]]]:
        return list(self._samples)


def draw_waveform(
    frame: np.ndarray,
    history: TelemetryHistory,
    ear_threshold: float,
    mar_threshold: float,
) -> None:
    """Desenha o painel "WAVEFORM (EAR/MAR)" com a linha de limiar do EAR."""
    height, width = frame.shape[:2]
    panel_w, panel_h = 320, 110
    x0, y0 = 12, height - panel_h - 12
    overlay = frame.copy()
    cv2.rectangle(overlay, (x0, y0), (x0 + panel_w, y0 + panel_h), _COLOR_PANEL_BG, -1)
    cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)
    cv2.putText(
        frame,
        "WAVEFORM (EAR/MAR)",
        (x0 + 8, y0 + 16),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        _COLOR_TITLE,
        1,
        cv2.LINE_AA,
    )

    plot_x0, plot_y0 = x0 + 8, y0 + 24
    plot_w, plot_h = panel_w - 16, panel_h - 34
    value_max = 1.0  # EAR e MAR ficam tipicamente em [0, 1] para esta escala visual

    def to_xy(t_ratio: float, value: float) -> Tuple[int, int]:
        px = plot_x0 + int(t_ratio * plot_w)
        py = plot_y0 + plot_h - int(max(0.0, min(1.0, value / value_max)) * plot_h)
        return px, py

    threshold_y = to_xy(0.0, ear_threshold)[1]
    cv2.line(
        frame,
        (plot_x0, threshold_y),
        (plot_x0 + plot_w, threshold_y),
        (120, 120, 255),
        1,
        cv2.LINE_AA,
    )

    samples = history.samples
    if len(samples) >= 2:
        t_start = samples[0][0]
        t_end = samples[-1][0]
        span = max(t_end - t_start, 1e-6)

        ear_points = []
        mar_points = []
        for t, ear, mar in samples:
            t_ratio = (t - t_start) / span
            if ear is not None:
                ear_points.append(to_xy(t_ratio, ear))
            if mar is not None:
                mar_points.append(to_xy(t_ratio, mar))
        if len(ear_points) >= 2:
            cv2.polylines(frame, [np.array(ear_points, dtype=np.int32)], False, _COLOR_EYE, 1)
        if len(mar_points) >= 2:
            cv2.polylines(frame, [np.array(mar_points, dtype=np.int32)], False, _COLOR_MOUTH, 1)
