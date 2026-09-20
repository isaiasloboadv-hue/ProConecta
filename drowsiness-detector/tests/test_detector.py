"""Testes de detector.py: microsono, piscada, PERCLOS e histerese (sintéticos)."""

import pytest

from drowsiness.calibration import Baseline, Calibrator
from drowsiness.config import Config
from drowsiness.detector import DriverState, DrowsinessDetector

_NEUTRAL_BASELINE = Baseline(
    ear=0.30, mar=0.0, pitch=0.0, yaw=0.0, ear_closed_threshold=0.20
)


def _no_trigger_config(**overrides) -> Config:
    """Config com todas as durações/limiares "desligados" exceto o que o teste sobrescrever."""
    defaults = dict(
        microsleep_s=1_000.0,
        mar_yawn=1_000.0,
        yawn_s=1_000.0,
        pitch_delta_deg=1_000.0,
        pitch_s=1_000.0,
        yaw_delta_deg=1_000.0,
        yaw_s=1_000.0,
        face_lost_s=1_000.0,
        perclos_drowsy=1.1,  # inatingível (perclos máximo é 1.0)
        perclos_window_s=1_000.0,
        hysteresis_s=0.0,
    )
    defaults.update(overrides)
    return Config(**defaults)


def test_microsleep_after_continuous_closed_eyes() -> None:
    config = _no_trigger_config(microsleep_s=0.8)
    detector = DrowsinessDetector(config, _NEUTRAL_BASELINE)

    timestamps = [0.0, 0.2, 0.4, 0.6, 0.8]
    results = [
        detector.update(t, ear=0.10, mar=0.0, pitch=0.0, yaw=0.0) for t in timestamps
    ]

    assert [r.microsleep_active for r in results] == [False, False, False, False, True]
    assert results[-1].state == DriverState.MICROSLEEP


def test_short_blink_does_not_trigger_microsleep() -> None:
    config = _no_trigger_config(microsleep_s=0.8)
    detector = DrowsinessDetector(config, _NEUTRAL_BASELINE)

    # olho fechado só por 0.2s (uma piscada normal), depois reabre.
    schedule = [
        (0.0, 0.10),
        (0.1, 0.10),
        (0.2, 0.30),
        (0.4, 0.30),
        (0.6, 0.30),
        (0.8, 0.30),
        (1.0, 0.30),
    ]
    results = [
        detector.update(t, ear=ear, mar=0.0, pitch=0.0, yaw=0.0) for t, ear in schedule
    ]

    assert all(not r.microsleep_active for r in results)
    assert all(r.state == DriverState.AWAKE for r in results)


def test_perclos_matches_known_window() -> None:
    config = _no_trigger_config(perclos_window_s=10.0)
    detector = DrowsinessDetector(config, _NEUTRAL_BASELINE)

    closed_seconds = {3, 4, 5, 6}
    result = None
    for t in range(10):  # t = 0..9, uma amostra por segundo
        ear = 0.10 if t in closed_seconds else 0.30
        result = detector.update(float(t), ear=ear, mar=0.0, pitch=0.0, yaw=0.0)

    # 4 dos 9 intervalos de 1s terminam com olho fechado -> 4/9.
    assert result.perclos == pytest.approx(4 / 9)


def test_hysteresis_keeps_elevated_state_briefly_after_recovery() -> None:
    config = _no_trigger_config(microsleep_s=0.1, hysteresis_s=0.3)
    detector = DrowsinessDetector(config, _NEUTRAL_BASELINE)

    # Fecha o olho tempo suficiente para disparar microsono...
    for t in (0.0, 0.05, 0.10):
        result = detector.update(t, ear=0.10, mar=0.0, pitch=0.0, yaw=0.0)
    assert result.state == DriverState.MICROSLEEP

    # ...reabre o olho: o estado sobe imediatamente mas só desce após hysteresis_s.
    result = detector.update(0.20, ear=0.30, mar=0.0, pitch=0.0, yaw=0.0)
    assert result.state == DriverState.MICROSLEEP  # ainda dentro da janela de histerese

    result = detector.update(0.35, ear=0.30, mar=0.0, pitch=0.0, yaw=0.0)
    assert result.state == DriverState.MICROSLEEP  # 0.35-0.20=0.15s < hysteresis_s

    result = detector.update(0.60, ear=0.30, mar=0.0, pitch=0.0, yaw=0.0)
    assert result.state == DriverState.AWAKE  # 0.60-0.20=0.40s >= hysteresis_s


def test_default_baseline_when_calibration_skipped() -> None:
    config = Config(ear_default_threshold=0.20, ear_closed_ratio=0.75)
    baseline = Calibrator.default_baseline(config)

    assert baseline.ear_closed_threshold == pytest.approx(0.20)
    assert baseline.ear == pytest.approx(0.20 / 0.75)
