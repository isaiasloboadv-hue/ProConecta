"""Alertas sonoros: beep sintético (numpy + pygame.mixer) com cooldown."""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pygame

from .config import Config
from .detector import DriverState

_SAMPLE_RATE = 44100


def _generate_tone(frequency_hz: float, duration_s: float, volume: float = 0.5) -> np.ndarray:
    """Gera um tom senoidal estéreo em memória, sem depender de arquivo externo."""
    t = np.linspace(0, duration_s, int(_SAMPLE_RATE * duration_s), endpoint=False)
    wave = (np.sin(2 * np.pi * frequency_hz * t) * volume * 32767).astype(np.int16)
    return np.column_stack([wave, wave])


class AlertPlayer:
    """Toca um beep curto em WARNING/DROWSY e um beep contínuo em MICROSLEEP.

    Se o mixer de áudio não puder ser inicializado (sem dispositivo de som
    disponível, por exemplo) os alertas viram no-ops silenciosos em vez de
    derrubar a aplicação.
    """

    def __init__(self, config: Config, mute: bool = False) -> None:
        self._config = config
        self._muted = mute
        self._mixer_ready = False
        self._warning_sound: Optional[pygame.mixer.Sound] = None
        self._microsleep_sound: Optional[pygame.mixer.Sound] = None
        self._microsleep_channel: Optional[pygame.mixer.Channel] = None
        self._last_warning_at = -math.inf
        if not mute:
            self._try_init_mixer()

    def _try_init_mixer(self) -> None:
        try:
            pygame.mixer.init(frequency=_SAMPLE_RATE, size=-16, channels=2)
            self._warning_sound = pygame.sndarray.make_sound(_generate_tone(880.0, 0.25))
            self._microsleep_sound = pygame.sndarray.make_sound(_generate_tone(1200.0, 0.6))
            self._mixer_ready = True
        except pygame.error:
            self._mixer_ready = False

    @property
    def muted(self) -> bool:
        """True quando os alertas sonoros estão desligados."""
        return self._muted

    def set_muted(self, muted: bool) -> None:
        """Liga/desliga o áudio (tecla ``m`` ou flag ``--mute``)."""
        self._muted = muted
        if muted:
            self.stop()
        elif not self._mixer_ready:
            self._try_init_mixer()

    def stop(self) -> None:
        """Interrompe qualquer alerta em reprodução."""
        if self._mixer_ready:
            pygame.mixer.stop()
        self._microsleep_channel = None

    def notify(self, state: DriverState, timestamp_s: float) -> None:
        """Toca o alerta apropriado para ``state``, respeitando o cooldown."""
        if self._muted or not self._mixer_ready:
            return

        if state == DriverState.MICROSLEEP:
            if self._microsleep_channel is None or not self._microsleep_channel.get_busy():
                self._microsleep_channel = self._microsleep_sound.play(loops=-1)
            return

        if self._microsleep_channel is not None:
            self._microsleep_channel.stop()
            self._microsleep_channel = None

        if state in (DriverState.WARNING, DriverState.DROWSY):
            if timestamp_s - self._last_warning_at >= self._config.alert_cooldown_s:
                self._warning_sound.play()
                self._last_warning_at = timestamp_s
