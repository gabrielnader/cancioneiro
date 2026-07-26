# -*- coding: utf-8 -*-
"""Helpers compartilhados para os testes Python do Cancioneiro."""
import math
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = REPO_ROOT / "tools"
EMBED_SCRIPT = TOOLS_DIR / "embed_lyrics.py"
FIXTURES_SCRIPT = TOOLS_DIR / "make_fixtures.py"
LAME = shutil.which("lame") or "/usr/bin/lame"


def write_sine_wav(path: Path, seconds: float = 1.5, freq: float = 440.0,
                   rate: int = 44100, amplitude: float = 0.5) -> None:
    """Gera um WAV PCM 16-bit mono com um tom senoidal."""
    n_frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        frames = bytearray()
        for i in range(n_frames):
            sample = int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / rate))
            frames += struct.pack("<h", sample)
        wf.writeframes(bytes(frames))


def make_mp3(dest: Path, seconds: float = 1.5, freq: float = 440.0) -> Path:
    """Cria um MP3 de teste (tom senoidal) usando lame. Sem tags ID3."""
    wav_path = dest.with_suffix(".tmp.wav")
    write_sine_wav(wav_path, seconds=seconds, freq=freq)
    subprocess.run(
        [LAME, "--quiet", "--noreplaygain", "-b", "64", str(wav_path), str(dest)],
        check=True,
        capture_output=True,
    )
    wav_path.unlink()
    # Garante ausencia de qualquer tag ID3 que o lame possa ter escrito.
    from mutagen.id3 import ID3, ID3NoHeaderError
    try:
        tags = ID3(str(dest))
        tags.delete()
    except ID3NoHeaderError:
        pass
    return dest


def run_embed(*args: str) -> subprocess.CompletedProcess:
    """Executa o CLI embed_lyrics.py e retorna o processo concluido."""
    return subprocess.run(
        [sys.executable, str(EMBED_SCRIPT), *[str(a) for a in args]],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


@pytest.fixture
def mp3_file(tmp_path: Path) -> Path:
    """MP3 temporario valido, sem tags ID3."""
    return make_mp3(tmp_path / "musica.mp3")
