# -*- coding: utf-8 -*-
"""Testes do CLI tools/embed_lyrics.py (spec F6 do PRD) — escritos antes da implementacao (TDD)."""
import hashlib
import os
import stat
import sys
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError

from conftest import TOOLS_DIR, run_embed

sys.path.insert(0, str(TOOLS_DIR))
import embed_lyrics as el  # noqa: E402

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


# ------------------------------------------------- gravação atômica (M3)

def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class TestGravacaoAtomica:
    """A gravação de tags cresce o arquivo no lugar (2–5 KB de USLT novo num
    MP3 que não tinha nenhum): uma queda no meio truncaria o MP3. O caminho
    compartilhado escreve numa cópia temporária na MESMA pasta e faz
    os.replace — atômico, e o nome visível do arquivo nunca muda."""

    def test_falha_na_gravacao_preserva_o_arquivo_original(self, mp3_file,
                                                           monkeypatch):
        """Gravação truncada (queda/disco cheio) atinge só a cópia."""
        antes = sha256(mp3_file)

        def sabota(self, filename=None, **kwargs):
            Path(filename).write_bytes(b"MP3 pela metade")  # trunca
            raise OSError("disco cheio")

        monkeypatch.setattr(ID3, "save", sabota)
        with pytest.raises(OSError):
            el.embed_lyrics(mp3_file, "letra nova " * 500)
        assert sha256(mp3_file) == antes           # nem um byte
        # e nenhum resto temporário na pasta
        assert [p.name for p in mp3_file.parent.iterdir()] == [mp3_file.name]

    def test_grava_numa_copia_na_mesma_pasta(self, mp3_file, monkeypatch):
        real_save = ID3.save
        destinos = []

        def espiao(self, filename=None, **kwargs):
            destinos.append(Path(filename))
            return real_save(self, filename, **kwargs)

        monkeypatch.setattr(ID3, "save", espiao)
        el.embed_lyrics(mp3_file, "letra nova")
        assert destinos, "nenhuma gravação aconteceu"
        # nunca escreve direto no arquivo do usuário...
        assert all(d != mp3_file for d in destinos)
        # ...e a cópia fica no mesmo volume (os.replace atômico)
        assert all(d.parent == mp3_file.parent for d in destinos)
        assert uslt_frames(mp3_file)[0].text == "letra nova"

    def test_gravacao_nao_renomeia_nem_move_o_arquivo(self, mp3_file):
        antes = sorted(p.name for p in mp3_file.parent.iterdir())
        el.embed_lyrics(mp3_file, "uma letra qualquer")
        assert sorted(p.name for p in mp3_file.parent.iterdir()) == antes
        assert mp3_file.is_file()
        assert uslt_frames(mp3_file)[0].text == "uma letra qualquer"

    def test_gravacao_preserva_o_modo_do_arquivo(self, mp3_file):
        os.chmod(mp3_file, 0o640)
        el.embed_lyrics(mp3_file, "uma letra qualquer")
        assert stat.S_IMODE(mp3_file.stat().st_mode) == 0o640

    def test_temas_e_tags_usam_o_mesmo_caminho_seguro(self, mp3_file,
                                                      monkeypatch):
        antes = sha256(mp3_file)

        def sabota(self, filename=None, **kwargs):
            Path(filename).write_bytes(b"MP3 pela metade")
            raise OSError("disco cheio")

        monkeypatch.setattr(ID3, "save", sabota)
        with pytest.raises(OSError):
            el.write_temas(mp3_file, ["água", "cura"])
        with pytest.raises(OSError):
            el.write_title_artist(mp3_file, title="X", artist="Y")
        assert sha256(mp3_file) == antes
        assert [p.name for p in mp3_file.parent.iterdir()] == [mp3_file.name]


class TestOrigemLyricsOvh:
    """V10 — o vocabulário de procedência ganhou `lyrics.ovh`.

    O aplicativo passou a gravar essa marca (a etapa 4 do funil, que
    substituiu o Vagalume), e o dado viaja no MP3: sem o valor aqui, o
    `--check` e o relatório do `curadoria.py` mostrariam o rótulo genérico
    para uma letra cuja procedência o arquivo declara. É perda pequena, mas
    é perda gratuita — as duas pilhas precisam falar a mesma língua
    (decisão 82).
    """

    def test_o_valor_e_o_mesmo_das_duas_pilhas(self):
        # o mesmo literal que o `writer::ORIGEM_LYRICS_OVH` do Rust grava
        assert el.ORIGEM_LYRICS_OVH == "lyrics.ovh"

    def test_a_marca_faz_round_trip_pelo_arquivo(self, mp3_file):
        el.embed_lyrics(mp3_file, "uma letra sem cadastro",
                        origem=el.ORIGEM_LYRICS_OVH)
        assert el.read_letra_origem(ID3(str(mp3_file))) == "lyrics.ovh"

    def test_o_check_mostra_o_rotulo_e_nao_o_valor_cru(self, mp3_file):
        el.embed_lyrics(mp3_file, "uma letra sem cadastro",
                        origem=el.ORIGEM_LYRICS_OVH)
        r = run_embed(str(mp3_file), "--check")
        assert r.returncode == 0, r.stderr
        assert "Origem da letra: lyrics.ovh" in r.stdout

    def test_a_marca_nao_e_confundida_com_transcricao(self, mp3_file):
        """A comparação do player é por igualdade estrita com "transcricao"
        (src/lib/types.ts): letra de site não pode herdar o aviso de "isto
        pode conter erros", que é o rótulo que o curador aprendeu a ler."""
        el.embed_lyrics(mp3_file, "uma letra sem cadastro",
                        origem=el.ORIGEM_LYRICS_OVH)
        assert el.read_letra_origem(ID3(str(mp3_file))) != el.ORIGEM_TRANSCRICAO
        assert el.ORIGEM_LYRICS_OVH not in (el.ORIGEM_TRANSCRICAO,
                                            el.ORIGEM_VAGALUME)
