"""Log de transições de estado e interface para sinks de eventos futuros."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from .detector import DetectionResult, DriverState


class EventSink(ABC):
    """Interface para publicar transições de estado.

    A implementação padrão grava em JSONL local; no futuro outras
    implementações podem publicar os mesmos eventos via MQTT/HTTP sem
    alterar o restante do pipeline.
    """

    @abstractmethod
    def emit(
        self,
        timestamp_s: float,
        state: DriverState,
        ear: Optional[float],
        mar: Optional[float],
        perclos: float,
        pitch: Optional[float],
        yaw: Optional[float],
    ) -> None:
        """Publica um evento de transição de estado."""


class JsonlEventSink(EventSink):
    """Grava cada transição de estado como uma linha JSON em ``events.jsonl``."""

    def __init__(self, path: str | Path = "events.jsonl") -> None:
        self._path = Path(path)

    def emit(
        self,
        timestamp_s: float,
        state: DriverState,
        ear: Optional[float],
        mar: Optional[float],
        perclos: float,
        pitch: Optional[float],
        yaw: Optional[float],
    ) -> None:
        record = {
            "timestamp_s": timestamp_s,
            "state": state.value,
            "ear": ear,
            "mar": mar,
            "perclos": perclos,
            "pitch": pitch,
            "yaw": yaw,
        }
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


class StateChangeLogger:
    """Observa o resultado do detector a cada frame e emite só as transições."""

    def __init__(self, sink: EventSink) -> None:
        self._sink = sink
        self._last_state: Optional[DriverState] = None

    def observe(
        self,
        timestamp_s: float,
        result: DetectionResult,
        ear: Optional[float],
        mar: Optional[float],
        pitch: Optional[float],
        yaw: Optional[float],
    ) -> None:
        """Emite um evento apenas quando ``result.state`` muda de valor."""
        if result.state != self._last_state:
            self._sink.emit(timestamp_s, result.state, ear, mar, result.perclos, pitch, yaw)
            self._last_state = result.state
