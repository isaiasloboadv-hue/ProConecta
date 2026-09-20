"""Carregamento da configuração (config.yaml) em um objeto tipado."""

from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class Config:
    """Todos os limiares e durações usados pelo pipeline de detecção."""

    calibration_seconds: float = 15.0
    ear_default_threshold: float = 0.20
    ear_closed_ratio: float = 0.75
    mar_yawn: float = 0.6
    perclos_window_s: float = 30.0
    perclos_drowsy: float = 0.20
    microsleep_s: float = 0.8
    yawn_s: float = 1.2
    pitch_delta_deg: float = 20.0
    pitch_s: float = 1.5
    yaw_delta_deg: float = 35.0
    yaw_s: float = 2.0
    face_lost_s: float = 2.0
    hysteresis_s: float = 1.0
    alert_cooldown_s: float = 3.0

    @staticmethod
    def load(path: str | Path) -> "Config":
        """Lê um YAML de configuração, preenchendo campos ausentes com o padrão."""
        raw: dict[str, Any] = {}
        config_path = Path(path)
        if config_path.exists():
            with config_path.open("r", encoding="utf-8") as handle:
                loaded = yaml.safe_load(handle)
                if loaded:
                    raw = loaded
        known = {f.name for f in fields(Config)}
        filtered = {k: v for k, v in raw.items() if k in known}
        return Config(**filtered)
