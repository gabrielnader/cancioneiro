#!/usr/bin/env python3
"""Diz por que o Cancioneiro não consegue GRAVAR etiquetas num arquivo.

Nasceu de um relato de campo: 7 músicas de uma pasta falharam todas com a
mesma frase — "não foi possível ler este MP3 até o fim [...] o arquivo pode
estar danificado, ou o disco onde ele está pode ter sido desconectado". Essa
frase cobre OITO situações diferentes da biblioteca de etiquetas, e algumas
delas não têm nada a ver com arquivo danificado nem com disco. Quem lê não
tem como saber qual aconteceu — e é justamente quem não tem a quem
perguntar.

Este script não conserta nada e **não escreve em nenhum arquivo**: abre para
leitura, mede, e imprime. É a mesma promessa do produto (a reprodução nunca
escreve; nada é gravado sem alguém conferir e clicar).

Uso:

    python3 tools/diagnosticar_mp3.py "/caminho/da/pasta"
    python3 tools/diagnosticar_mp3.py arquivo1.mp3 arquivo2.mp3
"""

from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Assinaturas de CONTAINER. O ponto do script.
#
# Um arquivo com extensão .mp3 que na verdade é MPEG-4/AAC, FLAC, Ogg ou WAV
# TOCA no Cancioneiro — quem decodifica o áudio é o WebView, e ele aceita
# vários formatos. Mas gravar etiqueta ID3 exige fluxo MPEG, e a biblioteca
# recusa. O sintoma que a pessoa vê é "não foi possível salvar", e o motivo
# real é que o arquivo nunca foi um MP3.
# ---------------------------------------------------------------------------
ASSINATURAS: list[tuple[int, bytes, str]] = [
    (4, b"ftyp", "MPEG-4 / AAC (.m4a, .mp4) com nome de .mp3"),
    (0, b"fLaC", "FLAC"),
    (0, b"OggS", "Ogg (Vorbis/Opus)"),
    (0, b"RIFF", "RIFF/WAVE"),
    (0, b"FORM", "AIFF"),
    (0, b"\x1aE\xdf\xa3", "Matroska / WebM"),
    (0, b"MAC ", "Monkey's Audio"),
    (0, b"wvpk", "WavPack"),
]


def container(dados: bytes) -> str | None:
    """O formato REAL do arquivo, quando não é MPEG."""
    for deslocamento, marca, nome in ASSINATURAS:
        if dados[deslocamento : deslocamento + len(marca)] == marca:
            return nome
    return None


def tamanho_do_id3(dados: bytes) -> int:
    """Bytes do cabeçalho ID3v2 no começo do arquivo (0 se não houver).

    O tamanho vem em "synchsafe": sete bits por byte, para o valor nunca
    imitar um sync de MPEG.
    """
    if len(dados) < 10 or dados[:3] != b"ID3":
        return 0
    b = dados[6:10]
    if any(x & 0x80 for x in b):
        return 0  # tamanho inválido; tratado como "não sei"
    return 10 + ((b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3])


def acha_sync_mpeg(dados: bytes, inicio: int) -> int | None:
    """Posição do primeiro quadro MPEG plausível a partir de `inicio`."""
    i = inicio
    limite = min(len(dados) - 1, inicio + 512 * 1024)
    while i < limite:
        if dados[i] == 0xFF and (dados[i + 1] & 0xE0) == 0xE0:
            versao = (dados[i + 1] >> 3) & 0x03
            camada = (dados[i + 1] >> 1) & 0x03
            # versão 01 é reservada; camada 00 é reservada
            if versao != 1 and camada != 0:
                return i
        i += 1
    return None


def texto_das_etiquetas(caminho: Path) -> list[str]:
    """Problemas de TEXTO nas etiquetas — a outra família da mesma frase.

    `StringFromUtf8`, `StrFromUtf8` e `TextDecode` caem na mesma mensagem que
    fala de arquivo danificado, e não são isso: são bytes de texto que não
    correspondem à codificação declarada no quadro.
    """
    achados: list[str] = []
    try:
        from mutagen.id3 import ID3  # type: ignore[import-not-found]
    except ImportError:
        return ["(mutagen não instalado — `pip install mutagen` para esta parte)"]
    try:
        tag = ID3(caminho)
    except Exception as e:  # noqa: BLE001 — qualquer falha aqui É o achado
        return [f"o ID3 não pôde ser lido pelo mutagen: {type(e).__name__}: {e}"]
    for quadro in tag.values():
        nome = getattr(quadro, "FrameID", type(quadro).__name__)
        # o campo de idioma de USLT/COMM foi causa de recusa de gravação antes
        idioma = getattr(quadro, "lang", None)
        if idioma is not None and (
            len(idioma) != 3 or not all(c.isascii() and c.isalpha() for c in idioma)
        ):
            achados.append(f"{nome}: campo de idioma fora do padrão ({idioma!r})")
        for texto in getattr(quadro, "text", []) or []:
            if not isinstance(texto, str):
                continue
            try:
                texto.encode("utf-8")
            except UnicodeEncodeError as e:
                achados.append(f"{nome}: texto que não vira UTF-8 ({e})")
    return achados


def diagnosticar(caminho: Path) -> None:
    print(f"\n=== {caminho.name}")
    try:
        with caminho.open("rb") as f:  # leitura, e só
            dados = f.read()
    except OSError as e:
        print(f"  NÃO DEU PARA ABRIR: {e}")
        return

    print(f"  tamanho: {len(dados):,} bytes")
    if len(dados) < 512:
        print("  PROBLEMA: arquivo minúsculo — download interrompido?")
        return

    real = container(dados)
    if real is not None:
        print(f"  >>> NÃO É UM MP3. É {real}.")
        print("      O player toca (quem decodifica é o sistema), mas gravar")
        print("      etiqueta exige fluxo MPEG — daí a recusa ao salvar.")
        return

    inicio = tamanho_do_id3(dados)
    print(f"  ID3v2 no começo: {inicio:,} bytes" if inicio else "  sem ID3v2 no começo")
    if inicio > len(dados):
        print("  >>> PROBLEMA: o ID3 diz ser MAIOR que o arquivo inteiro.")
        print("      É a assinatura de download interrompido no meio da etiqueta.")
        return

    sync = acha_sync_mpeg(dados, inicio)
    if sync is None:
        print("  >>> PROBLEMA: nenhum quadro MPEG encontrado depois da etiqueta.")
        print("      O arquivo tem etiqueta, mas não tem áudio MPEG reconhecível.")
        return
    if sync != inicio:
        print(f"  quadro MPEG começa em {sync:,} (e não em {inicio:,}) — {sync - inicio} bytes de sobra")
    else:
        print(f"  quadro MPEG começa em {sync:,}, como esperado")

    problemas = texto_das_etiquetas(caminho)
    if problemas:
        print("  etiquetas:")
        for p in problemas:
            print(f"    - {p}")
    else:
        print("  etiquetas: nada fora do padrão encontrado")
        print("  (se este arquivo ainda falha ao salvar, me mande esta saída:")
        print("   a causa não está nas coisas que este script sabe medir)")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    alvos: list[Path] = []
    for arg in argv[1:]:
        p = Path(arg).expanduser()
        if p.is_dir():
            alvos.extend(sorted(q for q in p.rglob("*") if q.suffix.lower() == ".mp3"))
        elif p.exists():
            alvos.append(p)
        else:
            print(f"não achei: {p}")
    if not alvos:
        print("nenhum .mp3 encontrado")
        return 1
    print(f"{len(alvos)} arquivo(s) — NADA é modificado, só lido")
    for a in alvos:
        diagnosticar(a)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
