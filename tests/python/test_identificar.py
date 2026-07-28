# -*- coding: utf-8 -*-
"""Testes da F15 (PRD V6): impressão digital acústica (AcoustID) e a
estimativa de tempo do funil (F15.1) no curadoria.py.

Escritos antes da implementação (TDD). NENHUM teste usa rede, `fpcalc` ou
modelo: a impressão digital é injetável (mesmo padrão do `transcritor` da
V5), o AcoustID e o LRCLIB são mockados por `fetcher`, o relógio da
estimativa é injetável e a pausa de cortesia é zerada (pausa=0). A suíte
roda numa máquina SEM chromaprint instalado — que é o caso do CI.
"""
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import unicodedata
import urllib.error
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TXXX, USLT, Encoding

from conftest import TOOLS_DIR, make_mp3

CURADORIA = TOOLS_DIR / "curadoria.py"

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402
import embed_lyrics as el  # noqa: E402

CHAVE = "chave-de-teste"
FINGERPRINT = "AQADtEmiSJKiJHkS5Aj0Iz-OHz8ePD8"
LETRA_OFICIAL = "Timoneiro, nunca fui ao mar\nPega ó Rei do Mar"

IDENTIFICAR_COLS = ["arquivo", "acao", "titulo", "artista", "confianca",
                    "pontuacao", "caracteres", "detalhe"]


# ---------------------------------------------------------------- helpers

def run_curadoria(*args, env=None) -> subprocess.CompletedProcess:
    ambiente = dict(os.environ)
    ambiente.pop("ACOUSTID_API_KEY", None)
    if env:
        ambiente.update(env)
    return subprocess.run(
        [sys.executable, str(CURADORIA), *[str(a) for a in args]],
        capture_output=True, text=True, encoding="utf-8", env=ambiente,
    )


def tag(path: Path, title=None, artist=None, letra=None, temas=None) -> None:
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
    if temas is not None:
        tags.delall("TXXX:TEMAS")
        tags.add(TXXX(encoding=Encoding.UTF8, desc="TEMAS",
                      text=["; ".join(temas)]))
    tags.save(str(path), v2_version=4)


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


def uslt_text(path: Path):
    try:
        frames = ID3(str(path)).getall("USLT")
    except ID3NoHeaderError:
        return None
    return str(frames[0].text) if frames else None


def temas_value(path: Path):
    try:
        frames = [f for f in ID3(str(path)).getall("TXXX")
                  if f.desc == "TEMAS"]
    except ID3NoHeaderError:
        return None
    return str(frames[0].text[0]) if frames else None


def origem_de(path: Path):
    try:
        return el.read_letra_origem(ID3(str(path)))
    except ID3NoHeaderError:
        return ""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def shas_mp3(pasta: Path) -> dict:
    return {p: sha256(p) for p in pasta.rglob("*")
            if p.is_file() and p.suffix.lower() == ".mp3"}


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


class FakeImpressao:
    """Stub do fpcalc: registra as chamadas e devolve (duração, impressão).

    Assinatura igual à real: (caminho) -> (duracao_segundos, fingerprint).
    """

    def __init__(self, duracao=232.0, fingerprint=FINGERPRINT, erro=None,
                 erro_em=None):
        self.duracao = duracao
        self.fingerprint = fingerprint
        self.erro = erro
        self.erro_em = erro_em  # nome de arquivo que dispara o erro
        self.chamadas = []

    def __call__(self, caminho):
        nome = Path(caminho).name
        self.chamadas.append(nome)
        if self.erro is not None and (self.erro_em is None
                                      or self.erro_em == nome):
            raise self.erro
        return (self.duracao, self.fingerprint)


def gravacao(titulo="Timoneiro", artista="Paulinho da Viola", duracao=231.0,
             mbid="7d1b8f0a") -> dict:
    artistas = ([] if artista is None
                else [{"id": "a1", "name": artista, "joinphrase": ""}])
    return {"id": mbid, "title": titulo, "duration": duracao,
            "artists": artistas}


def resposta_acoustid(score=0.94, gravacoes=None) -> dict:
    if gravacoes is None:
        gravacoes = [gravacao()]
    return {"status": "ok",
            "results": [{"id": "r1", "score": score,
                         "recordings": gravacoes}]}


def lrclib(track="Timoneiro", artist="Paulinho da Viola", duracao=231.0,
           letra=LETRA_OFICIAL) -> dict:
    return {"id": 42, "trackName": track, "artistName": artist,
            "duration": duracao, "plainLyrics": letra}


def fetcher_de(acoustid=None, lrclib_res=None, urls=None, erro=None):
    """Fetcher único que atende AcoustID e LRCLIB pela URL."""
    def fetcher(url: str) -> str:
        if urls is not None:
            urls.append(url)
        if erro is not None:
            raise erro
        if "acoustid" in url:
            return json.dumps(acoustid if acoustid is not None
                              else resposta_acoustid())
        if "lrclib" in url:
            return json.dumps(lrclib_res if lrclib_res is not None else [])
        raise AssertionError("url inesperada: " + url)
    return fetcher


def identificar(pasta, **kwargs):
    """cmd_identificar com os padrões offline dos testes."""
    kwargs.setdefault("impressao_digital", FakeImpressao())
    kwargs.setdefault("fetcher", fetcher_de())
    kwargs.setdefault("chave", CHAVE)
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_identificar(pasta, **kwargs)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um único MP3 limpo por módulo (~1,5 s); os testes copiam os bytes."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def pasta(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com um MP3 sem tag nenhuma e nome que não identifica nada."""
    p = tmp_path / "acervo"
    p.mkdir()
    shutil.copyfile(base_mp3, p / "Faixa 5.mp3")
    return p


def pasta_com(tmp_path: Path, base_mp3: Path, *arquivos) -> Path:
    p = tmp_path / "acervo"
    p.mkdir()
    for nome in arquivos:
        shutil.copyfile(base_mp3, p / nome)
    return p


# ------------------------------------------------- escolha do candidato

class TestEscolhaDoCandidato:
    def test_identificada_grava_titulo_e_artista(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta)
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"
        out = capsys.readouterr().out
        assert ("IDENTIFICADA: Faixa 5.mp3 → Timoneiro / "
                "Paulinho da Viola") in out

    def test_linha_traz_confianca_pontuacao_e_duracoes(self, pasta, capsys):
        identificar(pasta)
        out = capsys.readouterr().out
        assert "(ALTA, pontuação 0.94, mp3 232s, acoustid 231s)" in out

    def test_pontuacao_abaixo_do_minimo_e_rejeitada(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        antes = sha256(alvo)
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(score=0.69)))
        assert titulo_de(alvo) is None
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "SEM RESULTADO: Faixa 5.mp3" in out
        assert "| 1 sem resultado |" in out

    def test_pontuacao_no_limite_e_aceita(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(score=0.70)))
        assert titulo_de(alvo) == "Timoneiro"

    def test_duracao_muito_divergente_desqualifica(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        # 232s no MP3 contra 300s na gravação: 68s de diferença (>15s)
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(gravacoes=[gravacao(duracao=300.0)])))
        assert titulo_de(alvo) is None
        assert "SEM RESULTADO: Faixa 5.mp3" in capsys.readouterr().out

    def test_diferenca_media_rebaixa_a_confianca(self, pasta, capsys):
        """dif 10s com pontuação 0.75: as regras da V3 dão MÉDIA."""
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(score=0.75,
                              gravacoes=[gravacao(duracao=222.0)])))
        assert "(MÉDIA, pontuação 0.75," in capsys.readouterr().out

    def test_diferenca_ate_8s_com_pontuacao_altissima_e_alta(self, pasta,
                                                             capsys):
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(score=0.97,
                              gravacoes=[gravacao(duracao=226.0)])))
        assert "(ALTA, pontuação 0.97," in capsys.readouterr().out

    def test_gravacao_sem_duracao_exige_pontuacao_altissima(self, pasta,
                                                            capsys):
        """Sem duração comparável não há confirmação: 0.75 vira BAIXA (e
        BAIXA não é identificação); 0.9 ainda rende MÉDIA."""
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(score=0.75,
                              gravacoes=[gravacao(duracao=None)])))
        assert "SEM RESULTADO: Faixa 5.mp3" in capsys.readouterr().out
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(score=0.90,
                              gravacoes=[gravacao(duracao=None)])))
        assert "(MÉDIA, pontuação 0.90," in capsys.readouterr().out

    def test_resultado_com_placeholder_e_descartado(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(titulo="AudioTrack 05",
                                artista="Unknown Artist")])))
        assert titulo_de(alvo) is None
        assert "SEM RESULTADO: Faixa 5.mp3" in capsys.readouterr().out

    def test_gravacao_sem_artista_e_descartada(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(artista=None)])))
        assert titulo_de(alvo) is None

    def test_escolhe_a_gravacao_de_duracao_mais_proxima(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(titulo="Timoneiro (ao vivo)", duracao=240.0),
                       gravacao(titulo="Timoneiro", duracao=232.0)])))
        assert titulo_de(alvo) == "Timoneiro"

    def test_sem_nenhum_resultado_e_sem_resultado(self, pasta, capsys):
        identificar(pasta, fetcher=fetcher_de({"status": "ok",
                                               "results": []}))
        out = capsys.readouterr().out
        assert "SEM RESULTADO: Faixa 5.mp3" in out
        assert "| 0 identificadas |" in out

    def test_titulo_nfd_do_musicbrainz_e_gravado_em_nfc(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        nfd = unicodedata.normalize("NFD", "Canção do Mar")
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(titulo=nfd, artista="Dulce Pontes")])))
        gravado = titulo_de(alvo)
        assert gravado == unicodedata.normalize("NFC", "Canção do Mar")
        assert gravado == unicodedata.normalize("NFC", gravado)


# ------------------------------------------------- travas de segurança

class TestTravasDeSeguranca:
    """As mesmas travas que a V5 aprendeu na marra: o palpite vem do ÁUDIO,
    então casar não autoriza apagar o que o curador escreveu."""

    def test_tag_real_nunca_e_sobrescrita_nem_em_alta(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        antes = sha256(alvo)
        identificar(pasta)
        assert titulo_de(alvo) == "Canoeiro"
        assert artista_de(alvo) == "Paulo Diniz"
        assert sha256(alvo) == antes            # nem um byte
        out = capsys.readouterr().out
        assert ('CONFLITO: Faixa 5.mp3 — tag atual "Canoeiro / Paulo Diniz" '
                'difere do identificado "Timoneiro / Paulinho da Viola" '
                '(não alterado)') in out
        assert "| 1 conflitos |" in out

    def test_conflito_tambem_na_confianca_media(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        antes = sha256(alvo)
        identificar(pasta, fetcher=fetcher_de(
            resposta_acoustid(score=0.75,
                              gravacoes=[gravacao(duracao=222.0)])))
        assert sha256(alvo) == antes
        assert "| 1 conflitos |" in capsys.readouterr().out

    def test_tag_igual_nao_e_conflito(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="TIMONEIRO", artist="paulinho da viola")
        identificar(pasta)
        out = capsys.readouterr().out
        assert "CONFLITO" not in out
        assert "IDENTIFICADA: Faixa 5.mp3 → TIMONEIRO / paulinho da viola" \
            in out
        assert titulo_de(alvo) == "TIMONEIRO"   # a grafia do curador fica

    # Teste real (94 arquivos): 6 dos 8 "conflitos" eram a MESMA música com
    # grafia diferente — "Raízes de América"/"Raíces de América",
    # "Milionário y José Rico"/"Milionário & José Rico", "Toinho do
    # Alagoas"/"Toinho de Alagoas". Tratar isso como contradição desperdiça
    # identificação boa e enche o relatório de ruído.
    @pytest.mark.parametrize("atual_t, atual_a, id_t, id_a", [
        ("Disparada", "Raízes de América", "Disparada", "Raíces de América"),
        ("Mensagem do além", "Milionário y José Rico",
         "Mensagem do além", "Milionário & José Rico"),
        ("Balanço da canoa", "Toinho do Alagoas",
         "Balanço da Canoa", "Toinho de Alagoas"),
        # prefixo/sufixo: o mesmo título com um rótulo a mais
        ("Adventício - Lampejo", "Reynaldo Bessa",
         "Lampejo", "Reynaldo Bessa"),
        ("Marinheiro So (dj mitsu remix)", "Frankie Valentine",
         "Marinheiro So", "Frankie Valentine"),
    ])
    def test_variacao_de_grafia_nao_e_conflito(self, pasta, capsys,
                                               atual_t, atual_a, id_t, id_a):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title=atual_t, artist=atual_a)
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(titulo=id_t, artista=id_a)])))
        out = capsys.readouterr().out
        assert "CONFLITO" not in out
        assert "IDENTIFICADA" in out
        # a grafia do curador é preservada: nada de tag real sobrescrita
        assert titulo_de(alvo) == atual_t
        assert artista_de(alvo) == atual_a

    def test_titulo_parecido_mas_outra_musica_continua_conflito(self, pasta,
                                                               capsys):
        # "Satania" x "Sabrina" do mesmo artista: parecidas de letra, músicas
        # diferentes — este é o conflito que PRECISA continuar aparecendo.
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Satania", artist="Casaca")
        antes = sha256(alvo)
        identificar(pasta, fetcher=fetcher_de(resposta_acoustid(
            gravacoes=[gravacao(titulo="Sabrina", artista="Casaca")])))
        assert sha256(alvo) == antes
        assert "| 1 conflitos |" in capsys.readouterr().out

    def test_tag_lixo_de_ripador_nao_bloqueia_identificacao(self, pasta):
        # Caso real: título "1-2010 22-17-23)_converted" e artista
        # "04 Faixa 4 Artista Desconheci" viraram CONFLITO e travaram uma
        # identificação boa. Lixo de ripador é campo vazio, não contradição.
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="1-2010 22-17-23)_converted",
            artist="04 Faixa 4 Artista Desconheci")
        identificar(pasta)
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"

    def test_resultado_sem_metadados_explica_no_verboso(self, pasta, capsys):
        # Teste real: "1 resultados do AcoustID" seguido de SEM RESULTADO,
        # sem uma linha sequer dizendo por quê — impossível de depurar.
        identificar(pasta, verboso=True, fetcher=fetcher_de(
            resposta_acoustid(gravacoes=[])))
        out = capsys.readouterr().out
        assert "sem metadados" in out
        assert "SEM RESULTADO" in out

    def test_tag_placeholder_e_preenchida(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="AudioTrack 05", artist="no artist")
        identificar(pasta)
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"

    def test_campo_vazio_e_preenchido_e_o_real_preservado(self, pasta,
                                                          capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Timoneiro")            # real, sem artista
        identificar(pasta)
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"
        assert "IDENTIFICADA" in capsys.readouterr().out

    def test_sobrescrever_tags_permite_alta_substituir(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        identificar(pasta, sobrescrever_tags=True)
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"
        assert "| 1 identificadas |" in capsys.readouterr().out

    def test_sobrescrever_tags_nao_vale_para_media(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        identificar(pasta, sobrescrever_tags=True, fetcher=fetcher_de(
            resposta_acoustid(score=0.75,
                              gravacoes=[gravacao(duracao=222.0)])))
        assert titulo_de(alvo) == "Canoeiro"
        assert "| 1 conflitos |" in capsys.readouterr().out

    def test_conflito_nao_busca_letra(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        urls = []
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(urls=urls, lrclib_res=[lrclib()]))
        assert not any("lrclib" in u for u in urls)
        assert uslt_text(alvo) is None

    def test_temas_existentes_sao_preservados(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, temas=["água", "cura"])
        identificar(pasta)
        assert temas_value(alvo) == "água; cura"


# ------------------------------------------------- --com-letra

class TestComLetra:
    def test_grava_letra_oficial_sem_marcador_de_transcricao(self, pasta,
                                                             capsys):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(lrclib_res=[lrclib()]))
        assert uslt_text(alvo) == LETRA_OFICIAL
        assert origem_de(alvo) == ""        # letra OFICIAL, não transcrição
        out = capsys.readouterr().out
        assert "+ letra" in out
        assert "| 1 letras oficiais |" in out

    def test_usa_o_titulo_e_o_artista_confirmados(self, pasta):
        urls = []
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(urls=urls, lrclib_res=[lrclib()]))
        consulta = next(u for u in urls if "lrclib" in u)
        assert "track_name=Timoneiro" in consulta
        assert "artist_name=Paulinho" in consulta

    def test_sem_a_opcao_nao_consulta_o_lrclib(self, pasta):
        urls = []
        identificar(pasta, fetcher=fetcher_de(urls=urls,
                                              lrclib_res=[lrclib()]))
        assert not any("lrclib" in u for u in urls)

    def test_letra_existente_nunca_e_substituida(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, letra="letra conferida à mão")
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(lrclib_res=[lrclib()]))
        assert uslt_text(alvo) == "letra conferida à mão"

    def test_lrclib_sem_resultado_ainda_grava_as_tags(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, com_letra=True, fetcher=fetcher_de(lrclib_res=[]))
        assert titulo_de(alvo) == "Timoneiro"
        assert uslt_text(alvo) is None
        out = capsys.readouterr().out
        assert "+ letra" not in out
        assert "| 0 letras oficiais |" in out

    def test_letra_de_duracao_divergente_e_recusada(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, com_letra=True, fetcher=fetcher_de(
            lrclib_res=[lrclib(duracao=300.0)]))
        assert uslt_text(alvo) is None

    def test_erro_de_rede_na_letra_nao_perde_a_identificacao(self, pasta,
                                                             capsys):
        alvo = pasta / "Faixa 5.mp3"

        def fetcher(url):
            if "acoustid" in url:
                return json.dumps(resposta_acoustid())
            raise urllib.error.URLError("rede indisponível")

        identificar(pasta, com_letra=True, fetcher=fetcher)
        assert titulo_de(alvo) == "Timoneiro"   # a identificação foi gravada
        assert "IDENTIFICADA: Faixa 5.mp3" in capsys.readouterr().out


# ------------------------------------------------- CSV e resumo

class TestCsvEResumo:
    def test_csv_registra_o_aplicado_com_confianca_e_pontuacao(self, pasta,
                                                               tmp_path):
        saida = tmp_path / "feito.csv"
        identificar(pasta, com_letra=True, csv_out=saida,
                    fetcher=fetcher_de(lrclib_res=[lrclib()]))
        assert saida.read_bytes().startswith(b"\xef\xbb\xbf")  # BOM p/ Excel
        linha = read_csv(saida)[0]
        assert list(linha.keys()) == IDENTIFICAR_COLS
        assert linha["acao"] == "IDENTIFICADA"
        assert linha["titulo"] == "Timoneiro"
        assert linha["artista"] == "Paulinho da Viola"
        assert linha["confianca"] == "ALTA"
        assert linha["pontuacao"] == "0.94"
        assert linha["caracteres"] == str(len(LETRA_OFICIAL))

    def test_csv_mostra_o_que_ficou_no_arquivo_e_nao_o_do_acoustid(
            self, pasta, tmp_path):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="TIMONEIRO")        # grafia do curador, preservada
        saida = tmp_path / "feito.csv"
        identificar(pasta, csv_out=saida)
        linha = read_csv(saida)[0]
        assert linha["titulo"] == "TIMONEIRO"
        assert linha["artista"] == "Paulinho da Viola"
        assert "preservad" in linha["detalhe"]

    def test_csv_do_conflito_diz_que_nao_aplicou(self, pasta, tmp_path):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Canoeiro", artist="Paulo Diniz")
        saida = tmp_path / "feito.csv"
        identificar(pasta, csv_out=saida)
        linha = read_csv(saida)[0]
        assert linha["acao"] == "CONFLITO"
        assert linha["titulo"] == "Canoeiro"        # o que está no arquivo
        assert linha["artista"] == "Paulo Diniz"
        assert linha["confianca"] == "ALTA"
        assert "Timoneiro" in linha["detalhe"]      # o que NÃO foi aplicado
        assert "não aplicado" in linha["detalhe"]

    def test_csv_sem_resultado_tem_acao_propria(self, pasta, tmp_path):
        saida = tmp_path / "feito.csv"
        identificar(pasta, csv_out=saida,
                    fetcher=fetcher_de({"status": "ok", "results": []}))
        assert read_csv(saida)[0]["acao"] == "SEM RESULTADO"

    def test_resumo_fecha_a_conta(self, tmp_path, base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3", "c.mp3")
        tag(p / "c.mp3", title="Canoeiro", artist="Paulo Diniz")
        (p / "quebrado.mp3").write_bytes(b"isto nao e um mp3" * 40)
        # a.mp3 e b.mp3 identificam, c.mp3 conflita, quebrado.mp3 dá erro
        identificar(p)
        out = capsys.readouterr().out
        linha = next(l for l in out.splitlines() if l.startswith("Resumo:"))
        numeros = [int(t) for t in linha.replace("|", " ").split()
                   if t.isdigit()]
        (total, ident, letras, sem, confl, erros,
         vagalume, instrumentais) = numeros
        assert total == 4
        # todo arquivo cai em exatamente um balde ("letras oficiais", "pelo
        # Vagalume" e "instrumentais" são recortes, não baldes à parte: o
        # instrumental é identificado como qualquer outro — F17)
        assert ident + sem + confl + erros == total
        assert vagalume <= letras
        assert instrumentais <= total

    def test_contador_de_progresso_por_arquivo(self, tmp_path, base_mp3,
                                               capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3")
        identificar(p)
        out = capsys.readouterr().out
        assert "[1/2]" in out
        assert "[2/2]" in out


# ------------------------------------------------- erros e interrupção

class TestErrosEInterrupcao:
    def test_audio_ilegivel_vira_erro_e_o_lote_continua(self, tmp_path,
                                                        base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3")
        (p / "quebrado.mp3").write_bytes(b"isto nao e um mp3" * 40)
        identificar(p)
        out = capsys.readouterr().out
        assert "ERRO: quebrado.mp3 — áudio ilegível" in out
        assert titulo_de(p / "a.mp3") == "Timoneiro"    # o outro seguiu
        assert "| 1 erros" in out

    def test_falha_do_fpcalc_num_arquivo_nao_derruba_o_lote(self, tmp_path,
                                                            base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3")
        antes = sha256(p / "b.mp3")
        fp = FakeImpressao(erro=RuntimeError("fpcalc: broken pipe"),
                           erro_em="b.mp3")
        identificar(p, impressao_digital=fp)
        assert titulo_de(p / "a.mp3") == "Timoneiro"
        assert sha256(p / "b.mp3") == antes
        out = capsys.readouterr().out
        assert "ERRO: b.mp3" in out
        assert "broken pipe" not in out         # nada de inglês cru
        assert "| 1 erros" in out

    def test_detalhe_tecnico_do_erro_so_no_verboso(self, pasta, capsys):
        fp = FakeImpressao(erro=RuntimeError("fpcalc: broken pipe"))
        identificar(pasta, impressao_digital=fp, verboso=True)
        assert "broken pipe" in capsys.readouterr().out

    def test_erro_de_rede_vira_erro_e_o_lote_continua(self, tmp_path,
                                                      base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3")
        antes = shas_mp3(p)
        identificar(p, fetcher=fetcher_de(erro=urllib.error.URLError("off")))
        assert shas_mp3(p) == antes
        assert "| 2 erros" in capsys.readouterr().out

    def test_resposta_de_erro_do_acoustid_e_tratada(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        identificar(pasta, fetcher=fetcher_de(
            {"status": "error", "error": {"message": "invalid API key"}}))
        assert titulo_de(alvo) is None
        out = capsys.readouterr().out
        assert "ERRO: Faixa 5.mp3" in out
        assert "invalid API key" not in out     # detalhe cru só no verboso

    def test_ctrl_c_resume_grava_o_csv_e_diz_onde_parou(self, tmp_path,
                                                        base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3", "c.mp3")
        saida = tmp_path / "feito.csv"
        antes_b = sha256(p / "b.mp3")
        fp = FakeImpressao(erro=KeyboardInterrupt(), erro_em="b.mp3")
        identificar(p, impressao_digital=fp, csv_out=saida)
        assert titulo_de(p / "a.mp3") == "Timoneiro"    # a primeira gravou
        assert sha256(p / "b.mp3") == antes_b           # a segunda, intacta
        out = capsys.readouterr().out
        assert "INTERROMPIDO: b.mp3" in out
        linhas = out.splitlines()
        i_resumo = next(i for i, l in enumerate(linhas)
                        if l.startswith("Resumo:"))
        depois = "\n".join(linhas[i_resumo:])
        assert "Interrompido em: b.mp3" in depois
        assert "2 de 3" in depois
        assert "1 não processados" in depois
        assert saida.is_file(), "horas de trabalho perdidas sem o CSV"
        arquivos = [linha["arquivo"] for linha in read_csv(saida)]
        assert "a.mp3" in arquivos
        assert "c.mp3" not in arquivos

    def test_ctrl_c_na_gravacao_nao_diz_nada_gravado(self, pasta, capsys,
                                                     monkeypatch):
        alvo = pasta / "Faixa 5.mp3"
        real = el.write_title_artist

        def grava_e_interrompe(*args, **kwargs):
            real(*args, **kwargs)
            raise KeyboardInterrupt()

        monkeypatch.setattr(curadoria.el, "write_title_artist",
                            grava_e_interrompe)
        identificar(pasta)
        assert titulo_de(alvo) == "Timoneiro"       # a tag ESTÁ no arquivo
        out = capsys.readouterr().out
        assert "INTERROMPIDO: Faixa 5.mp3" in out
        assert "nada gravado" not in out            # não mente
        assert "Resumo:" in out


# ------------------------------------------------- invioláveis

class TestInviolaveis:
    def test_frames_de_audio_e_nome_do_arquivo_intactos(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        audio_antes = frames_audio(alvo)
        nomes_antes = nomes(pasta)
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(lrclib_res=[lrclib()]))
        assert frames_audio(alvo) == audio_antes    # só a tag ID3 mudou
        assert nomes(pasta) == nomes_antes          # nada renomeado nem movido
        assert titulo_de(alvo) == "Timoneiro"       # (sanidade: a tag mudou)

    def test_pausa_de_cortesia_respeita_o_limite_do_acoustid(self, tmp_path,
                                                             base_mp3,
                                                             monkeypatch):
        # o AcoustID pede no máximo 3 consultas por segundo
        assert curadoria.PAUSA_ACOUSTID_S >= 1 / 3
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3", "c.mp3")
        pausas = []
        monkeypatch.setattr(curadoria.time, "sleep", pausas.append)
        identificar(p, pausa=curadoria.PAUSA_ACOUSTID_S)
        # entre as 3 consultas, nunca antes da primeira
        assert pausas == [curadoria.PAUSA_ACOUSTID_S] * 2

    def test_a_chave_nunca_vaza_na_saida_nem_no_csv(self, pasta, tmp_path,
                                                    capsys):
        saida = tmp_path / "feito.csv"
        identificar(pasta, chave="segredo-do-curador", csv_out=saida,
                    verboso=True)
        assert "segredo-do-curador" not in capsys.readouterr().out
        gravado = saida.read_text(encoding="utf-8-sig")
        assert "segredo-do-curador" not in gravado

    def test_a_chave_vai_na_consulta_ao_acoustid(self, pasta):
        urls = []
        identificar(pasta, chave="minha-chave", fetcher=fetcher_de(urls=urls))
        assert "client=minha-chave" in urls[0]
        assert f"fingerprint={FINGERPRINT}" in urls[0]
        assert "duration=232" in urls[0]


# ------------------------------------------------- dependências ausentes

class TestDependenciasAusentes:
    def _sem_fpcalc(self, tmp_path) -> dict:
        vazio = tmp_path / "sem-path"
        vazio.mkdir()
        return {"PATH": str(vazio)}

    def test_sem_fpcalc_explica_como_instalar_e_sai_1(self, pasta, tmp_path):
        antes = shas_mp3(pasta)
        env = self._sem_fpcalc(tmp_path)
        env["ACOUSTID_API_KEY"] = CHAVE
        result = run_curadoria("identificar", pasta, env=env)
        assert result.returncode == 1
        assert len(result.stderr.strip().splitlines()) == 1  # uma linha
        assert "fpcalc" in result.stderr
        assert "chromaprint" in result.stderr.lower()
        assert "brew" in result.stderr           # macOS
        assert "apt" in result.stderr            # Linux
        assert shas_mp3(pasta) == antes          # nenhum arquivo tocado

    def test_sem_chave_diz_onde_obter_e_sai_1(self, pasta, tmp_path):
        antes = shas_mp3(pasta)
        result = run_curadoria("identificar", pasta,
                               env=self._sem_fpcalc(tmp_path))
        assert result.returncode == 1
        assert len(result.stderr.strip().splitlines()) == 1
        assert "acoustid.org" in result.stderr.lower()
        assert "ACOUSTID_API_KEY" in result.stderr
        assert "gratuita" in result.stderr.lower()
        assert shas_mp3(pasta) == antes

    def test_chave_da_variavel_de_ambiente_serve(self, pasta, tmp_path):
        """Com chave no ambiente o erro passa a ser o do fpcalc — prova que
        a variável foi lida (e que a chave não precisa ir para o disco)."""
        env = self._sem_fpcalc(tmp_path)
        env["ACOUSTID_API_KEY"] = CHAVE
        result = run_curadoria("identificar", pasta, env=env)
        assert "chave" not in result.stderr.lower()
        assert "fpcalc" in result.stderr

    def test_outros_subcomandos_seguem_funcionando_sem_fpcalc(self, pasta,
                                                              tmp_path):
        result = run_curadoria("relatorio", pasta,
                               env=self._sem_fpcalc(tmp_path))
        assert result.returncode == 0, result.stderr
        assert "Faixa 5.mp3" in result.stdout

    def test_curadoria_nao_procura_fpcalc_no_topo_do_modulo(self):
        """Nada de `which`/subprocess ao importar o módulo: a dependência
        externa só é procurada dentro do subcomando que precisa dela (o
        docstring do módulo pode citá-la à vontade)."""
        import ast
        fonte = (TOOLS_DIR / "curadoria.py").read_text(encoding="utf-8")
        arvore = ast.parse(fonte)
        for no in arvore.body:
            if isinstance(no, (ast.FunctionDef, ast.ClassDef)):
                continue  # corpo de função só roda quando chamado
            for interno in ast.walk(no):
                if isinstance(interno, ast.Call):
                    assert "fpcalc" not in ast.dump(interno)
                    assert "which" not in ast.dump(interno)
                    assert "subprocess" not in ast.dump(interno)


# ------------------------------------------------- CLI

class TestCli:
    def test_ajuda_geral_lista_os_subcomandos_novos(self):
        result = run_curadoria("--help")
        assert result.returncode == 0, result.stderr
        assert "identificar" in result.stdout
        assert "estimar" in result.stdout

    def test_ajuda_do_identificar(self):
        result = run_curadoria("identificar", "--help")
        assert result.returncode == 0, result.stderr
        for flag in ("--chave", "--com-letra", "--csv", "--sobrescrever-tags",
                     "--verboso"):
            assert flag in result.stdout
        assert "ACOUSTID_API_KEY" in result.stdout
        assert "DESTRUTIVO" in result.stdout

    def test_ajuda_do_estimar(self):
        result = run_curadoria("estimar", "--help")
        assert result.returncode == 0, result.stderr
        assert "--amostra" in result.stdout

    def test_codigo_compativel_com_python_39(self):
        import ast
        fonte = (TOOLS_DIR / "curadoria.py").read_text(encoding="utf-8")
        ast.parse(fonte, feature_version=(3, 9))


# ------------------------------------------------- F15.1 estimar

class Relogio:
    """Relógio injetável: cada leitura avança um passo fixo, então cada
    medição (duas leituras) custa exatamente `passo` segundos."""

    def __init__(self, passo=1.5):
        self.passo = passo
        self.agora = 0.0

    def __call__(self):
        valor = self.agora
        self.agora += self.passo
        return valor


def estimar(pasta, **kwargs):
    kwargs.setdefault("relogio", Relogio())
    kwargs.setdefault("impressao_digital", FakeImpressao())
    return curadoria.cmd_estimar(pasta, **kwargs)


@pytest.fixture
def acervo_longo(tmp_path, base_mp3, monkeypatch):
    """10 MP3s que a leitura de tags reporta como 4 minutos cada."""
    p = tmp_path / "acervo"
    p.mkdir()
    for i in range(10):
        shutil.copyfile(base_mp3, p / f"{i:02d}.mp3")
    real = curadoria.ler_info

    def quatro_minutos(path):
        info = real(path)
        info["duracao"] = 240.0
        return info

    monkeypatch.setattr(curadoria, "ler_info", quatro_minutos)
    return p


class TestEstimar:
    def test_conta_arquivos_e_incompletos(self, tmp_path, base_mp3, capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3", "c.mp3")
        tag(p / "a.mp3", title="Timoneiro", artist="Paulinho",
            letra="uma letra")
        tag(p / "b.mp3", title="AudioTrack 02", artist="no artist")
        estimar(p, amostra=3)
        out = capsys.readouterr().out
        # a.mp3 está completa; b.mp3 (placeholder) e c.mp3 (vazia), não
        assert "Acervo: 3 arquivos | 2 incompletos | 2 sem letra" in out

    def test_projecao_do_identificar_usa_o_tempo_medido(self, acervo_longo,
                                                        capsys):
        # 2 s por música medidos × 10 arquivos = 20 s
        estimar(acervo_longo, amostra=5, relogio=Relogio(passo=2.0))
        out = capsys.readouterr().out
        assert "identificar: ~20 s" in out

    def test_projecao_da_transcricao_por_modelo(self, acervo_longo, capsys):
        estimar(acervo_longo, amostra=5, relogio=Relogio(passo=2.0))
        out = capsys.readouterr().out
        small = curadoria.RAZAO_TRANSCRICAO["small"] * 240.0 * 10
        tiny = curadoria.RAZAO_TRANSCRICAO["tiny"] * 240.0 * 10
        assert f"transcrever o restante: {curadoria._fmt_estimativa(small)} " \
               f"(modelo small)" in out
        assert f"ou {curadoria._fmt_estimativa(tiny)} (modelo tiny)" in out

    def test_formato_das_estimativas(self):
        assert curadoria._fmt_estimativa(0.4) == "~1 s"   # "~0 s" não informa
        assert curadoria._fmt_estimativa(45) == "~45 s"
        assert curadoria._fmt_estimativa(240) == "~4 min"
        assert curadoria._fmt_estimativa(4800) == "~1h20"

    def test_mede_apenas_o_tamanho_da_amostra(self, acervo_longo):
        fp = FakeImpressao()
        estimar(acervo_longo, amostra=3, impressao_digital=fp)
        assert len(fp.chamadas) == 3

    def test_amostra_maior_que_o_acervo_usa_tudo(self, tmp_path, base_mp3,
                                                 capsys):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3")
        fp = FakeImpressao()
        estimar(p, amostra=50, impressao_digital=fp)
        assert len(fp.chamadas) == 2
        assert "Amostra: 2 arquivos" in capsys.readouterr().out

    def test_diz_que_sao_estimativas(self, acervo_longo, capsys):
        estimar(acervo_longo, amostra=5)
        out = capsys.readouterr().out.lower()
        assert "estimativa" in out
        assert "varia" in out

    def test_sem_fpcalc_projeta_por_media_publicada_e_avisa(self,
                                                            acervo_longo,
                                                            capsys,
                                                            monkeypatch):
        monkeypatch.setattr(curadoria.shutil, "which", lambda _nome: None)
        curadoria.cmd_estimar(acervo_longo, amostra=5)   # sem injeção
        out = capsys.readouterr().out
        assert "AVISO:" in out
        assert "fpcalc" in out
        assert "não medido" in out
        esperado = curadoria._fmt_estimativa(
            curadoria.SEGUNDOS_IDENTIFICAR_PADRAO * 10)
        assert f"identificar: {esperado}" in out

    def test_transcricao_sem_modelo_avisa_que_e_proporcao_publicada(
            self, acervo_longo, capsys):
        estimar(acervo_longo, amostra=5)
        out = capsys.readouterr().out
        assert "proporção publicada" in out
        assert "não medido" in out

    def test_nao_baixa_modelo_nenhum(self, acervo_longo, monkeypatch):
        def nao_pode(*args, **kwargs):
            raise AssertionError("estimar não pode carregar modelo")

        monkeypatch.setattr(curadoria, "criar_transcritor", nao_pode)
        estimar(acervo_longo, amostra=5)

    def test_transcritor_injetado_e_medido_de_verdade(self, acervo_longo,
                                                      capsys):
        chamadas = []

        def transcritor(caminho, inicio=None, duracao=None):
            chamadas.append((Path(caminho).name, inicio, duracao))
            return "texto qualquer"

        estimar(acervo_longo, amostra=2, transcritor=transcritor,
                relogio=Relogio(passo=3.0))
        assert len(chamadas) == 2
        out = capsys.readouterr().out
        assert "proporção publicada" not in out
        assert "medido nesta máquina" in out

    def test_pasta_vazia_nao_quebra(self, tmp_path, capsys):
        vazia = tmp_path / "vazia"
        vazia.mkdir()
        estimar(vazia)
        assert "Acervo: 0 arquivos" in capsys.readouterr().out

    def test_nao_toca_em_arquivo_nenhum(self, tmp_path, base_mp3):
        p = pasta_com(tmp_path, base_mp3, "a.mp3", "b.mp3")
        antes = shas_mp3(p)
        estimar(p, amostra=2)
        assert shas_mp3(p) == antes
