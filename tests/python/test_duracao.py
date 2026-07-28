# -*- coding: utf-8 -*-
"""Testes da PROVA DE DURAÇÃO (achado CRÍTICO do QA sobre a F17/V8.1).

O defeito: a marca de instrumental é decidida por DENSIDADE (caracteres da
transcrição por segundo de áudio), e a duração vinha de
`mutagen.mp3.MP3().info.length`. Num MP3 **sem cabeçalho Xing/Info**
(remontado, cortado, editado à mão ou com uma entrada de bitrate baixo —
tudo rotina em acervo montado à mão) o mutagen NÃO sabe a duração: ele
estima a partir do bitrate do PRIMEIRO quadro, como se o arquivo inteiro
fosse aquilo. O QA mediu `real 300 s -> mutagen 2260,3 s` e o efeito:

    [1/1] INSTRUMENTAL: ponto_de_ogum.mp3 (631 caracteres em 37m40s de
          áudio = 0,28 caractere por segundo, abaixo do mínimo de 0,30 —
          marcado como instrumental)

Uma música CANTADA, com 631 caracteres de letra legítima (2,1 c/s reais),
perdia a letra para sempre — a marca vence até `--forcar-tudo`, e desfazer
exige um comando de terminal num produto cujo requisito declarado é que o
terminal desapareça (PRD V8, "40 curadores").

Este arquivo NÃO falsifica duração nenhuma: ele MONTA o MP3 do defeito
(entrada de bitrate baixo + corpo de bitrate alto, sem tag Xing, colados) e
prova a correção nele, ponta a ponta. Nada de rede e nada de modelo: o
transcritor é sempre o stub injetável da suíte.
"""
import math
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp3 import MP3

from conftest import LAME, TOOLS_DIR, make_mp3

sys.path.insert(0, str(TOOLS_DIR))
import curadoria  # noqa: E402
import embed_lyrics as el  # noqa: E402


# ---------------------------------------------------------------- helpers

def _wav(path: Path, segundos: float, freq: float, rate: int = 44100) -> None:
    """WAV PCM 16-bit mono. Um segundo é gerado e repetido: a 44100 Hz uma
    senoide de 440/300 Hz fecha o período no segundo, então a emenda é
    contínua — e o teste não gasta minutos gerando amostra a amostra."""
    um_segundo = b"".join(
        struct.pack("<h", int(0.5 * 32767 * math.sin(2 * math.pi * freq * i
                                                     / rate)))
        for i in range(rate))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        inteiros = int(segundos)
        wf.writeframes(um_segundo * inteiros)
        resto = int((segundos - inteiros) * rate)
        if resto:
            wf.writeframes(um_segundo[:resto * 2])


def _mp3_sem_xing(destino: Path, segundos: float, bitrate: int,
                  freq: float) -> Path:
    """MP3 CBR SEM a tag Xing/Info do lame (-t) — é a ausência dela que faz
    o leitor de tags CHUTAR a duração."""
    wav = destino.with_suffix(".tmp.wav")
    _wav(wav, segundos, freq)
    subprocess.run([LAME, "--quiet", "-t", "--noreplaygain", "-b",
                    str(bitrate), str(wav), str(destino)],
                   check=True, capture_output=True)
    wav.unlink()
    return destino


# Proporções do defeito do QA (real 300 s -> mutagen 2260 s, 7,5x), em
# escala de teste: 2 s de entrada a 32 kbps + 58 s de corpo a 256 kbps.
ENTRADA_S = 2.0
CORPO_S = 58.0
REAL_S = ENTRADA_S + CORPO_S
# Mesma densidade real do arquivo do QA (631 car / 300 s = 2,1 c/s): letra
# legítima, rala, de música cantada.
LETRA_LEGITIMA = ("Ogum de ronda pela estrada\n"
                  "abre o caminho de quem vai\n"
                  "salve a espada e a madrugada\n")   # ~128 caracteres


@pytest.fixture(scope="module")
def remontado(tmp_path_factory) -> Path:
    """O MP3 do defeito: dois arquivos CBR de bitrates MUITO diferentes,
    sem Xing, colados byte a byte — exatamente o que sai de um corte, de
    uma emenda ou de um download remontado."""
    base = tmp_path_factory.mktemp("remontado")
    entrada = _mp3_sem_xing(base / "entrada.mp3", ENTRADA_S, 32, 300.0)
    corpo = _mp3_sem_xing(base / "corpo.mp3", CORPO_S, 256, 440.0)
    alvo = base / "ponto_de_ogum.mp3"
    alvo.write_bytes(entrada.read_bytes() + corpo.read_bytes())
    return alvo


@pytest.fixture(scope="module")
def base_mp3(tmp_path_factory) -> Path:
    """MP3 normal (com Xing, escrito pelo lame), ~1,5 s."""
    return make_mp3(tmp_path_factory.mktemp("base") / "base.mp3")


@pytest.fixture
def pasta_remontada(tmp_path, remontado) -> Path:
    pasta = tmp_path / "acervo"
    pasta.mkdir()
    shutil.copyfile(remontado, pasta / "ponto_de_ogum.mp3")
    return pasta


class FakeTranscritor:
    """Stub do transcritor. `duracao_medida` liga o contrato novo: o motor
    devolve (texto, segundos de áudio que ele realmente processou)."""

    def __init__(self, completo="", trecho="", duracao_medida=None):
        self.completo = completo
        self.trecho = trecho
        self.duracao_medida = duracao_medida
        self.chamadas = []

    def __call__(self, caminho, inicio=None, duracao=None):
        self.chamadas.append((Path(caminho).name, inicio, duracao))
        texto = self.trecho if duracao is not None else self.completo
        if self.duracao_medida is None:
            return texto
        return texto, self.duracao_medida


def transcrever(pasta, **kwargs):
    kwargs.setdefault("transcritor", FakeTranscritor())
    kwargs.setdefault("fetcher", lambda url: "[]")
    kwargs.setdefault("pausa", 0)
    return curadoria.cmd_transcrever(pasta, **kwargs)


def instrumental_de(path: Path) -> bool:
    try:
        return el.read_instrumental(ID3(str(path)))
    except ID3NoHeaderError:
        return False


def uslt_text(path: Path):
    try:
        frames = ID3(str(path)).getall("USLT")
    except ID3NoHeaderError:
        return None
    return str(frames[0].text) if frames else None


def resumo_de(out: str) -> str:
    return next(l for l in out.splitlines() if l.startswith("Resumo:"))


# ==================================== o defeito existe, e é desta ordem

class TestOCabecalhoMente:
    """Antes de corrigir: provar que o cenário do QA é real e reproduzido."""

    def test_o_mp3_remontado_engana_a_leitura_de_tags(self, remontado):
        estimada = MP3(str(remontado)).info.length
        assert estimada > REAL_S * 4, (
            "o defeito do QA depende do cabeçalho mentir por uma ORDEM DE "
            f"GRANDEZA; aqui ele disse {estimada:.0f}s")
        # e não é o `sketchy` do mutagen que denuncia: ele acha 4 quadros
        # válidos seguidos e se declara confiante
        assert MP3(str(remontado)).info.sketchy is False

    def test_a_densidade_pelo_cabecalho_condenaria_a_musica(self, remontado):
        estimada = MP3(str(remontado)).info.length
        assert curadoria.sem_conteudo(LETRA_LEGITIMA, estimada) is True
        assert curadoria.sem_conteudo(LETRA_LEGITIMA, REAL_S) is False


# ================================================ a medição independente

class TestMedirDuracaoPorQuadros:
    """A duração medida somando a duração de CADA quadro MPEG do arquivo —
    de graça, offline, sem depender de cabeçalho nenhum."""

    def test_mp3_normal_bate_com_o_cabecalho(self, base_mp3):
        medida = curadoria.medir_duracao_por_quadros(base_mp3)
        assert medida is not None
        assert abs(medida - MP3(str(base_mp3)).info.length) < 0.2

    def test_mp3_remontado_devolve_a_duracao_real(self, remontado):
        medida = curadoria.medir_duracao_por_quadros(remontado)
        assert medida is not None
        assert abs(medida - REAL_S) < 0.5, (
            f"medido {medida}, real {REAL_S}")

    def test_tag_id3_grande_nao_entra_na_conta(self, tmp_path, base_mp3):
        alvo = tmp_path / "com_tag.mp3"
        shutil.copyfile(base_mp3, alvo)
        antes = curadoria.medir_duracao_por_quadros(alvo)
        el.embed_lyrics(alvo, "letra muito longa\n" * 500)
        assert abs(curadoria.medir_duracao_por_quadros(alvo) - antes) < 0.05

    def test_arquivo_que_nao_e_mp3_nao_inventa_duracao(self, tmp_path):
        lixo = tmp_path / "corrompido.mp3"
        lixo.write_bytes(b"isto nao e um mp3" * 240)
        assert curadoria.medir_duracao_por_quadros(lixo) is None

    def test_arquivo_inexistente_nao_explode(self, tmp_path):
        ausente = tmp_path / "nao.mp3"
        assert curadoria.medir_duracao_por_quadros(ausente) is None

    def test_arquivo_vazio_nao_explode(self, tmp_path):
        vazio = tmp_path / "vazio.mp3"
        vazio.write_bytes(b"")
        assert curadoria.medir_duracao_por_quadros(vazio) is None

    def test_nao_toca_no_arquivo(self, tmp_path, remontado):
        alvo = tmp_path / "copia.mp3"
        shutil.copyfile(remontado, alvo)
        antes = alvo.read_bytes()
        curadoria.medir_duracao_por_quadros(alvo)
        assert alvo.read_bytes() == antes


class TestDuracaoConfirmada:
    """`duracao_confirmada` devolve a duração que o programa consegue
    PROVAR — e 0,0 quando não consegue nenhuma."""

    def test_arquivo_normal_mantem_o_numero_do_cabecalho(self, base_mp3):
        info = curadoria.ler_info(base_mp3)
        assert curadoria.duracao_confirmada(base_mp3, info) == info["duracao"]

    def test_cabecalho_mentiroso_cede_para_a_medicao(self, remontado):
        info = curadoria.ler_info(remontado)
        confirmada = curadoria.duracao_confirmada(remontado, info)
        assert abs(confirmada - REAL_S) < 0.5
        assert confirmada < info["duracao"] / 4

    def test_sem_medicao_possivel_nao_confirma_nada(self, base_mp3,
                                                    monkeypatch):
        monkeypatch.setattr(curadoria, "medir_duracao_por_quadros",
                            lambda _p: None)
        info = curadoria.ler_info(base_mp3)
        assert curadoria.duracao_confirmada(base_mp3, info) == 0.0

    def test_arquivo_ilegivel_nao_confirma_nada(self, tmp_path):
        lixo = tmp_path / "corrompido.mp3"
        lixo.write_bytes(b"isto nao e um mp3" * 240)
        info = curadoria.ler_info(lixo)
        assert curadoria.duracao_confirmada(lixo, info) == 0.0


# ================================== o cenário do QA, ponta a ponta, no MP3

class TestReproducaoDoQA:
    def test_musica_cantada_nao_e_mais_marcada_instrumental(
            self, pasta_remontada, capsys):
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo=LETRA_LEGITIMA))
        out = capsys.readouterr().out
        assert instrumental_de(alvo) is False, (
            "letra legítima de 2,1 c/s reais não pode virar instrumental "
            "por causa de um cabeçalho que mente")
        assert uslt_text(alvo) is not None
        assert el.read_letra_origem(ID3(str(alvo))) == el.ORIGEM_TRANSCRICAO
        assert "TRANSCRITA: ponto_de_ogum.mp3" in out
        assert "INSTRUMENTAL" not in out
        assert "| 1 transcritas" in resumo_de(out)
        assert "| 0 instrumentais" in resumo_de(out)

    def test_a_saida_diz_qual_duracao_foi_usada(self, pasta_remontada,
                                                capsys):
        """Quando a duração medida discorda do cabeçalho, o curador tem de
        ver as DUAS: é a única pista de que aquele MP3 é remontado."""
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo=LETRA_LEGITIMA))
        out = capsys.readouterr().out
        assert curadoria._fmt_dur(REAL_S) in out          # 1m00s
        assert "cabeçalho" in out

    def test_segunda_passada_nao_encontra_marca_nenhuma(self,
                                                        pasta_remontada):
        """O pior do defeito era a segunda passada: 'já marcado como
        instrumental — nada a transcrever', para sempre."""
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo=LETRA_LEGITIMA))
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo=LETRA_LEGITIMA))
        assert instrumental_de(alvo) is False

    def test_instrumental_de_verdade_no_mesmo_arquivo_ainda_e_marcado(
            self, pasta_remontada, capsys):
        """A correção não pode desligar a F17: transcrição VAZIA com áudio
        legível continua marcando (nem duração entra nessa conta)."""
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        transcrever(pasta_remontada, transcritor=FakeTranscritor(completo=""))
        assert instrumental_de(alvo) is True
        assert "transcrição vazia" in capsys.readouterr().out

    def test_ruido_de_verdade_no_arquivo_remontado_ainda_marca(
            self, pasta_remontada, capsys):
        """Ruído medido contra a duração REAL continua sendo ruído: 4
        caracteres em 1m00s são 0,07 c/s, o número das duas faixas
        instrumentais do acervo real."""
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo="la"))
        out = capsys.readouterr().out
        assert instrumental_de(alvo) is True
        assert uslt_text(alvo) is None
        assert curadoria._fmt_dur(REAL_S) in out
        assert "| 1 instrumentais" in resumo_de(out)


# ============================= o motor de transcrição como fonte da verdade

class TestTranscritorInformaADuracao:
    """O transcritor DECODIFICA o áudio: a duração que ele processou é
    verdade de campo e não custa nada. Quando ele informa, ela manda."""

    def test_duracao_do_motor_manda_na_densidade(self, tmp_path, base_mp3,
                                                 capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "sem voz.mp3"
        shutil.copyfile(base_mp3, alvo)
        # o arquivo tem ~1,5 s de cabeçalho, mas o motor processou 175 s
        # (é o caso oposto: o cabeçalho subestima) — 13 caracteres em
        # 175 s são 0,07 c/s, instrumental de verdade
        transcrever(pasta, transcritor=FakeTranscritor(
            completo="la la la la l", duracao_medida=175.0))
        assert instrumental_de(alvo) is True
        assert "2m55s" in capsys.readouterr().out

    def test_duracao_do_motor_salva_a_musica_do_cabecalho_mentiroso(
            self, pasta_remontada):
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(completo=LETRA_LEGITIMA,
                                                duracao_medida=REAL_S))
        assert instrumental_de(alvo) is False
        assert uslt_text(alvo) is not None

    def test_transcritor_antigo_so_com_texto_continua_valendo(
            self, tmp_path, base_mp3):
        """A assinatura histórica (só o texto) não pode quebrar: é a que
        qualquer motor injetado cumpre."""
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        alvo = pasta / "musica.mp3"
        shutil.copyfile(base_mp3, alvo)
        transcrever(pasta, transcritor=FakeTranscritor(completo="uma letra "
                                                       "de verdade"))
        assert uslt_text(alvo) is not None

    def test_o_transcritor_real_informa_a_duracao_que_processou(self,
                                                                monkeypatch):
        class ModeloFalso:
            def transcribe(self, caminho, **kwargs):
                seg = type("S", (), {"text": "canto"})()
                info = type("I", (), {"duration": 302.5})()
                return [seg], info

        monkeypatch.setitem(
            sys.modules, "faster_whisper",
            type("M", (), {"WhisperModel": lambda *a, **k: ModeloFalso()}))
        texto, duracao = curadoria.criar_transcritor(modelo="tiny")("x.mp3")
        assert texto == "canto"
        assert duracao == 302.5

    def test_motor_sem_duracao_nao_quebra(self, monkeypatch):
        class ModeloFalso:
            def transcribe(self, caminho, **kwargs):
                return [], None

        monkeypatch.setitem(
            sys.modules, "faster_whisper",
            type("M", (), {"WhisperModel": lambda *a, **k: ModeloFalso()}))
        texto, duracao = curadoria.criar_transcritor(modelo="tiny")("x.mp3")
        assert texto == ""
        assert duracao == 0.0


# ==================== duração que não se pode provar NÃO marca instrumental

class TestSemProvaNaoMarca:
    """A regra que fecha o buraco: na dúvida, o arquivo fica para o humano.
    Marcar errado é irreversível na prática (a marca vence --forcar-tudo);
    não marcar custa uma nova passada."""

    @pytest.fixture
    def pasta(self, tmp_path, remontado, monkeypatch) -> Path:
        p = tmp_path / "acervo"
        p.mkdir()
        shutil.copyfile(remontado, p / "duvidosa.mp3")
        # o MP3 é o remontado (cabeçalho dizendo minutos que não existem),
        # o fluxo não pôde ser medido (quadros demais fora de lugar) e o
        # motor injetado não informa duração: sobra só o cabeçalho, que é
        # justamente o que não serve de prova
        monkeypatch.setattr(curadoria, "medir_duracao_por_quadros",
                            lambda _p: None)
        return p

    def test_transcricao_rala_sem_prova_nao_marca_nem_grava(self, pasta,
                                                            capsys):
        alvo = pasta / "duvidosa.mp3"
        antes = alvo.read_bytes()
        transcrever(pasta, transcritor=FakeTranscritor(completo="la la"))
        out = capsys.readouterr().out
        assert instrumental_de(alvo) is False
        assert uslt_text(alvo) is None          # nem o ruído virou letra
        assert alvo.read_bytes() == antes       # nenhum byte tocado
        assert "ADIADA: duvidosa.mp3" in out
        assert "duração" in out
        assert "| 1 adiadas" in resumo_de(out)
        assert "| 0 instrumentais" in resumo_de(out)
        assert "| 0 erros" in resumo_de(out)

    def test_a_mensagem_explica_o_que_fazer(self, pasta, capsys):
        """Não há suporte possível: a linha tem de se explicar sozinha."""
        transcrever(pasta, transcritor=FakeTranscritor(completo="la la"))
        out = capsys.readouterr().out
        assert "instrumental" in out.lower()
        assert "editor" in out.lower() or "--instrumental" in out

    def test_transcricao_vazia_sem_prova_ainda_marca(self, pasta):
        """Texto VAZIO não depende de duração nenhuma — nada mudou aí."""
        alvo = pasta / "duvidosa.mp3"
        transcrever(pasta, transcritor=FakeTranscritor(completo=""))
        assert instrumental_de(alvo) is True

    def test_letra_farta_sem_prova_e_gravada_normalmente(self, pasta):
        alvo = pasta / "duvidosa.mp3"
        transcrever(pasta, transcritor=FakeTranscritor(
            completo="uma letra inteira de música cantada\n" * 8))
        assert uslt_text(alvo) is not None
        assert instrumental_de(alvo) is False

    def test_csv_registra_a_acao_adiada(self, pasta, tmp_path):
        import csv as _csv
        saida = tmp_path / "feito.csv"
        transcrever(pasta, transcritor=FakeTranscritor(completo="la la"),
                    csv_out=saida)
        with open(saida, encoding="utf-8-sig", newline="") as fh:
            linha = list(_csv.DictReader(fh))[0]
        assert linha["acao"] == "ADIADA"
        assert "duração" in linha["detalhe"]

    def test_densidade_zero_desliga_a_regra_inteira(self, pasta):
        """Com --densidade-minima 0 só a vazia marca: nada de ADIADA."""
        alvo = pasta / "duvidosa.mp3"
        transcrever(pasta, transcritor=FakeTranscritor(completo="la la"),
                    densidade_minima=0)
        assert uslt_text(alvo) is not None
        assert instrumental_de(alvo) is False


# ============================ a mesma prova na identificação pelo refrão

class TestF14PrecisaDaDuracaoProvada:
    """A F14.1 confirma o casamento do LRCLIB pela duração (decisão 64: o
    palpite vindo do áudio precisa de prova objetiva). Com o cabeçalho
    mentindo, a prova vira sorteio."""

    def _fetcher(self, duracao):
        import json

        def fetcher(url):
            return json.dumps([{"id": 42, "trackName": "Ponto de Ogum",
                                "artistName": "Coral da Mata",
                                "duration": duracao,
                                "plainLyrics": "ponto de ogum na estrada\n"
                                               "abre o caminho"}])
        return fetcher

    def test_a_duracao_medida_confirma_o_casamento_certo(self,
                                                         pasta_remontada,
                                                         capsys):
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(trecho="Ponto de Ogum\n" * 3,
                                                completo=LETRA_LEGITIMA),
                    fetcher=self._fetcher(REAL_S + 1),
                    identificar_por_refrao=True)
        assert "IDENTIFICADA: ponto_de_ogum.mp3" in capsys.readouterr().out

    def test_sem_duracao_provada_nao_identifica(self, pasta_remontada,
                                                monkeypatch, capsys):
        monkeypatch.setattr(curadoria, "medir_duracao_por_quadros",
                            lambda _p: None)
        transcrever(pasta_remontada,
                    transcritor=FakeTranscritor(
                        trecho="Ponto de Ogum\n" * 3,
                        completo=LETRA_LEGITIMA * 3),
                    fetcher=self._fetcher(REAL_S + 1),
                    identificar_por_refrao=True)
        out = capsys.readouterr().out
        assert "IDENTIFICADA" not in out
        assert "TRANSCRITA: ponto_de_ogum.mp3" in out


# ================================= a mesma prova na impressão digital

class TestIdentificarSemDuracaoDoFpcalc:
    """O `identificar` prefere a duração do fpcalc (real). Quando o fpcalc
    não a devolve, o que entrava no lugar era o cabeçalho — e é a duração
    que desqualifica o homônimo no AcoustID: trava calibrada por número
    falso não é trava."""

    def _fetcher(self, duracao):
        import json

        def fetcher(url):
            return json.dumps({
                "status": "ok",
                "results": [{"id": "r1", "score": 0.95, "recordings": [{
                    "id": "g1", "title": "Ponto de Ogum", "duration": duracao,
                    "artists": [{"id": "a1", "name": "Coral da Mata",
                                 "joinphrase": ""}]}]}]})
        return fetcher

    def test_a_duracao_medida_entra_no_lugar_da_do_cabecalho(
            self, pasta_remontada, capsys):
        alvo = pasta_remontada / "ponto_de_ogum.mp3"
        curadoria.cmd_identificar(
            pasta_remontada, chave="chave-de-teste", pausa=0,
            impressao_digital=lambda _c: (0.0, "AQADtEmiSJKiJHkS"),
            fetcher=self._fetcher(REAL_S + 1))
        out = capsys.readouterr().out
        assert "IDENTIFICADA: ponto_de_ogum.mp3" in out
        assert ID3(str(alvo))["TIT2"].text[0] == "Ponto de Ogum"


# =========================================== estimar não pode mentir também

class TestEstimarUsaDuracaoProvada:
    def test_a_projecao_usa_a_duracao_real_do_remontado(self, tmp_path,
                                                        remontado, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(remontado, pasta / "ponto_de_ogum.mp3")
        curadoria.cmd_estimar(pasta, amostra=1,
                              impressao_digital=lambda _c: (REAL_S, "fp"))
        out = capsys.readouterr().out
        assert f"média de {curadoria._fmt_dur(REAL_S)} por música" in out

    def test_avisa_quando_a_duracao_da_amostra_nao_pode_ser_confirmada(
            self, tmp_path, base_mp3, monkeypatch, capsys):
        pasta = tmp_path / "acervo"
        pasta.mkdir()
        shutil.copyfile(base_mp3, pasta / "a.mp3")
        monkeypatch.setattr(curadoria, "medir_duracao_por_quadros",
                            lambda _p: None)
        curadoria.cmd_estimar(pasta, amostra=1,
                              impressao_digital=lambda _c: (0.0, "fp"))
        out = capsys.readouterr().out
        assert "AVISO:" in out
        assert "duração" in out


class TestFonteUnica:
    def test_python39(self):
        import ast
        for nome in ("curadoria.py", "embed_lyrics.py", "make_fixtures.py"):
            fonte = (TOOLS_DIR / nome).read_text(encoding="utf-8")
            ast.parse(fonte, feature_version=(3, 9))
