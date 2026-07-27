# -*- coding: utf-8 -*-
"""Testes do CLI tools/embed_lyrics.py (spec F6 do PRD) — escritos antes da implementacao (TDD)."""
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError

from conftest import run_embed

LETRA = (
    "Quando o sol amanhecer\n"
    "Meu coração vai cantar\n"
    "A esperança vai nascer\n"
    "E a alegria vai chegar\n"
    "\n"
    "Não há noite sem estrela\n"
    "Não há dor que não se cura\n"
)


def write_lyrics_file(tmp_path: Path, text: str = LETRA) -> Path:
    p = tmp_path / "letra.txt"
    p.write_text(text, encoding="utf-8")
    return p


def uslt_frames(mp3_path: Path):
    try:
        tags = ID3(str(mp3_path))
    except ID3NoHeaderError:
        return []
    return tags.getall("USLT")


class TestGravarLetra:
    def test_grava_letra_de_arquivo_txt(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        result = run_embed(mp3_file, lyrics_file)
        assert result.returncode == 0, result.stderr
        frames = uslt_frames(mp3_file)
        assert len(frames) == 1
        assert frames[0].text == LETRA  # acentos e \n preservados

    def test_uslt_utf8_e_lang_por(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        run_embed(mp3_file, lyrics_file)
        frame = uslt_frames(mp3_file)[0]
        assert frame.lang == "por"
        assert int(frame.encoding) == 3  # Encoding.UTF8

    def test_lyrics_inline(self, mp3_file):
        result = run_embed(mp3_file, "--lyrics", "Letra inline com ç e ã\nsegunda linha")
        assert result.returncode == 0, result.stderr
        frames = uslt_frames(mp3_file)
        assert len(frames) == 1
        assert frames[0].text == "Letra inline com ç e ã\nsegunda linha"

    def test_saida_sucesso_formato_exato(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        result = run_embed(mp3_file, lyrics_file)
        expected = f"OK: letra gravada em {mp3_file} ({len(LETRA)} caracteres)"
        assert result.stdout.strip() == expected

    def test_rodar_duas_vezes_substitui_uslt(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        run_embed(mp3_file, lyrics_file)
        result = run_embed(mp3_file, "--lyrics", "Nova letra")
        assert result.returncode == 0
        frames = uslt_frames(mp3_file)
        assert len(frames) == 1  # substitui, nao duplica
        assert frames[0].text == "Nova letra"

    def test_title_e_artist(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        result = run_embed(
            mp3_file, lyrics_file,
            "--title", "Coração Sertanejo",
            "--artist", "Artista Teste",
        )
        assert result.returncode == 0, result.stderr
        tags = ID3(str(mp3_file))
        assert str(tags["TIT2"]) == "Coração Sertanejo"
        assert str(tags["TPE1"]) == "Artista Teste"

    def test_mp3_sem_header_id3_cria_tag(self, mp3_file):
        # mp3_file vem sem nenhuma tag ID3 (conftest garante)
        with pytest.raises(Exception):
            ID3(str(mp3_file))
        result = run_embed(mp3_file, "--lyrics", "Letra em MP3 cru")
        assert result.returncode == 0, result.stderr
        frames = uslt_frames(mp3_file)
        assert len(frames) == 1
        assert frames[0].text == "Letra em MP3 cru"

    def test_salva_id3v24(self, mp3_file):
        run_embed(mp3_file, "--lyrics", "qualquer letra")
        tags = ID3(str(mp3_file))
        assert tags.version[:2] == (2, 4)

    def test_audio_preservado(self, mp3_file, tmp_path):
        from mutagen.mp3 import MP3
        dur_antes = MP3(str(mp3_file)).info.length
        lyrics_file = write_lyrics_file(tmp_path)
        run_embed(mp3_file, lyrics_file)
        dur_depois = MP3(str(mp3_file)).info.length
        assert dur_depois == pytest.approx(dur_antes, abs=0.2)


class TestTagsSemLetra:
    """--title/--artist sozinhos, sem letra e sem temas (standalone)."""

    def test_title_sozinho_grava_tit2(self, mp3_file):
        result = run_embed(mp3_file, "--title", "Florestal")
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == f"OK: tags gravadas em {mp3_file}"
        tags = ID3(str(mp3_file))
        assert str(tags["TIT2"]) == "Florestal"
        assert tags.getall("USLT") == []  # nenhuma letra criada

    def test_artist_sozinho_grava_tpe1(self, mp3_file):
        result = run_embed(mp3_file, "--artist", "Martonio Holanda")
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == f"OK: tags gravadas em {mp3_file}"
        tags = ID3(str(mp3_file))
        assert str(tags["TPE1"]) == "Martonio Holanda"
        assert "TIT2" not in tags

    def test_title_e_artist_juntos(self, mp3_file):
        result = run_embed(mp3_file, "--title", "Musica Bonita",
                           "--artist", "Hyldon")
        assert result.returncode == 0, result.stderr
        tags = ID3(str(mp3_file))
        assert str(tags["TIT2"]) == "Musica Bonita"
        assert str(tags["TPE1"]) == "Hyldon"

    def test_nao_altera_uslt_nem_temas_existentes(self, mp3_file):
        run_embed(mp3_file, "--lyrics", "letra que fica", "--temas", "cura")
        result = run_embed(mp3_file, "--title", "Novo Título")
        assert result.returncode == 0, result.stderr
        tags = ID3(str(mp3_file))
        assert str(tags["TIT2"]) == "Novo Título"
        assert tags.getall("USLT")[0].text == "letra que fica"
        temas = [f for f in tags.getall("TXXX") if f.desc == "TEMAS"]
        assert len(temas) == 1
        assert str(temas[0].text[0]) == "cura"

    def test_salva_id3v24(self, mp3_file):
        run_embed(mp3_file, "--title", "X")
        assert ID3(str(mp3_file)).version[:2] == (2, 4)


class TestCheck:
    def test_check_imprime_letra(self, mp3_file, tmp_path):
        lyrics_file = write_lyrics_file(tmp_path)
        run_embed(
            mp3_file, lyrics_file,
            "--title", "Coração Sertanejo", "--artist", "Artista Teste",
        )
        result = run_embed("--check", mp3_file)
        assert result.returncode == 0, result.stderr
        assert "Coração Sertanejo" in result.stdout
        assert "Artista Teste" in result.stdout
        assert LETRA.strip() in result.stdout


class TestErros:
    def test_arquivo_inexistente(self, tmp_path):
        missing = tmp_path / "nao_existe.mp3"
        result = run_embed(missing, "--lyrics", "abc")
        assert result.returncode == 1
        msg = f"ERRO: arquivo inválido ou não encontrado: {missing}"
        assert msg in (result.stderr + result.stdout)

    def test_arquivo_nao_mp3(self, tmp_path):
        txt = tmp_path / "nao_e_mp3.txt"
        txt.write_text("apenas texto", encoding="utf-8")
        result = run_embed(txt, "--lyrics", "abc")
        assert result.returncode == 1
        msg = f"ERRO: arquivo inválido ou não encontrado: {txt}"
        assert msg in (result.stderr + result.stdout)

    def test_letra_vazia_inline(self, mp3_file):
        result = run_embed(mp3_file, "--lyrics", "")
        assert result.returncode == 1
        assert "ERRO: letra vazia — nada gravado" in (result.stderr + result.stdout)

    def test_letra_vazia_arquivo(self, mp3_file, tmp_path):
        empty = tmp_path / "vazia.txt"
        empty.write_text("", encoding="utf-8")
        result = run_embed(mp3_file, empty)
        assert result.returncode == 1
        assert "ERRO: letra vazia — nada gravado" in (result.stderr + result.stdout)

    def test_letra_vazia_nao_grava_nada(self, mp3_file):
        run_embed(mp3_file, "--lyrics", "")
        assert uslt_frames(mp3_file) == [] or not uslt_frames(mp3_file)
