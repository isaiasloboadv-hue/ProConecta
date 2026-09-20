"""Testes de head_pose.py: rotação conhecida e normalização de wrap-around."""

import cv2
import numpy as np
import pytest

from drowsiness.head_pose import (
    POSE_LANDMARKS,
    _build_camera_matrix,
    _MODEL_POINTS,
    estimate_head_pose,
    normalize_angle_deg,
)

_ORDER = ("nose", "chin", "left_eye_outer", "right_eye_outer", "mouth_left", "mouth_right")
_FRAME_WIDTH = 640
_FRAME_HEIGHT = 480


def _landmarks_for_rotation(pitch_deg: float, yaw_deg: float, roll_deg: float) -> np.ndarray:
    """Projeta o modelo 3D com uma rotação conhecida para landmarks 2D sintéticos."""
    rvec = np.radians([pitch_deg, yaw_deg, roll_deg]).reshape(3, 1)
    tvec = np.array([[0.0], [0.0], [1000.0]])
    camera_matrix = _build_camera_matrix(_FRAME_WIDTH, _FRAME_HEIGHT)
    dist_coeffs = np.zeros((4, 1))

    image_points, _ = cv2.projectPoints(_MODEL_POINTS, rvec, tvec, camera_matrix, dist_coeffs)
    image_points = image_points.reshape(-1, 2)

    n_landmarks = max(POSE_LANDMARKS.values()) + 1
    landmarks = np.zeros((n_landmarks, 3))
    for name, point in zip(_ORDER, image_points):
        landmarks[POSE_LANDMARKS[name], :2] = point
    return landmarks


def test_estimate_head_pose_recovers_known_pitch() -> None:
    landmarks = _landmarks_for_rotation(pitch_deg=15.0, yaw_deg=0.0, roll_deg=0.0)

    pose = estimate_head_pose(landmarks, _FRAME_WIDTH, _FRAME_HEIGHT)

    assert pose is not None
    assert pose.pitch == pytest.approx(15.0, abs=0.5)
    assert pose.yaw == pytest.approx(0.0, abs=0.5)
    assert pose.roll == pytest.approx(0.0, abs=0.5)


def test_estimate_head_pose_recovers_known_yaw() -> None:
    landmarks = _landmarks_for_rotation(pitch_deg=0.0, yaw_deg=-25.0, roll_deg=0.0)

    pose = estimate_head_pose(landmarks, _FRAME_WIDTH, _FRAME_HEIGHT)

    assert pose is not None
    assert pose.yaw == pytest.approx(-25.0, abs=0.5)
    assert pose.pitch == pytest.approx(0.0, abs=0.5)


def test_estimate_head_pose_recovers_known_roll() -> None:
    landmarks = _landmarks_for_rotation(pitch_deg=0.0, yaw_deg=0.0, roll_deg=12.0)

    pose = estimate_head_pose(landmarks, _FRAME_WIDTH, _FRAME_HEIGHT)

    assert pose is not None
    assert pose.roll == pytest.approx(12.0, abs=0.5)


def test_estimate_head_pose_neutral_is_zero() -> None:
    landmarks = _landmarks_for_rotation(pitch_deg=0.0, yaw_deg=0.0, roll_deg=0.0)

    pose = estimate_head_pose(landmarks, _FRAME_WIDTH, _FRAME_HEIGHT)

    assert pose is not None
    assert pose.pitch == pytest.approx(0.0, abs=0.5)
    assert pose.yaw == pytest.approx(0.0, abs=0.5)


@pytest.mark.parametrize(
    "raw_angle, expected",
    [
        (-171.0, 9.0),
        (171.0, -9.0),
        (95.0, -85.0),
        (-95.0, 85.0),
        (45.0, 45.0),
        (-45.0, -45.0),
        (0.0, 0.0),
        (90.0, 90.0),
        (-90.0, -90.0),
    ],
)
def test_normalize_angle_deg_handles_wraparound(raw_angle: float, expected: float) -> None:
    assert normalize_angle_deg(raw_angle) == pytest.approx(expected)
