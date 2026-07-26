#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_fixtures.py — gera os MP3s de teste do Cancioneiro em fixtures/.

Reprodutível e idempotente (sobrescreve). Gera:
  - com_letra.mp3   tom 440Hz ~3s, TIT2/TPE1 + USLT em português + TXXX:TEMAS
  - sem_letra.mp3   tom 523Hz ~2s, TIT2/TPE1, sem USLT
  - sem_tags.mp3    tom 330Hz ~2s, sem nenhuma tag ID3
  - corrompido.mp3  4096 bytes pseudo-aleatórios (seed 42), não é MP3
"""
import math
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed_lyrics import embed_lyrics, normalize_temas, write_temas  # noqa: E402

from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, Encoding  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "fixtures"
LAME = shutil.which("lame") or "/usr/bin/lame"

LETRA_COM_LETRA = """Quando o sol amanhecer
Meu coração vai cantar
A esperança vai nascer
E a alegria vai chegar

Não há noite sem estrela
Não há dor que não se cura"""

# Temas da fixture com_letra.mp3 (F7/F8 — diacríticos nos dois lados).
# Após normalização (ordenação sem acento: "agua" < "esperanca"),
# o valor gravado no TXXX:TEMAS é "água; esperança".
TEMAS_COM_LETRA = ["esperança", "água"]


def write_sine_wav(path: Path, seconds: float, freq: float,
                   rate: int = 44100, amplitude: float = 0.5) -> None:
    """Gera um WAV PCM 16-bit mono 44100Hz com um tom senoidal."""
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


def make_tone_mp3(dest: Path, seconds: float, freq: float) -> None:
    """Gera um MP3 (lame -b 64) com tom senoidal, sem nenhuma tag ID3."""
    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = Path(tmpdir) / "tone.wav"
        write_sine_wav(wav_path, seconds=seconds, freq=freq)
        subprocess.run(
            [LAME, "--quiet", "--noreplaygain", "-b", "64",
             str(wav_path), str(dest)],
            check=True,
        )
    # lame pode gravar tags residuais; garante MP3 realmente sem ID3.
    strip_id3(dest)


def strip_id3(path: Path) -> None:
    try:
        tags = ID3(str(path))
        tags.delete()
    except ID3NoHeaderError:
        pass


def set_basic_tags(path: Path, title: str, artist: str) -> None:
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8, text=[title])])
    tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8, text=[artist])])
    tags.save(str(path), v2_version=4)


def make_com_letra(dest: Path) -> None:
    make_tone_mp3(dest, seconds=3.0, freq=440.0)
    embed_lyrics(dest, LETRA_COM_LETRA,
                 title="Coração Sertanejo", artist="Artista Teste")
    write_temas(dest, normalize_temas(TEMAS_COM_LETRA))


def make_sem_letra(dest: Path) -> None:
    make_tone_mp3(dest, seconds=2.0, freq=523.0)
    set_basic_tags(dest, "Instrumental Sem Letra", "Banda Fixture")


def make_sem_tags(dest: Path) -> None:
    make_tone_mp3(dest, seconds=2.0, freq=330.0)
    strip_id3(dest)  # redundante por segurança: nenhum header ID3


def make_corrompido(dest: Path) -> None:
    rnd = random.Random(42)
    dest.write_bytes(bytes(rnd.getrandbits(8) for _ in range(4096)))


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    make_com_letra(FIXTURES_DIR / "com_letra.mp3")
    make_sem_letra(FIXTURES_DIR / "sem_letra.mp3")
    make_sem_tags(FIXTURES_DIR / "sem_tags.mp3")
    make_corrompido(FIXTURES_DIR / "corrompido.mp3")
    for nome in ("com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3", "corrompido.mp3"):
        print(f"OK: {FIXTURES_DIR / nome}")


if __name__ == "__main__":
    main()
