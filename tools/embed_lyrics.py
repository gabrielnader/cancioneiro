#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""embed_lyrics.py — grava/inspeciona letras (frame USLT) em arquivos MP3.

Spec F6 do PRD do Cancioneiro.

Uso:
    python tools/embed_lyrics.py musica.mp3 letra.txt [--title T] [--artist A]
    python tools/embed_lyrics.py musica.mp3 --lyrics "texto inline"
    python tools/embed_lyrics.py --check musica.mp3
"""
import argparse
import sys
from pathlib import Path

from mutagen.id3 import ID3, ID3NoHeaderError, USLT, TIT2, TPE1, Encoding
from mutagen.mp3 import MP3

LANG = "por"


def die(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def validate_mp3(path: Path) -> None:
    """Valida que o caminho existe e contem um stream MPEG real."""
    if not path.is_file():
        die(f"ERRO: arquivo inválido ou não encontrado: {path}")
    try:
        MP3(str(path))
    except Exception:
        die(f"ERRO: arquivo inválido ou não encontrado: {path}")


def load_tags(path: Path) -> ID3:
    """Carrega a tag ID3; se o MP3 nao tiver header ID3, cria uma do zero."""
    try:
        return ID3(str(path))
    except ID3NoHeaderError:
        return ID3()


def embed_lyrics(path: Path, lyrics: str, title: str | None = None,
                 artist: str | None = None) -> None:
    """Grava/substitui o frame USLT (UTF-8, lang 'por') e salva como ID3v2.4."""
    tags = load_tags(path)
    tags.delall("USLT")  # substitui, nunca duplica
    tags.add(USLT(encoding=Encoding.UTF8, lang=LANG, desc="", text=lyrics))
    if title:
        tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8, text=[title])])
    if artist:
        tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8, text=[artist])])
    tags.save(str(path), v2_version=4)


def check(path: Path) -> None:
    """Imprime title, artist e a letra completa embutida no MP3."""
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    title = str(tags["TIT2"]) if "TIT2" in tags else "(sem título)"
    artist = str(tags["TPE1"]) if "TPE1" in tags else "(sem artista)"
    uslt = tags.getall("USLT")
    print(f"Título: {title}")
    print(f"Artista: {artist}")
    if uslt:
        print("Letra:")
        print(uslt[0].text)
    else:
        print("Letra: (nenhuma letra embutida)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Grava/substitui letra (USLT) em arquivos MP3 ou inspeciona tags."
    )
    parser.add_argument("mp3", help="caminho do arquivo MP3")
    parser.add_argument("lyrics_file", nargs="?", default=None,
                        help="arquivo .txt com a letra")
    parser.add_argument("--lyrics", default=None,
                        help="letra inline (alternativa ao arquivo de letra)")
    parser.add_argument("--title", default=None, help="grava TIT2 (título)")
    parser.add_argument("--artist", default=None, help="grava TPE1 (artista)")
    parser.add_argument("--check", action="store_true",
                        help="imprime title, artist e letra embutida")
    args = parser.parse_args(argv)

    mp3_path = Path(args.mp3)
    validate_mp3(mp3_path)

    if args.check:
        check(mp3_path)
        return

    if args.lyrics is not None and args.lyrics_file is not None:
        parser.error("use um arquivo de letra OU --lyrics, não ambos")
    if args.lyrics is not None:
        lyrics = args.lyrics
    elif args.lyrics_file is not None:
        lyrics_path = Path(args.lyrics_file)
        if not lyrics_path.is_file():
            die(f"ERRO: arquivo inválido ou não encontrado: {lyrics_path}")
        lyrics = lyrics_path.read_text(encoding="utf-8")
    else:
        parser.error("informe um arquivo de letra ou --lyrics (ou use --check)")

    if not lyrics:
        die("ERRO: letra vazia — nada gravado")

    embed_lyrics(mp3_path, lyrics, title=args.title, artist=args.artist)
    print(f"OK: letra gravada em {mp3_path} ({len(lyrics)} caracteres)")


if __name__ == "__main__":
    main()
