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


def test_os_arquivos_existem():
    for nome in (
        "com_letra.mp3",
        "sem_letra.mp3",
        "sem_tags.mp3",
        "corrompido.mp3",
        "sobra_antes_do_audio.mp3",
    ):
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


# ---------------------------------------------------------------------------
# V10.8 — a fixture da SOBRA entre a etiqueta declarada e o primeiro quadro.
#
# Ela existe para reproduzir a recusa de gravação medida em sete arquivos de um
# acervo real, e a reprodução depende de NÚMEROS: se a sobra encolher para menos
# que o teto de bytes de lixo da biblioteca de etiquetas (1.024 no lofty 0.22), o
# arquivo passa a gravar sozinho e o teste do conserto vira um teste de nada.
#
# É o mesmo cuidado do teste de fumaça que "passava" sem passar o modelo, e que
# custou uma versão inteira: fixture que não reproduz o defeito certifica o
# contrário do que se quer garantir.
# ---------------------------------------------------------------------------

SOBRA_FIM_DA_ETIQUETA = 4096
SOBRA_PRIMEIRO_QUADRO = 5347
SOBRA_TETO_DE_LIXO_DO_LOFTY = 1024


def _fim_declarado_do_id3(dados: bytes) -> int:
    """Fim declarado do bloco ID3v2: 10 de cabeçalho + o tamanho synchsafe."""
    assert dados[:3] == b"ID3"
    return 10 + (
        (dados[6] << 21) | (dados[7] << 14) | (dados[8] << 7) | dados[9]
    )


def test_sobra_tem_a_estrutura_medida_em_campo():
    dados = (FIXTURES_DIR / "sobra_antes_do_audio.mp3").read_bytes()
    fim = _fim_declarado_do_id3(dados)
    assert fim == SOBRA_FIM_DA_ETIQUETA

    # o primeiro quadro MPEG de verdade vem depois da sobra
    quadro = dados.index(b"\xff\xfb", fim)
    assert quadro == SOBRA_PRIMEIRO_QUADRO
    sobra = quadro - fim
    assert sobra == 1251
    assert sobra > SOBRA_TETO_DE_LIXO_DO_LOFTY, (
        f"a sobra ({sobra}) precisa passar do teto de lixo do lofty "
        f"({SOBRA_TETO_DE_LIXO_DO_LOFTY}): abaixo dele a gravação funciona e a "
        "fixture deixa de reproduzir o defeito"
    )


def test_sobra_e_quase_toda_de_zeros_e_nao_tem_sync_de_mpeg():
    dados = (FIXTURES_DIR / "sobra_antes_do_audio.mp3").read_bytes()
    regiao = dados[SOBRA_FIM_DA_ETIQUETA:SOBRA_PRIMEIRO_QUADRO]
    assert regiao.count(0) / len(regiao) >= 0.75  # como no arquivo medido
    # nenhum 0xFF: um sync por sorte da semente faria a biblioteca achar um
    # quadro DENTRO da sobra, e a fixture pararia de reproduzir a recusa
    assert 0xFF not in regiao


def test_sobra_e_um_mp3_legivel_com_titulo():
    """Ela TOCA e aparece na lista — é por isso que ninguém suspeita dela."""
    caminho = FIXTURES_DIR / "sobra_antes_do_audio.mp3"
    tags = ID3(str(caminho))
    assert str(tags["TIT2"]) == "Sobra Antes do Áudio"
    assert str(tags["TPE1"]) == "Banda Fixture"
    mp3 = MP3(str(caminho))
    assert 1.5 <= mp3.info.length <= 5.5


def test_sobra_deterministica():
    """Duas gerações dão o mesmo arquivo (o retrato dos testes Rust depende)."""
    primeiro = (FIXTURES_DIR / "sobra_antes_do_audio.mp3").read_bytes()
    result = subprocess.run(
        [sys.executable, str(FIXTURES_SCRIPT)],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert (FIXTURES_DIR / "sobra_antes_do_audio.mp3").read_bytes() == primeiro


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
