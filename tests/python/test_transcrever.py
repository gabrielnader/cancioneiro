# -*- coding: utf-8 -*-
"""Testes da F14 (PRD V5): transcrição local de áudio no curadoria.py.

Escritos antes da implementação (TDD). NENHUM teste usa rede NEM modelo:
o transcritor é injetável (mesmo padrão do fetcher do LRCLIB) e sempre um
stub local; o LRCLIB é mockado por fetcher; a pausa de cortesia é zerada
(pausa=0). A suíte roda sem faster-whisper instalado — que é exatamente o
cenário do CI e do container de desenvolvimento.
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
EMBED = TOOLS_DIR / "embed_lyrics.py"

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402
import embed_lyrics as el  # noqa: E402

TRECHO_REFRAO = (
    "Me apresento, me apresento\n"
    "Sou filho da natureza\n"
    "Me apresento!\n"
    "ME APRESENTO\n"
)
TEXTO_COMPLETO = (
    "Me apresento, me apresento\n"
    "Sou filho da natureza\n"
    "Nas ondas do mar sagrado\n"
    "Me apresento outra vez\n"
)
LETRA_OFICIAL = "Me apresento\nEu venho da beira do mar"

TRANSCREVER_COLS = ["arquivo", "acao", "titulo", "artista", "candidatos",
                    "caracteres", "detalhe"]


# ---------------------------------------------------------------- helpers

def run_curadoria(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CURADORIA), *[str(a) for a in args]],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def run_embed(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(EMBED), *[str(a) for a in args]],
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


class FakeTranscritor:
    """Stub do transcritor: registra as chamadas e devolve texto fixo.

    Assinatura igual à real: (caminho, inicio, duracao) -> texto. Chamada
    com duracao != None é o TRECHO de identificação; sem duração é a
    transcrição completa.
    """

    def __init__(self, trecho=TRECHO_REFRAO, completo=TEXTO_COMPLETO,
                 erro=None, erro_em=None):
        self.trecho = trecho
        self.completo = completo
        self.erro = erro
        self.erro_em = erro_em  # nome de arquivo que dispara o erro
        self.chamadas = []

    def __call__(self, caminho, inicio=None, duracao=None):
        nome = Path(caminho).name
        self.chamadas.append((nome, inicio, duracao))
        if self.erro is not None and (self.erro_em is None
                                      or self.erro_em == nome):
            raise self.erro
        return self.trecho if duracao is not None else self.completo

    @property
    def trechos(self):
        return [c for c in self.chamadas if c[2] is not None]

    @property
    def completos(self):
        return [c for c in self.chamadas if c[2] is None]


def resultado(id=7, track="Me Apresento", artist="Barquinha", duration=2.0,
              letra=LETRA_OFICIAL) -> dict:
    return {"id": id, "trackName": track, "artistName": artist,
            "duration": duration, "plainLyrics": letra}


def fetcher_vazio(url: str) -> str:
    if "/api/search" in url:
        return json.dumps([])
    raise AssertionError("url inesperada: " + url)


def fetcher_apresento(url: str) -> str:
    if "/api/search" in url:
        return json.dumps([resultado()])
    raise AssertionError("url inesperada: " + url)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um único MP3 limpo por módulo (~1,5 s); os testes copiam os bytes."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def pasta(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com um MP3 sem letra e com nome que não identifica nada."""
    p = tmp_path / "acervo"
    p.mkdir()
    shutil.copyfile(base_mp3, p / "Faixa 5.mp3")
    return p


# ------------------------------------------------- extração de candidatos

class TestExtrairCandidatos:
    def test_linha_mais_repetida_vem_primeiro(self):
        texto = ("Sou filho da natureza\n"
                 "Me apresento\nMe apresento\nMe apresento\n"
                 "Nas ondas do mar\nNas ondas do mar\n")
        assert curadoria.extrair_candidatos(texto)[0] == "me apresento"

    def test_ignora_pontuacao_caixa_e_acento(self):
        texto = ("Me apresento!\nME APRESENTO,\nme apresentó\n"
                 "outra coisa qualquer\n")
        candidatos = curadoria.extrair_candidatos(texto)
        assert candidatos[0] == "me apresento"
        # as três variantes contam como a MESMA linha (chave normalizada)
        assert "me apresentó" not in candidatos

    def test_inclui_primeira_linha_cantada(self):
        texto = ("Segura o remo\n"
                 "vem comigo meu irmão\nvem comigo meu irmão\n")
        candidatos = curadoria.extrair_candidatos(texto)
        assert "vem comigo meu irmao" not in candidatos  # sai com acento
        assert candidatos[0] == "vem comigo meu irmão"
        assert "segura o remo" in candidatos

    def test_linha_longa_repetida_nao_vira_titulo(self):
        longa = ("eu vim de muito longe para cantar esta canção "
                 "com todos vocês hoje")
        texto = f"{longa}\n{longa}\ncanta comigo\ncanta comigo\n"
        assert curadoria.extrair_candidatos(texto)[0] == "canta comigo"

    def test_frase_unica_nao_repetida_nao_entra(self):
        texto = "primeira linha\nsegunda linha\nterceira linha\n"
        # só a primeira linha cantada é candidata: nada se repete
        assert curadoria.extrair_candidatos(texto) == ["primeira linha"]

    def test_divide_por_pontuacao_no_mesmo_paragrafo(self):
        texto = "Me apresento, me apresento. Me apresento; sou daqui"
        assert curadoria.extrair_candidatos(texto)[0] == "me apresento"

    def test_texto_vazio_nao_gera_candidato(self):
        assert curadoria.extrair_candidatos("") == []
        assert curadoria.extrair_candidatos("   \n\n ...") == []

    def test_placeholder_e_numero_nao_viram_candidato(self):
        texto = "12\n12\nfaixa 5\nfaixa 5\ncanta comigo\ncanta comigo\n"
        assert curadoria.extrair_candidatos(texto) == ["canta comigo"]

    def test_texto_nfd_do_macos_vira_nfc(self):
        nfd = unicodedata.normalize("NFD", "Água viva\nÁgua viva\n")
        candidatos = curadoria.extrair_candidatos(nfd)
        assert candidatos[0] == "água viva"
        assert candidatos[0] == unicodedata.normalize("NFC", candidatos[0])

    def test_limita_a_quantidade_de_candidatos(self):
        linhas = []
        for i in range(10):
            linhas += [f"linha numero {i}"] * 2
        candidatos = curadoria.extrair_candidatos("\n".join(linhas))
        assert 0 < len(candidatos) <= 5


# ------------------------------------------------- F14.1 identificação

class TestIdentificacao:
    def test_identificada_grava_titulo_artista_e_letra_oficiais(self, pasta,
                                                                capsys):
        alvo = pasta / "Faixa 5.mp3"
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_apresento, pausa=0)
        assert titulo_de(alvo) == "Me Apresento"
        assert artista_de(alvo) == "Barquinha"
        assert uslt_text(alvo) == LETRA_OFICIAL
        # letra oficial NÃO é marcada como transcrição
        assert origem_de(alvo) == ""
        out = capsys.readouterr().out
        assert "IDENTIFICADA: Faixa 5.mp3 → Me Apresento / Barquinha" in out
        assert 'refrão "me apresento"' in out

    def test_linha_identificada_usa_segundos_puros(self, pasta, capsys,
                                                   monkeypatch):
        real = curadoria.ler_info

        def musica_longa(path):
            info = real(path)
            info["duracao"] = 214.0  # 3m34s: a linha do PRD mostra "214s"
            return info

        monkeypatch.setattr(curadoria, "ler_info", musica_longa)
        curadoria.cmd_transcrever(
            pasta, transcritor=FakeTranscritor(),
            fetcher=lambda url: json.dumps([resultado(duration=216.0)]),
            pausa=0)
        out = capsys.readouterr().out
        assert ('(refrão "me apresento", mp3 214s, lrclib 216s)') in out

    def test_identificada_nao_transcreve_o_arquivo_inteiro(self, pasta):
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_apresento, pausa=0)
        assert len(t.trechos) == 1
        assert t.completos == []  # não gastou CPU com a música inteira

    def test_trecho_padrao_90s_a_partir_de_20s(self, pasta):
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_apresento, pausa=0)
        assert t.trechos[0][1] == 20.0
        assert t.trechos[0][2] == 90.0

    def test_trecho_configuravel(self, pasta):
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_apresento, trecho=45.0,
                                  pausa=0)
        assert t.trechos[0][2] == 45.0

    def test_consulta_usa_o_candidato_como_track_name(self, pasta):
        urls = []

        def espiao(url):
            urls.append(url)
            return json.dumps([resultado()])

        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=espiao, pausa=0)
        assert len(urls) == 1
        assert "track_name=me+apresento" in urls[0]
        assert "q=" not in urls[0]

    def test_duracao_divergente_desqualifica(self, pasta, capsys):
        def homonimo(url):  # mesmo título, 300 s (>15 s de diferença)
            return json.dumps([resultado(duration=300.0)])

        alvo = pasta / "Faixa 5.mp3"
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t, fetcher=homonimo,
                                  pausa=0)
        assert titulo_de(alvo) is None          # nada foi identificado
        assert uslt_text(alvo) == TEXTO_COMPLETO  # caiu na F14.2
        assert len(t.completos) == 1
        assert "TRANSCRITA: Faixa 5.mp3" in capsys.readouterr().out

    def test_resultado_placeholder_do_lrclib_e_descartado(self, pasta):
        def lixo(url):
            return json.dumps([resultado(track="AudioTrack 05",
                                         artist="Unknown Artist")])

        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=lixo, pausa=0)
        assert titulo_de(alvo) is None
        assert origem_de(alvo) == "transcricao"

    def test_sem_resultado_cai_para_transcricao_completa(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_vazio, pausa=0)
        assert len(t.completos) == 1
        assert uslt_text(alvo) == TEXTO_COMPLETO
        assert titulo_de(alvo) is None  # título nunca sai da transcrição
        assert "TRANSCRITA: Faixa 5.mp3" in capsys.readouterr().out

    def test_erro_de_rede_avisa_e_transcreve(self, pasta, capsys):
        def caiu(url):
            raise urllib.error.URLError("rede indisponível")

        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=caiu, pausa=0)
        out = capsys.readouterr().out
        assert "AVISO: Faixa 5.mp3 — erro de rede na identificação" in out
        assert uslt_text(alvo) == TEXTO_COMPLETO  # o trabalho não se perde

    def test_identificada_preserva_temas_existentes(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, temas=["água", "cura"])
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_apresento, pausa=0)
        assert temas_value(alvo) == "água; cura"


# ------------------------------------------------- F14.2 transcrição

class TestTranscricaoCompleta:
    def test_grava_letra_limpa_sem_cabecalho(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        letra = uslt_text(alvo)
        assert letra == TEXTO_COMPLETO  # nenhuma linha de cabeçalho
        assert "transcri" not in letra.lower()

    def test_marca_letra_origem_transcricao(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        assert origem_de(alvo) == "transcricao"

    def test_nao_inventa_titulo_nem_artista(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, title="Faixa 5", artist="Desconhecido")
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        assert titulo_de(alvo) == "Faixa 5"
        assert artista_de(alvo) == "Desconhecido"

    def test_linha_transcrita_traz_caracteres_e_tempos(self, pasta, capsys):
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        linha = next(l for l in capsys.readouterr().out.splitlines()
                     if "TRANSCRITA:" in l)
        assert f"({len(TEXTO_COMPLETO)} caracteres" in linha
        assert "de áudio em" in linha

    def test_milhar_com_ponto_no_padrao_pt_br(self, pasta, capsys):
        grande = "canta comigo agora\n" * 200
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(
            completo=grande), fetcher=fetcher_vazio, pausa=0)
        linha = next(l for l in capsys.readouterr().out.splitlines()
                     if "TRANSCRITA:" in l)
        assert f"({len(grande):,}".replace(",", ".") in linha

    def test_formato_de_duracao_do_audio(self):
        assert curadoria._fmt_dur(252.4) == "4m12s"   # "4m12s de áudio"
        assert curadoria._fmt_dur(38.2) == "38s"
        assert curadoria._fmt_dur(0) == "0s"

    def test_texto_nfd_e_gravado_em_nfc(self, pasta):
        nfd = unicodedata.normalize("NFD", "Água viva na canção\n")
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(
            completo=nfd), fetcher=fetcher_vazio, pausa=0)
        letra = uslt_text(alvo)
        assert letra == unicodedata.normalize("NFC", nfd)
        assert "Água" in letra

    def test_transcricao_vazia_vira_erro_sem_gravar(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        antes = sha256(alvo)
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(
            trecho="", completo="   \n\n"), fetcher=fetcher_vazio, pausa=0)
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "ERRO: Faixa 5.mp3 — transcrição vazia" in out
        assert "| 1 erros" in out


# ------------------------------------------------- letra existente

class TestLetraExistente:
    def test_nunca_sobrescreve_sem_forcar(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, letra="letra que já estava lá")
        antes = sha256(alvo)
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t,
                                  fetcher=fetcher_apresento, pausa=0)
        assert sha256(alvo) == antes        # nem um byte
        assert t.chamadas == []             # nem transcreve o trecho
        out = capsys.readouterr().out
        assert "PULADO: Faixa 5.mp3 (já tem letra)" in out
        assert "| 1 puladas |" in out

    def test_forcar_reprocessa_e_sobrescreve(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        tag(alvo, letra="letra antiga")
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, forcar=True, pausa=0)
        assert uslt_text(alvo) == TEXTO_COMPLETO
        assert origem_de(alvo) == "transcricao"

    def test_forcar_com_identificacao_limpa_a_marca_de_transcricao(self,
                                                                   pasta):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        assert origem_de(alvo) == "transcricao"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_apresento, forcar=True,
                                  pausa=0)
        assert uslt_text(alvo) == LETRA_OFICIAL
        assert origem_de(alvo) == ""  # agora é letra oficial


# ------------------------------------------------- gates

class TestGates:
    def test_so_identificar_nao_transcreve_inteiro(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        antes = sha256(alvo)
        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t, fetcher=fetcher_vazio,
                                  so_identificar=True, pausa=0)
        assert t.completos == []
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "PULADO: Faixa 5.mp3 (não identificada)" in out
        assert "| 0 transcritas |" in out

    def test_so_identificar_ainda_grava_quando_identifica(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_apresento,
                                  so_identificar=True, pausa=0)
        assert titulo_de(alvo) == "Me Apresento"
        assert uslt_text(alvo) == LETRA_OFICIAL

    def test_so_transcrever_pula_o_lrclib(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        chamadas = []

        def espiao(url):
            chamadas.append(url)
            return json.dumps([resultado()])

        t = FakeTranscritor()
        curadoria.cmd_transcrever(pasta, transcritor=t, fetcher=espiao,
                                  so_transcrever=True, pausa=0)
        assert chamadas == []        # nenhuma rede
        assert t.trechos == []       # nenhum trecho de identificação
        assert len(t.completos) == 1
        assert uslt_text(alvo) == TEXTO_COMPLETO
        assert "| 0 identificadas |" in capsys.readouterr().out


# ------------------------------------------------- erros e interrupção

class TestErrosEInterrupcao:
    def test_audio_ilegivel_vira_erro_e_lote_continua(self, pasta, base_mp3,
                                                      capsys):
        (pasta / "quebrado.mp3").write_bytes(b"isto nao e um mp3" * 40)
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        out = capsys.readouterr().out
        assert "ERRO: quebrado.mp3 — áudio ilegível" in out
        assert uslt_text(alvo) == TEXTO_COMPLETO  # o outro seguiu normal
        assert ("Resumo: 2 arquivos | 0 identificadas | 1 transcritas | "
                "0 puladas | 1 erros") in out

    def test_falha_do_transcritor_vira_erro_sem_gravar(self, pasta, capsys):
        alvo = pasta / "Faixa 5.mp3"
        antes = sha256(alvo)
        t = FakeTranscritor(erro=RuntimeError("ffmpeg morreu"))
        curadoria.cmd_transcrever(pasta, transcritor=t, fetcher=fetcher_vazio,
                                  pausa=0)
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "ERRO: Faixa 5.mp3" in out
        assert "| 1 erros" in out

    def test_ctrl_c_nao_grava_o_arquivo_em_andamento(self, tmp_path, base_mp3,
                                                     capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        shutil.copyfile(base_mp3, p / "a.mp3")
        shutil.copyfile(base_mp3, p / "b.mp3")
        antes_b = sha256(p / "b.mp3")
        t = FakeTranscritor(erro=KeyboardInterrupt(), erro_em="b.mp3")
        curadoria.cmd_transcrever(p, transcritor=t, fetcher=fetcher_vazio,
                                  pausa=0)
        assert uslt_text(p / "a.mp3") == TEXTO_COMPLETO  # a primeira gravou
        assert sha256(p / "b.mp3") == antes_b            # a segunda, intacta
        out = capsys.readouterr().out
        assert "INTERROMPIDO: b.mp3" in out
        assert "Resumo:" in out  # o resumo do que foi feito ainda sai


# ------------------------------------------------- invioláveis

class TestInviolaveis:
    def test_frames_de_audio_e_nome_do_arquivo_intactos(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        audio_antes = frames_audio(alvo)
        nomes_antes = nomes(pasta)
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_apresento, pausa=0)
        assert frames_audio(alvo) == audio_antes  # só a tag ID3 mudou
        assert nomes(pasta) == nomes_antes        # nada renomeado nem movido
        assert titulo_de(alvo) == "Me Apresento"  # (sanidade: a tag mudou)

    def test_transcricao_tambem_preserva_os_frames_de_audio(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        audio_antes = frames_audio(alvo)
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        assert frames_audio(alvo) == audio_antes


# ------------------------------------------------- CSV e resumo

class TestCsvEResumo:
    def test_csv_colunas_e_linhas(self, tmp_path, base_mp3):
        p = tmp_path / "acervo"
        p.mkdir()
        shutil.copyfile(base_mp3, p / "a.mp3")
        shutil.copyfile(base_mp3, p / "b.mp3")
        tag(p / "b.mp3", letra="já tem")
        saida = tmp_path / "feito.csv"
        curadoria.cmd_transcrever(p, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_apresento, csv_out=saida,
                                  pausa=0)
        assert saida.read_bytes().startswith(b"\xef\xbb\xbf")  # BOM p/ Excel
        rows = read_csv(saida)
        assert list(rows[0].keys()) == TRANSCREVER_COLS
        por_arquivo = {r["arquivo"]: r for r in rows}
        assert por_arquivo["a.mp3"]["acao"] == "IDENTIFICADA"
        assert por_arquivo["a.mp3"]["titulo"] == "Me Apresento"
        assert por_arquivo["a.mp3"]["artista"] == "Barquinha"
        assert "me apresento" in por_arquivo["a.mp3"]["candidatos"]
        assert por_arquivo["b.mp3"]["acao"] == "PULADO"
        assert por_arquivo["b.mp3"]["detalhe"] == "já tem letra"

    def test_resumo_fecha_a_conta(self, tmp_path, base_mp3, capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        for nome in ("a.mp3", "b.mp3", "c.mp3"):
            shutil.copyfile(base_mp3, p / nome)
        tag(p / "c.mp3", letra="já tem")
        (p / "quebrado.mp3").write_bytes(b"nao e mp3" * 50)

        def so_para_a(url):
            return json.dumps([resultado()] if "track_name" in url else [])

        # a.mp3 identifica; b.mp3 transcreve; c.mp3 pula; quebrado dá erro
        curadoria.cmd_transcrever(p, transcritor=FakeTranscritor(),
                                  fetcher=so_para_a, pausa=0)
        out = capsys.readouterr().out
        linha = next(l for l in out.splitlines() if l.startswith("Resumo:"))
        numeros = [int(t) for t in linha.replace("|", " ").split()
                   if t.isdigit()]
        total, ident, transc, pulad, erros = numeros
        assert total == 4
        assert ident + transc + pulad + erros == total

    def test_contador_de_progresso_por_arquivo(self, tmp_path, base_mp3,
                                               capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        shutil.copyfile(base_mp3, p / "a.mp3")
        shutil.copyfile(base_mp3, p / "b.mp3")
        curadoria.cmd_transcrever(p, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        out = capsys.readouterr().out
        assert "[1/2]" in out
        assert "[2/2]" in out

    def test_verboso_mostra_trecho_e_candidatos(self, pasta, capsys):
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, verboso=True,
                                  pausa=0)
        out = capsys.readouterr().out
        assert "Sou filho da natureza" in out       # o trecho transcrito
        assert "candidatos: me apresento" in out


# ------------------------------------------------- LETRA_ORIGEM round-trip

class TestLetraOrigem:
    def test_embed_lyrics_grava_e_le_a_origem(self, tmp_path, base_mp3):
        alvo = tmp_path / "x.mp3"
        shutil.copyfile(base_mp3, alvo)
        el.embed_lyrics(alvo, "uma letra", origem=el.ORIGEM_TRANSCRICAO)
        assert el.read_letra_origem(ID3(str(alvo))) == "transcricao"
        el.embed_lyrics(alvo, "outra letra", origem="")
        assert el.read_letra_origem(ID3(str(alvo))) == ""

    def test_check_mostra_a_origem_da_letra(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        result = run_embed("--check", alvo)
        assert result.returncode == 0, result.stderr
        assert "Origem da letra: transcrição automática" in result.stdout
        linhas = result.stdout.splitlines()
        i_origem = next(i for i, l in enumerate(linhas)
                        if l.startswith("Origem da letra:"))
        i_letra = next(i for i, l in enumerate(linhas)
                       if l.startswith("Letra"))
        assert i_origem < i_letra

    def test_check_sem_origem_nao_polui_a_saida(self, tmp_path, base_mp3):
        alvo = tmp_path / "x.mp3"
        shutil.copyfile(base_mp3, alvo)
        el.embed_lyrics(alvo, "letra oficial")
        result = run_embed("--check", alvo)
        assert "Origem da letra:" not in result.stdout

    def test_relatorio_mostra_sim_transcricao(self, pasta):
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        result = run_curadoria("relatorio", pasta)
        assert result.returncode == 0, result.stderr
        linha = next(l for l in result.stdout.splitlines()
                     if "Faixa 5.mp3" in l)
        assert "SIM (transcrição)" in linha
        assert "1 com letra" in result.stdout

    def test_relatorio_letra_oficial_continua_sim(self, pasta):
        tag(pasta / "Faixa 5.mp3", letra="letra oficial")
        result = run_curadoria("relatorio", pasta)
        linha = next(l for l in result.stdout.splitlines()
                     if "Faixa 5.mp3" in l)
        assert "SIM" in linha
        assert "transcrição" not in linha

    def test_round_trip_relatorio_aplicar_preserva_a_letra(self, pasta,
                                                           tmp_path):
        alvo = pasta / "Faixa 5.mp3"
        curadoria.cmd_transcrever(pasta, transcritor=FakeTranscritor(),
                                  fetcher=fetcher_vazio, pausa=0)
        plano = tmp_path / "plano.csv"
        assert run_curadoria("relatorio", pasta, "--csv",
                             plano).returncode == 0
        assert run_curadoria("aplicar", pasta, "--csv",
                             plano).returncode == 0
        assert uslt_text(alvo) == TEXTO_COMPLETO   # nada foi apagado
        assert origem_de(alvo) == "transcricao"


# ------------------------------------------------- CLI sem faster-whisper

class TestCliSemFasterWhisper:
    def test_ajuda_geral_funciona(self):
        result = run_curadoria("--help")
        assert result.returncode == 0, result.stderr
        assert "transcrever" in result.stdout

    def test_ajuda_do_subcomando_funciona(self):
        result = run_curadoria("transcrever", "--help")
        assert result.returncode == 0, result.stderr
        for flag in ("--modelo", "--idioma", "--trecho", "--so-identificar",
                     "--so-transcrever", "--forcar", "--csv", "--verboso"):
            assert flag in result.stdout

    def test_sem_a_biblioteca_explica_e_sai_1_sem_gravar(self, pasta):
        try:
            import faster_whisper  # noqa: F401
            pytest.skip("faster-whisper instalado: cenário não se aplica")
        except ImportError:
            pass
        antes = shas_mp3(pasta)
        result = run_curadoria("transcrever", pasta)
        assert result.returncode == 1
        assert "faster-whisper" in result.stderr
        assert "pip" in result.stderr
        assert len(result.stderr.strip().splitlines()) == 1  # uma linha
        assert shas_mp3(pasta) == antes  # nenhum arquivo tocado

    def test_outros_subcomandos_seguem_funcionando(self, pasta):
        result = run_curadoria("relatorio", pasta)
        assert result.returncode == 0, result.stderr
        assert "Faixa 5.mp3" in result.stdout

    def test_curadoria_nao_importa_faster_whisper_no_topo(self):
        fonte = (TOOLS_DIR / "curadoria.py").read_text(encoding="utf-8")
        topo = fonte.split("def ", 1)[0]
        assert "faster_whisper" not in topo
