"""CLI do sistema de detecção de sonolência do motorista.

Uso:
    python -m drowsiness --source 0
    python -m drowsiness --source video.mp4 --output saida.mp4 --headless

Teclas (janela interativa): ``q``/ESC encerra, ``c`` reinicia a
calibração, ``m`` alterna o mudo.
"""

from __future__ import annotations

import argparse
import time
from typing import Optional

import cv2

from .alerts import AlertPlayer
from .calibration import Baseline, Calibrator
from .capture import VideoCapture
from .config import Config
from .detector import DrowsinessDetector
from .events import JsonlEventSink, StateChangeLogger
from .head_pose import estimate_head_pose
from .landmarks import FaceMeshLandmarker
from .metrics import compute_ear, compute_mar
from .overlay import (
    TelemetryHistory,
    banner_text,
    draw_all_landmarks,
    draw_banner,
    draw_calibration_progress,
    draw_eye_contours,
    draw_face_not_found,
    draw_header,
    draw_head_pose_axes,
    draw_mouth_contour,
    draw_telemetry_panel,
    draw_waveform,
)

WINDOW_NAME = "AI Driver Monitoring System"


def parse_args() -> argparse.Namespace:
    """Lê os argumentos de linha de comando da aplicação."""
    parser = argparse.ArgumentParser(prog="drowsiness", description=__doc__)
    parser.add_argument(
        "--source",
        default="0",
        help="Índice da webcam (ex.: 0) ou caminho de um arquivo de vídeo.",
    )
    parser.add_argument(
        "--config", default="config.yaml", help="Caminho do arquivo config.yaml."
    )
    parser.add_argument(
        "--no-calibrate",
        action="store_true",
        help="Pula a calibração inicial e usa os valores padrão do config.yaml.",
    )
    parser.add_argument("--mute", action="store_true", help="Desliga o áudio dos alertas.")
    parser.add_argument(
        "--headless", action="store_true", help="Não abre janela (processa sem exibir vídeo)."
    )
    parser.add_argument("--output", default=None, help="Caminho para salvar o vídeo processado.")
    parser.add_argument(
        "--show-landmarks",
        action="store_true",
        help="Desenha todos os landmarks faciais além dos contornos de olhos/boca.",
    )
    parser.add_argument(
        "--events-output",
        default="events.jsonl",
        help="Caminho do log JSONL de transições de estado.",
    )
    return parser.parse_args()


class _App:
    """Estado mutável do loop principal (calibração, detector, alertas, histórico)."""

    def __init__(self, config: Config, args: argparse.Namespace) -> None:
        self.config = config
        self.args = args
        self.calibrator: Optional[Calibrator] = None
        self.baseline: Optional[Baseline] = None
        self.detector: Optional[DrowsinessDetector] = None
        self.history = TelemetryHistory()
        self.alerts = AlertPlayer(config, mute=args.mute)
        self.events = StateChangeLogger(JsonlEventSink(args.events_output))
        self.start_calibration(skip=args.no_calibrate)

    def start_calibration(self, skip: bool) -> None:
        """(Re)inicia a calibração, ou usa os padrões do config quando ``skip``."""
        self.history = TelemetryHistory()
        if skip:
            self.calibrator = None
            self.baseline = Calibrator.default_baseline(self.config)
            self.detector = DrowsinessDetector(self.config, self.baseline)
        else:
            self.calibrator = Calibrator(self.config)
            self.baseline = None
            self.detector = None

    def toggle_mute(self) -> None:
        self.alerts.set_muted(not self.alerts.muted)


def run(args: argparse.Namespace) -> None:
    """Executa o loop principal de captura, detecção e exibição do HUD."""
    config = Config.load(args.config)
    source = int(args.source) if args.source.isdigit() else args.source
    app = _App(config, args)

    writer = None
    fps_smoothed = 0.0
    last_tick = time.monotonic()

    with VideoCapture(source) as capture, FaceMeshLandmarker() as landmarker:
        if args.output:
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(
                args.output,
                fourcc,
                capture.fps or 25.0,
                (capture.frame_width, capture.frame_height),
            )

        while True:
            frame = capture.read()
            if frame is None:
                break

            image = frame.image
            timestamp_s = frame.timestamp_s
            landmarks = landmarker.detect(image)

            now = time.monotonic()
            dt = max(now - last_tick, 1e-6)
            last_tick = now
            fps_smoothed = 0.9 * fps_smoothed + 0.1 * (1.0 / dt) if fps_smoothed else 1.0 / dt

            ear = mar = pitch = yaw = None
            head_pose = None
            if landmarks is not None:
                ear = compute_ear(landmarks)
                mar = compute_mar(landmarks)
                head_pose = estimate_head_pose(landmarks, image.shape[1], image.shape[0])
                if head_pose is not None:
                    pitch, yaw = head_pose.pitch, head_pose.yaw

            draw_header(image, fps_smoothed, frame.index)

            if landmarks is not None:
                draw_eye_contours(image, landmarks)
                draw_mouth_contour(image, landmarks)
                if args.show_landmarks:
                    draw_all_landmarks(image, landmarks)
                if head_pose is not None:
                    draw_head_pose_axes(image, head_pose)
            else:
                draw_face_not_found(image)

            if app.calibrator is not None and not app.calibrator.is_done:
                if landmarks is not None and pitch is not None:
                    app.calibrator.update(timestamp_s, ear, mar, pitch, yaw)
                draw_calibration_progress(image, app.calibrator.progress(timestamp_s))
                if app.calibrator.is_done:
                    app.baseline = app.calibrator.baseline
                    app.detector = DrowsinessDetector(config, app.baseline)
            elif app.detector is not None and app.baseline is not None:
                result = app.detector.update(timestamp_s, ear, mar, pitch, yaw)
                app.history.add(timestamp_s, ear, mar)
                app.alerts.notify(result.state, timestamp_s)
                app.events.observe(timestamp_s, result, ear, mar, pitch, yaw)

                draw_telemetry_panel(image, ear, mar, result.perclos, head_pose, app.baseline, config)
                draw_waveform(
                    image, app.history, app.baseline.ear_closed_threshold, config.mar_yawn
                )
                message = banner_text(result)
                if message:
                    draw_banner(image, message)

            if writer is not None:
                writer.write(image)

            if not args.headless:
                cv2.imshow(WINDOW_NAME, image)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                if key == ord("c"):
                    app.start_calibration(skip=False)
                if key == ord("m"):
                    app.toggle_mute()

    if writer is not None:
        writer.release()
    if not args.headless:
        cv2.destroyAllWindows()
    app.alerts.stop()


def main() -> None:
    """Ponto de entrada da CLI."""
    args = parse_args()
    try:
        run(args)
    except RuntimeError as exc:
        print(f"Erro: {exc}")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
