#!/usr/bin/env python3
"""V16 — mede o DETECTOR DE VOZ nas músicas de verdade, antes de ele entrar no app.

O detector (Silero VAD, do whisper.cpp v1.7.6 em diante) promete duas coisas:
transcrição mais rápida (pula introdução, solo e silêncio) e instrumental
reconhecida em segundos. O risco é ele ter sido feito para FALA: canto com
instrumento alto pode passar por "sem voz", e aí a letra sai incompleta.

Por isso este script transcreve cada música DUAS vezes — sem e com o detector
— e mostra lado a lado o tempo e quanto texto saiu. Mesmo modelo e mesmos
parâmetros do app (português, sem carimbo de tempo, sem contexto entre
trechos).

**O acervo não é tocado.** O áudio é convertido para WAV numa pasta temporária
do sistema, e o programa e o modelo do detector são baixados para
~/cancioneiro-medicao. Só o Mac com chip M (M1 em diante).

Uso:  curl -sL <este arquivo> | python3 - "musica 1.mp3" "musica 2.mp3" ...
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = "https://github.com/gabrielnader/cancioneiro/releases/download/acessorios-v1/"
PROGRAMA = "whisper-cli-v195-macos12-arm64-metal"
DETECTOR = "ggml-silero-v6.2.0.bin"
MODELO = Path.home() / "Library/Application Support/br.com.avantsoft.cancioneiro/acessorios/ggml-medium.bin"
PASTA = Path.home() / "cancioneiro-medicao"


def baixar(nome: str) -> Path:
    destino = PASTA / nome
    if not destino.exists():
        print(f"baixando {nome}…", file=sys.stderr)
        urllib.request.urlretrieve(BASE + nome, destino)
        destino.chmod(0o755)
    return destino


# V16 — a 1ª medição (regulagem de fábrica, limiar 0,5) acertou as
# instrumentais e PERDEU canto: "Balanço do mar II" ficou sem nada. O detector
# foi feito para fala; aqui se mede se ele fica útil mais sensível.
REGULAGENS = [
    ("sem detector", None),
    ("sensível (0,3)", ["--vad-threshold", "0.3", "--vad-speech-pad-ms", "500"]),
    ("muito sensível (0,15)", ["--vad-threshold", "0.15", "--vad-speech-pad-ms", "500"]),
]


def transcrever(programa: Path, wav: Path, detector: Path | None, extra: list[str] | None) -> tuple[float, str]:
    args = [str(programa), "--model", str(MODELO), "--file", str(wav), "--language", "pt",
            "--no-timestamps", "--max-context", "0"]
    if extra is not None:
        args += ["--vad", "--vad-model", str(detector), *extra]
    inicio = time.monotonic()
    r = subprocess.run(args, capture_output=True, text=True)
    return time.monotonic() - inicio, " ".join(r.stdout.split())


def main(arquivos: list[str]) -> int:
    if not arquivos:
        print(__doc__)
        return 2
    if not MODELO.exists():
        print(f"não achei o modelo do app em {MODELO} — baixe-o em Programas extras")
        return 1
    PASTA.mkdir(exist_ok=True)
    programa, detector = baixar(PROGRAMA), baixar(DETECTOR)
    totais = [0.0] * len(REGULAGENS)
    with tempfile.TemporaryDirectory() as tmp:
        for i, mp3 in enumerate(arquivos, 1):
            caminho = Path(mp3).expanduser()
            wav = Path(tmp) / "audio.wav"
            # a mesma conversão do app: 16 kHz, mono, 16 bits
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(caminho), str(wav)],
                           check=True, capture_output=True)
            print(f"\n=== [{i}/{len(arquivos)}] {caminho.name}")
            for n, (nome, extra) in enumerate(REGULAGENS):
                t, texto = transcrever(programa, wav, detector, extra)
                totais[n] += t
                print(f"  {nome:22} {t:5.0f} s, {len(texto):5} letras — {texto[:70]!r}")
            wav.unlink(missing_ok=True)
    print("\nTOTAL:")
    for (nome, _), t in zip(REGULAGENS, totais):
        print(f"  {nome:22} {t:5.0f} s" + (f" — {totais[0] / t:.1f}x mais rápido" if t and nome != REGULAGENS[0][0] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
