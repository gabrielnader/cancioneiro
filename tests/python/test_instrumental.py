# -*- coding: utf-8 -*-
"""Testes da F17 (PRD V8): a marca de instrumental (`TXXX:INSTRUMENTAL`).

Escritos antes da implementação (TDD). NENHUM teste usa rede NEM modelo de
transcrição: o transcritor, a impressão digital e o acesso HTTP entram
pelos mesmos pontos injetáveis do resto da suíte, e a pausa de cortesia é
sempre zerada (pausa=0).

O que a F17 promete, e o que cada bloco aqui prova:

- a marca viaja no MP3 e volta pelo `--check` (round-trip);
- transcrição VAZIA com áudio LEGÍVEL marca instrumental — não é erro;
  áudio ILEGÍVEL continua erro, porque são coisas diferentes;
- a escolha humana manda: nenhuma rotina desmarca sozinha, nem com
  `--forcar-tudo`;
- economia: toda etapa de LETRA pula o instrumental, mas a IMPRESSÃO
  DIGITAL continua rodando nele;
- o `relatorio` mostra o estado e o CSV continua fechando o round-trip com
  o `aplicar`.
"""
import ast
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
EMBED = TOOLS_DIR / "embed_lyrics.py"

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402
import embed_lyrics as el  # noqa: E402

CHAVE_AC = "chave-acoustid-de-teste"
CHAVE_VG = "chave-vagalume-de-teste"
FINGERPRINT = "AQADtEmiSJKiJHkS5Aj0Iz-OHz8ePD8"
LETRA_OFICIAL = "Letra oficial inventada\nSegunda linha inventada"
LETRA_VG = "Letra do Vagalume inventada\nOutra linha à toa"
TEXTO_COMPLETO = "Uma transcrição qualquer\nque saiu do áudio"


# ---------------------------------------------------------------- helpers

def run_embed(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(EMBED), *[str(a) for a in args]],
        capture_output=True, text=True, encoding="utf-8",
    )


def run_curadoria(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CURADORIA), *[str(a) for a in args]],
        capture_output=True, text=True, encoding="utf-8",
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


def marcar(path: Path) -> None:
    """Marca à MÃO, pelo caminho público do embed_lyrics."""
    el.write_instrumental(path, True)


def instrumental_de(path: Path) -> bool:
    try:
        return el.read_instrumental(ID3(str(path)))
    except ID3NoHeaderError:
        return False


def valor_instrumental(path: Path):
    """O texto cru do frame TXXX:INSTRUMENTAL (None se não existe)."""
    try:
        frames = [f for f in ID3(str(path)).getall("TXXX")
                  if f.desc == "INSTRUMENTAL"]
    except ID3NoHeaderError:
        return None
    return str(frames[0].text[0]) if frames else None


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


def resumo_de(out: str) -> str:
    return next(l for l in out.splitlines() if l.startswith("Resumo:"))


def numeros_do_resumo(out: str) -> list:
    return [int(t) for t in resumo_de(out).replace("|", " ").split()
            if t.isdigit()]


# ---------------------------------------------------------- stubs das APIs

class FakeTranscritor:
    """Stub do transcritor: (caminho, inicio, duracao) -> texto."""

    def __init__(self, trecho="", completo=TEXTO_COMPLETO):
        self.trecho = trecho
        self.completo = completo
        self.chamadas = []

    def __call__(self, caminho, inicio=None, duracao=None):
        self.chamadas.append((Path(caminho).name, inicio, duracao))
        return self.trecho if duracao is not None else self.completo

    @property
    def arquivos(self):
        return sorted({c[0] for c in self.chamadas})


class FakeImpressao:
    """Stub do fpcalc: (caminho) -> (duracao_segundos, fingerprint)."""

    def __init__(self, duracao=232.0, fingerprint=FINGERPRINT):
        self.duracao = duracao
        self.fingerprint = fingerprint
        self.chamadas = []

    def __call__(self, caminho):
        self.chamadas.append(Path(caminho).name)
        return (self.duracao, self.fingerprint)


def gravacao(titulo="Timoneiro", artista="Paulinho da Viola", duracao=231.0):
    return {"id": "7d1b8f0a", "title": titulo, "duration": duracao,
            "artists": [{"id": "a1", "name": artista, "joinphrase": ""}]}


def resposta_acoustid(score=0.94) -> dict:
    return {"status": "ok",
            "results": [{"id": "r1", "score": score,
                         "recordings": [gravacao()]}]}


def lrclib_search(track="Água Viva", artist="Coral Novo", duracao=232.0,
                  letra=LETRA_OFICIAL) -> list:
    return [{"id": 42, "trackName": track, "artistName": artist,
             "duration": duracao, "plainLyrics": letra}]


def resposta_vagalume(titulo="Água Viva", artista="Coral Novo",
                      letra=LETRA_VG) -> dict:
    return {"type": "exact",
            "art": {"id": "a1", "name": artista},
            "mus": [{"id": "m1", "name": titulo, "text": letra}]}


def fetcher_de(urls=None, lrclib=None, vagalume=None, acoustid=None):
    """Fetcher único que atende LRCLIB, Vagalume e AcoustID pela URL e
    registra em `urls` tudo o que foi consultado — é assim que os testes de
    ECONOMIA provam que a rede nem foi tocada."""
    def fetcher(url: str) -> str:
        if urls is not None:
            urls.append(url)
        if "vagalume" in url:
            return json.dumps(vagalume if vagalume is not None
                              else {"type": "notfound"})
        if "acoustid" in url:
            return json.dumps(acoustid if acoustid is not None
                              else resposta_acoustid())
        if "lrclib" in url:
            if lrclib is None:
                if "/api/search" in url:
                    return json.dumps([])
                raise urllib.error.HTTPError(url, 404, "Not Found", None,
                                             None)
            if "/api/search" in url:
                return json.dumps(lrclib)
            # /api/get devolve UMA faixa, não uma lista
            return json.dumps(lrclib[0])
        raise AssertionError("url inesperada: " + url)
    return fetcher


def transcrever(pasta, **kwargs):
    kwargs.setdefault("transcritor", FakeTranscritor())
    kwargs.setdefault("fetcher", fetcher_de())
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_transcrever(pasta, **kwargs)


def buscar_letra(pasta, **kwargs):
    kwargs.setdefault("fetcher", fetcher_de())
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_buscar_letra(pasta, **kwargs)


def identificar(pasta, **kwargs):
    kwargs.setdefault("impressao_digital", FakeImpressao())
    kwargs.setdefault("fetcher", fetcher_de())
    kwargs.setdefault("chave", CHAVE_AC)
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_identificar(pasta, **kwargs)


# ---------------------------------------------------------------- fixtures

@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """Um único MP3 limpo por módulo (~1,5 s); os testes copiam os bytes."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def limpo(tmp_path: Path, base_mp3: Path) -> Path:
    """Um MP3 sem tag nenhuma, fora de qualquer pasta de acervo."""
    alvo = tmp_path / "musica.mp3"
    shutil.copyfile(base_mp3, alvo)
    return alvo


@pytest.fixture
def acervo(tmp_path: Path, base_mp3: Path) -> Path:
    """Pasta com um MP3 instrumental (marcado à mão), com título e artista
    REAIS e sem letra — o caso do `doce preludio` do acervo real."""
    pasta = tmp_path / "acervo"
    pasta.mkdir()
    alvo = pasta / "doce preludio.mp3"
    shutil.copyfile(base_mp3, alvo)
    tag(alvo, title="Água Viva", artist="Coral Novo")
    marcar(alvo)
    return pasta


# ============================================== a marca dentro do arquivo

class TestMarcaNoArquivo:
    """`TXXX:INSTRUMENTAL = "1"`, na mesma filosofia dos temas e da
    procedência da letra: o dado viaja com o arquivo."""

    def test_instrumental_grava_a_marca_e_o_check_a_mostra(self, limpo):
        r = run_embed(limpo, "--instrumental")
        assert r.returncode == 0, r.stderr
        assert "instrumental" in r.stdout.lower()
        conferido = run_embed("--check", limpo)
        assert conferido.returncode == 0, conferido.stderr
        assert "Instrumental: sim" in conferido.stdout

    def test_frame_gravado_e_o_do_prd(self, limpo):
        run_embed(limpo, "--instrumental")
        assert valor_instrumental(limpo) == "1"
        assert el.INSTRUMENTAL_KEY == "TXXX:INSTRUMENTAL"

    def test_check_diz_nao_quando_nao_ha_marca(self, limpo):
        r = run_embed("--check", limpo)
        assert "Instrumental: não" in r.stdout

    def test_nao_instrumental_remove_a_marca(self, limpo):
        run_embed(limpo, "--instrumental")
        r = run_embed(limpo, "--nao-instrumental")
        assert r.returncode == 0, r.stderr
        assert valor_instrumental(limpo) is None  # o frame some, não fica "0"
        assert "Instrumental: não" in run_embed("--check", limpo).stdout

    def test_as_duas_flags_juntas_sao_erro(self, limpo):
        r = run_embed(limpo, "--instrumental", "--nao-instrumental")
        assert r.returncode == 1
        assert "--instrumental" in (r.stderr + r.stdout)
        assert valor_instrumental(limpo) is None  # nada gravado

    def test_leitura_pela_api_e_ida_e_volta(self, limpo):
        assert instrumental_de(limpo) is False
        el.write_instrumental(limpo, True)
        assert instrumental_de(limpo) is True
        el.write_instrumental(limpo, False)
        assert instrumental_de(limpo) is False

    def test_marcar_nao_toca_no_audio_nem_no_nome(self, limpo):
        audio_antes = frames_audio(limpo)
        nomes_antes = nomes(limpo.parent)
        run_embed(limpo, "--instrumental")
        assert frames_audio(limpo) == audio_antes   # só a tag ID3 mudou
        assert nomes(limpo.parent) == nomes_antes   # nada renomeado nem movido
        assert instrumental_de(limpo) is True       # (sanidade: mudou algo)

    def test_marca_convive_com_letra_temas_e_origem(self, limpo):
        tag(limpo, title="Uma", artist="Outra", letra="uma letra",
            origem=el.ORIGEM_TRANSCRICAO, temas=["água", "cura"])
        run_embed(limpo, "--instrumental")
        assert uslt_text(limpo) == "uma letra"
        assert temas_value(limpo) == "água; cura"
        assert origem_de(limpo) == el.ORIGEM_TRANSCRICAO
        assert titulo_de(limpo) == "Uma"
        assert instrumental_de(limpo) is True

    def test_gravar_letra_depois_preserva_a_marca(self, limpo):
        el.write_instrumental(limpo, True)
        el.embed_lyrics(limpo, "letra nova", title="T")
        # a marca descreve o ÁUDIO, não a letra: gravar letra não desmarca
        assert instrumental_de(limpo) is True
        assert uslt_text(limpo) == "letra nova"

    def test_operacao_de_temas_preserva_a_marca(self, limpo):
        el.write_instrumental(limpo, True)
        run_embed(limpo, "--temas", "água, cura")
        assert instrumental_de(limpo) is True
        assert temas_value(limpo) == "água; cura"

    def test_ler_info_expoe_a_marca(self, limpo):
        assert curadoria.ler_info(limpo)["instrumental"] is False
        el.write_instrumental(limpo, True)
        assert curadoria.ler_info(limpo)["instrumental"] is True

    def test_arquivo_ilegivel_nao_e_instrumental(self, tmp_path):
        quebrado = tmp_path / "quebrado.mp3"
        quebrado.write_bytes(b"isto nao e um mp3" * 40)
        info = curadoria.ler_info(quebrado)
        assert info["ilegivel"] is True
        assert info["instrumental"] is False

    def test_ajuda_documenta_as_duas_flags(self):
        r = run_embed("--help")
        assert r.returncode == 0, r.stderr
        assert "--instrumental" in r.stdout
        assert "--nao-instrumental" in r.stdout


# ================================== marcação automática pelo `transcrever`

class TestMarcacaoAutomatica:
    """Transcrição vazia com áudio LEGÍVEL é música sem voz, não defeito."""

    @pytest.fixture
    def pasta(self, tmp_path, base_mp3) -> Path:
        p = tmp_path / "acervo"
        p.mkdir()
        shutil.copyfile(base_mp3, p / "sem voz.mp3")
        return p

    def test_transcricao_vazia_marca_instrumental(self, pasta, capsys):
        alvo = pasta / "sem voz.mp3"
        transcrever(pasta, transcritor=FakeTranscritor(completo="   \n\n"))
        assert instrumental_de(alvo) is True
        out = capsys.readouterr().out
        assert "INSTRUMENTAL: sem voz.mp3" in out
        assert "transcrição vazia" in out

    def test_transcricao_vazia_nao_e_mais_erro(self, pasta, capsys):
        transcrever(pasta, transcritor=FakeTranscritor(completo=""))
        out = capsys.readouterr().out
        assert "ERRO" not in out
        assert "| 0 erros" in resumo_de(out)
        assert "| 1 instrumentais" in resumo_de(out)

    def test_marcar_nao_grava_letra_vazia(self, pasta):
        alvo = pasta / "sem voz.mp3"
        transcrever(pasta, transcritor=FakeTranscritor(completo="  "))
        assert uslt_text(alvo) is None       # nada de letra em branco
        assert origem_de(alvo) == ""

    def test_marcar_preserva_audio_tags_e_nome(self, pasta):
        alvo = pasta / "sem voz.mp3"
        tag(alvo, title="Doce Prelúdio", artist="Coral Novo")
        audio_antes = frames_audio(alvo)
        nomes_antes = nomes(pasta)
        transcrever(pasta, transcritor=FakeTranscritor(completo=""))
        assert frames_audio(alvo) == audio_antes
        assert nomes(pasta) == nomes_antes
        assert titulo_de(alvo) == "Doce Prelúdio"
        assert artista_de(alvo) == "Coral Novo"

    def test_audio_ilegivel_continua_erro_e_nao_vira_instrumental(
            self, pasta, capsys):
        quebrado = pasta / "quebrado.mp3"
        quebrado.write_bytes(b"isto nao e um mp3" * 40)
        transcrever(pasta, transcritor=FakeTranscritor(completo=""))
        out = capsys.readouterr().out
        assert "ERRO: quebrado.mp3 — áudio ilegível" in out
        assert instrumental_de(quebrado) is False
        # o legível virou instrumental; o ilegível, erro: baldes diferentes
        assert "| 1 erros" in resumo_de(out)
        assert "| 1 instrumentais" in resumo_de(out)

    def test_falha_do_transcritor_nao_marca_instrumental(self, pasta, capsys):
        """Motor que EXPLODE não é áudio sem voz: continua erro."""
        alvo = pasta / "sem voz.mp3"

        class Explode:
            def __call__(self, caminho, inicio=None, duracao=None):
                raise RuntimeError("ffmpeg morreu")

        antes = sha256(alvo)
        transcrever(pasta, transcritor=Explode())
        assert instrumental_de(alvo) is False
        assert sha256(alvo) == antes
        out = capsys.readouterr().out
        assert "ERRO: sem voz.mp3" in out
        assert "| 1 erros" in resumo_de(out)

    def test_csv_registra_a_acao_propria(self, pasta, tmp_path):
        saida = tmp_path / "feito.csv"
        transcrever(pasta, transcritor=FakeTranscritor(completo=""),
                    csv_out=saida)
        linha = read_csv(saida)[0]
        assert linha["acao"] == "INSTRUMENTAL"
        assert "instrumental" in linha["detalhe"]

    def test_segunda_execucao_nao_transcreve_de_novo(self, pasta, capsys):
        """O ponto da F17: marcar UMA vez tira o arquivo da fila para sempre."""
        transcrever(pasta, transcritor=FakeTranscritor(completo=""))
        capsys.readouterr()
        t = FakeTranscritor(completo=TEXTO_COMPLETO)
        transcrever(pasta, transcritor=t)
        assert t.chamadas == []                    # nem o trecho foi pedido
        assert uslt_text(pasta / "sem voz.mp3") is None
        assert "| 1 instrumentais" in resumo_de(capsys.readouterr().out)


# ================================================ a escolha humana manda

class TestEscolhaHumana:
    """Marcada à mão, nenhuma rotina desmarca sozinha — e a decisão sobre o
    caminho inverso (marcado, mas o motor produziria texto) está pinada
    aqui: o instrumental é pulado ANTES de qualquer transcrição, inclusive
    com --forcar/--forcar-tudo, e a letra que porventura exista continua
    intacta. Desmarcar é gesto humano: `--nao-instrumental`."""

    def test_transcrever_nao_desmarca(self, acervo):
        transcrever(acervo)
        assert instrumental_de(acervo / "doce preludio.mp3") is True

    def test_buscar_letra_nao_desmarca(self, acervo):
        buscar_letra(acervo, aplicar=True, chave_vagalume=CHAVE_VG,
                     fetcher=fetcher_de(lrclib=lrclib_search(),
                                        vagalume=resposta_vagalume()))
        assert instrumental_de(acervo / "doce preludio.mp3") is True

    def test_identificar_nao_desmarca(self, acervo):
        identificar(acervo, com_letra=True,
                    fetcher=fetcher_de(lrclib=lrclib_search()))
        assert instrumental_de(acervo / "doce preludio.mp3") is True

    def test_aplicar_csv_nao_desmarca(self, acervo, tmp_path):
        plano = tmp_path / "plano.csv"
        plano.write_text(
            "arquivo,titulo,artista,tem_letra,temas,letra_arquivo\n"
            "doce preludio.mp3,Novo Título,Novo Artista,,água,\n",
            encoding="utf-8-sig")
        curadoria.cmd_aplicar(acervo, plano)
        alvo = acervo / "doce preludio.mp3"
        assert titulo_de(alvo) == "Novo Título"
        assert instrumental_de(alvo) is True

    def test_enriquecer_nao_desmarca(self, acervo):
        curadoria.cmd_enriquecer(acervo, auto=True, pausa=0,
                                 fetcher=fetcher_de(lrclib=lrclib_search()))
        assert instrumental_de(acervo / "doce preludio.mp3") is True

    def test_temas_de_pastas_nao_desmarca(self, tmp_path, base_mp3):
        pasta = tmp_path / "acervo"
        (pasta / "cantos").mkdir(parents=True)
        alvo = pasta / "cantos" / "prelúdio.mp3"
        shutil.copyfile(base_mp3, alvo)
        marcar(alvo)
        curadoria.cmd_temas_de_pastas(pasta, aplicar=True)
        assert temas_value(alvo) == "cantos"
        assert instrumental_de(alvo) is True

    def test_forcar_tudo_nao_transcreve_nem_desmarca(self, acervo, capsys):
        """DECISÃO (F17): a marca de instrumental vence --forcar-tudo.

        --forcar/--forcar-tudo falam de LETRA (refazer o que a máquina
        escreveu, ou substituir a oficial), não de rediscutir se a música
        tem voz. Se a marca cedesse a eles, o arquivo voltaria à fila de
        horas de CPU a cada execução — exatamente o que a F17 veio
        eliminar. Para reprocessar, o humano desmarca antes."""
        alvo = acervo / "doce preludio.mp3"
        antes = sha256(alvo)
        t = FakeTranscritor(completo=TEXTO_COMPLETO)
        transcrever(acervo, transcritor=t, forcar=True, forcar_tudo=True)
        assert t.chamadas == []                 # nem foi ouvido
        assert sha256(alvo) == antes            # nem um byte
        assert uslt_text(alvo) is None
        assert instrumental_de(alvo) is True
        assert "INSTRUMENTAL: doce preludio.mp3" in capsys.readouterr().out

    def test_desmarcar_devolve_o_arquivo_a_fila(self, acervo):
        alvo = acervo / "doce preludio.mp3"
        run_embed(alvo, "--nao-instrumental")
        transcrever(acervo, transcritor=FakeTranscritor(
            completo=TEXTO_COMPLETO))
        assert uslt_text(alvo) == TEXTO_COMPLETO
        assert origem_de(alvo) == el.ORIGEM_TRANSCRICAO

    def test_instrumental_com_letra_registrada_mantem_as_duas_coisas(
            self, acervo):
        """Caso raro do PRD: instrumental que AINDA ASSIM tem letra. A letra
        aparece normalmente e a marca não é apagada por causa dela."""
        alvo = acervo / "doce preludio.mp3"
        el.embed_lyrics(alvo, "uma letra digitada à mão")
        info = curadoria.ler_info(alvo)
        assert info["instrumental"] is True
        assert curadoria.rotulo_letra(info) == "SIM"
        transcrever(acervo)
        buscar_letra(acervo, aplicar=True)
        assert instrumental_de(alvo) is True
        assert uslt_text(alvo) == "uma letra digitada à mão"


# ======================================================== economia (F17)

class TestEconomiaBuscarLetra:
    def test_pula_o_arquivo_sem_tocar_na_rede(self, acervo, capsys):
        urls = []
        buscar_letra(acervo, aplicar=True, fetcher=fetcher_de(
            urls=urls, lrclib=lrclib_search()))
        assert urls == []                       # nem uma consulta
        assert uslt_text(acervo / "doce preludio.mp3") is None
        out = capsys.readouterr().out
        assert "PULADO: doce preludio.mp3 (instrumental)" in out

    def test_pula_tambem_a_perna_do_vagalume(self, acervo):
        urls = []
        buscar_letra(acervo, aplicar=True, chave_vagalume=CHAVE_VG,
                     fetcher=fetcher_de(urls=urls,
                                        vagalume=resposta_vagalume()))
        assert not any("vagalume" in u for u in urls)
        assert uslt_text(acervo / "doce preludio.mp3") is None

    def test_forcar_nao_ressuscita_o_instrumental(self, acervo):
        alvo = acervo / "doce preludio.mp3"
        tag(alvo, letra="transcrição velha", origem=el.ORIGEM_TRANSCRICAO)
        urls = []
        buscar_letra(acervo, aplicar=True, forcar=True,
                     fetcher=fetcher_de(urls=urls, lrclib=lrclib_search()))
        assert urls == []
        assert uslt_text(alvo) == "transcrição velha"

    def test_resumo_conta_os_instrumentais(self, acervo, base_mp3, capsys):
        outro = acervo / "com voz.mp3"
        shutil.copyfile(base_mp3, outro)
        tag(outro, title="Água Viva", artist="Coral Novo")
        buscar_letra(acervo, fetcher=fetcher_de(lrclib=lrclib_search()))
        out = capsys.readouterr().out
        assert "| 1 instrumentais" in resumo_de(out)
        assert "1 encontradas" in resumo_de(out)

    def test_csv_registra_o_status_instrumental(self, acervo, tmp_path):
        saida = tmp_path / "busca.csv"
        buscar_letra(acervo, csv_out=saida)
        linha = read_csv(saida)[0]
        assert list(linha.keys()) == ["arquivo", "titulo", "artista",
                                      "status", "caracteres"]
        assert linha["status"] == "instrumental"


class TestEconomiaTranscrever:
    def test_nao_carrega_nem_chama_o_motor(self, acervo, capsys):
        t = FakeTranscritor(completo=TEXTO_COMPLETO)
        transcrever(acervo, transcritor=t)
        assert t.chamadas == []
        out = capsys.readouterr().out
        assert "INSTRUMENTAL: doce preludio.mp3" in out
        assert "| 1 instrumentais" in resumo_de(out)

    def test_csv_do_pulo_tem_acao_propria(self, acervo, tmp_path):
        saida = tmp_path / "feito.csv"
        transcrever(acervo, csv_out=saida)
        linha = read_csv(saida)[0]
        assert linha["acao"] == "INSTRUMENTAL"
        assert "instrumental" in linha["detalhe"]


class TestEconomiaIdentificar:
    """A impressão digital CONTINUA rodando: instrumental sem letra ainda
    pode (e deve) ter título e artista corretos. Só a letra é pulada."""

    @pytest.fixture
    def pasta(self, tmp_path, base_mp3) -> Path:
        p = tmp_path / "acervo"
        p.mkdir()
        alvo = p / "Faixa 5.mp3"
        shutil.copyfile(base_mp3, alvo)
        marcar(alvo)
        return p

    def test_impressao_digital_roda_e_grava_titulo_e_artista(self, pasta):
        alvo = pasta / "Faixa 5.mp3"
        fp = FakeImpressao()
        identificar(pasta, impressao_digital=fp, com_letra=True)
        assert fp.chamadas == ["Faixa 5.mp3"]    # a etapa cara rodou
        assert titulo_de(alvo) == "Timoneiro"
        assert artista_de(alvo) == "Paulinho da Viola"

    def test_com_letra_nao_consulta_letra_nenhuma(self, pasta):
        urls = []
        identificar(pasta, com_letra=True, chave_vagalume=CHAVE_VG,
                    fetcher=fetcher_de(urls=urls, lrclib=lrclib_search(),
                                       vagalume=resposta_vagalume()))
        assert any("acoustid" in u for u in urls)      # identificou
        assert not any("lrclib" in u for u in urls)    # não buscou letra
        assert not any("vagalume" in u for u in urls)
        assert uslt_text(pasta / "Faixa 5.mp3") is None

    def test_resumo_conta_os_instrumentais(self, pasta, capsys):
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(lrclib=lrclib_search()))
        out = capsys.readouterr().out
        assert "| 1 instrumentais" in resumo_de(out)
        assert "| 0 letras oficiais" in resumo_de(out)
        assert "INSTRUMENTAL: Faixa 5.mp3" in out

    def test_arquivo_normal_continua_recebendo_letra(self, pasta, base_mp3,
                                                     capsys):
        outro = pasta / "com voz.mp3"
        shutil.copyfile(base_mp3, outro)
        identificar(pasta, com_letra=True,
                    fetcher=fetcher_de(lrclib=lrclib_search(
                        track="Timoneiro", artist="Paulinho da Viola",
                        duracao=232.0)))
        assert uslt_text(outro) == LETRA_OFICIAL
        assert uslt_text(pasta / "Faixa 5.mp3") is None
        assert "| 1 letras oficiais" in resumo_de(capsys.readouterr().out)


# ============================================ relatório, CSV e round-trip

class TestRelatorio:
    def test_coluna_letra_mostra_instrumental(self, acervo, capsys):
        curadoria.cmd_relatorio(acervo)
        out = capsys.readouterr().out
        linha = next(l for l in out.splitlines()
                     if l.startswith("doce preludio.mp3"))
        assert "INSTRUMENTAL" in linha
        assert "NÃO" not in linha  # não é pendência: é informação

    def test_rotulo_por_estado(self):
        def info(letra="", origem="", instrumental=False):
            return {"letra": letra, "letra_origem": origem,
                    "instrumental": instrumental}

        assert curadoria.rotulo_letra(info()) == "NÃO"
        assert curadoria.rotulo_letra(info(instrumental=True)) == \
            "INSTRUMENTAL"
        # a letra registrada continua mandando na coluna de LETRA
        assert curadoria.rotulo_letra(info(letra="x",
                                           instrumental=True)) == "SIM"
        assert curadoria.rotulo_letra(
            info(letra="x", origem=el.ORIGEM_TRANSCRICAO,
                 instrumental=True)) == "SIM (transcrição)"

    def test_resumo_conta_instrumentais(self, acervo, base_mp3, capsys):
        outro = acervo / "com voz.mp3"
        shutil.copyfile(base_mp3, outro)
        curadoria.cmd_relatorio(acervo)
        resumo = resumo_de(capsys.readouterr().out)
        assert "Resumo: 2 arquivos | 0 com letra | 2 sem letra" in resumo
        assert "| 1 instrumentais" in resumo

    def test_csv_traz_o_estado_e_o_aplicar_faz_o_round_trip(self, acervo,
                                                            tmp_path, capsys):
        alvo = acervo / "doce preludio.mp3"
        saida = tmp_path / "plano.csv"
        curadoria.cmd_relatorio(acervo, csv_out=saida)
        linha = read_csv(saida)[0]
        assert list(linha.keys()) == ["arquivo", "titulo", "artista",
                                      "tem_letra", "temas", "letra_arquivo"]
        assert linha["tem_letra"] == "INSTRUMENTAL"
        # o mesmo CSV volta pelo aplicar sem estragar nada
        capsys.readouterr()
        curadoria.cmd_aplicar(acervo, saida)
        assert "OK: doce preludio.mp3" in capsys.readouterr().out
        assert titulo_de(alvo) == "Água Viva"
        assert artista_de(alvo) == "Coral Novo"
        assert instrumental_de(alvo) is True      # a marca sobreviveu
        assert uslt_text(alvo) is None


# =============================================== aritmética dos resumos

class TestResumosFecham:
    def test_transcrever_todo_arquivo_num_balde_so(self, tmp_path, base_mp3,
                                                   capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        for nome in ("a.mp3", "b.mp3", "c.mp3", "d.mp3"):
            shutil.copyfile(base_mp3, p / nome)
        tag(p / "c.mp3", letra="já tem")
        marcar(p / "d.mp3")
        (p / "quebrado.mp3").write_bytes(b"nao e mp3" * 50)
        # a.mp3 e b.mp3 voltam vazios (instrumentais), c.mp3 pula,
        # d.mp3 já está marcado, quebrado.mp3 dá erro
        transcrever(p, transcritor=FakeTranscritor(completo=""))
        out = capsys.readouterr().out
        (total, ident, transc, nao_ident, pulad, confl, erros,
         instrum) = numeros_do_resumo(out)
        assert total == 5
        assert (ident + transc + nao_ident + pulad + confl + erros
                + instrum) == total
        assert instrum == 3
        assert erros == 1

    def test_buscar_letra_soma_com_os_instrumentais(self, tmp_path, base_mp3,
                                                    capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        for nome in ("a.mp3", "b.mp3"):
            shutil.copyfile(base_mp3, p / nome)
            tag(p / nome, title="Água Viva", artist="Coral Novo")
        marcar(p / "b.mp3")
        buscar_letra(p, fetcher=fetcher_de(lrclib=lrclib_search()))
        (encontradas, nao_encontradas, erros, vagalume,
         instrum) = numeros_do_resumo(capsys.readouterr().out)
        assert encontradas + nao_encontradas + erros + instrum == 2
        assert instrum == 1

    def test_identificar_conta_sem_criar_balde_novo(self, tmp_path, base_mp3,
                                                    capsys):
        p = tmp_path / "acervo"
        p.mkdir()
        for nome in ("a.mp3", "b.mp3"):
            shutil.copyfile(base_mp3, p / nome)
        marcar(p / "b.mp3")
        identificar(p, com_letra=True,
                    fetcher=fetcher_de(lrclib=lrclib_search(
                        track="Timoneiro", artist="Paulinho da Viola")))
        (total, ident, letras, sem, confl, erros, vagalume,
         instrum) = numeros_do_resumo(capsys.readouterr().out)
        assert total == 2
        # os dois são identificados pela impressão digital; "instrumentais"
        # é recorte (quantos pularam a letra), não balde à parte
        assert ident + sem + confl + erros == total
        assert instrum == 1
        assert letras == 1


# ==================================================== compatibilidade 3.9

class TestCompatibilidade:
    @pytest.mark.parametrize("nome", ["curadoria.py", "embed_lyrics.py",
                                      "make_fixtures.py"])
    def test_codigo_compativel_com_python_39(self, nome):
        fonte = (TOOLS_DIR / nome).read_text(encoding="utf-8")
        ast.parse(fonte, feature_version=(3, 9))
