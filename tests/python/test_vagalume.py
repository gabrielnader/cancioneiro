# -*- coding: utf-8 -*-
"""Testes da V6.1: o Vagalume como SEGUNDA fonte de letra oficial, depois
do LRCLIB e antes da transcrição, no `buscar-letra` e no
`identificar --com-letra` do curadoria.py.

Escritos antes da implementação (TDD). NENHUM teste usa rede: o acesso HTTP
entra pelo mesmo `fetcher` injetável das outras fontes, a impressão digital
do `identificar` é injetável e a pausa de cortesia é zerada (pausa=0). A
chave da API é sempre falsa — o Vagalume nunca é consultado de verdade.
"""
import ast
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.error
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TXXX, USLT, Encoding

from conftest import TOOLS_DIR, make_mp3

REPO_ROOT = Path(__file__).resolve().parents[2]
CURADORIA = TOOLS_DIR / "curadoria.py"
TYPES_TS = REPO_ROOT / "src" / "lib" / "types.ts"

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402
import embed_lyrics as el  # noqa: E402

CHAVE_VG = "chave-vagalume-de-teste"
CHAVE_AC = "chave-acoustid-de-teste"
FINGERPRINT = "AQADtEmiSJKiJHkS5Aj0Iz-OHz8ePD8"
# Textos inventados: nenhum teste depende de letra real de ninguém.
LETRA_VG = "Primeira linha inventada\nSegunda linha inventada à toa"
LETRA_LRCLIB = "Letra vinda do LRCLIB\nOutra linha qualquer"


# ---------------------------------------------------------------- helpers

def run_curadoria(*args, env=None) -> subprocess.CompletedProcess:
    ambiente = dict(os.environ)
    ambiente.pop("VAGALUME_API_KEY", None)
    ambiente.pop("ACOUSTID_API_KEY", None)
    if env:
        ambiente.update(env)
    return subprocess.run(
        [sys.executable, str(CURADORIA), *[str(a) for a in args]],
        capture_output=True, text=True, encoding="utf-8", env=ambiente,
    )


def tag(path: Path, title=None, artist=None, letra=None, origem=None,
        temas=None) -> None:
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    if title is not None:
        tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8, text=[title])])
    if artist is not None:
        tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8, text=[artist])])
    if letra is not None:
        tags.delall("USLT")
        tags.add(USLT(encoding=Encoding.UTF8, lang="por", desc="", text=letra))
    if origem is not None:
        tags.delall("TXXX:LETRA_ORIGEM")
        tags.add(TXXX(encoding=Encoding.UTF8, desc="LETRA_ORIGEM",
                      text=[origem]))
    if temas is not None:
        tags.delall("TXXX:TEMAS")
        tags.add(TXXX(encoding=Encoding.UTF8, desc="TEMAS",
                      text=["; ".join(temas)]))
    tags.save(str(path), v2_version=4)


def uslt_text(path: Path):
    try:
        frames = ID3(str(path)).getall("USLT")
    except ID3NoHeaderError:
        return None
    return str(frames[0].text) if frames else None


def titulo_de(path: Path):
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        return None
    return str(tags["TIT2"]) if "TIT2" in tags else None


def artista_de(path: Path):
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        return None
    return str(tags["TPE1"]) if "TPE1" in tags else None


def temas_value(path: Path):
    try:
        frames = [f for f in ID3(str(path)).getall("TXXX")
                  if f.desc == "TEMAS"]
    except ID3NoHeaderError:
        return None
    return str(frames[0].text[0]) if frames else None


def origem_de(path: Path) -> str:
    try:
        return el.read_letra_origem(ID3(str(path)))
    except ID3NoHeaderError:
        return ""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def frames_audio(path: Path) -> str:
    """Hash SÓ dos frames de áudio (tudo depois do bloco ID3v2)."""
    dados = path.read_bytes()
    try:
        inicio = ID3(str(path)).size
    except ID3NoHeaderError:
        inicio = 0
    return hashlib.sha256(dados[inicio:]).hexdigest()


def nomes(pasta: Path) -> list:
    return sorted(p.relative_to(pasta).as_posix() for p in pasta.rglob("*"))


def read_csv(path: Path) -> list:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


# ------------------------------------------------------- stubs das APIs

def resposta_vagalume(titulo="Água Viva", artista="Coral Novo",
                      letra=LETRA_VG, tipo="exact"):
    """Resposta do /search.php do Vagalume (formato real da API)."""
    corpo = {"type": tipo}
    if artista is not None:
        corpo["art"] = {"id": "a1", "name": artista, "url": "coral-novo"}
    if letra is not None:
        corpo["mus"] = [{"id": "m1", "name": titulo, "url": "agua-viva",
                         "lang": 1, "text": letra}]
    return corpo


def fetcher_de(vagalume=None, lrclib=None, urls=None, erro_vagalume=None,
               erro_lrclib=None, acoustid=None):
    """Fetcher único que atende LRCLIB, Vagalume e AcoustID pela URL.

    `lrclib`/`vagalume` = None significa "esta fonte não tem a música".
    """
    def fetcher(url: str) -> str:
        if urls is not None:
            urls.append(url)
        if "vagalume" in url:
            if erro_vagalume is not None:
                raise erro_vagalume
            return json.dumps(vagalume if vagalume is not None
                              else {"type": "notfound"})
        if "lrclib" in url:
            if erro_lrclib is not None:
                raise erro_lrclib
            if lrclib is None:
                if "/api/search" in url:
                    return json.dumps([])
                raise urllib.error.HTTPError(url, 404, "Not Found", None,
                                             None)
            return json.dumps(lrclib)
        if "acoustid" in url:
            return json.dumps(acoustid if acoustid is not None
                              else resposta_acoustid())
        raise AssertionError("url inesperada: " + url)
    return fetcher


def lrclib_get(letra=LETRA_LRCLIB) -> dict:
    return {"plainLyrics": letra, "syncedLyrics": None}


def lrclib_search(track="Timoneiro", artist="Paulinho da Viola",
                  duracao=231.0, letra=LETRA_LRCLIB) -> list:
    return [{"id": 42, "trackName": track, "artistName": artist,
             "duration": duracao, "plainLyrics": letra}]


def gravacao(titulo="Timoneiro", artista="Paulinho da Viola", duracao=231.0):
    return {"id": "7d1b8f0a", "title": titulo, "duration": duracao,
            "artists": [{"id": "a1", "name": artista, "joinphrase": ""}]}


def resposta_acoustid(score=0.94, gravacoes=None) -> dict:
    return {"status": "ok",
            "results": [{"id": "r1", "score": score,
                         "recordings": gravacoes or [gravacao()]}]}


class FakeImpressao:
    """Stub do fpcalc: (caminho) -> (duracao_segundos, fingerprint)."""

    def __init__(self, duracao=232.0, fingerprint=FINGERPRINT):
        self.duracao = duracao
        self.fingerprint = fingerprint
        self.chamadas = []

    def __call__(self, caminho):
        self.chamadas.append(Path(caminho).name)
        return (self.duracao, self.fingerprint)


def buscar_letra(pasta, **kwargs):
    """cmd_buscar_letra com os padrões offline dos testes."""
    kwargs.setdefault("fetcher", fetcher_de(vagalume=resposta_vagalume()))
    kwargs.setdefault("chave_vagalume", CHAVE_VG)
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_buscar_letra(pasta, **kwargs)


def identificar(pasta, **kwargs):
    """cmd_identificar com os padrões offline dos testes."""
    kwargs.setdefault("impressao_digital", FakeImpressao())
    kwargs.setdefault("fetcher", fetcher_de())
    kwargs.setdefault("chave", CHAVE_AC)
    kwargs.setdefault("chave_vagalume", CHAVE_VG)
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_identificar(pasta, **kwargs)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um único MP3 limpo por módulo (~1,5 s); os testes copiam os bytes."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def acervo(tmp_path: Path, base_mp3: Path) -> Path:
    """Um MP3 com título e artista reais e SEM letra."""
    pasta = tmp_path / "acervo"
    pasta.mkdir()
    alvo = pasta / "sem_letra.mp3"
    shutil.copyfile(base_mp3, alvo)
    tag(alvo, title="Água Viva", artist="Coral Novo")
    return pasta


@pytest.fixture
def sem_tags(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com um MP3 sem tag nenhuma (alvo do `identificar`)."""
    pasta = tmp_path / "acervo"
    pasta.mkdir()
    shutil.copyfile(base_mp3, pasta / "Faixa 5.mp3")
    return pasta


# ------------------------------------------------- a consulta em si

class TestConsultarVagalume:
    def test_monta_a_url_da_api_com_os_tres_parametros(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps(resposta_vagalume())

        curadoria.consultar_vagalume("Água Viva", "Coral Novo", CHAVE_VG,
                                     fetcher=espiao)
        assert len(urls) == 1
        assert urls[0].startswith("https://api.vagalume.com.br/search.php?")
        assert "art=Coral+Novo" in urls[0]
        assert "mus=%C3%81gua+Viva" in urls[0]          # NFC, escapado
        assert f"apikey={CHAVE_VG}" in urls[0]

    def test_envia_o_texto_em_nfc(self):
        """Nome vindo do macOS chega NFD; a API recebe NFC."""
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps(resposta_vagalume())

        nfd = unicodedata.normalize("NFD", "Água Viva")
        curadoria.consultar_vagalume(nfd, "Coral Novo", CHAVE_VG,
                                     fetcher=espiao)
        assert "mus=%C3%81gua+Viva" in urls[0]

    def test_404_nao_explode(self):
        def fetcher_404(url):
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        assert curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", CHAVE_VG, fetcher=fetcher_404) is None

    def test_erro_de_rede_propaga_para_o_chamador(self):
        def caiu(url):
            raise urllib.error.URLError("rede indisponível")

        with pytest.raises(urllib.error.URLError):
            curadoria.consultar_vagalume("A", "B", CHAVE_VG, fetcher=caiu)


# ------------------------------------------------- disciplina do casamento

class TestDisciplinaDoCasamento:
    def test_titulo_e_artista_conferidos_devolvem_a_letra(self):
        letra = curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume()))
        assert letra == LETRA_VG

    def test_artista_divergente_e_recusado(self):
        letra = curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(
                artista="Roberto Carlos")))
        assert letra is None

    def test_titulo_divergente_e_recusado(self):
        letra = curadoria.buscar_letra_vagalume(
            "Lampejo", "Adventício", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(
                titulo="Vou Chegar Mais Cedo em Casa", artista="Adventício")))
        assert letra is None

    def test_variacao_de_grafia_nao_e_divergencia(self):
        """Mesma regra do _discorda: "&" x "y", acento a mais/a menos."""
        letra = curadoria.buscar_letra_vagalume(
            "Água Viva", "Milionário y José Rico", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(
                artista="Milionário & José Rico")))
        assert letra == LETRA_VG

    def test_artista_contido_no_do_pedido_nao_e_divergencia(self):
        letra = curadoria.buscar_letra_vagalume(
            "Adventício - Lampejo", "Coral Novo", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(titulo="Lampejo")))
        assert letra == LETRA_VG

    def test_resultado_com_artista_placeholder_e_recusado(self):
        for lixo in ("Unknown Artist", "Artista Desconhecido", ""):
            letra = curadoria.buscar_letra_vagalume(
                "Água Viva", "Coral Novo", CHAVE_VG,
                fetcher=fetcher_de(vagalume=resposta_vagalume(artista=lixo)))
            assert letra is None, lixo

    def test_resultado_com_titulo_placeholder_e_recusado(self):
        for lixo in ("Faixa 8", "AudioTrack 02", "untitled"):
            letra = curadoria.buscar_letra_vagalume(
                "Água Viva", "Coral Novo", CHAVE_VG,
                fetcher=fetcher_de(vagalume=resposta_vagalume(titulo=lixo)))
            assert letra is None, lixo

    def test_texto_de_letra_indisponivel_e_recusado(self):
        for lixo in ("Ainda não temos a letra desta música.",
                     "Letra não disponível"):
            letra = curadoria.buscar_letra_vagalume(
                "Água Viva", "Coral Novo", CHAVE_VG,
                fetcher=fetcher_de(vagalume=resposta_vagalume(letra=lixo)))
            assert letra is None, lixo

    def test_letra_vazia_e_recusada(self):
        assert curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(letra="  "))
        ) is None

    def test_notfound_e_song_notfound_nao_sao_letra(self):
        for tipo in ("notfound", "song_notfound"):
            assert curadoria.buscar_letra_vagalume(
                "Água Viva", "Coral Novo", CHAVE_VG,
                fetcher=fetcher_de(vagalume={"type": tipo})) is None, tipo

    def test_sem_artista_nao_consulta(self):
        """A ÚNICA prova possível aqui é artista+título baterem: sem artista
        não há o que conferir (o Vagalume não tem duração)."""
        urls = []
        assert curadoria.buscar_letra_vagalume(
            "Água Viva", "", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(), urls=urls)
        ) is None
        assert urls == []

    def test_pedido_com_placeholder_nao_consulta(self):
        urls = []
        assert curadoria.buscar_letra_vagalume(
            "Faixa 5", "no artist", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(), urls=urls)
        ) is None
        assert urls == []

    def test_sem_chave_nao_consulta(self):
        urls = []
        assert curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", "",
            fetcher=fetcher_de(vagalume=resposta_vagalume(), urls=urls)
        ) is None
        assert urls == []

    def test_letra_volta_em_nfc(self):
        nfd = unicodedata.normalize("NFD", "Água à toa\ncanção")
        letra = curadoria.buscar_letra_vagalume(
            "Água Viva", "Coral Novo", CHAVE_VG,
            fetcher=fetcher_de(vagalume=resposta_vagalume(letra=nfd)))
        assert letra == unicodedata.normalize("NFC", nfd)


# ------------------------------------------------- buscar-letra

class TestBuscarLetraComVagalume:
    def test_lrclib_primeiro_vagalume_nem_e_consultado(self, acervo):
        urls = []
        buscar_letra(acervo, aplicar=True,
                     fetcher=fetcher_de(lrclib=lrclib_get(), urls=urls,
                                        vagalume=resposta_vagalume()))
        assert uslt_text(acervo / "sem_letra.mp3") == LETRA_LRCLIB
        assert not any("vagalume" in u for u in urls)

    def test_vagalume_preenche_o_que_o_lrclib_nao_tem(self, acervo, capsys):
        alvo = acervo / "sem_letra.mp3"
        buscar_letra(acervo, aplicar=True)
        assert uslt_text(alvo) == LETRA_VG
        out = capsys.readouterr().out
        assert (f"ENCONTRADA (Vagalume): sem_letra.mp3 ({len(LETRA_VG)} "
                "caracteres)") in out

    def test_sem_aplicar_nao_grava_nada(self, acervo, capsys):
        alvo = acervo / "sem_letra.mp3"
        antes = sha256(alvo)
        buscar_letra(acervo)
        assert uslt_text(alvo) is None
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "ENCONTRADA (Vagalume): sem_letra.mp3" in out

    def test_letra_do_vagalume_recebe_a_marca_de_origem(self, acervo):
        buscar_letra(acervo, aplicar=True)
        assert origem_de(acervo / "sem_letra.mp3") == el.ORIGEM_VAGALUME
        assert el.ORIGEM_VAGALUME == "vagalume"

    def test_letra_do_lrclib_continua_sem_marca(self, acervo):
        buscar_letra(acervo, aplicar=True,
                     fetcher=fetcher_de(lrclib=lrclib_get()))
        assert origem_de(acervo / "sem_letra.mp3") == ""

    def test_recusa_do_vagalume_vira_nao_encontrada(self, acervo, capsys):
        alvo = acervo / "sem_letra.mp3"
        buscar_letra(acervo, aplicar=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(artista="Roberto Carlos")))
        assert uslt_text(alvo) is None
        out = capsys.readouterr().out
        assert "NÃO ENCONTRADA: sem_letra.mp3" in out

    def test_arquivo_com_letra_nunca_e_tocado(self, acervo, base_mp3):
        outro = acervo / "com_letra.mp3"
        shutil.copyfile(base_mp3, outro)
        tag(outro, title="Água Viva", artist="Coral Novo",
            letra="letra conferida à mão")
        urls = []
        buscar_letra(acervo, aplicar=True,
                     fetcher=fetcher_de(vagalume=resposta_vagalume(),
                                        urls=urls))
        assert uslt_text(outro) == "letra conferida à mão"
        assert origem_de(outro) == ""
        # nem consulta gastou com ele
        assert not any("com+letra" in u.lower() for u in urls)

    def test_erro_de_rede_no_vagalume_nao_derruba_o_lote(self, acervo,
                                                         base_mp3, capsys):
        """O resultado que o LRCLIB já entregou para OUTRO arquivo continua
        gravado, e o resumo contabiliza o erro sem perder nada."""
        primeiro = acervo / "aaa_primeira.mp3"   # ordena antes
        shutil.copyfile(base_mp3, primeiro)
        tag(primeiro, title="Primeira", artist="Alguém")

        def fetcher(url):
            if "vagalume" in url:
                if "Primeira" in url or "Algu" in url:
                    raise urllib.error.URLError("caiu")
                return json.dumps(resposta_vagalume())
            if "Primeira" in url:
                return json.dumps(lrclib_get())
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        buscar_letra(acervo, aplicar=True, fetcher=fetcher)
        assert uslt_text(primeiro) == LETRA_LRCLIB    # LRCLIB resolveu
        assert uslt_text(acervo / "sem_letra.mp3") == LETRA_VG
        out = capsys.readouterr().out
        assert "ENCONTRADA (Vagalume): sem_letra.mp3" in out

    def test_erro_de_rede_no_vagalume_e_relatado_e_contado(self, acervo,
                                                           capsys):
        buscar_letra(acervo, aplicar=True, fetcher=fetcher_de(
            erro_vagalume=urllib.error.URLError("caiu")))
        assert uslt_text(acervo / "sem_letra.mp3") is None
        out = capsys.readouterr().out
        assert "ERRO DE REDE: sem_letra.mp3 (Vagalume)" in out
        assert ("Resumo: 0 encontradas | 0 não encontradas | 1 erros de rede "
                "| 0 pelo Vagalume") in out

    def test_resumo_soma_as_duas_fontes(self, acervo, base_mp3, capsys):
        so_lrclib = acervo / "aaa_lrclib.mp3"
        shutil.copyfile(base_mp3, so_lrclib)
        tag(so_lrclib, title="Timoneiro", artist="Paulinho da Viola")
        nenhuma = acervo / "zzz_nenhuma.mp3"
        shutil.copyfile(base_mp3, nenhuma)
        tag(nenhuma, title="Perdida", artist="Ninguém")

        def fetcher(url):
            if "vagalume" in url:
                if "Perdida" in url:
                    return json.dumps({"type": "notfound"})
                return json.dumps(resposta_vagalume())
            if "Timoneiro" in url:
                return json.dumps(lrclib_get())
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        buscar_letra(acervo, aplicar=True, fetcher=fetcher)
        out = capsys.readouterr().out
        # 3 arquivos: 1 pelo LRCLIB, 1 pelo Vagalume, 1 sem letra nenhuma
        assert ("Resumo: 2 encontradas | 1 não encontradas | 0 erros de rede "
                "| 1 pelo Vagalume") in out

    def test_csv_distingue_a_fonte_sem_mudar_as_colunas(self, acervo,
                                                        tmp_path):
        saida = tmp_path / "busca.csv"
        buscar_letra(acervo, csv_out=saida)
        rows = read_csv(saida)
        assert list(rows[0].keys()) == ["arquivo", "titulo", "artista",
                                        "status", "caracteres"]
        assert rows[0]["status"] == "encontrada (vagalume)"
        assert rows[0]["caracteres"] == str(len(LETRA_VG))

    def test_sem_chave_pula_o_vagalume_com_uma_linha(self, acervo, capsys):
        urls = []
        buscar_letra(acervo, aplicar=True, chave_vagalume="",
                     fetcher=fetcher_de(urls=urls,
                                        vagalume=resposta_vagalume()))
        out = capsys.readouterr().out
        assert not any("vagalume" in u for u in urls)
        assert uslt_text(acervo / "sem_letra.mp3") is None
        # uma linha só, em pt-BR, dizendo como habilitar
        linhas = [ln for ln in out.splitlines() if "pulado" in ln]
        assert len(linhas) == 1
        assert linhas[0].startswith("Vagalume: pulado")
        assert "auth.vagalume.com.br/settings/api" in linhas[0]
        assert "VAGALUME_API_KEY" in linhas[0]
        # o resto do comando segue exatamente como antes
        assert ("Resumo: 0 encontradas | 1 não encontradas | 0 erros de rede"
                in out)
        assert "NÃO ENCONTRADA: sem_letra.mp3" in out

    def test_a_chave_nunca_aparece_na_saida(self, acervo, capsys):
        buscar_letra(acervo, aplicar=True)
        assert CHAVE_VG not in capsys.readouterr().out

    def test_pausa_de_cortesia_entre_consultas(self, acervo, base_mp3,
                                               monkeypatch):
        outro = acervo / "aaa_outra.mp3"
        shutil.copyfile(base_mp3, outro)
        tag(outro, title="Outra Canção", artist="Coral Novo")
        dormidas = []
        monkeypatch.setattr(curadoria.time, "sleep", dormidas.append)

        def fetcher(url):
            if "vagalume" in url:
                titulo = ("Outra Canção" if "Outra" in url else "Água Viva")
                return json.dumps(resposta_vagalume(titulo=titulo))
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        buscar_letra(acervo, aplicar=True, fetcher=fetcher,
                     pausa=curadoria.PAUSA_S)
        # duas consultas ao Vagalume, uma pausa entre elas
        assert dormidas == [curadoria.PAUSA_S]


# ------------------------------------------------- identificar --com-letra

class TestIdentificarComVagalume:
    def test_vagalume_entra_quando_o_lrclib_nao_tem(self, sem_tags, capsys):
        alvo = sem_tags / "Faixa 5.mp3"
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(titulo="Timoneiro",
                                       artista="Paulinho da Viola")))
        assert titulo_de(alvo) == "Timoneiro"
        assert uslt_text(alvo) == LETRA_VG
        assert origem_de(alvo) == el.ORIGEM_VAGALUME
        out = capsys.readouterr().out
        assert "+ letra (Vagalume)" in out
        assert "| 1 letras oficiais |" in out
        assert "| 1 pelo Vagalume" in out

    def test_usa_o_titulo_e_o_artista_confirmados(self, sem_tags):
        urls = []
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            urls=urls, vagalume=resposta_vagalume(
                titulo="Timoneiro", artista="Paulinho da Viola")))
        consulta = next(u for u in urls if "vagalume" in u)
        assert "mus=Timoneiro" in consulta
        assert "art=Paulinho+da+Viola" in consulta

    def test_lrclib_tendo_a_letra_o_vagalume_nao_e_consultado(self, sem_tags,
                                                              capsys):
        alvo = sem_tags / "Faixa 5.mp3"
        urls = []
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            urls=urls, lrclib=lrclib_search(),
            vagalume=resposta_vagalume()))
        assert uslt_text(alvo) == LETRA_LRCLIB
        assert origem_de(alvo) == ""
        assert not any("vagalume" in u for u in urls)
        out = capsys.readouterr().out
        assert "+ letra" in out
        assert "(Vagalume)" not in out
        assert "| 0 pelo Vagalume" in out

    def test_erro_no_vagalume_nao_perde_a_identificacao(self, sem_tags,
                                                        capsys):
        alvo = sem_tags / "Faixa 5.mp3"
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            erro_vagalume=urllib.error.URLError("caiu")))
        assert titulo_de(alvo) == "Timoneiro"       # identificação preservada
        assert artista_de(alvo) == "Paulinho da Viola"
        assert uslt_text(alvo) is None
        out = capsys.readouterr().out
        assert "IDENTIFICADA: Faixa 5.mp3" in out
        assert "erro de rede na busca da letra" in out
        assert "| 1 identificadas |" in out

    def test_erro_no_lrclib_nao_impede_o_vagalume(self, sem_tags):
        """A queda de uma fonte não leva a outra junto."""
        alvo = sem_tags / "Faixa 5.mp3"
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            erro_lrclib=urllib.error.URLError("caiu"),
            vagalume=resposta_vagalume(titulo="Timoneiro",
                                       artista="Paulinho da Viola")))
        assert uslt_text(alvo) == LETRA_VG
        assert origem_de(alvo) == el.ORIGEM_VAGALUME

    def test_letra_existente_nunca_e_substituida(self, sem_tags):
        alvo = sem_tags / "Faixa 5.mp3"
        tag(alvo, letra="letra conferida à mão")
        urls = []
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            urls=urls, vagalume=resposta_vagalume(
                titulo="Timoneiro", artista="Paulinho da Viola")))
        assert uslt_text(alvo) == "letra conferida à mão"
        assert origem_de(alvo) == ""
        assert not any("vagalume" in u for u in urls)

    def test_tag_real_nunca_e_sobrescrita_pelo_caminho_do_vagalume(self,
                                                                   sem_tags):
        alvo = sem_tags / "Faixa 5.mp3"
        tag(alvo, title="Timoneiro", artist="Paulinho de Viola")
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(titulo="Timoneiro",
                                       artista="Paulinho da Viola")))
        assert artista_de(alvo) == "Paulinho de Viola"   # tag do curador
        assert uslt_text(alvo) == LETRA_VG               # só a letra entrou

    def test_temas_existentes_sao_preservados(self, sem_tags):
        alvo = sem_tags / "Faixa 5.mp3"
        tag(alvo, temas=["água", "cura"])
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(titulo="Timoneiro",
                                       artista="Paulinho da Viola")))
        assert temas_value(alvo) == "água; cura"

    def test_recusa_do_vagalume_ainda_grava_as_tags(self, sem_tags, capsys):
        alvo = sem_tags / "Faixa 5.mp3"
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(titulo="Outra Coisa Totalmente",
                                       artista="Roberto Carlos")))
        assert titulo_de(alvo) == "Timoneiro"
        assert uslt_text(alvo) is None
        out = capsys.readouterr().out
        assert "| 0 letras oficiais |" in out
        assert "| 0 pelo Vagalume" in out

    def test_sem_chave_pula_com_uma_linha_so(self, sem_tags, capsys):
        urls = []
        identificar(sem_tags, com_letra=True, chave_vagalume="",
                    fetcher=fetcher_de(urls=urls,
                                       vagalume=resposta_vagalume()))
        out = capsys.readouterr().out
        assert not any("vagalume" in u for u in urls)
        linhas = [ln for ln in out.splitlines() if "pulado" in ln]
        assert len(linhas) == 1
        assert linhas[0].startswith("Vagalume: pulado")
        assert "IDENTIFICADA: Faixa 5.mp3" in out    # o resto segue igual

    def test_sem_com_letra_nao_consulta_nem_avisa(self, sem_tags, capsys):
        """Sem --com-letra não há busca de letra nenhuma: nada a pular, e
        avisar seria ruído (o balde do resumo continua saindo, zerado)."""
        urls = []
        identificar(sem_tags, chave_vagalume="",
                    fetcher=fetcher_de(urls=urls))
        out = capsys.readouterr().out
        assert not any("vagalume" in u for u in urls)
        assert "pulado" not in out
        assert "| 0 pelo Vagalume" in out

    def test_csv_registra_a_fonte_da_letra(self, sem_tags, tmp_path):
        saida = tmp_path / "feito.csv"
        identificar(sem_tags, com_letra=True, csv_out=saida,
                    fetcher=fetcher_de(vagalume=resposta_vagalume(
                        titulo="Timoneiro", artista="Paulinho da Viola")))
        linha = read_csv(saida)[0]
        assert linha["acao"] == "IDENTIFICADA"
        assert linha["caracteres"] == str(len(LETRA_VG))
        assert "Vagalume" in linha["detalhe"]


# ------------------------------------------------- não é transcrição

class TestNaoEhTranscricao:
    def test_o_selo_de_transcricao_nao_acende(self, acervo):
        """O player só trata como transcrição o valor exato de
        ORIGEM_TRANSCRICAO (src/lib/types.ts, comparação ===). A letra do
        Vagalume tem OUTRO valor, então o aviso "letra transcrita
        automaticamente" não aparece para ela."""
        buscar_letra(acervo, aplicar=True)
        origem = origem_de(acervo / "sem_letra.mp3")
        assert origem == el.ORIGEM_VAGALUME
        assert origem != el.ORIGEM_TRANSCRICAO
        texto = TYPES_TS.read_text(encoding="utf-8")
        achado = re.search(
            r'ORIGEM_TRANSCRICAO\s*=\s*"([^"]+)"', texto)
        assert achado, "constante do player não encontrada em types.ts"
        assert achado.group(1) == el.ORIGEM_TRANSCRICAO
        assert origem != achado.group(1)

    def test_relatorio_nao_diz_transcricao(self, acervo, capsys):
        buscar_letra(acervo, aplicar=True)
        capsys.readouterr()
        curadoria.cmd_relatorio(acervo)
        out = capsys.readouterr().out
        assert "SIM (transcrição)" not in out
        assert "SIM (Vagalume)" in out

    def test_relatorio_continua_marcando_a_transcricao(self, acervo,
                                                       base_mp3, capsys):
        outro = acervo / "transcrita.mp3"
        shutil.copyfile(base_mp3, outro)
        tag(outro, title="Transcrita", artist="Ninguém",
            letra="saiu do áudio", origem=el.ORIGEM_TRANSCRICAO)
        curadoria.cmd_relatorio(acervo)
        out = capsys.readouterr().out
        assert "SIM (transcrição)" in out

    def test_transcrever_respeita_a_letra_do_vagalume_como_oficial(
            self, acervo, capsys):
        """--forcar reprocessa só o que a MÁQUINA escreveu; letra do
        Vagalume é OFICIAL e exige --forcar-tudo."""
        buscar_letra(acervo, aplicar=True)
        capsys.readouterr()
        alvo = acervo / "sem_letra.mp3"
        curadoria.cmd_transcrever(acervo, transcritor=lambda *a, **k: "x",
                                  fetcher=fetcher_de(), forcar=True, pausa=0)
        assert uslt_text(alvo) == LETRA_VG
        out = capsys.readouterr().out
        assert "letra oficial — use --forcar-tudo para substituir" in out


# ------------------------------------------------- invioláveis

class TestInvioláveis:
    def test_audio_e_nome_do_arquivo_intactos(self, acervo):
        alvo = acervo / "sem_letra.mp3"
        audio_antes = frames_audio(alvo)
        nomes_antes = nomes(acervo)
        buscar_letra(acervo, aplicar=True)
        assert uslt_text(alvo) == LETRA_VG        # gravou mesmo
        assert frames_audio(alvo) == audio_antes  # áudio idêntico
        assert nomes(acervo) == nomes_antes       # nada renomeado/criado

    def test_audio_intacto_tambem_no_identificar(self, sem_tags):
        alvo = sem_tags / "Faixa 5.mp3"
        audio_antes = frames_audio(alvo)
        nomes_antes = nomes(sem_tags)
        identificar(sem_tags, com_letra=True, fetcher=fetcher_de(
            vagalume=resposta_vagalume(titulo="Timoneiro",
                                       artista="Paulinho da Viola")))
        assert uslt_text(alvo) == LETRA_VG
        assert frames_audio(alvo) == audio_antes
        assert nomes(sem_tags) == nomes_antes

    def test_ctrl_c_no_vagalume_nao_deixa_lixo_nem_arquivo_pela_metade(
            self, acervo):
        alvo = acervo / "sem_letra.mp3"
        antes = sha256(alvo)

        def fetcher(url):
            if "vagalume" in url:
                raise KeyboardInterrupt
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

        with pytest.raises(KeyboardInterrupt):
            buscar_letra(acervo, aplicar=True, fetcher=fetcher)
        assert sha256(alvo) == antes              # gravação atômica
        assert nomes(acervo) == ["sem_letra.mp3"]  # sem .tmp esquecido

    def test_a_chave_nunca_e_gravada_em_disco(self, acervo):
        buscar_letra(acervo, aplicar=True)
        for p in acervo.rglob("*"):
            assert CHAVE_VG.encode("utf-8") not in p.read_bytes()


# ------------------------------------------------- CLI

class TestCLI:
    def test_ajuda_do_buscar_letra_documenta_a_opcao(self):
        r = run_curadoria("buscar-letra", "--help")
        assert r.returncode == 0, r.stderr
        assert "--chave-vagalume" in r.stdout
        assert "VAGALUME_API_KEY" in r.stdout

    def test_ajuda_do_identificar_documenta_a_opcao(self):
        r = run_curadoria("identificar", "--help")
        assert r.returncode == 0, r.stderr
        assert "--chave-vagalume" in r.stdout

    def test_sem_chave_o_comando_roda_igual(self, tmp_path, base_mp3):
        pasta = tmp_path / "so_sem_tags"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "sem_tags.mp3")
        r = run_curadoria("buscar-letra", pasta)
        assert r.returncode == 0, r.stderr
        assert ("Resumo: 0 encontradas | 0 não encontradas | 0 erros de rede"
                in r.stdout)

    def test_a_variavel_de_ambiente_habilita_o_vagalume(self, tmp_path,
                                                        base_mp3):
        """Sem candidato não há rede: o que se prova aqui é que a variável é
        aceita e o aviso de "pulado" some."""
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "sem_tags.mp3")
        r = run_curadoria("buscar-letra", pasta,
                          env={"VAGALUME_API_KEY": CHAVE_VG})
        assert r.returncode == 0, r.stderr
        assert "pulado" not in r.stdout


# ------------------------------------------------- compatibilidade

class TestCompatibilidade:
    def test_curadoria_e_embed_lyrics_compilam_em_python_39(self):
        for arquivo in (CURADORIA, TOOLS_DIR / "embed_lyrics.py"):
            fonte = arquivo.read_text(encoding="utf-8")
            ast.parse(fonte, filename=str(arquivo),
                      feature_version=(3, 9))

    def test_origem_desconhecida_no_arquivo_nao_quebra_o_relatorio(
            self, acervo, capsys):
        """Arquivo antigo só tem "transcricao" ou nada; um valor
        desconhecido (de uma versão futura) ainda deve sair como SIM."""
        alvo = acervo / "sem_letra.mp3"
        tag(alvo, letra="letra qualquer", origem="fonte-do-futuro")
        curadoria.cmd_relatorio(acervo)
        out = capsys.readouterr().out
        assert "SIM" in out
        assert "SIM (transcrição)" not in out

    def test_embed_lyrics_check_mostra_a_origem_vagalume(self, acervo):
        buscar_letra(acervo, aplicar=True)
        r = subprocess.run(
            [sys.executable, str(TOOLS_DIR / "embed_lyrics.py"), "--check",
             str(acervo / "sem_letra.mp3")],
            capture_output=True, text=True, encoding="utf-8")
        assert r.returncode == 0, r.stderr
        assert "Origem da letra: Vagalume" in r.stdout
