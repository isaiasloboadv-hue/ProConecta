"""Estimativa da pose da cabeça (pitch/yaw/roll) via solvePnP."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

from .landmarks import POSE_LANDMARKS

# Modelo 3D genérico do rosto (unidades arbitrárias, mm), usado em conjunto
# com solvePnP. Ordem alinhada com POSE_LANDMARKS.
_LANDMARK_ORDER: Tuple[str, ...] = (
    "nose",
    "chin",
    "left_eye_outer",
    "right_eye_outer",
    "mouth_left",
    "mouth_right",
)
_MODEL_POINTS = np.array(
    [
        (0.0, 0.0, 0.0),  # nariz
        (0.0, -330.0, -65.0),  # queixo
        (-225.0, 170.0, -135.0),  # canto externo olho esquerdo
        (225.0, 170.0, -135.0),  # canto externo olho direito
        (-150.0, -150.0, -125.0),  # canto esquerdo da boca
        (150.0, -150.0, -125.0),  # canto direito da boca
    ],
    dtype=np.float64,
)
_AXIS_LENGTH = 100.0
_AXIS_3D = np.array(
    [[_AXIS_LENGTH, 0.0, 0.0], [0.0, _AXIS_LENGTH, 0.0], [0.0, 0.0, _AXIS_LENGTH]],
    dtype=np.float64,
)


@dataclass(frozen=True)
class HeadPose:
    """Ângulos de Euler da cabeça (graus, normalizados para [-90, 90])."""

    pitch: float
    yaw: float
    roll: float
    nose_point: Tuple[int, int]
    axis_x: Tuple[int, int]
    axis_y: Tuple[int, int]
    axis_z: Tuple[int, int]


def normalize_angle_deg(angle: float) -> float:
    """Normaliza um ângulo de Euler (graus) para o intervalo [-90, 90].

    ``cv2.decomposeProjectionMatrix`` pode devolver ângulos próximos de
    ±180° para rotações pequenas em torno do eixo oposto (wrap-around).
    Como a cabeça de um motorista nunca gira mais que ~90° em pitch/yaw
    de forma válida, um ângulo fora de [-90, 90] é a mesma rotação vista
    do lado oposto e é trazido de volta somando/subtraindo 180°.

    Exemplo: -171° → -171 + 180 = 9°.
    """
    if angle > 90.0:
        return angle - 180.0
    if angle < -90.0:
        return angle + 180.0
    return angle


def _build_camera_matrix(frame_width: int, frame_height: int) -> np.ndarray:
    focal_length = float(frame_width)
    center = (frame_width / 2.0, frame_height / 2.0)
    return np.array(
        [
            [focal_length, 0.0, center[0]],
            [0.0, focal_length, center[1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def estimate_head_pose(
    landmarks: np.ndarray, frame_width: int, frame_height: int
) -> Optional[HeadPose]:
    """Estima pitch/yaw/roll da cabeça a partir de 6 landmarks faciais.

    Retorna ``None`` quando o solvePnP não converge. Os ângulos já saem
    normalizados para [-90, 90] via :func:`normalize_angle_deg`.
    """
    image_points = np.array(
        [landmarks[POSE_LANDMARKS[name]][:2] for name in _LANDMARK_ORDER],
        dtype=np.float64,
    )
    camera_matrix = _build_camera_matrix(frame_width, frame_height)
    dist_coeffs = np.zeros((4, 1), dtype=np.float64)

    success, rotation_vec, translation_vec = cv2.solvePnP(
        _MODEL_POINTS,
        image_points,
        camera_matrix,
        dist_coeffs,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not success:
        return None

    rotation_matrix, _ = cv2.Rodrigues(rotation_vec)
    projection_matrix = np.hstack((rotation_matrix, translation_vec))
    euler_angles = cv2.decomposeProjectionMatrix(projection_matrix)[6]
    pitch, yaw, roll = (float(a) for a in euler_angles.flatten())

    axis_2d, _ = cv2.projectPoints(
        _AXIS_3D, rotation_vec, translation_vec, camera_matrix, dist_coeffs
    )
    axis_2d = axis_2d.reshape(-1, 2)
    nose_point = (int(image_points[0][0]), int(image_points[0][1]))

    return HeadPose(
        pitch=normalize_angle_deg(pitch),
        yaw=normalize_angle_deg(yaw),
        roll=normalize_angle_deg(roll),
        nose_point=nose_point,
        axis_x=(int(axis_2d[0][0]), int(axis_2d[0][1])),
        axis_y=(int(axis_2d[1][0]), int(axis_2d[1][1])),
        axis_z=(int(axis_2d[2][0]), int(axis_2d[2][1])),
    )
