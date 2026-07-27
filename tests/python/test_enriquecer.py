# -*- coding: utf-8 -*-
"""Testes da F9 (PRD V3): enriquecimento automático do acervo.

Escritos antes da implementação (TDD). NENHUM teste usa rede: fetch_search e
fetch_lyrics_by_id são injetáveis (fetcher) e mockados com stubs locais; a
pausa de cortesia é zerada por parâmetro (pausa=0) ou espionada via
monkeypatch de time.sleep.
"""
import csv
import hashlib
import json
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

LETRA_LRCLIB = "Chove lá fora\nE aqui dentro canta o coração"

PROPOSTA_COLS = ["arquivo", "titulo_atual", "artista_atual", "titulo_proposto",
                 "artista_proposto", "confianca", "duracao_mp3",
                 "duracao_encontrada", "letra", "temas_propostos",
                 "lrclib_id", "aceitar"]


# ---------------------------------------------------------------- helpers

def run_curadoria(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CURADORIA), *[str(a) for a in args]],
        capture_output=True,
        text=True,
        encoding="utf-8",
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


def uslt_text(path: Path):
    try:
        frames = ID3(str(path)).getall("USLT")
    except ID3NoHeaderError:
        return None
    return str(frames[0].text) if frames else None


def temas_value(path: Path):
    try:
        frames = [f for f in ID3(str(path)).getall("TXXX") if f.desc == "TEMAS"]
    except ID3NoHeaderError:
        return None
    return str(frames[0].text[0]) if frames else None


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


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def shas_mp3(pasta: Path) -> dict:
    return {p: sha256(p) for p in pasta.rglob("*")
            if p.is_file() and p.suffix.lower() == ".mp3"}


def read_csv(path: Path) -> list:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def linha_proposta(**kw) -> dict:
    base = {c: "" for c in PROPOSTA_COLS}
    base.update(kw)
    return base


def write_proposta(path: Path, rows: list) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=PROPOSTA_COLS)
        writer.writeheader()
        writer.writerows(rows)


def resultado(id=42, track="Oh! Chuva", artist="Falamansa", duration=2.0,
              letra=LETRA_LRCLIB) -> dict:
    return {"id": id, "trackName": track, "artistName": artist,
            "duration": duration, "plainLyrics": letra}


RES_CHUVA = resultado()


def fetcher_vazio(url: str) -> str:
    if "/api/search" in url:
        return json.dumps([])
    raise AssertionError("url inesperada: " + url)


def fetcher_chuva(url: str) -> str:
    if "/api/search" in url:
        return json.dumps([RES_CHUVA])
    if "/api/get/42" in url:
        return json.dumps(RES_CHUVA)
    raise AssertionError("url inesperada: " + url)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um único MP3 limpo por módulo (~1,5 s); os testes copiam os bytes."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def pasta_chuva(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com um único MP3 sem tags cujo nome identifica a faixa."""
    pasta = tmp_path / "acervo"
    pasta.mkdir()
    shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
    return pasta


# ---------------------------------------------------------------- unidades

class TestLimparNomeArquivo:
    def test_remove_extensao(self):
        assert curadoria.limpar_nome_arquivo("Oh! Chuva.mp3") == "Oh! Chuva"

    def test_preserva_divisor_artista_titulo(self):
        assert (curadoria.limpar_nome_arquivo("Falamansa - Oh! Chuva.mp3")
                == "Falamansa - Oh! Chuva")

    def test_remove_numero_de_faixa(self):
        assert (curadoria.limpar_nome_arquivo("08 Na dança das Folhas.mp3")
                == "Na dança das Folhas")

    def test_remove_numero_de_faixa_com_hifen(self):
        assert curadoria.limpar_nome_arquivo("08 - Xote.mp3") == "Xote"

    def test_remove_numero_de_faixa_entre_parenteses(self):
        assert curadoria.limpar_nome_arquivo("(08) Xote.mp3") == "Xote"

    def test_underscores_e_ruido_entre_colchetes_e_parenteses(self):
        assert (curadoria.limpar_nome_arquivo(
            "Oh_Chuva_[Official]_(Ao Vivo).mp3") == "Oh Chuva")

    def test_parenteses_ficam_se_sobrar_vazio(self):
        assert (curadoria.limpar_nome_arquivo("(Instrumental).mp3")
                == "(Instrumental)")

    def test_nome_so_numerico_nao_vira_vazio(self):
        assert curadoria.limpar_nome_arquivo("12.mp3") == "12"

    def test_nome_nfd_vira_nfc_sem_partir_palavra(self):
        # macOS entrega nomes de arquivo decompostos (NFD); o palpite deve
        # sair recomposto (NFC), nunca com a palavra partida
        nfd = unicodedata.normalize("NFD", "adventício - Chegança.mp3")
        limpo = curadoria.limpar_nome_arquivo(nfd)
        assert limpo == "adventício - Chegança"
        assert unicodedata.is_normalized("NFC", limpo)


class TestGerarPalpites:
    def test_tags_vem_primeiro(self):
        palpites = curadoria.gerar_palpites("qualquer.mp3",
                                            "Título Tag", "Artista Tag")
        assert palpites[0] == ("Título Tag", "Artista Tag")

    def test_divisor_gera_as_duas_ordens_e_o_nome_inteiro(self):
        palpites = curadoria.gerar_palpites("Falamansa - Oh! Chuva.mp3")
        assert palpites == [
            ("Oh! Chuva", "Falamansa"),   # Artista - Título
            ("Falamansa", "Oh! Chuva"),   # Título - Artista
            ("Falamansa - Oh! Chuva", ""),  # nome inteiro como título
        ]

    def test_sem_divisor_so_nome_inteiro(self):
        assert curadoria.gerar_palpites("Só Nome.mp3") == [("Só Nome", "")]

    def test_titulo_de_tag_com_divisor_sem_artista_gera_split(self):
        # caso real: TIT2 "Hyldon - Musica Bonita" com TPE1 vazio — o split
        # nas duas ordens vem ANTES dos palpites de nome de arquivo
        palpites = curadoria.gerar_palpites("arquivo qualquer.mp3",
                                            "Hyldon - Musica Bonita", "")
        assert palpites[0] == ("Hyldon - Musica Bonita", "")
        assert palpites[1] == ("Musica Bonita", "Hyldon")   # Artista - Título
        assert palpites[2] == ("Hyldon", "Musica Bonita")   # Título - Artista
        assert palpites[3] == ("arquivo qualquer", "")      # nome vem depois

    def test_titulo_de_tag_com_divisor_e_artista_nao_gera_split(self):
        palpites = curadoria.gerar_palpites("x.mp3", "A - B", "Artista")
        assert palpites[0] == ("A - B", "Artista")
        assert ("B", "A") not in palpites

    def test_tag_placeholder_nunca_vira_palpite(self):
        # caso real: TIT2 "02 AudioTrack 02", TPE1 "no artist" — tags-lixo
        # de ripador não identificam nada; palpites saem do NOME do arquivo
        palpites = curadoria.gerar_palpites(
            "adventício - Cheganca - Antonio Nobrega.mp3",
            "02 AudioTrack 02", "no artist")
        assert palpites[0] == ("Cheganca - Antonio Nobrega", "adventício")
        for titulo, artista in palpites:
            assert "AudioTrack" not in titulo
            assert artista != "no artist"

    def test_so_artista_placeholder_e_tratado_como_vazio(self):
        # título real + artista placeholder: vira o caso "artista vazio"
        # (inclusive o split do título com " - " nas duas ordens)
        palpites = curadoria.gerar_palpites("x.mp3", "Hyldon - Musica Bonita",
                                            "[Unknown Artist]")
        assert palpites[0] == ("Hyldon - Musica Bonita", "")
        assert ("Musica Bonita", "Hyldon") in palpites

    def test_nome_com_tres_segmentos_combina_os_dois_ultimos(self):
        # "coleção - Título - Artista": além dos palpites atuais (split no
        # PRIMEIRO " - "), os dois últimos segmentos nas duas ordens
        palpites = curadoria.gerar_palpites(
            "adventício - Cheganca - Antonio Nobrega.mp3")
        assert ("Cheganca", "Antonio Nobrega") in palpites   # Título, Artista
        assert ("Antonio Nobrega", "Cheganca") in palpites   # Artista, Título
        # os palpites atuais continuam presentes, na frente
        assert palpites[0] == ("Cheganca - Antonio Nobrega", "adventício")
        assert palpites[1] == ("adventício", "Cheganca - Antonio Nobrega")
        assert ("adventício - Cheganca - Antonio Nobrega", "") in palpites

    def test_nome_com_dois_segmentos_nao_ganha_combinacoes_extras(self):
        palpites = curadoria.gerar_palpites("Falamansa - Oh! Chuva.mp3")
        assert len(palpites) == 3  # sem duplicar os palpites do split simples


class TestSimilaridade:
    def test_ignora_acento_caixa_e_pontuacao(self):
        assert curadoria.similaridade("Oh! Chuva", "oh chuva") == 1.0

    def test_textos_diferentes_dao_valor_baixo(self):
        assert curadoria.similaridade("Oh! Chuva", "Asa Branca") < 0.5


class TestClassificar:
    def test_alta_por_duracao_justa(self):
        assert curadoria.classificar(0.65, 2.0) == "ALTA"

    def test_alta_por_similaridade_forte(self):
        assert curadoria.classificar(0.9, 7.0) == "ALTA"

    def test_media(self):
        assert curadoria.classificar(0.55, 10.0) == "MÉDIA"

    def test_duracao_divergente_e_baixa(self):
        assert curadoria.classificar(0.95, 20.0) == "BAIXA"

    def test_similaridade_fraca_e_baixa(self):
        assert curadoria.classificar(0.4, 1.0) == "BAIXA"

    def test_sem_duracao_similaridade_forte_e_media(self):
        # resultado sem duration comparável: sem bônus, mas não é
        # desclassificado — similaridade >= 0.85 vira MÉDIA
        assert curadoria.classificar(0.95, None) == "MÉDIA"
        assert curadoria.classificar(0.85, None) == "MÉDIA"

    def test_sem_duracao_similaridade_fraca_e_baixa(self):
        assert curadoria.classificar(0.7, None) == "BAIXA"


class TestLimparConsulta:
    def test_remove_hifen_solto(self):
        assert (curadoria.limpar_consulta("Hyldon - Musica Bonita")
                == "Hyldon Musica Bonita")

    def test_remove_pontuacao_e_colapsa_espacos(self):
        assert curadoria.limpar_consulta("Oh!   Chuva ") == "Oh Chuva"

    def test_preserva_acentos_e_caixa(self):
        assert curadoria.limpar_consulta("Água Viva") == "Água Viva"

    # BUG real: nome de arquivo NFD (macOS) fazia o combining char virar
    # espaço e PARTIA a palavra ("Música" → "Mu sica"). Contrato: a consulta
    # sai em NFC, acentos preservados, palavra NUNCA partida.
    @pytest.mark.parametrize("original", [
        "Música Espírita",
        "É cedo ainda",
        "Na dança das Folhas",
        "adventício",
        "Berço de Deus",
        "Apreço ao meu lugar",
        "Lembrança cósmica",
    ])
    def test_nfd_nao_parte_palavra_acentuada(self, original):
        nfd = unicodedata.normalize("NFD", original)
        assert curadoria.limpar_consulta(nfd) == original

    def test_nfd_com_pontuacao_continua_limpando(self):
        nfd = unicodedata.normalize("NFD", "É cedo, ainda!")
        assert curadoria.limpar_consulta(nfd) == "É cedo ainda"


class TestEhPlaceholder:
    @pytest.mark.parametrize("texto", [
        "", "   ", "12", "#", "###", "02",
        "AudioTrack 02", "02 AudioTrack 02", "Audio Track 5", "audiotrack",
        "Faixa 8", "faixa 2", "Faixa", "Track 10", "track", "Pista 3",
        "no artist", "No Artist", "unknown artist", "[Unknown Artist]",
        "Artista Desconhecido", "artista desconhecido", "artist",
        "no title", "Sem Título", "sem titulo", "untitled", "Unknown",
    ])
    def test_placeholder_e_detectado(self, texto):
        assert curadoria.eh_placeholder(texto) is True

    @pytest.mark.parametrize("texto", [
        "Oh! Chuva", "Chegança", "Antonio Nobrega", "Cali",
        "Faixa de Gaza", "12 Horas", "Música Espírita", "O Artista",
        "Princesa Goiana", "É cedo ainda",
    ])
    def test_nome_real_nao_e_placeholder(self, texto):
        assert curadoria.eh_placeholder(texto) is False


class TestFetchSearch:
    def test_monta_url_com_q_escapado(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps([RES_CHUVA])

        resultados = curadoria.fetch_search("Água Viva", fetcher=espiao)
        assert resultados == [RES_CHUVA]
        assert len(urls) == 1
        assert urls[0].startswith("https://lrclib.net/api/search?")
        assert "q=%C3%81gua+Viva" in urls[0]

    def test_q_e_limpo_antes_de_enviar(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps([])

        curadoria.fetch_search("Hyldon - Musica Bonita!", fetcher=espiao)
        assert urls == \
            ["https://lrclib.net/api/search?q=Hyldon+Musica+Bonita"]

    def test_monta_url_com_track_name_e_artist_name(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps([RES_CHUVA])

        resultados = curadoria.fetch_search(
            track_name="Oh! Chuva", artist_name="Falamansa", fetcher=espiao)
        assert resultados == [RES_CHUVA]
        assert len(urls) == 1
        assert urls[0].startswith("https://lrclib.net/api/search?")
        assert "track_name=Oh%21+Chuva" in urls[0]
        assert "artist_name=Falamansa" in urls[0]
        assert "q=" not in urls[0]

    def test_erro_de_rede_propaga(self):
        def caiu(url):
            raise urllib.error.URLError("rede indisponível")
        with pytest.raises(urllib.error.URLError):
            curadoria.fetch_search("x", fetcher=caiu)


class TestFetchLyricsById:
    def test_monta_url_com_id_no_caminho(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps({"plainLyrics": "x"})

        assert curadoria.fetch_lyrics_by_id("42", fetcher=espiao) == "x"
        assert urls == ["https://lrclib.net/api/get/42"]

    def test_404_vira_none(self):
        def f404(url):
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
        assert curadoria.fetch_lyrics_by_id("9", fetcher=f404) is None

    def test_plain_lyrics_vazia_vira_none(self):
        def instrumental(url):
            return json.dumps({"plainLyrics": None, "instrumental": True})
        assert curadoria.fetch_lyrics_by_id("9", fetcher=instrumental) is None


# ---------------------------------------------------------------- enriquecer

class TestEnriquecerCsv:
    def test_alta_por_nome_de_arquivo_com_letra(self, pasta_chuva, tmp_path,
                                                 capsys):
        saida = tmp_path / "proposta.csv"
        antes = shas_mp3(pasta_chuva)
        curadoria.cmd_enriquecer(pasta_chuva, csv_out=saida,
                                 fetcher=fetcher_chuva, pausa=0)
        assert shas_mp3(pasta_chuva) == antes  # propor não grava nada
        rows = read_csv(saida)
        assert list(rows[0].keys()) == PROPOSTA_COLS
        assert len(rows) == 1
        row = rows[0]
        assert row["arquivo"] == "Falamansa - Oh! Chuva.mp3"
        assert row["titulo_atual"] == ""
        assert row["artista_atual"] == ""
        assert row["titulo_proposto"] == "Oh! Chuva"
        assert row["artista_proposto"] == "Falamansa"
        assert row["confianca"] == "ALTA"
        assert row["duracao_mp3"] in ("1", "2")
        assert row["duracao_encontrada"] == "2"
        assert row["letra"] == "SIM"
        assert row["lrclib_id"] == "42"
        assert row["aceitar"] == "SIM"  # pré-preenchido só para ALTA
        out = capsys.readouterr().out
        assert ("Resumo: 1 confiança alta | 0 média | 0 baixa | "
                "0 aplicados | 0 erros de rede") in out

    def test_numero_de_faixa_sai_do_palpite(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "08 Na dança das Folhas.mp3")
        chamadas = []

        def espiao(url):
            chamadas.append(url)
            return json.dumps([])

        curadoria.cmd_enriquecer(pasta, fetcher=espiao, pausa=0)
        assert len(chamadas) == 1
        assert "08" not in chamadas[0]
        assert "Folhas" in chamadas[0]

    def test_duracao_divergente_desclassifica(self, tmp_path, base_mp3,
                                              capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        saida = tmp_path / "proposta.csv"

        def homonimo(url):  # texto idêntico, mas duração 300 s (>15 s)
            return json.dumps([resultado(duration=300.0)])

        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=homonimo,
                                 pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert row["lrclib_id"] == ""
        assert row["letra"] == "NÃO"
        assert row["aceitar"] == ""
        # BAIXA propõe apenas o palpite de nome de arquivo
        assert row["titulo_proposto"] == "Oh! Chuva"
        assert row["artista_proposto"] == "Falamansa"
        out = capsys.readouterr().out
        assert ("Resumo: 0 confiança alta | 0 média | 1 baixa | "
                "0 aplicados | 0 erros de rede") in out

    def test_completo_e_pulado_sem_busca(self, pasta_chuva, tmp_path, capsys):
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        tag(alvo, title="Oh! Chuva", artist="Falamansa", letra="já tem")
        saida = tmp_path / "proposta.csv"
        chamadas = []

        def espiao(url):
            chamadas.append(url)
            return json.dumps([RES_CHUVA])

        curadoria.cmd_enriquecer(pasta_chuva, csv_out=saida, fetcher=espiao,
                                 pausa=0)
        assert chamadas == []          # nem consulta a rede
        assert read_csv(saida) == []   # nem entra na proposta
        out = capsys.readouterr().out
        assert "PULADO: Falamansa - Oh! Chuva.mp3" in out
        assert ("Resumo: 0 confiança alta | 0 média | 0 baixa | "
                "0 aplicados | 0 erros de rede") in out

    def test_forcar_reprocessa_completos(self, pasta_chuva, tmp_path):
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        tag(alvo, title="Oh! Chuva", artist="Falamansa", letra="já tem")
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta_chuva, csv_out=saida, forcar=True,
                                 fetcher=fetcher_chuva, pausa=0)
        rows = read_csv(saida)
        assert len(rows) == 1
        assert rows[0]["confianca"] == "ALTA"
        assert rows[0]["titulo_atual"] == "Oh! Chuva"

    def test_temas_das_subpastas_no_csv(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        (pasta / "cura" / "aniversário").mkdir(parents=True)
        shutil.copyfile(base_mp3, pasta / "raiz.mp3")
        shutil.copyfile(base_mp3, pasta / "cura" / "x.mp3")
        shutil.copyfile(base_mp3, pasta / "cura" / "aniversário" / "y.mp3")
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher_vazio,
                                 pausa=0)
        por_arquivo = {r["arquivo"]: r for r in read_csv(saida)}
        assert por_arquivo["cura/x.mp3"]["temas_propostos"] == "cura"
        assert (por_arquivo["cura/aniversário/y.mp3"]["temas_propostos"]
                == "aniversário; cura")
        assert por_arquivo["raiz.mp3"]["temas_propostos"] == ""  # raiz: nada

    def test_sem_temas_de_pastas_desativa(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        (pasta / "cura").mkdir(parents=True)
        shutil.copyfile(base_mp3, pasta / "cura" / "x.mp3")
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, temas_pastas=False,
                                 fetcher=fetcher_vazio, pausa=0)
        assert read_csv(saida)[0]["temas_propostos"] == ""

    def test_erro_de_rede_nao_aborta_o_lote(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "AAA Erro.mp3")
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")

        def fetcher(url):
            if "Erro" in url:
                raise urllib.error.URLError("caiu")
            return fetcher_chuva(url)

        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher,
                                 pausa=0)
        out = capsys.readouterr().out
        assert "ERRO DE REDE: AAA Erro.mp3" in out
        rows = read_csv(saida)
        assert [r["arquivo"] for r in rows] == ["Falamansa - Oh! Chuva.mp3"]
        assert ("Resumo: 1 confiança alta | 0 média | 0 baixa | "
                "0 aplicados | 1 erros de rede") in out

    def test_resumo_exato_com_todas_as_classes(self, tmp_path, base_mp3,
                                               capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "AAA Erro.mp3")
        shutil.copyfile(base_mp3, pasta / "Desconhecida.mp3")
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        shutil.copyfile(base_mp3, pasta / "Zeca - Outra.mp3")

        def fetcher(url):
            if "Erro" in url:
                raise urllib.error.URLError("caiu")
            if "Chuva" in url:
                return json.dumps([RES_CHUVA])
            if "Outra" in url:  # duração diverge ~10 s: MÉDIA
                return json.dumps([resultado(id=7, track="Outra",
                                             artist="Zeca", duration=12.0)])
            return json.dumps([])

        curadoria.cmd_enriquecer(pasta, fetcher=fetcher, pausa=0)
        out = capsys.readouterr().out
        assert ("Resumo: 1 confiança alta | 1 média | 1 baixa | "
                "0 aplicados | 1 erros de rede") in out


class TestBuscaDuasFormas:
    def test_palpite_com_artista_tenta_track_name_primeiro(self, tmp_path,
                                                           base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        urls = []

        def espiao(url):
            urls.append(url)
            if "track_name=" in url:
                return json.dumps([RES_CHUVA])
            return json.dumps([])

        curadoria.cmd_enriquecer(pasta, fetcher=espiao, pausa=0)
        assert "track_name=Oh%21+Chuva" in urls[0]
        assert "artist_name=Falamansa" in urls[0]
        assert len(urls) == 1  # achou na forma precisa: sem fallback

    def test_fallback_para_q_limpo_quando_track_name_nao_acha(self, tmp_path,
                                                              base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps([])

        curadoria.cmd_enriquecer(pasta, fetcher=espiao, pausa=0)
        # palpite 1: track_name → fallback q; palpite 2: idem; palpite 3: q
        assert len(urls) == 5
        assert "track_name=Oh%21+Chuva" in urls[0]
        assert "track_name" not in urls[1]
        assert "q=Oh+Chuva+Falamansa" in urls[1]  # texto limpo, sem "!"
        assert "track_name=Falamansa" in urls[2]
        assert "q=Falamansa+Oh+Chuva" in urls[3]
        assert "q=Falamansa+Oh+Chuva" in urls[4]  # nome inteiro, sem " - "

    def test_titulo_de_tag_com_artista_embutido_acha_via_split(self, tmp_path,
                                                               base_mp3):
        # caso real "Hyldon - Musica Bonita" em TIT2, TPE1 vazio
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "faixa01.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Hyldon - Musica Bonita")

        def fetcher(url):
            if ("/api/search" in url and "track_name=Musica+Bonita" in url
                    and "artist_name=Hyldon" in url):
                return json.dumps([resultado(id=9, track="Musica Bonita",
                                             artist="Hyldon", duration=2.0)])
            if "/api/search" in url:
                return json.dumps([])
            raise AssertionError("url inesperada: " + url)

        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher,
                                 pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "ALTA"
        assert row["titulo_proposto"] == "Musica Bonita"
        assert row["artista_proposto"] == "Hyldon"


class TestBaixaNaoSobrescreve:
    def test_csv_baixa_repete_tags_existentes(self, tmp_path, base_mp3):
        # BAIXA com tag existente: *_proposto repete o valor atual (nunca o
        # palpite invertido do nome de arquivo), aceitar continua vazio
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "Florestal - Martonio Holanda.mp3"  # nome invertido
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Florestal", artist="Martonio Holanda")
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher_vazio,
                                 pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert row["titulo_proposto"] == "Florestal"
        assert row["artista_proposto"] == "Martonio Holanda"
        assert row["aceitar"] == ""

    def test_csv_baixa_preenche_so_campo_vazio(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "Hyldon - Musica Bonita.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Musica Bonita")  # artista vazio
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher_vazio,
                                 pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert row["titulo_proposto"] == "Musica Bonita"  # tag preservada
        assert row["artista_proposto"] == "Hyldon"        # vazio: preenche


class TestPlaceholderDoLrclib:
    """Resultados do LRCLIB com trackName OU artistName placeholder são
    descartados ANTES do score: nunca ALTA/MÉDIA, nunca propostos nem
    aplicados (caso real: "AudioTrack 02"/"Cali" com sim 0.90 aplicado
    por cima de um arquivo com tags-lixo)."""

    @pytest.fixture
    def pasta_lixo(self, tmp_path: Path, base_mp3: Path) -> Path:
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "adventício - Cheganca - Antonio Nobrega.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="02 AudioTrack 02", artist="no artist")
        return pasta

    def test_track_name_placeholder_e_descartado_nunca_aplicado(
            self, pasta_lixo, tmp_path, capsys):
        def fetcher(url):
            if "/api/search" in url:
                return json.dumps([resultado(id=13, track="AudioTrack 02",
                                             artist="Cali", duration=2.0)])
            raise AssertionError("url inesperada: " + url)

        saida = tmp_path / "proposta.csv"
        antes = shas_mp3(pasta_lixo)
        curadoria.cmd_enriquecer(pasta_lixo, auto=True, csv_out=saida,
                                 fetcher=fetcher, pausa=0, verboso=True)
        assert shas_mp3(pasta_lixo) == antes  # nada aplicado
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert "AudioTrack" not in row["titulo_proposto"]
        assert row["artista_proposto"] != "Cali"
        assert row["lrclib_id"] == ""
        out = capsys.readouterr().out
        assert "descartado" in out  # verboso relata o descarte

    def test_artist_name_placeholder_tambem_descarta(self, tmp_path,
                                                     base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "barquinha - Princesa Goiana.mp3")

        def fetcher(url):
            if "/api/search" in url:
                return json.dumps([resultado(
                    id=8, track="Faixa 8", artist="Artista Desconhecido",
                    duration=2.0)])
            raise AssertionError("url inesperada: " + url)

        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta, csv_out=saida, fetcher=fetcher,
                                 pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert row["titulo_proposto"] != "Faixa 8"
        assert row["artista_proposto"] != "Artista Desconhecido"
        assert row["lrclib_id"] == ""

    def test_busca_precisa_so_com_placeholder_cai_para_q(self, tmp_path,
                                                         base_mp3):
        # a busca por campo "achou" só lixo: NÃO conta como achado — o
        # fallback q= (e os demais palpites) ainda rodam
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        urls = []

        def fetcher(url):
            urls.append(url)
            if "track_name=" in url:
                return json.dumps([resultado(track="Faixa 1",
                                             artist="[Unknown Artist]")])
            return json.dumps([])

        curadoria.cmd_enriquecer(pasta, fetcher=fetcher, pausa=0)
        assert len(urls) == 5  # mesmas 5 consultas do caso "nada achado"
        assert "q=Oh+Chuva+Falamansa" in urls[1]


class TestPlaceholderNasTags:
    """Tag placeholder é tratada como campo VAZIO em todos os pontos:
    não vira palpite, não bloqueia o preenchimento por proposta BAIXA
    (interativo/auto/csv/aplicar-proposta) e não faz o arquivo ser pulado."""

    @pytest.fixture
    def pasta_sessao(self, tmp_path: Path, base_mp3: Path) -> Path:
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "adventício - Abrir a sessão.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="AudioTrack 17", artist="no artist")
        return pasta

    def test_csv_baixa_propoe_nome_de_arquivo_sobre_placeholder(
            self, pasta_sessao, tmp_path):
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta_sessao, csv_out=saida,
                                 fetcher=fetcher_vazio, pausa=0)
        row = read_csv(saida)[0]
        assert row["confianca"] == "BAIXA"
        assert row["titulo_atual"] == "AudioTrack 17"    # informativo, cru
        assert row["artista_atual"] == "no artist"
        assert row["titulo_proposto"] == "Abrir a sessão"
        assert row["artista_proposto"] == "adventício"

    def test_interativo_a_sobrescreve_tags_placeholder(self, pasta_sessao,
                                                       monkeypatch):
        monkeypatch.setattr("builtins.input", lambda prompt="": "a")
        curadoria.cmd_enriquecer(pasta_sessao, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        alvo = pasta_sessao / "adventício - Abrir a sessão.mp3"
        assert titulo_de(alvo) == "Abrir a sessão"
        assert artista_de(alvo) == "adventício"

    def test_tags_placeholder_com_letra_nao_e_pulado(self, pasta_sessao,
                                                     tmp_path, capsys):
        alvo = pasta_sessao / "adventício - Abrir a sessão.mp3"
        tag(alvo, letra="já tem letra")
        saida = tmp_path / "proposta.csv"
        curadoria.cmd_enriquecer(pasta_sessao, csv_out=saida,
                                 fetcher=fetcher_vazio, pausa=0)
        assert "PULADO" not in capsys.readouterr().out
        assert len(read_csv(saida)) == 1

    def test_aplicar_proposta_baixa_preenche_sobre_placeholder(
            self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Faixa 5", artist="Artista Desconhecido")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3",
                           titulo_proposto="Abrir a sessão",
                           artista_proposto="adventício",
                           confianca="BAIXA", aceitar="SIM"),
        ])
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        assert titulo_de(alvo) == "Abrir a sessão"       # placeholder cedeu
        assert artista_de(alvo) == "adventício"
        out = capsys.readouterr().out
        assert "Resumo: 1 aplicados | 0 pulados | 0 erros de rede" in out


class TestEnriquecerAuto:
    def test_auto_aplica_so_alta(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        shutil.copyfile(base_mp3, pasta / "Zeca - Outra.mp3")

        def fetcher(url):
            if "Chuva" in url:
                return json.dumps([RES_CHUVA])
            return json.dumps([resultado(id=7, track="Outra", artist="Zeca",
                                         duration=12.0)])

        media_antes = sha256(pasta / "Zeca - Outra.mp3")
        curadoria.cmd_enriquecer(pasta, auto=True, fetcher=fetcher, pausa=0)
        alta = pasta / "Falamansa - Oh! Chuva.mp3"
        assert titulo_de(alta) == "Oh! Chuva"
        assert artista_de(alta) == "Falamansa"
        assert uslt_text(alta) == LETRA_LRCLIB
        assert sha256(pasta / "Zeca - Outra.mp3") == media_antes  # intacta
        out = capsys.readouterr().out
        assert "APLICADO: Falamansa - Oh! Chuva.mp3" in out
        assert ("Resumo: 1 confiança alta | 1 média | 0 baixa | "
                "1 aplicados | 0 erros de rede") in out

    def test_auto_soma_temas_de_pasta_aos_existentes(self, tmp_path,
                                                     base_mp3):
        pasta = tmp_path / "acervo"
        (pasta / "cura").mkdir(parents=True)
        alvo = pasta / "cura" / "Falamansa - Oh! Chuva.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, temas=["esperança"])
        curadoria.cmd_enriquecer(pasta, auto=True, fetcher=fetcher_chuva,
                                 pausa=0)
        assert temas_value(alvo) == "cura; esperança"  # soma, não substitui

    def test_auto_preserva_letra_existente_sem_forcar(self, pasta_chuva):
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        tag(alvo, letra="LETRA ANTIGA")  # sem título/artista: não é pulado
        curadoria.cmd_enriquecer(pasta_chuva, auto=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert titulo_de(alvo) == "Oh! Chuva"       # tags aplicadas
        assert uslt_text(alvo) == "LETRA ANTIGA"    # letra intocada

    def test_auto_forcar_sobrescreve_letra(self, pasta_chuva):
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        tag(alvo, letra="LETRA ANTIGA")
        curadoria.cmd_enriquecer(pasta_chuva, auto=True, forcar=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert uslt_text(alvo) == LETRA_LRCLIB


class TestEnriquecerInterativo:
    def test_enter_aceita_e_prompt_do_prd(self, pasta_chuva, monkeypatch,
                                          capsys):
        prompts = []

        def fake_input(prompt=""):
            prompts.append(prompt)
            return ""

        monkeypatch.setattr("builtins.input", fake_input)
        curadoria.cmd_enriquecer(pasta_chuva, interativo=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert len(prompts) == 1
        assert "[Enter] aceitar  [p] pular  [t] só temas  [q] sair" in prompts[0]
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        assert titulo_de(alvo) == "Oh! Chuva"
        assert uslt_text(alvo) == LETRA_LRCLIB
        out = capsys.readouterr().out
        assert "1 aplicados" in out

    def test_p_pula_sem_gravar(self, pasta_chuva, monkeypatch, capsys):
        monkeypatch.setattr("builtins.input", lambda prompt="": "p")
        antes = shas_mp3(pasta_chuva)
        curadoria.cmd_enriquecer(pasta_chuva, interativo=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert shas_mp3(pasta_chuva) == antes
        assert "0 aplicados" in capsys.readouterr().out

    def test_t_grava_so_temas(self, tmp_path, base_mp3, monkeypatch, capsys):
        pasta = tmp_path / "acervo"
        (pasta / "cura").mkdir(parents=True)
        alvo = pasta / "cura" / "Falamansa - Oh! Chuva.mp3"
        shutil.copyfile(base_mp3, alvo)
        monkeypatch.setattr("builtins.input", lambda prompt="": "t")
        curadoria.cmd_enriquecer(pasta, interativo=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert temas_value(alvo) == "cura"
        assert titulo_de(alvo) is None   # título NÃO foi gravado
        assert uslt_text(alvo) is None   # letra NÃO foi gravada
        assert "1 aplicados" in capsys.readouterr().out

    def test_q_interrompe_mas_imprime_resumo(self, tmp_path, base_mp3,
                                             monkeypatch, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Falamansa - Oh! Chuva.mp3")
        shutil.copyfile(base_mp3, pasta / "Zeca - Outra.mp3")
        respostas = iter(["q"])  # segunda chamada estouraria StopIteration
        monkeypatch.setattr("builtins.input",
                            lambda prompt="": next(respostas))
        antes = shas_mp3(pasta)
        curadoria.cmd_enriquecer(pasta, interativo=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert shas_mp3(pasta) == antes
        out = capsys.readouterr().out
        assert "Zeca - Outra.mp3" not in out  # segundo arquivo nem processado
        assert ("Resumo: 1 confiança alta | 0 média | 0 baixa | "
                "0 aplicados | 0 erros de rede") in out


class TestEnriquecerInterativoBaixa:
    @pytest.fixture
    def pasta_baixa(self, tmp_path: Path, base_mp3: Path) -> Path:
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Martonio Holanda - Florestal.mp3")
        return pasta

    def test_baixa_tem_prompt_proprio_e_enter_pula(self, pasta_baixa,
                                                   monkeypatch, capsys):
        prompts = []

        def fake_input(prompt=""):
            prompts.append(prompt)
            return ""  # Enter

        monkeypatch.setattr("builtins.input", fake_input)
        antes = shas_mp3(pasta_baixa)
        curadoria.cmd_enriquecer(pasta_baixa, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        assert len(prompts) == 1
        assert ("[Enter] pular  [a] aceitar  [t] só temas  [q] sair"
                in prompts[0])
        assert shas_mp3(pasta_baixa) == antes  # Enter em BAIXA NÃO grava
        assert "0 aplicados" in capsys.readouterr().out

    def test_baixa_a_aceita_e_preenche_campos_vazios(self, pasta_baixa,
                                                     monkeypatch, capsys):
        monkeypatch.setattr("builtins.input", lambda prompt="": "a")
        curadoria.cmd_enriquecer(pasta_baixa, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        alvo = pasta_baixa / "Martonio Holanda - Florestal.mp3"
        assert titulo_de(alvo) == "Florestal"
        assert artista_de(alvo) == "Martonio Holanda"
        assert "1 aplicados" in capsys.readouterr().out

    def test_baixa_a_nao_sobrescreve_tags_existentes(self, tmp_path, base_mp3,
                                                     monkeypatch, capsys):
        # cenário do teste real: TIT2/TPE1 corretos, nome de arquivo invertido
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "Florestal - Martonio Holanda.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Florestal", artist="Martonio Holanda")
        monkeypatch.setattr("builtins.input", lambda prompt="": "a")
        curadoria.cmd_enriquecer(pasta, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        assert titulo_de(alvo) == "Florestal"            # intocado
        assert artista_de(alvo) == "Martonio Holanda"    # intocado

    def test_baixa_a_preenche_so_artista_vazio(self, tmp_path, base_mp3,
                                               monkeypatch):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "Hyldon - Musica Bonita.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Hyldon - Musica Bonita")  # artista vazio
        monkeypatch.setattr("builtins.input", lambda prompt="": "a")
        curadoria.cmd_enriquecer(pasta, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        assert titulo_de(alvo) == "Hyldon - Musica Bonita"  # não sobrescreve
        assert artista_de(alvo) == "Hyldon"                 # vazio: preenche

    def test_baixa_q_sai(self, pasta_baixa, monkeypatch, capsys):
        monkeypatch.setattr("builtins.input", lambda prompt="": "q")
        antes = shas_mp3(pasta_baixa)
        curadoria.cmd_enriquecer(pasta_baixa, interativo=True,
                                 fetcher=fetcher_vazio, pausa=0)
        assert shas_mp3(pasta_baixa) == antes
        out = capsys.readouterr().out
        assert ("Resumo: 0 confiança alta | 0 média | 1 baixa | "
                "0 aplicados | 0 erros de rede") in out

    def test_alta_mantem_enter_aceita(self, pasta_chuva, monkeypatch):
        prompts = []

        def fake_input(prompt=""):
            prompts.append(prompt)
            return ""

        monkeypatch.setattr("builtins.input", fake_input)
        curadoria.cmd_enriquecer(pasta_chuva, interativo=True,
                                 fetcher=fetcher_chuva, pausa=0)
        assert ("[Enter] aceitar  [p] pular  [t] só temas  [q] sair"
                in prompts[0])
        alvo = pasta_chuva / "Falamansa - Oh! Chuva.mp3"
        assert titulo_de(alvo) == "Oh! Chuva"


class TestVerboso:
    def test_verboso_imprime_busca_resultados_e_melhor(self, pasta_chuva,
                                                       capsys):
        curadoria.cmd_enriquecer(pasta_chuva, fetcher=fetcher_chuva, pausa=0,
                                 verboso=True)
        out = capsys.readouterr().out
        assert '  busca: track="Oh! Chuva" artista="Falamansa"' in out
        assert "  1 resultados" in out
        assert '  melhor: "Oh! Chuva" / "Falamansa" (sim 1.00, dur mp3 ' in out
        assert "s vs 2s)" in out

    def test_verboso_zero_resultados_e_q_limpo(self, tmp_path, base_mp3,
                                               capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Hyldon - Musica Bonita.mp3")
        curadoria.cmd_enriquecer(pasta, fetcher=fetcher_vazio, pausa=0,
                                 verboso=True)
        out = capsys.readouterr().out
        assert '  busca: track="Musica Bonita" artista="Hyldon"' in out
        assert '  busca: "Musica Bonita Hyldon"' in out   # fallback q limpo
        assert '  busca: "Hyldon Musica Bonita"' in out   # nome inteiro limpo
        assert "  0 resultados" in out

    def test_verboso_imprime_erro_da_busca(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Qualquer.mp3")

        def caiu(url):
            raise urllib.error.URLError("caiu na rede")

        curadoria.cmd_enriquecer(pasta, fetcher=caiu, pausa=0, verboso=True)
        out = capsys.readouterr().out
        assert "  erro: " in out
        assert "caiu na rede" in out
        assert "ERRO DE REDE: Qualquer.mp3" in out

    def test_sem_verboso_nao_imprime_busca(self, pasta_chuva, capsys):
        curadoria.cmd_enriquecer(pasta_chuva, fetcher=fetcher_chuva, pausa=0)
        out = capsys.readouterr().out
        assert "  busca:" not in out
        assert "  melhor:" not in out

    def test_cli_aceita_flag_verboso(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "completa.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Completa", artist="Coral", letra="tem letra")
        result = run_curadoria("enriquecer", pasta, "--verboso")
        assert result.returncode == 0, result.stderr
        assert "PULADO: completa.mp3" in result.stdout


class TestPausaEntreBuscas:
    def test_pausa_padrao_de_0_3s_entre_buscas(self, tmp_path, base_mp3,
                                               monkeypatch, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Primeira.mp3")
        shutil.copyfile(base_mp3, pasta / "Segunda.mp3")
        dormidas = []
        monkeypatch.setattr(curadoria.time, "sleep",
                            lambda s: dormidas.append(s))
        curadoria.cmd_enriquecer(pasta, fetcher=fetcher_vazio)  # pausa padrão
        assert dormidas == [0.3]  # 2 buscas -> 1 pausa entre elas

    def test_pausa_zero_nao_dorme(self, tmp_path, base_mp3, monkeypatch,
                                  capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "Primeira.mp3")
        shutil.copyfile(base_mp3, pasta / "Segunda.mp3")
        dormidas = []
        monkeypatch.setattr(curadoria.time, "sleep",
                            lambda s: dormidas.append(s))
        curadoria.cmd_enriquecer(pasta, fetcher=fetcher_vazio, pausa=0)
        assert dormidas == []


# ---------------------------------------------------------------- temas-de-pastas

@pytest.fixture
def pasta_temas(tmp_path: Path, base_mp3: Path) -> Path:
    pasta = tmp_path / "acervo"
    (pasta / "cura" / "aniversário").mkdir(parents=True)
    shutil.copyfile(base_mp3, pasta / "raiz.mp3")
    tag(pasta / "raiz.mp3", temas=["esperança"])
    shutil.copyfile(base_mp3, pasta / "cura" / "x.mp3")
    shutil.copyfile(base_mp3, pasta / "cura" / "aniversário" / "y.mp3")
    ja_tem = pasta / "cura" / "ja_tem.mp3"
    shutil.copyfile(base_mp3, ja_tem)
    tag(ja_tem, temas=["cura", "fé"])
    return pasta


class TestTemasDePastas:
    def test_sem_aplicar_so_mostra(self, pasta_temas, capsys):
        antes = shas_mp3(pasta_temas)
        curadoria.cmd_temas_de_pastas(pasta_temas)
        assert shas_mp3(pasta_temas) == antes  # nada gravado
        out = capsys.readouterr().out
        assert "TEMAS: cura/x.mp3 + cura" in out
        assert "TEMAS: cura/aniversário/y.mp3 + aniversário; cura" in out
        assert "ja_tem.mp3" not in out   # já tem "cura": nada novo
        assert "raiz.mp3" not in out     # raiz não ganha tema de pasta
        assert "Resumo: 2 arquivos com temas novos | 0 aplicados" in out

    def test_aplicar_soma_e_preserva(self, pasta_temas, capsys):
        curadoria.cmd_temas_de_pastas(pasta_temas, aplicar=True)
        assert temas_value(pasta_temas / "cura" / "x.mp3") == "cura"
        assert (temas_value(pasta_temas / "cura" / "aniversário" / "y.mp3")
                == "aniversário; cura")
        assert temas_value(pasta_temas / "cura" / "ja_tem.mp3") == "cura; fé"
        assert temas_value(pasta_temas / "raiz.mp3") == "esperança"
        out = capsys.readouterr().out
        assert "Resumo: 2 arquivos com temas novos | 2 aplicados" in out

    def test_cli_temas_de_pastas(self, pasta_temas):
        result = run_curadoria("temas-de-pastas", pasta_temas, "--aplicar")
        assert result.returncode == 0, result.stderr
        assert ("Resumo: 2 arquivos com temas novos | 2 aplicados"
                in result.stdout)
        assert temas_value(pasta_temas / "cura" / "x.mp3") == "cura"

    def test_cli_pasta_inexistente(self, tmp_path):
        alvo = tmp_path / "nada"
        result = run_curadoria("temas-de-pastas", alvo)
        assert result.returncode == 1
        assert f"ERRO: pasta inválida: {alvo}" in result.stderr


# ---------------------------------------------------------------- aplicar-proposta

class TestAplicarProposta:
    def test_aplica_so_aceitar_sim(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        shutil.copyfile(base_mp3, pasta / "b.mp3")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="Oh! Chuva",
                           artista_proposto="Falamansa",
                           temas_propostos="cura", lrclib_id="42",
                           letra="SIM", confianca="ALTA", aceitar="SIM"),
            linha_proposta(arquivo="b.mp3", titulo_proposto="Não Vai",
                           artista_proposto="Ninguém", lrclib_id="43",
                           confianca="MÉDIA", aceitar=""),
        ])
        b_antes = sha256(pasta / "b.mp3")
        chamadas = []

        def fetcher(url):
            chamadas.append(url)
            return json.dumps(RES_CHUVA)

        curadoria.cmd_aplicar_proposta(pasta, proposta, fetcher=fetcher,
                                       pausa=0)
        assert chamadas == ["https://lrclib.net/api/get/42"]
        a = pasta / "a.mp3"
        assert titulo_de(a) == "Oh! Chuva"
        assert artista_de(a) == "Falamansa"
        assert uslt_text(a) == LETRA_LRCLIB
        assert temas_value(a) == "cura"
        assert sha256(pasta / "b.mp3") == b_antes  # aceitar vazio: intacto
        out = capsys.readouterr().out
        linha = next(l for l in out.splitlines() if l.startswith("OK:"))
        assert "a.mp3" in linha
        for campo in ("titulo", "artista", "temas", "letra"):
            assert campo in linha
        assert "Resumo: 1 aplicados | 1 pulados | 0 erros de rede" in out

    def test_temas_somam_aos_existentes(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, temas=["esperança"])
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", temas_propostos="cura",
                           aceitar="SIM"),
        ])
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        assert temas_value(alvo) == "cura; esperança"

    def test_dry_run_bytes_identicos_e_sem_rede(self, tmp_path, base_mp3,
                                                capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="Oh! Chuva",
                           artista_proposto="Falamansa", lrclib_id="42",
                           letra="SIM", aceitar="SIM"),
        ])
        chamadas = []

        def fetcher(url):
            chamadas.append(url)
            return json.dumps(RES_CHUVA)

        antes = shas_mp3(pasta)
        curadoria.cmd_aplicar_proposta(pasta, proposta, dry_run=True,
                                       fetcher=fetcher, pausa=0)
        assert shas_mp3(pasta) == antes  # nenhum byte alterado
        assert chamadas == []            # dry-run nem consulta a rede
        out = capsys.readouterr().out
        assert "OK: a.mp3" in out        # ainda relata o que faria
        assert "letra" in out
        assert "Resumo: 1 aplicados | 0 pulados | 0 erros de rede" in out

    def test_letra_existente_preservada_sem_forcar(self, tmp_path, base_mp3,
                                                   capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, letra="LETRA ANTIGA")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="Oh! Chuva",
                           lrclib_id="42", letra="SIM", aceitar="SIM"),
        ])
        chamadas = []

        def fetcher(url):
            chamadas.append(url)
            return json.dumps(RES_CHUVA)

        curadoria.cmd_aplicar_proposta(pasta, proposta, fetcher=fetcher,
                                       pausa=0)
        assert chamadas == []                    # nem busca a letra
        assert uslt_text(alvo) == "LETRA ANTIGA"  # letra intocada
        assert titulo_de(alvo) == "Oh! Chuva"     # título aplicado

    def test_forcar_sobrescreve_letra(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, letra="LETRA ANTIGA")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", lrclib_id="42", letra="SIM",
                           aceitar="SIM"),
        ])

        def fetcher(url):
            return json.dumps(RES_CHUVA)

        curadoria.cmd_aplicar_proposta(pasta, proposta, forcar=True,
                                       fetcher=fetcher, pausa=0)
        assert uslt_text(alvo) == LETRA_LRCLIB

    def test_erro_de_rede_nao_aborta_o_lote(self, tmp_path, base_mp3, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        shutil.copyfile(base_mp3, pasta / "b.mp3")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="X",
                           lrclib_id="42", letra="SIM", aceitar="SIM"),
            linha_proposta(arquivo="b.mp3", titulo_proposto="Oh! Chuva",
                           lrclib_id="43", letra="SIM", aceitar="SIM"),
        ])

        def fetcher(url):
            if url.endswith("/42"):
                raise urllib.error.URLError("caiu")
            return json.dumps(RES_CHUVA)

        curadoria.cmd_aplicar_proposta(pasta, proposta, fetcher=fetcher,
                                       pausa=0)
        out = capsys.readouterr().out
        assert "ERRO DE REDE: a.mp3" in out
        assert titulo_de(pasta / "a.mp3") is None      # nada aplicado no erro
        assert titulo_de(pasta / "b.mp3") == "Oh! Chuva"  # lote continuou
        assert "Resumo: 1 aplicados | 0 pulados | 1 erros de rede" in out

    def test_baixa_nao_sobrescreve_tags_existentes(self, tmp_path, base_mp3,
                                                   capsys):
        # linha BAIXA com aceitar=SIM (editada à mão): só PREENCHE vazios
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Florestal")  # artista vazio
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3",
                           titulo_proposto="Martonio Holanda",  # invertido
                           artista_proposto="Martonio Holanda",
                           confianca="BAIXA", aceitar="SIM"),
        ])
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        assert titulo_de(alvo) == "Florestal"           # tag preservada
        assert artista_de(alvo) == "Martonio Holanda"   # vazio: preenchido
        out = capsys.readouterr().out
        assert "Resumo: 1 aplicados | 0 pulados | 0 erros de rede" in out

    def test_baixa_com_tudo_preenchido_e_pulada(self, tmp_path, base_mp3,
                                                capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Florestal", artist="Martonio Holanda")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="Outro",
                           artista_proposto="Alguém",
                           confianca="BAIXA", aceitar="SIM"),
        ])
        antes = sha256(alvo)
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        assert sha256(alvo) == antes  # nenhum byte alterado
        out = capsys.readouterr().out
        assert "Resumo: 0 aplicados | 1 pulados | 0 erros de rede" in out

    def test_media_continua_podendo_sobrescrever(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "a.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Errado")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="Certo",
                           confianca="MÉDIA", aceitar="SIM"),
        ])
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        assert titulo_de(alvo) == "Certo"

    def test_arquivo_inexistente_avisa_e_continua(self, tmp_path, base_mp3,
                                                  capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="fantasma.mp3", titulo_proposto="X",
                           aceitar="SIM"),
            linha_proposta(arquivo="a.mp3", titulo_proposto="Depois",
                           aceitar="SIM"),
        ])
        curadoria.cmd_aplicar_proposta(pasta, proposta, pausa=0)
        out = capsys.readouterr().out
        assert "AVISO: arquivo não encontrado: fantasma.mp3" in out
        assert titulo_de(pasta / "a.mp3") == "Depois"
        assert "Resumo: 1 aplicados | 1 pulados | 0 erros de rede" in out


# ---------------------------------------------------------------- CLI

class TestCli:
    def test_enriquecer_pasta_inexistente(self, tmp_path):
        alvo = tmp_path / "nada"
        result = run_curadoria("enriquecer", alvo)
        assert result.returncode == 1
        assert f"ERRO: pasta inválida: {alvo}" in result.stderr

    def test_enriquecer_completos_nao_usa_rede(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "completa.mp3"
        shutil.copyfile(base_mp3, alvo)
        tag(alvo, title="Completa", artist="Coral", letra="tem letra")
        result = run_curadoria("enriquecer", pasta)
        assert result.returncode == 0, result.stderr
        assert "PULADO: completa.mp3" in result.stdout
        assert ("Resumo: 0 confiança alta | 0 média | 0 baixa | "
                "0 aplicados | 0 erros de rede") in result.stdout

    def test_enriquecer_auto_e_interativo_conflitam(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        result = run_curadoria("enriquecer", pasta, "--auto", "--interativo")
        assert result.returncode == 2  # argparse: opções mutuamente exclusivas

    def test_aplicar_proposta_dry_run(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        proposta = tmp_path / "proposta.csv"
        write_proposta(proposta, [
            linha_proposta(arquivo="a.mp3", titulo_proposto="X",
                           aceitar="SIM"),
        ])
        antes = shas_mp3(pasta)
        result = run_curadoria("aplicar-proposta", pasta, "--csv", proposta,
                               "--dry-run")
        assert result.returncode == 0, result.stderr
        assert shas_mp3(pasta) == antes
        assert "Resumo: 1 aplicados | 0 pulados | 0 erros de rede" \
            in result.stdout

    def test_aplicar_proposta_csv_inexistente(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        sumido = tmp_path / "sumido.csv"
        result = run_curadoria("aplicar-proposta", pasta, "--csv", sumido)
        assert result.returncode == 1
        assert f"ERRO: CSV inválido ou não encontrado: {sumido}" \
            in result.stderr
