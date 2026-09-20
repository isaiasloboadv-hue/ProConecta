"""Métricas geométricas puras: Eye Aspect Ratio (EAR) e Mouth Aspect Ratio (MAR)."""

from __future__ import annotations

import numpy as np

from .landmarks import LEFT_EYE, MOUTH_VERTICAL_PAIRS, MOUTH_WIDTH_PAIR, RIGHT_EYE


def eye_aspect_ratio(eye_points: np.ndarray) -> float:
    """Calcula o EAR de um olho a partir de 6 pontos (x, y) [, z].

    ``eye_points`` deve estar na ordem ``p1..p6`` onde ``p1``/``p4`` são os
    cantos horizontais do olho e (``p2``, ``p6``), (``p3``, ``p5``) são os
    pares verticais opostos das pálpebras:

        EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2·‖p1−p4‖)

    Valores próximos de ~0.3 indicam olho aberto; próximos de 0 indicam
    olho fechado.
    """
    points = np.asarray(eye_points, dtype=np.float64)[:, :2]
    p1, p2, p3, p4, p5, p6 = points[:6]
    vertical = np.linalg.norm(p2 - p6) + np.linalg.norm(p3 - p5)
    horizontal = np.linalg.norm(p1 - p4)
    return float(vertical / (2.0 * horizontal))


def mouth_aspect_ratio(vertical_pairs: np.ndarray, horizontal_pair: np.ndarray) -> float:
    """Calcula o MAR a partir de pares verticais internos e da largura da boca.

    ``vertical_pairs`` tem forma ``(3, 2, 2)`` — três pares (topo, base) de
    pontos (x, y). ``horizontal_pair`` tem forma ``(2, 2)`` — os dois cantos
    da boca.

        MAR = média(‖topo_i − base_i‖) / ‖canto_esq − canto_dir‖

    Valores baixos (~0.2 ou menos) indicam boca fechada; acima de ~0.6
    indicam boca bem aberta (bocejo).
    """
    verticals = np.asarray(vertical_pairs, dtype=np.float64)[:, :, :2]
    horizontal = np.asarray(horizontal_pair, dtype=np.float64)[:, :2]

    vertical_distances = np.linalg.norm(verticals[:, 0] - verticals[:, 1], axis=1)
    horizontal_distance = np.linalg.norm(horizontal[0] - horizontal[1])
    return float(np.mean(vertical_distances) / horizontal_distance)


def compute_ear(landmarks: np.ndarray) -> float:
    """EAR final do frame: média entre olho esquerdo e direito."""
    left = eye_aspect_ratio(landmarks[list(LEFT_EYE)])
    right = eye_aspect_ratio(landmarks[list(RIGHT_EYE)])
    return (left + right) / 2.0


def compute_mar(landmarks: np.ndarray) -> float:
    """MAR do frame a partir dos landmarks completos do rosto."""
    vertical_pairs = np.array(
        [[landmarks[top], landmarks[bottom]] for top, bottom in MOUTH_VERTICAL_PAIRS]
    )
    horizontal_pair = np.array([landmarks[MOUTH_WIDTH_PAIR[0]], landmarks[MOUTH_WIDTH_PAIR[1]]])
    return mouth_aspect_ratio(vertical_pairs, horizontal_pair)
