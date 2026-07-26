# -*- coding: utf-8 -*-
"""Testes de temas (frame TXXX:TEMAS) — spec F7 do PRD-v2-temas.md.

Escritos antes da implementacao (TDD).
"""
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError

from conftest import run_embed

LETRA = "Quando o sol amanhecer\nMeu coração vai cantar"


def temas_frames(mp3_path: Path):
    try:
        tags = ID3(str(mp3_path))
    except ID3NoHeaderError:
        return []
    return [f for f in tags.getall("TXXX") if f.desc == "TEMAS"]


def temas_value(mp3_path: Path):
    frames = temas_frames(mp3_path)
    assert len(frames) == 1, f"esperado 1 frame TXXX:TEMAS, achei {len(frames)}"
    return str(frames[0].text[0])


class TestGravarTemas:
    def test_temas_normaliza_dedup_ordena(self, mp3_file):
        # Acceptance: --temas "Água, cura, Água" grava valor "água; cura"
        result = run_embed(mp3_file, "--temas", "Água, cura, Água")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; cura"

    def test_temas_aceita_ponto_e_virgula_no_input(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "cura; água")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; cura"

    def test_ordenacao_sem_acento(self, mp3_file):
        # "água" ordena antes de "esperança" (agua < esperanca sem acento)
        result = run_embed(mp3_file, "--temas", "esperança, água")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; esperança"

    def test_trim_e_colapso_de_espacos(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "  santa   ceia  ,  cura ")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "cura; santa ceia"

    def test_dedup_compara_sem_acento(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "agua, Água, cura")
        assert result.returncode == 0, result.stderr
        frames = temas_frames(mp3_file)
        assert len(frames) == 1
        valor = str(frames[0].text[0])
        assert valor.count("cura") == 1
        assert len(valor.split("; ")) == 2  # agua/Água deduplicados

    def test_frame_utf8_id3v24(self, mp3_file):
        run_embed(mp3_file, "--temas", "água")
        tags = ID3(str(mp3_file))
        frame = temas_frames(mp3_file)[0]
        assert int(frame.encoding) == 3  # Encoding.UTF8
        assert tags.version[:2] == (2, 4)

    def test_rodar_temas_duas_vezes_substitui(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura")
        result = run_embed(mp3_file, "--temas", "ceia")
        assert result.returncode == 0, result.stderr
        frames = temas_frames(mp3_file)
        assert len(frames) == 1  # substitui, nunca duplica
        assert str(frames[0].text[0]) == "ceia"

    def test_saida_sucesso_formato_exato(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "água, cura")
        expected = f"OK: temas gravados em {mp3_file} (2 temas)"
        assert result.stdout.strip() == expected

    def test_temas_vazio_remove_frame(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura")
        result = run_embed(mp3_file, "--temas", "")
        assert result.returncode == 0, result.stderr
        assert temas_frames(mp3_file) == []

    def test_temas_sozinho_sem_letra_nao_exige_letra(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "água")
        assert result.returncode == 0, result.stderr
        tags = ID3(str(mp3_file))
        assert tags.getall("USLT") == []  # nenhuma letra criada


class TestAddRemoveTema:
    def test_add_tema_preserva_existentes(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura")
        result = run_embed(mp3_file, "--add-tema", "esperança")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; cura; esperança"

    def test_add_tema_repetivel(self, mp3_file):
        run_embed(mp3_file, "--temas", "cura")
        result = run_embed(mp3_file, "--add-tema", "água", "--add-tema", "ceia")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; ceia; cura"

    def test_add_tema_em_mp3_sem_temas(self, mp3_file):
        result = run_embed(mp3_file, "--add-tema", "água")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água"

    def test_add_tema_duplicado_nao_duplica(self, mp3_file):
        run_embed(mp3_file, "--temas", "água")
        result = run_embed(mp3_file, "--add-tema", "Agua")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água"

    def test_remove_tema_remove_so_o_pedido(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura, ceia")
        result = run_embed(mp3_file, "--remove-tema", "cura")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água; ceia"

    def test_remove_tema_repetivel(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura, ceia")
        result = run_embed(mp3_file, "--remove-tema", "cura", "--remove-tema", "ceia")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "água"

    def test_remove_tema_compara_sem_acento(self, mp3_file):
        run_embed(mp3_file, "--temas", "água, cura")
        result = run_embed(mp3_file, "--remove-tema", "AGUA")
        assert result.returncode == 0, result.stderr
        assert temas_value(mp3_file) == "cura"

    def test_remove_ultimo_tema_remove_frame(self, mp3_file):
        run_embed(mp3_file, "--temas", "água")
        result = run_embed(mp3_file, "--remove-tema", "água")
        assert result.returncode == 0, result.stderr
        assert temas_frames(mp3_file) == []

    def test_remove_tema_inexistente_aviso_exit_0(self, mp3_file):
        run_embed(mp3_file, "--temas", "água")
        result = run_embed(mp3_file, "--remove-tema", "fogo")
        assert result.returncode == 0
        assert "AVISO: tema não encontrado: fogo" in (result.stdout + result.stderr)
        assert temas_value(mp3_file) == "água"  # resto intacto

    def test_remove_inexistente_demais_operacoes_aplicam(self, mp3_file):
        run_embed(mp3_file, "--temas", "água")
        result = run_embed(mp3_file, "--add-tema", "cura", "--remove-tema", "fogo")
        assert result.returncode == 0
        assert "AVISO: tema não encontrado: fogo" in (result.stdout + result.stderr)
        assert temas_value(mp3_file) == "água; cura"


class TestErrosTemas:
    def test_temas_com_add_tema_conflito(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "água", "--add-tema", "cura")
        assert result.returncode == 1
        msg = "ERRO: use --temas OU --add-tema/--remove-tema, não ambos"
        assert msg in (result.stderr + result.stdout)

    def test_temas_com_remove_tema_conflito(self, mp3_file):
        result = run_embed(mp3_file, "--temas", "água", "--remove-tema", "cura")
        assert result.returncode == 1
        msg = "ERRO: use --temas OU --add-tema/--remove-tema, não ambos"
        assert msg in (result.stderr + result.stdout)

    def test_conflito_nao_grava_nada(self, mp3_file):
        run_embed(mp3_file, "--temas", "água", "--add-tema", "cura")
        assert temas_frames(mp3_file) == []

    def test_arquivo_inexistente_mesma_mensagem_v1(self, tmp_path):
        missing = tmp_path / "nao_existe.mp3"
        result = run_embed(missing, "--temas", "água")
        assert result.returncode == 1
        msg = f"ERRO: arquivo inválido ou não encontrado: {missing}"
        assert msg in (result.stderr + result.stdout)

    def test_sem_letra_e_sem_temas_continua_erro(self, mp3_file):
        result = run_embed(mp3_file)
        assert result.returncode != 0


class TestCheckTemas:
    def test_check_exibe_temas(self, mp3_file):
        run_embed(mp3_file, "--temas", "cura, água")
        result = run_embed("--check", mp3_file)
        assert result.returncode == 0, result.stderr
        assert "Temas: água; cura" in result.stdout

    def test_check_sem_temas(self, mp3_file):
        result = run_embed("--check", mp3_file)
        assert result.returncode == 0, result.stderr
        assert "Temas: (nenhum)" in result.stdout

    def test_check_ordem_das_linhas(self, mp3_file):
        run_embed(mp3_file, "--lyrics", LETRA, "--title", "T", "--artist", "A")
        run_embed(mp3_file, "--add-tema", "água")
        result = run_embed("--check", mp3_file)
        lines = result.stdout.splitlines()
        i_artista = next(i for i, l in enumerate(lines) if l.startswith("Artista:"))
        i_temas = next(i for i, l in enumerate(lines) if l.startswith("Temas:"))
        i_letra = next(i for i, l in enumerate(lines) if l.startswith("Letra"))
        assert i_artista < i_temas < i_letra


class TestTemasComLetra:
    def test_letra_e_temas_juntos_duas_linhas_ok(self, mp3_file):
        result = run_embed(mp3_file, "--lyrics", LETRA, "--temas", "água, cura")
        assert result.returncode == 0, result.stderr
        lines = result.stdout.strip().splitlines()
        assert lines[0] == f"OK: letra gravada em {mp3_file} ({len(LETRA)} caracteres)"
        assert lines[1] == f"OK: temas gravados em {mp3_file} (2 temas)"
        assert temas_value(mp3_file) == "água; cura"
        tags = ID3(str(mp3_file))
        assert tags.getall("USLT")[0].text == LETRA

    def test_gravar_temas_nao_altera_uslt_tit2_tpe1(self, mp3_file):
        run_embed(mp3_file, "--lyrics", LETRA, "--title", "Coração Sertanejo",
                  "--artist", "Artista Teste")
        antes = ID3(str(mp3_file))
        uslt_antes = [(f.encoding, f.lang, f.desc, f.text) for f in antes.getall("USLT")]
        tit2_antes = str(antes["TIT2"])
        tpe1_antes = str(antes["TPE1"])

        result = run_embed(mp3_file, "--temas", "água, cura")
        assert result.returncode == 0, result.stderr

        depois = ID3(str(mp3_file))
        uslt_depois = [(f.encoding, f.lang, f.desc, f.text) for f in depois.getall("USLT")]
        assert uslt_depois == uslt_antes
        assert str(depois["TIT2"]) == tit2_antes
        assert str(depois["TPE1"]) == tpe1_antes

    def test_audio_preservado_ao_gravar_temas(self, mp3_file):
        from mutagen.mp3 import MP3
        dur_antes = MP3(str(mp3_file)).info.length
        run_embed(mp3_file, "--temas", "água, cura")
        dur_depois = MP3(str(mp3_file)).info.length
        assert dur_depois == pytest.approx(dur_antes, abs=0.2)
