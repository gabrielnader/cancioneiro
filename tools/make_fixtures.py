#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_fixtures.py — gera os MP3s de teste do Cancioneiro em fixtures/.

Reprodutível e idempotente (sobrescreve). Gera:
  - com_letra.mp3   tom 440Hz ~3s, TIT2/TPE1 + USLT em português + TXXX:TEMAS
  - sem_letra.mp3   tom 523Hz ~2s, TIT2/TPE1, sem USLT
  - sem_tags.mp3    tom 330Hz ~2s, sem nenhuma tag ID3
  - corrompido.mp3  4096 bytes pseudo-aleatórios (seed 42), não é MP3
  - sobra_antes_do_audio.mp3  MP3 REAL com a anomalia do acervo do relato: a
    etiqueta declara terminar antes do primeiro quadro MPEG, e sobra uma região
    de bytes no meio. Reproduz a recusa de gravação medida em campo (V10.8).
"""

from __future__ import annotations
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


# ---------------------------------------------------------------------------
# V10.8 — a fixture da SOBRA ENTRE A ETIQUETA E O PRIMEIRO QUADRO.
#
# Sete arquivos de um acervo real recusavam TODA gravação de etiqueta. A causa
# foi medida arquivo por arquivo: entre o fim DECLARADO da etiqueta ID3v2 e o
# primeiro quadro MPEG existe uma região de bytes que não é etiqueta declarada,
# não é cabeçalho de codificador e não é áudio. No arquivo medido, a etiqueta
# declarava terminar no byte 4.096 e o primeiro quadro começava em 5.347 —
# 1.251 bytes no meio, 81% zeros com bytes aleatórios por cima.
#
# Os números abaixo são EXATAMENTE os do arquivo medido, e não uma aproximação.
# O que importa neles é a relação com o teto de "bytes de lixo" da biblioteca de
# etiquetas (1.024 no lofty 0.22): é ela que decide se a gravação passa ou é
# recusada, e 1.251 > 1.024 é a razão pela qual estes sete arquivos falhavam
# enquanto outros, com sobra menor, gravavam sem reclamar. Encolher a sobra
# abaixo de 1.024 faria a fixture PASSAR a gravar, e o teste deixaria de testar
# o defeito — que é o erro que já nos custou uma versão inteira (o teste de
# fumaça que "passava" sem passar o modelo).
# ---------------------------------------------------------------------------

#: Tamanho TOTAL do bloco ID3v2 declarado no cabeçalho (10 de cabeçalho + corpo).
TAM_DA_ETIQUETA_DECLARADA = 4096
#: Bytes entre o fim declarado da etiqueta e o primeiro quadro MPEG.
TAM_DA_SOBRA = 1251
#: Proporção de bytes NÃO nulos na sobra — o resto é zero, como no arquivo medido.
SOBRA_BYTES_ALEATORIOS = 0.19


def _synchsafe(n: int) -> bytes:
    """Os 4 bytes "synchsafe" do campo de tamanho do ID3v2 (7 bits por byte).

    Sete bits por byte para o valor nunca imitar um sync de MPEG — é a mesma
    conta que o `tamanho_do_id3` do tools/diagnosticar_mp3.py desfaz.
    """
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def _sobra_deterministica(tamanho: int) -> bytes:
    """A região entre a etiqueta e o áudio: zeros com bytes aleatórios por cima.

    **Nenhum byte 0xFF entra aqui, e isso é de propósito.** 0xFF é o primeiro
    byte de um sync de MPEG: um 0xFF por sorte da semente poderia fazer a
    biblioteca achar um quadro DENTRO da sobra, e aí a fixture deixaria de
    reproduzir a recusa — o teste passaria a medir a semente em vez da anomalia.
    A região do arquivo medido também não tinha nenhum.
    """
    rnd = random.Random(TAM_DA_SOBRA)
    sobra = bytearray(tamanho)
    for i in range(tamanho):
        if rnd.random() < SOBRA_BYTES_ALEATORIOS:
            sobra[i] = rnd.randrange(0x00, 0xFF)  # exclui 0xFF
    return bytes(sobra)


def make_sobra_antes_do_audio(dest: Path) -> None:
    """MP3 REAL cuja etiqueta declara terminar antes do primeiro quadro MPEG.

    É montado a partir de um MP3 de verdade (o mesmo tom do sem_tags.mp3, gerado
    pelo lame), e só o CAMPO DE TAMANHO da etiqueta fica mentindo: o áudio é
    áudio de verdade, os quadros da etiqueta são quadros de verdade, e a região
    do meio é enchimento não declarado. Um arquivo inventado byte a byte não
    provaria nada — o defeito é a relação entre três coisas reais.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        base = Path(tmpdir) / "base.mp3"
        make_tone_mp3(base, seconds=2.0, freq=330.0)
        # etiqueta SEM enchimento: assim o tamanho declarado é exatamente o dos
        # quadros, e o enchimento que vem depois é escolhido por nós
        tags = ID3()
        tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8, text=["Sobra Antes do Áudio"])])
        tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8, text=["Banda Fixture"])])
        tags.save(str(base), v2_version=4, padding=lambda _info: 0)
        bytes_do_base = base.read_bytes()

    # desfaz o campo synchsafe para separar os três pedaços do arquivo base
    declarado = (
        (bytes_do_base[6] << 21)
        | (bytes_do_base[7] << 14)
        | (bytes_do_base[8] << 7)
        | bytes_do_base[9]
    )
    quadros_da_etiqueta = bytes_do_base[10 : 10 + declarado]
    audio = bytes_do_base[10 + declarado :]

    # o corpo da etiqueta: os quadros de verdade + enchimento de zeros até o
    # tamanho declarado. Enchimento de zeros dentro de uma etiqueta ID3v2 é
    # previsto pelo padrão, e é o que todo editor de etiqueta escreve.
    corpo = quadros_da_etiqueta + bytes(TAM_DA_ETIQUETA_DECLARADA - 10 - len(quadros_da_etiqueta))
    cabecalho = b"ID3" + bytes([4, 0, 0]) + _synchsafe(TAM_DA_ETIQUETA_DECLARADA - 10)
    dest.write_bytes(cabecalho + corpo + _sobra_deterministica(TAM_DA_SOBRA) + audio)


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    make_com_letra(FIXTURES_DIR / "com_letra.mp3")
    make_sem_letra(FIXTURES_DIR / "sem_letra.mp3")
    make_sem_tags(FIXTURES_DIR / "sem_tags.mp3")
    make_corrompido(FIXTURES_DIR / "corrompido.mp3")
    make_sobra_antes_do_audio(FIXTURES_DIR / "sobra_antes_do_audio.mp3")
    for nome in (
        "com_letra.mp3",
        "sem_letra.mp3",
        "sem_tags.mp3",
        "corrompido.mp3",
        "sobra_antes_do_audio.mp3",
    ):
        print(f"OK: {FIXTURES_DIR / nome}")


if __name__ == "__main__":
    main()
