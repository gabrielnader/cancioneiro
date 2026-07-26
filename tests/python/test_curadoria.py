# -*- coding: utf-8 -*-
"""Testes do CLI de curadoria em massa (tools/curadoria.py) — V2.

Escritos antes da implementacao (TDD). NENHUM teste usa rede: o fetch do
LRCLIB e injetavel (fetcher) e mockado com stubs locais.
"""
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TXXX, USLT, Encoding

from conftest import TOOLS_DIR, make_mp3

CURADORIA = TOOLS_DIR / "curadoria.py"

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402

LETRA_RAIZ = "Quando o sol amanhecer\nMeu coração vai cantar"


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


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv(path: Path, rows: list[dict]) -> None:
    cols = ["arquivo", "titulo", "artista", "tem_letra", "temas", "letra_arquivo"]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=cols)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um unico MP3 limpo por modulo; os testes copiam os bytes (rapido)."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def acervo(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com 3 MP3s: com tudo, sem tags (.MP3 em subpasta), sem letra."""
    pasta = tmp_path / "acervo"
    (pasta / "sub").mkdir(parents=True)
    raiz = pasta / "raiz.mp3"
    shutil.copyfile(base_mp3, raiz)
    tag(raiz, title="Amanhecer", artist="Coral",
        letra=LETRA_RAIZ, temas=["água", "esperança"])
    shutil.copyfile(base_mp3, pasta / "sub" / "aninhada.MP3")  # sem tags
    sem_letra = pasta / "sem_letra.mp3"
    shutil.copyfile(base_mp3, sem_letra)
    tag(sem_letra, title="Água Viva", artist="Coral Novo")
    return pasta


# ---------------------------------------------------------------- relatorio

class TestRelatorio:
    def test_recursivo_e_case_insensitive(self, acervo):
        result = run_curadoria("relatorio", acervo)
        assert result.returncode == 0, result.stderr
        assert "raiz.mp3" in result.stdout
        assert "sub/aninhada.MP3" in result.stdout  # subpasta + extensao maiuscula
        assert "sem_letra.mp3" in result.stdout

    def test_linha_mostra_titulo_artista_letra_temas(self, acervo):
        result = run_curadoria("relatorio", acervo)
        assert result.returncode == 0, result.stderr
        linha = next(l for l in result.stdout.splitlines() if "raiz.mp3" in l)
        assert "Amanhecer" in linha
        assert "Coral" in linha
        assert "SIM" in linha
        assert "água; esperança" in linha

    def test_ausentes_viram_travessao(self, acervo):
        result = run_curadoria("relatorio", acervo)
        linha = next(l for l in result.stdout.splitlines()
                     if "aninhada.MP3" in l)
        assert "—" in linha
        assert "NÃO" in linha

    def test_resumo_exato(self, acervo):
        result = run_curadoria("relatorio", acervo)
        assert ("Resumo: 3 arquivos | 1 com letra | 2 sem letra | 1 com temas"
                in result.stdout)

    def test_csv_utf8_bom_e_colunas(self, acervo, tmp_path):
        saida = tmp_path / "plano.csv"
        result = run_curadoria("relatorio", acervo, "--csv", saida)
        assert result.returncode == 0, result.stderr
        assert saida.read_bytes().startswith(b"\xef\xbb\xbf")  # BOM p/ Excel
        rows = read_csv(saida)
        assert list(rows[0].keys()) == ["arquivo", "titulo", "artista",
                                        "tem_letra", "temas", "letra_arquivo"]
        por_arquivo = {r["arquivo"]: r for r in rows}
        raiz = por_arquivo["raiz.mp3"]
        assert raiz["titulo"] == "Amanhecer"
        assert raiz["artista"] == "Coral"
        assert raiz["tem_letra"] == "SIM"
        assert raiz["temas"] == "água; esperança"
        assert raiz["letra_arquivo"] == ""  # sempre vazia: usuario preenche
        aninhada = por_arquivo["sub/aninhada.MP3"]
        assert aninhada["titulo"] == ""
        assert aninhada["tem_letra"] == "NÃO"
        assert all(r["letra_arquivo"] == "" for r in rows)

    def test_corrompido_nao_aborta(self, acervo):
        (acervo / "quebrado.mp3").write_bytes(b"isto nao e um mp3 de verdade" * 40)
        result = run_curadoria("relatorio", acervo)
        assert result.returncode == 0, result.stderr
        linha = next(l for l in result.stdout.splitlines() if "quebrado.mp3" in l)
        assert "(ilegível)" in linha
        assert "raiz.mp3" in result.stdout  # os demais seguem listados
        assert ("Resumo: 4 arquivos | 1 com letra | 3 sem letra | 1 com temas"
                in result.stdout)

    def test_pasta_inexistente(self, tmp_path):
        alvo = tmp_path / "nao_existe"
        result = run_curadoria("relatorio", alvo)
        assert result.returncode == 1
        assert f"ERRO: pasta inválida: {alvo}" in result.stderr


# ---------------------------------------------------------------- aplicar

class TestAplicar:
    def test_grava_titulo_artista_temas_e_letra(self, acervo, tmp_path):
        letra_txt = tmp_path / "letra_nova.txt"
        letra_txt.write_text("Nova letra\ncom acentuação", encoding="utf-8")
        plano = tmp_path / "plano.csv"
        write_csv(plano, [{
            "arquivo": "sub/aninhada.MP3", "titulo": "Nova Canção",
            "artista": "Grupo Vida", "tem_letra": "NÃO",
            "temas": "Fé, Água", "letra_arquivo": "letra_nova.txt",
        }])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        alvo = acervo / "sub" / "aninhada.MP3"
        assert titulo_de(alvo) == "Nova Canção"
        assert artista_de(alvo) == "Grupo Vida"
        assert temas_value(alvo) == "água; fé"  # normalizado via embed_lyrics
        assert uslt_text(alvo) == "Nova letra\ncom acentuação"
        linha = next(l for l in result.stdout.splitlines()
                     if l.startswith("OK:"))
        assert "sub/aninhada.MP3" in linha
        for campo in ("titulo", "artista", "temas", "letra"):
            assert campo in linha

    def test_campos_vazios_nao_mexe(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        write_csv(plano, [{
            "arquivo": "raiz.mp3", "titulo": "Outro Título", "artista": "",
            "tem_letra": "SIM", "temas": "", "letra_arquivo": "",
        }])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        alvo = acervo / "raiz.mp3"
        assert titulo_de(alvo) == "Outro Título"          # mudou
        assert artista_de(alvo) == "Coral"                # intacto
        assert uslt_text(alvo) == LETRA_RAIZ              # intacta
        assert temas_value(alvo) == "água; esperança"     # intactos
        linha = next(l for l in result.stdout.splitlines()
                     if l.startswith("OK:"))
        assert "titulo" in linha
        assert "letra" not in linha
        assert "temas" not in linha

    def test_temas_com_ponto_e_virgula(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        write_csv(plano, [{
            "arquivo": "sem_letra.mp3", "titulo": "", "artista": "",
            "tem_letra": "", "temas": "Cura; cura ; Água", "letra_arquivo": "",
        }])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        assert temas_value(acervo / "sem_letra.mp3") == "água; cura"

    def test_letra_arquivo_caminho_absoluto(self, acervo, tmp_path):
        letra_txt = tmp_path / "outra_pasta" / "letra.txt"
        letra_txt.parent.mkdir()
        letra_txt.write_text("Letra por caminho absoluto", encoding="utf-8")
        plano = tmp_path / "plano.csv"
        write_csv(plano, [{
            "arquivo": "sem_letra.mp3", "titulo": "", "artista": "",
            "tem_letra": "", "temas": "", "letra_arquivo": str(letra_txt),
        }])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        assert uslt_text(acervo / "sem_letra.mp3") == "Letra por caminho absoluto"

    def test_arquivo_inexistente_avisa_e_continua(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        write_csv(plano, [
            {"arquivo": "fantasma.mp3", "titulo": "X", "artista": "",
             "tem_letra": "", "temas": "", "letra_arquivo": ""},
            {"arquivo": "sem_letra.mp3", "titulo": "Depois do Aviso",
             "artista": "", "tem_letra": "", "temas": "", "letra_arquivo": ""},
        ])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        assert "AVISO: arquivo não encontrado: fantasma.mp3" in result.stdout
        assert titulo_de(acervo / "sem_letra.mp3") == "Depois do Aviso"

    def test_resumo_exato(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        write_csv(plano, [
            {"arquivo": "raiz.mp3", "titulo": "Novo", "artista": "",
             "tem_letra": "", "temas": "", "letra_arquivo": ""},
            {"arquivo": "sem_letra.mp3", "titulo": "", "artista": "",
             "tem_letra": "", "temas": "", "letra_arquivo": ""},
            {"arquivo": "fantasma.mp3", "titulo": "X", "artista": "",
             "tem_letra": "", "temas": "", "letra_arquivo": ""},
        ])
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        assert "Resumo: 1 alterados | 1 sem mudanças | 1 avisos" in result.stdout

    def test_dry_run_bytes_identicos(self, acervo, tmp_path):
        letra_txt = tmp_path / "letra.txt"
        letra_txt.write_text("Não deve ser gravada", encoding="utf-8")
        plano = tmp_path / "plano.csv"
        write_csv(plano, [{
            "arquivo": "raiz.mp3", "titulo": "Mudança Total",
            "artista": "Outro", "tem_letra": "", "temas": "novo tema",
            "letra_arquivo": "letra.txt",
        }])
        antes = {p: sha256(p) for p in acervo.rglob("*")
                 if p.is_file() and p.suffix.lower() == ".mp3"}
        result = run_curadoria("aplicar", acervo, "--csv", plano, "--dry-run")
        assert result.returncode == 0, result.stderr
        depois = {p: sha256(p) for p in acervo.rglob("*")
                  if p.is_file() and p.suffix.lower() == ".mp3"}
        assert antes == depois  # nenhum byte alterado
        assert "raiz.mp3" in result.stdout  # ainda relata o que faria
        assert "Resumo: 1 alterados | 0 sem mudanças | 0 avisos" in result.stdout

    def test_pasta_inexistente(self, tmp_path):
        plano = tmp_path / "plano.csv"
        write_csv(plano, [])
        alvo = tmp_path / "nada"
        result = run_curadoria("aplicar", alvo, "--csv", plano)
        assert result.returncode == 1
        assert f"ERRO: pasta inválida: {alvo}" in result.stderr

    def test_roundtrip_relatorio_editar_aplicar(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        result = run_curadoria("relatorio", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        rows = read_csv(plano)
        letra_txt = tmp_path / "aninhada.txt"
        letra_txt.write_text("Letra vinda do fluxo CSV", encoding="utf-8")
        for row in rows:
            if row["arquivo"] == "sub/aninhada.MP3":
                row["titulo"] = "Aninhada Editada"
                row["temas"] = "ceia, gratidão"
                row["letra_arquivo"] = "aninhada.txt"
        write_csv(plano, rows)
        result = run_curadoria("aplicar", acervo, "--csv", plano)
        assert result.returncode == 0, result.stderr
        alvo = acervo / "sub" / "aninhada.MP3"
        assert titulo_de(alvo) == "Aninhada Editada"
        assert temas_value(alvo) == "ceia; gratidão"
        assert uslt_text(alvo) == "Letra vinda do fluxo CSV"
        # linhas nao editadas re-gravam os mesmos valores sem perder nada
        assert uslt_text(acervo / "raiz.mp3") == LETRA_RAIZ
        assert temas_value(acervo / "raiz.mp3") == "água; esperança"


# ---------------------------------------------------------------- buscar-letra

LETRA_LRCLIB = "Letra vinda do LRCLIB\nSegunda linha à toa"


def fetcher_ok(url: str) -> str:
    return json.dumps({"plainLyrics": LETRA_LRCLIB, "syncedLyrics": None})


def fetcher_404(url: str) -> str:
    raise urllib.error.HTTPError(url, 404, "Not Found", None, None)


def fetcher_rede_caida(url: str) -> str:
    raise urllib.error.URLError("rede indisponível")


class TestFetchLyrics:
    def test_monta_url_com_parametros_escapados(self):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps({"plainLyrics": "x"})

        letra = curadoria.fetch_lyrics("Coral Novo", "Água Viva",
                                       fetcher=espiao)
        assert letra == "x"
        assert len(urls) == 1
        assert urls[0].startswith("https://lrclib.net/api/get?")
        assert "artist_name=Coral+Novo" in urls[0]
        assert "track_name=%C3%81gua+Viva" in urls[0]

    def test_404_vira_none(self):
        assert curadoria.fetch_lyrics("A", "B", fetcher=fetcher_404) is None

    def test_plain_lyrics_vazia_vira_none(self):
        def instrumental(url):
            return json.dumps({"plainLyrics": None, "instrumental": True})
        assert curadoria.fetch_lyrics("A", "B", fetcher=instrumental) is None

    def test_erro_de_rede_propaga(self):
        with pytest.raises(urllib.error.URLError):
            curadoria.fetch_lyrics("A", "B", fetcher=fetcher_rede_caida)


class TestBuscarLetra:
    def test_so_consulta_sem_letra_com_titulo_e_artista(self, acervo, capsys):
        chamadas = []

        def espiao(url):
            chamadas.append(url)
            return fetcher_ok(url)

        curadoria.cmd_buscar_letra(acervo, fetcher=espiao)
        # raiz.mp3 ja tem letra; aninhada.MP3 nao tem titulo/artista:
        # somente sem_letra.mp3 (Água Viva / Coral Novo) e consultada.
        assert len(chamadas) == 1
        assert "Coral+Novo" in chamadas[0]

    def test_relata_sem_gravar_por_padrao(self, acervo, capsys):
        curadoria.cmd_buscar_letra(acervo, fetcher=fetcher_ok)
        out = capsys.readouterr().out
        n = len(LETRA_LRCLIB)
        assert f"ENCONTRADA: sem_letra.mp3 ({n} caracteres)" in out
        assert uslt_text(acervo / "sem_letra.mp3") is None  # nada gravado
        assert ("Resumo: 1 encontradas | 0 não encontradas | 0 erros de rede"
                in out)

    def test_aplicar_grava_uslt(self, acervo, capsys):
        curadoria.cmd_buscar_letra(acervo, aplicar=True, fetcher=fetcher_ok)
        assert uslt_text(acervo / "sem_letra.mp3") == LETRA_LRCLIB

    def test_404_nao_encontrada(self, acervo, capsys):
        curadoria.cmd_buscar_letra(acervo, fetcher=fetcher_404)
        out = capsys.readouterr().out
        assert "NÃO ENCONTRADA: sem_letra.mp3" in out
        assert ("Resumo: 0 encontradas | 1 não encontradas | 0 erros de rede"
                in out)

    def test_erro_de_rede_nao_aborta_o_lote(self, acervo, base_mp3, capsys):
        outra = acervo / "aaa_primeira.mp3"  # ordena antes de sem_letra.mp3
        shutil.copyfile(base_mp3, outra)
        tag(outra, title="Primeira", artist="Alguém")

        def fetcher(url):
            if "Primeira" in url:
                raise urllib.error.URLError("caiu")
            return fetcher_ok(url)

        curadoria.cmd_buscar_letra(acervo, fetcher=fetcher)
        out = capsys.readouterr().out
        assert "ERRO DE REDE: aaa_primeira.mp3" in out
        assert "ENCONTRADA: sem_letra.mp3" in out  # lote continuou
        assert ("Resumo: 1 encontradas | 0 não encontradas | 1 erros de rede"
                in out)

    def test_csv_de_saida(self, acervo, tmp_path, capsys):
        saida = tmp_path / "busca.csv"
        curadoria.cmd_buscar_letra(acervo, csv_out=saida, fetcher=fetcher_ok)
        rows = read_csv(saida)
        assert list(rows[0].keys()) == ["arquivo", "titulo", "artista",
                                        "status", "caracteres"]
        assert rows[0]["arquivo"] == "sem_letra.mp3"
        assert rows[0]["titulo"] == "Água Viva"
        assert rows[0]["artista"] == "Coral Novo"
        assert rows[0]["status"] == "encontrada"
        assert rows[0]["caracteres"] == str(len(LETRA_LRCLIB))

    def test_cli_sem_candidatos_nao_usa_rede(self, tmp_path, base_mp3):
        pasta = tmp_path / "so_sem_tags"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "sem_tags.mp3")  # sem titulo/artista
        result = run_curadoria("buscar-letra", pasta)
        assert result.returncode == 0, result.stderr
        assert ("Resumo: 0 encontradas | 0 não encontradas | 0 erros de rede"
                in result.stdout)

    def test_pasta_inexistente(self, tmp_path):
        alvo = tmp_path / "nada"
        result = run_curadoria("buscar-letra", alvo)
        assert result.returncode == 1
        assert f"ERRO: pasta inválida: {alvo}" in result.stderr
