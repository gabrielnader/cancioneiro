"""O diagnóstico aponta QUAL etiqueta tem texto que o programa não lê.

Relato de campo (v0.13.0): "Não deu para gravar: [...] o texto de uma etiqueta
deste MP3 está escrito de um jeito que o programa não conseguiu ler". A
biblioteca do app (lofty 0.22) derruba a leitura do arquivo INTEIRO quando o
texto de um único quadro não bate com a codificação que o quadro declara — em
qualquer modo de leitura. O mutagen, que o diagnóstico usava, é tolerante e
lia o mesmo arquivo sem reclamar: o achado ficava invisível.

Estes testes montam a etiqueta byte a byte, com cada defeito que o lofty
recusa, e conferem que o diagnóstico nomeia o quadro e o defeito.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("diag", RAIZ / "tools" / "diagnosticar_mp3.py")
diag = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(diag)  # type: ignore[union-attr]


def _syncsafe(n: int) -> bytes:
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def _quadro(ident: str, dados: bytes, versao: int) -> bytes:
    tamanho = _syncsafe(len(dados)) if versao == 4 else len(dados).to_bytes(4, "big")
    return ident.encode("latin-1") + tamanho + b"\x00\x00" + dados


def _etiqueta(quadros: list[bytes], versao: int = 3) -> bytes:
    corpo = b"".join(quadros)
    return b"ID3" + bytes([versao, 0, 0]) + _syncsafe(len(corpo)) + corpo


def test_etiqueta_saudavel_nao_acusa_nada():
    dados = _etiqueta([
        _quadro("TIT2", b"\x03Asa Branca", 3),
        _quadro("TPE1", b"\x01\xff\xfeL\x00u\x00", 3),
        _quadro("COMM", b"\x00por\x00um coment\xe1rio em latin-1", 3),
    ])
    assert diag.quadros_que_o_programa_nao_le(dados) == []


def test_utf8_invalido_aponta_o_quadro_e_mostra_o_texto():
    # o caso típico: programa antigo grava Latin-1 e declara UTF-8
    dados = _etiqueta([
        _quadro("TIT2", b"\x03Deckard's Dream", 3),
        _quadro("TALB", b"\x03Blade Runner \x96 Vangelis", 3),
    ])
    achados = diag.quadros_que_o_programa_nao_le(dados)
    assert len(achados) == 1
    assert achados[0].startswith("TALB")
    assert "UTF-8" in achados[0]
    # o pedaço legível ajuda a reconhecer QUAL texto é, sem abrir nada
    assert "Blade Runner" in achados[0]


def test_utf16_sem_marca_de_ordem_aponta_o_quadro():
    dados = _etiqueta([_quadro("TXXX", b"\x01\xff\xfeD\x00\x00\x00V\x00a\x00", 3)])
    achados = diag.quadros_que_o_programa_nao_le(dados)
    assert len(achados) == 1
    assert achados[0].startswith("TXXX")
    assert "sem a marca" in achados[0]


def test_codificacao_que_nao_existe_aponta_o_quadro():
    dados = _etiqueta([_quadro("TCON", b"\x07Trilha", 4)], versao=4)
    achados = diag.quadros_que_o_programa_nao_le(dados)
    assert len(achados) == 1
    assert achados[0].startswith("TCON")
    assert "codificação 7" in achados[0]


def test_versao_4_usa_tamanho_syncsafe_e_continua_achando():
    texto = b"\x03" + b"x" * 200 + b"\xff"  # 202 bytes: o tamanho só cabe certo em syncsafe
    dados = _etiqueta([_quadro("TIT2", texto, 4), _quadro("TPE1", b"\x03ok", 4)], versao=4)
    achados = diag.quadros_que_o_programa_nao_le(dados)
    assert [a.split(":")[0] for a in achados] == ["TIT2"]


def test_sem_id3_nao_acusa_nada():
    assert diag.quadros_que_o_programa_nao_le(b"\xff\xfb" + b"\x00" * 600) == []
