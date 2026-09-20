"""Testes de metrics.py: EAR e MAR com dados sintéticos (sem câmera/MediaPipe)."""

import numpy as np
import pytest

from drowsiness.metrics import eye_aspect_ratio, mouth_aspect_ratio


def _synthetic_eye(half_height: float) -> np.ndarray:
    """Olho sintético: cantos em (0,0)/(4,0), pálpebras a ``half_height`` do eixo."""
    return np.array(
        [
            (0.0, 0.0),  # p1: canto esquerdo
            (1.0, -half_height),  # p2: topo esquerdo
            (3.0, -half_height),  # p3: topo direito
            (4.0, 0.0),  # p4: canto direito
            (3.0, half_height),  # p5: base direita
            (1.0, half_height),  # p6: base esquerda
        ]
    )


def test_eye_aspect_ratio_open_eye_is_approximately_point_three() -> None:
    eye = _synthetic_eye(half_height=0.6)
    assert eye_aspect_ratio(eye) == pytest.approx(0.3)


def test_eye_aspect_ratio_closed_eye_is_below_point_one() -> None:
    eye = _synthetic_eye(half_height=0.02)
    assert eye_aspect_ratio(eye) < 0.1


def test_mouth_aspect_ratio_closed_mouth_is_low() -> None:
    horizontal = np.array([(0.0, 0.0), (10.0, 0.0)])
    vertical_pairs = np.array(
        [
            [(3.0, -0.4), (3.0, 0.4)],
            [(5.0, -0.5), (5.0, 0.5)],
            [(7.0, -0.4), (7.0, 0.4)],
        ]
    )
    mar = mouth_aspect_ratio(vertical_pairs, horizontal)
    assert mar < 0.2


def test_mouth_aspect_ratio_open_mouth_is_high() -> None:
    horizontal = np.array([(0.0, 0.0), (10.0, 0.0)])
    vertical_pairs = np.array(
        [
            [(3.0, -3.0), (3.0, 3.0)],
            [(5.0, -3.5), (5.0, 3.5)],
            [(7.0, -3.0), (7.0, 3.0)],
        ]
    )
    mar = mouth_aspect_ratio(vertical_pairs, horizontal)
    assert mar > 0.6
