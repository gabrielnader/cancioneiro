#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""embed_lyrics.py — grava/inspeciona letras (USLT) e temas (TXXX:TEMAS) em MP3s.

Spec F6 do PRD do Cancioneiro + F7 do PRD-v2-temas.md.

Uso:
    python tools/embed_lyrics.py musica.mp3 letra.txt [--title T] [--artist A]
    python tools/embed_lyrics.py musica.mp3 --lyrics "texto inline"
    python tools/embed_lyrics.py musica.mp3 --title "X" [--artist "Y"]
    python tools/embed_lyrics.py musica.mp3 --temas "água, cura"
    python tools/embed_lyrics.py musica.mp3 --add-tema "esperança" --remove-tema "cura"
    python tools/embed_lyrics.py --check musica.mp3
"""

from __future__ import annotations
import argparse
import sys
import unicodedata
from pathlib import Path

from mutagen.id3 import ID3, ID3NoHeaderError, USLT, TIT2, TPE1, TXXX, Encoding
from mutagen.mp3 import MP3

LANG = "por"
TEMAS_DESC = "TEMAS"
TEMAS_KEY = f"TXXX:{TEMAS_DESC}"  # HashKey do mutagen: "TXXX:" + desc


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


def write_title_artist(path: Path, title: str | None = None,
                       artist: str | None = None) -> None:
    """Grava só TIT2/TPE1 (os informados), sem tocar USLT nem TXXX:TEMAS."""
    tags = load_tags(path)
    if title:
        tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8, text=[title])])
    if artist:
        tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8, text=[artist])])
    tags.save(str(path), v2_version=4)


def _sem_acento(text: str) -> str:
    """Remove diacríticos (NFD) e baixa a caixa — chave de comparação/ordenação."""
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def normalize_temas(temas: list[str]) -> list[str]:
    """Trim, colapso de espaços internos, minúsculas, dedup (sem acento/caixa)
    e ordem alfabética (chave sem acento, para estabilidade)."""
    vistos: dict[str, str] = {}
    for tema in temas:
        limpo = " ".join(tema.split()).lower()
        if not limpo:
            continue
        chave = _sem_acento(limpo)
        if chave not in vistos:
            vistos[chave] = limpo
    return [vistos[k] for k in sorted(vistos)]


def split_temas_input(raw: str) -> list[str]:
    """Divide o input de --temas aceitando vírgula OU ponto-e-vírgula."""
    return raw.replace(";", ",").split(",")


def read_temas(tags: ID3) -> list[str]:
    """Lê a lista de temas do frame TXXX:TEMAS (ou [] se ausente)."""
    frames = [f for f in tags.getall("TXXX") if f.desc == TEMAS_DESC]
    if not frames:
        return []
    valor = str(frames[0].text[0]) if frames[0].text else ""
    return [t.strip() for t in valor.split(";") if t.strip()]


def write_temas(path: Path, temas: list[str]) -> int:
    """Grava a lista (já normalizada) no frame TXXX:TEMAS, substituindo o
    existente; lista vazia remove o frame. Retorna o nº de temas gravados."""
    tags = load_tags(path)
    tags.delall(TEMAS_KEY)  # substitui, nunca duplica
    if temas:
        tags.add(TXXX(encoding=Encoding.UTF8, desc=TEMAS_DESC,
                      text=["; ".join(temas)]))
    tags.save(str(path), v2_version=4)
    return len(temas)


def apply_temas_ops(path: Path, temas_arg: str | None,
                    add: list[str], remove: list[str]) -> int:
    """Aplica --temas OU --add-tema/--remove-tema e retorna o nº final de temas."""
    if temas_arg is not None:
        final = normalize_temas(split_temas_input(temas_arg))
        return write_temas(path, final)
    atuais = normalize_temas(read_temas(load_tags(path)))
    atuais_por_chave = {_sem_acento(t): t for t in atuais}
    for tema in normalize_temas(add):
        atuais_por_chave.setdefault(_sem_acento(tema), tema)
    for tema in normalize_temas(remove):
        chave = _sem_acento(tema)
        if chave in atuais_por_chave:
            del atuais_por_chave[chave]
        else:
            print(f"AVISO: tema não encontrado: {tema}")
    final = [atuais_por_chave[k] for k in sorted(atuais_por_chave)]
    return write_temas(path, final)


def check(path: Path) -> None:
    """Imprime title, artist, temas e a letra completa embutida no MP3."""
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    title = str(tags["TIT2"]) if "TIT2" in tags else "(sem título)"
    artist = str(tags["TPE1"]) if "TPE1" in tags else "(sem artista)"
    uslt = tags.getall("USLT")
    temas = read_temas(tags)
    print(f"Título: {title}")
    print(f"Artista: {artist}")
    if temas:
        print(f"Temas: {'; '.join(temas)}")
    else:
        print("Temas: (nenhum)")
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
                        help="imprime title, artist, temas e letra embutida")
    parser.add_argument("--temas", default=None,
                        help='define a lista inteira de temas ("" remove o frame)')
    parser.add_argument("--add-tema", action="append", default=[],
                        metavar="TEMA", help="acrescenta um tema (repetível)")
    parser.add_argument("--remove-tema", action="append", default=[],
                        metavar="TEMA", help="remove um tema (repetível)")
    args = parser.parse_args(argv)

    mp3_path = Path(args.mp3)
    validate_mp3(mp3_path)

    if args.check:
        check(mp3_path)
        return

    if args.temas is not None and (args.add_tema or args.remove_tema):
        die("ERRO: use --temas OU --add-tema/--remove-tema, não ambos")

    has_temas_op = (args.temas is not None or bool(args.add_tema)
                    or bool(args.remove_tema))

    if args.lyrics is not None and args.lyrics_file is not None:
        parser.error("use um arquivo de letra OU --lyrics, não ambos")
    if args.lyrics is not None:
        lyrics = args.lyrics
    elif args.lyrics_file is not None:
        lyrics_path = Path(args.lyrics_file)
        if not lyrics_path.is_file():
            die(f"ERRO: arquivo inválido ou não encontrado: {lyrics_path}")
        lyrics = lyrics_path.read_text(encoding="utf-8")
    elif has_temas_op or args.title or args.artist:
        lyrics = None  # operação só de temas e/ou tags, sem exigir letra
    else:
        parser.error("informe um arquivo de letra, --lyrics, --title/--artist "
                     "ou --temas (ou use --check)")

    if lyrics is not None:
        if not lyrics:
            die("ERRO: letra vazia — nada gravado")
        embed_lyrics(mp3_path, lyrics, title=args.title, artist=args.artist)
        print(f"OK: letra gravada em {mp3_path} ({len(lyrics)} caracteres)")
    elif args.title or args.artist:
        # só título/artista (com ou sem operação de temas junto): não toca
        # USLT nem TXXX:TEMAS existentes
        write_title_artist(mp3_path, title=args.title, artist=args.artist)
        print(f"OK: tags gravadas em {mp3_path}")

    if has_temas_op:
        n = apply_temas_ops(mp3_path, args.temas, args.add_tema, args.remove_tema)
        print(f"OK: temas gravados em {mp3_path} ({n} temas)")


if __name__ == "__main__":
    main()
