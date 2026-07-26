# -*- coding: utf-8 -*-
"""Testes do gerador de fixtures tools/make_fixtures.py — escritos antes da implementacao (TDD)."""
import subprocess
import sys

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3

from conftest import FIXTURES_SCRIPT, REPO_ROOT

FIXTURES_DIR = REPO_ROOT / "fixtures"

LETRA_ESPERADA = (
    "Quando o sol amanhecer\n"
    "Meu coração vai cantar\n"
    "A esperança vai nascer\n"
    "E a alegria vai chegar\n"
    "\n"
    "Não há noite sem estrela\n"
    "Não há dor que não se cura"
)


@pytest.fixture(scope="module", autouse=True)
def gerar_fixtures():
    """Roda o gerador uma vez por modulo (idempotente)."""
    result = subprocess.run(
        [sys.executable, str(FIXTURES_SCRIPT)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr


def test_quatro_arquivos_existem():
    for nome in ("com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3", "corrompido.mp3"):
        assert (FIXTURES_DIR / nome).is_file(), f"fixture ausente: {nome}"


def test_com_letra_tem_uslt_exato():
    tags = ID3(str(FIXTURES_DIR / "com_letra.mp3"))
    frames = tags.getall("USLT")
    assert len(frames) == 1
    assert frames[0].text == LETRA_ESPERADA  # acentos e quebras de linha preservados
    assert frames[0].lang == "por"


def test_com_letra_tem_titulo_e_artista():
    tags = ID3(str(FIXTURES_DIR / "com_letra.mp3"))
    assert str(tags["TIT2"]) == "Coração Sertanejo"
    assert str(tags["TPE1"]) == "Artista Teste"


def test_sem_letra_tem_tags_mas_nao_uslt():
    tags = ID3(str(FIXTURES_DIR / "sem_letra.mp3"))
    assert str(tags["TIT2"]) == "Instrumental Sem Letra"
    assert str(tags["TPE1"]) == "Banda Fixture"
    assert tags.getall("USLT") == []


def test_com_letra_tem_temas():
    tags = ID3(str(FIXTURES_DIR / "com_letra.mp3"))
    frames = [f for f in tags.getall("TXXX") if f.desc == "TEMAS"]
    assert len(frames) == 1
    assert str(frames[0].text[0]) == "água; esperança"  # normalizado/ordenado sem acento


def test_constante_temas_exportada():
    import sys as _sys
    _sys.path.insert(0, str(REPO_ROOT / "tools"))
    from make_fixtures import TEMAS_COM_LETRA
    assert TEMAS_COM_LETRA == ["esperança", "água"]


def test_sem_letra_e_sem_tags_nao_tem_txxx():
    tags = ID3(str(FIXTURES_DIR / "sem_letra.mp3"))
    assert tags.getall("TXXX") == []
    # sem_tags.mp3 nao tem header ID3 algum (coberto abaixo)


def test_sem_tags_nao_tem_id3():
    with pytest.raises(ID3NoHeaderError):
        ID3(str(FIXTURES_DIR / "sem_tags.mp3"))


def test_corrompido_nao_e_mp3_valido():
    path = FIXTURES_DIR / "corrompido.mp3"
    assert path.stat().st_size == 4096
    with pytest.raises(Exception):
        mp3 = MP3(str(path))
        # se carregou, precisa ao menos ter um stream de audio real
        assert mp3.info.length > 0

def test_corrompido_deterministico():
    import random
    rnd = random.Random(42)
    esperado = bytes(rnd.getrandbits(8) for _ in range(4096))
    assert (FIXTURES_DIR / "corrompido.mp3").read_bytes() == esperado


@pytest.mark.parametrize("nome", ["com_letra.mp3", "sem_letra.mp3", "sem_tags.mp3"])
def test_duracao_dos_mp3s_validos(nome):
    mp3 = MP3(str(FIXTURES_DIR / nome))
    assert 1.5 <= mp3.info.length <= 5.5


def test_idempotente():
    """Rodar de novo sobrescreve sem erro e mantem o conteudo esperado."""
    result = subprocess.run(
        [sys.executable, str(FIXTURES_SCRIPT)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    tags = ID3(str(FIXTURES_DIR / "com_letra.mp3"))
    assert len(tags.getall("USLT")) == 1
