#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""curadoria.py — CLI de curadoria em massa do acervo do Cancioneiro (V2+V3).

Subcomandos:
    relatorio PASTA [--csv saida.csv]
        Varre a pasta recursivamente (*.mp3, case-insensitive), imprime uma
        tabela alinhada com arquivo/título/artista/letra/temas e, com --csv,
        grava um plano editável (UTF-8 com BOM, para abrir direto no Excel).
        Música marcada como instrumental (V8/F17) aparece como INSTRUMENTAL
        na coluna de letra, no lugar do NÃO — informação, não cobrança.

    aplicar PASTA --csv plano.csv [--dry-run]
        Aplica em massa o CSV editado: título (TIT2), artista (TPE1), temas
        (TXXX:TEMAS, normalizados) e letra (USLT, lida de letra_arquivo).
        Campos vazios nunca são tocados. --dry-run só relata, não grava.

    buscar-letra PASTA [--aplicar] [--chave-vagalume CHAVE] [--forcar]
                 [--csv saida.csv] [--verboso]
        Para cada MP3 sem letra com título E artista, consulta o LRCLIB
        (https://lrclib.net/api/get) e relata/grava o plainLyrics. V6.1:
        no que o LRCLIB não tiver, consulta o Vagalume (chave gratuita em
        --chave-vagalume ou VAGALUME_API_KEY, nunca gravada em disco) —
        base comunitária brasileira, que cobre o repertório de nicho onde
        o LRCLIB ficou em ~3%. Sem a chave, o Vagalume é pulado com uma
        linha (que só sai quando ele teria mesmo entrado) e o comando roda
        exatamente como antes. A letra do Vagalume é OFICIAL (nada de
        marcador de transcrição), mas leva TXXX:LETRA_ORIGEM="vagalume",
        porque essa API não tem duração e portanto não pode ser confirmada
        como a do LRCLIB — daí o casamento estrito da V6.2 (só type
        "exact", e as MESMAS palavras de título e artista). --forcar
        reprocessa SÓ a letra que veio de transcrição (mesma semântica do
        transcrever --forcar): sem ele, quem já transcreveu o acervo
        inteiro nunca alcança as fontes oficiais. Arquivo marcado como
        instrumental (V8/F17) é pulado nas DUAS fontes, com contagem
        própria no Resumo — nem o --forcar o devolve à fila.

    enriquecer PASTA [--csv proposta.csv] [--interativo | --auto]
               [--forcar] [--sem-temas-de-pastas] [--verboso]
        Identifica cada MP3 sozinho (tags + nome de arquivo + duração vs.
        busca do LRCLIB /api/search), classifica a proposta em ALTA/MÉDIA/
        BAIXA e propõe título/artista/letra + temas das subpastas. Modos:
        padrão gera proposta (stdout e --csv); --interativo pergunta por
        arquivo (ALTA/MÉDIA: [Enter] aceitar  [p] pular  [t] só temas
        [q] sair; BAIXA: [Enter] pular  [a] aceitar  [t] só temas  [q] sair);
        --auto aplica na hora somente as ALTA. --forcar reprocessa arquivos
        completos e permite sobrescrever letra existente. --verboso mostra
        cada consulta enviada, quantos resultados voltaram e o melhor
        candidato. Proposta BAIXA nunca sobrescreve título/artista
        existentes — só preenche campos vazios (em qualquer modo).

    aplicar-proposta PASTA --csv proposta.csv [--dry-run] [--forcar]
        Aplica as linhas com aceitar=SIM do CSV gerado pelo enriquecer
        (título/artista/temas; letra re-buscada por /api/get/{lrclib_id}
        na hora). --dry-run só relata (bytes intactos, sem rede).

    transcrever PASTA [--modelo M] [--idioma pt] [--trecho SEGUNDOS]
                [--so-identificar | --so-transcrever]
                [--forcar | --forcar-tudo] [--sobrescrever-tags]
                [--csv saida.csv] [--verboso]
        V5/F14. Transcreve um trecho (90 s a partir de 20 s) com o
        faster-whisper (dependência OPCIONAL, na CPU), extrai o refrão —
        as frases curtas mais repetidas — e tenta identificar a música no
        LRCLIB por track_name + duração (F14.1); casando, grava a letra
        OFICIAL e preenche só os campos vazios de título/artista. Sem
        casar, transcreve a música inteira e grava o texto no USLT com
        TXXX:LETRA_ORIGEM="transcricao" (F14.2). Como o candidato vem do
        ÁUDIO, casar não prova nada: título/artista REAIS nunca são
        sobrescritos (nem em ALTA) sem --sobrescrever-tags, e divergência
        vira CONFLITO relatado sem gravar nada. Letra existente só é
        reprocessada com --forcar (a que veio de transcrição) ou
        --forcar-tudo (qualquer uma, inclusive oficial). V8/F17:
        transcrição vazia com áudio LEGÍVEL marca o arquivo como
        instrumental (balde próprio no Resumo) em vez de virar erro —
        áudio ilegível continua erro —, e arquivo já marcado é pulado
        antes de qualquer transcrição, inclusive com --forcar-tudo.
        Alucinações do motor ("música", "legendas pela comunidade
        Amara.org") e frases de uma palavra nunca viram consulta.
        V8.2: transcrição RALA só marca instrumental quando a duração do
        áudio pôde ser PROVADA (medida pelo transcritor ou quadro a quadro
        no MP3 — o cabeçalho sozinho não é medição, ver
        `duracao_confirmada`); sem prova o arquivo sai como ADIADA, com
        balde próprio, e nada é gravado.

    identificar PASTA [--chave CHAVE] [--com-letra] [--csv saida.csv]
                [--sobrescrever-tags] [--verboso]
        V6/F15. Impressão digital acústica: calcula a assinatura do áudio
        com o fpcalc (Chromaprint, dependência externa OPCIONAL), consulta
        o AcoustID (chave gratuita em --chave ou ACOUSTID_API_KEY, nunca
        gravada em disco) e aplica o melhor candidato — pontuação >= 0,7 E
        duração compatível pelas MESMAS regras da V3 (±3s ALTA, ≤15s
        MÉDIA, >15s desqualifica). Custa ~1-2 s por música: é a etapa 3 do
        funil, antes da transcrição (~30-80 s). Travas idênticas às da V5,
        porque o candidato também vem do ÁUDIO: título/artista REAIS nunca
        são sobrescritos sem --sobrescrever-tags, divergência vira
        CONFLITO sem gravar nada, e resultado com título/artista de
        placeholder é descartado. --com-letra encadeia a busca da letra
        OFICIAL no LRCLIB com o título/artista confirmados (sem marcador
        de transcrição, e sem tocar em letra existente) e, no que ele não
        tiver, no Vagalume (--chave-vagalume ou VAGALUME_API_KEY). Em
        arquivo marcado como instrumental (V8/F17) a busca de letra é
        pulada, mas a impressão digital RODA: instrumental sem letra ainda
        pode (e deve) ter título e artista corretos.

    estimar PASTA [--amostra N] [--verboso]
        V6/F15.1. Conta os arquivos, quantos estão incompletos, mede uma
        amostra e projeta o tempo de cada etapa do funil neste computador.
        Não grava nada e não baixa nada: sem fpcalc a identificação sai da
        média publicada e a transcrição sai sempre da proporção publicada
        do faster-whisper — a saída diz quando o número é medido e quando
        é projetado. A média de duração sai da duração CONFIRMADA de cada
        arquivo da amostra (V8.2), e o instrumental (F17) não conta como
        pendência: as duas coisas inflavam a projeção.

    temas-de-pastas PASTA [--aplicar]
        Cada subpasta do caminho relativo vira um tema (normalizado, V2),
        SOMADO aos existentes; MP3 na raiz não ganha tema. Sem --aplicar,
        só mostra o que faria.

Reutiliza embed_lyrics.py para toda a lógica de USLT e TXXX:TEMAS.
"""

from __future__ import annotations
import argparse
import csv
import difflib
import html
import json
import mmap
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import embed_lyrics as el  # noqa: E402
from mutagen.id3 import TIT2, TPE1, Encoding  # noqa: E402
from mutagen.mp3 import MP3  # noqa: E402

USER_AGENT = "Cancioneiro/0.3"
LRCLIB_URL = "https://lrclib.net/api/get"
LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"
TIMEOUT_S = 10
PAUSA_S = 0.3  # cortesia com a API entre buscas
CSV_COLUNAS = ["arquivo", "titulo", "artista", "tem_letra", "temas",
               "letra_arquivo"]
BUSCA_COLUNAS = ["arquivo", "titulo", "artista", "status", "caracteres"]
ENRIQUECER_COLUNAS = ["arquivo", "titulo_atual", "artista_atual",
                      "titulo_proposto", "artista_proposto", "confianca",
                      "duracao_mp3", "duracao_encontrada", "letra",
                      "temas_propostos", "lrclib_id", "aceitar"]
TRANSCREVER_COLUNAS = ["arquivo", "acao", "titulo", "artista", "confianca",
                       "candidatos", "caracteres", "detalhe"]
PROMPT_INTERATIVO = "[Enter] aceitar  [p] pular  [t] só temas  [q] sair "
# BAIXA é só palpite: aceitar exige gesto explícito; Enter (reflexo) PULA.
PROMPT_INTERATIVO_BAIXA = "[Enter] pular  [a] aceitar  [t] só temas  [q] sair "
# Ruído típico de nome de arquivo baixado (dentro de () e []).
_RE_COLCHETES = re.compile(r"\[[^\]]*\]")
_RE_PARENTESES = re.compile(r"\([^)]*\)")
_RE_FAIXA = re.compile(r"^\s*\(?\d{1,3}\)?\s*[-.)]*\s+")


def die(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def validar_pasta(pasta: Path) -> None:
    if not pasta.is_dir():
        die(f"ERRO: pasta inválida: {pasta}")


def listar_mp3s(pasta: Path) -> list[Path]:
    """Todos os *.mp3 da pasta, recursivo e case-insensitive, ordenados."""
    return sorted(
        (p for p in pasta.rglob("*")
         if p.is_file() and p.suffix.lower() == ".mp3"),
        key=lambda p: p.relative_to(pasta).as_posix(),
    )


def ler_info(path: Path) -> dict:
    """Lê as tags (e a duração) de um MP3; corrompido/ilegível não aborta."""
    try:
        audio = MP3(str(path))  # valida que ha um stream MPEG real
        tags = el.load_tags(path)
    except Exception:
        return {"ilegivel": True, "titulo": "", "artista": "",
                "letra": "", "temas": [], "duracao": 0.0, "letra_origem": "",
                "instrumental": False}
    uslt = tags.getall("USLT")
    return {
        "ilegivel": False,
        "titulo": str(tags["TIT2"]) if "TIT2" in tags else "",
        "artista": str(tags["TPE1"]) if "TPE1" in tags else "",
        "letra": str(uslt[0].text) if uslt and uslt[0].text else "",
        "temas": el.read_temas(tags),
        "duracao": float(audio.info.length or 0.0),
        "letra_origem": el.read_letra_origem(tags),
        # V8/F17: a marca viaja no MP3 e todo subcomando enxerga daqui
        "instrumental": el.read_instrumental(tags),
    }


# ------------------------------------------- a duração que se pode PROVAR
#
# Achado CRÍTICO do QA (V8.2). `mutagen.mp3.MP3().info.length` NÃO é uma
# medição: quando o MP3 não tem cabeçalho Xing/Info/VBRI — arquivo
# remontado, cortado, editado à mão ou com uma entrada de bitrate baixo,
# tudo rotina num acervo montado à mão — o mutagen ESTIMA a duração
# assumindo que o arquivo inteiro tem o bitrate do PRIMEIRO quadro. O QA
# mediu `real 300 s -> mutagen 2260,3 s` (7,5x) e reproduziu a consequência:
# uma música cantada, com 631 caracteres de letra legítima, foi marcada
# como INSTRUMENTAL por "0,28 caractere por segundo" e perdeu a letra para
# sempre (a marca vence até o --forcar-tudo; desfazer é comando de
# terminal, no produto que promete não ter terminal).
#
# Nem o `sketchy` do mutagen denuncia isso: ele fica False assim que
# quatro quadros válidos aparecem seguidos, o que o arquivo remontado tem.
#
# A saída é medir. A duração de um MP3 é a soma da duração de CADA quadro
# MPEG, e cada quadro DIZ a sua no próprio cabeçalho de 4 bytes (amostras
# por quadro / taxa de amostragem). Percorrer os cabeçalhos é offline, não
# depende de dependência opcional nenhuma, não decodifica áudio e custa
# poucos milissegundos por arquivo (medido: ~0,25 ms por 250 kB) — barato
# o bastante para rodar antes de cada decisão que dependa da duração, e
# caro demais para rodar em varredura que não precisa dela (por isso é
# chamada no ponto de uso, e não dentro do `ler_info`).
#
# Ordem de autoridade das fontes de duração, da mais forte para a mais
# fraca:
#   1. o TRANSCRITOR, que decodificou o áudio inteiro (verdade de campo, e
#      de graça: ele já sabe — ver `criar_transcritor`);
#   2. esta medição por quadros;
#   3. o `fpcalc`, que também devolve a duração real (já é a fonte
#      preferida do `identificar`, ver cmd_identificar);
#   4. o cabeçalho — que só vale quando alguma das anteriores o confirma.
#
# Sem nenhuma das três primeiras, a duração NÃO é prova de nada, e a ação
# segura é não marcar: o erro de deixar um instrumental na fila custa uma
# nova passada; o erro de marcar uma música cantada custa a letra dela,
# para sempre, na máquina de alguém que não tem a quem pedir socorro.

# Tabelas do padrão MPEG-1/2/2.5 Layer I-III (bitrate em kbps por índice).
_BITRATES_MPEG = {
    (1, 1): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384,
             416, 448],
    (1, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
             384],
    (1, 3): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256,
             320],
    (2, 1): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224,
             256],
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_BITRATES_MPEG[(2, 3)] = _BITRATES_MPEG[(2, 2)]
_TAXAS_MPEG = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000],
               2.5: [11025, 12000, 8000]}
# Quadro estranho no meio do fluxo acontece (tag alheia, resto de corte).
# Acima desta fração de bytes ignorados a medição não é confiável e o
# arquivo sai SEM duração provada — melhor nenhuma resposta que uma errada.
# O teto absoluto existe para o pior caso (arquivo grande e todo
# corrompido) não virar um laço de milhões de passos: passar dele é
# desistir, que é justamente o lado seguro.
_MAX_FRACAO_LIXO = 0.05
_MAX_LIXO_BYTES = 1 << 20
_MIN_QUADROS = 8


def _ler_quadro(cab: bytes):
    """(bytes do quadro, segundos do quadro) do cabeçalho MPEG de 4 bytes,
    ou None se aqueles 4 bytes não são um cabeçalho válido."""
    if len(cab) < 4:
        return None
    b1, b2 = cab[1], cab[2]
    if cab[0] != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    versao = (2.5, None, 2, 1)[(b1 >> 3) & 0x03]
    camada = 4 - ((b1 >> 1) & 0x03)
    if versao is None or camada == 4:
        return None
    indice_bitrate = (b2 >> 4) & 0x0F
    indice_taxa = (b2 >> 2) & 0x03
    padding = (b2 >> 1) & 0x01
    # 0 = formato livre (não dá para calcular o tamanho), 15 = inválido
    if indice_bitrate in (0, 15) or indice_taxa == 3:
        return None
    bitrate = _BITRATES_MPEG[(1 if versao == 1 else 2, camada)][indice_bitrate]
    bitrate *= 1000
    taxa = _TAXAS_MPEG[versao][indice_taxa]
    if camada == 1:
        amostras = 384
        tamanho = ((12 * bitrate) // taxa + padding) * 4
    else:
        amostras = 1152 if (camada == 2 or versao == 1) else 576
        tamanho = (amostras // 8 * bitrate) // taxa + padding
    if tamanho < 4:
        return None
    return tamanho, amostras / float(taxa)


def _pular_id3(dados, pos: int, total: int) -> int:
    """Se em `pos` começa um bloco ID3v2, devolve a posição depois dele."""
    if dados[pos:pos + 3] != b"ID3" or pos + 10 > total:
        return pos
    tamanho = 0
    for byte in dados[pos + 6:pos + 10]:
        tamanho = (tamanho << 7) | (byte & 0x7F)
    fim = pos + 10 + tamanho
    if dados[pos + 5] & 0x10:   # bit de rodapé
        fim += 10
    return fim


def medir_duracao_por_quadros(path) -> float | None:
    """Duração REAL do MP3 em segundos, somando quadro a quadro — ou None
    quando o fluxo não pôde ser percorrido com confiança.

    Só LÊ o arquivo (nunca escreve, nunca renomeia) e nunca levanta: um
    arquivo que não é MP3 devolve None, como qualquer outro problema.

    A leitura é por `mmap`: percorrer cabeçalhos não exige carregar o
    arquivo inteiro na memória, e um acervo tem arquivos de centenas de MB
    (set de duas horas) em máquinas modestas.
    """
    try:
        with open(str(path), "rb") as fh:
            try:
                dados = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
            except (ValueError, OSError):   # arquivo vazio, /proc, etc.
                return _somar_quadros(fh.read())
            try:
                return _somar_quadros(dados)
            finally:
                dados.close()
    except OSError:
        return None


def _somar_quadros(dados) -> float | None:
    """O laço de medição, sobre bytes ou sobre um mmap."""
    total = len(dados)
    if total < 4:
        return None
    limite_lixo = max(64, min(int(total * _MAX_FRACAO_LIXO),
                              _MAX_LIXO_BYTES))
    pos = _pular_id3(dados, 0, total)
    segundos = 0.0
    quadros = 0
    lixo = 0
    while pos + 4 <= total:
        quadro = _ler_quadro(dados[pos:pos + 4])
        if quadro is None:
            depois = _pular_id3(dados, pos, total)
            if depois > pos:            # tag ID3 no meio do fluxo
                pos = depois
                continue
            if dados[pos:pos + 3] == b"TAG" and total - pos <= 128:
                break                   # ID3v1 no fim: acabou o áudio
            # ressincroniza no próximo 0xFF possível, contando o desperdício
            seguinte = dados.find(b"\xff", pos + 1)
            if seguinte < 0:
                lixo += total - pos
                break
            lixo += seguinte - pos
            if lixo > limite_lixo:
                return None
            pos = seguinte
            continue
        tamanho, duracao_quadro = quadro
        if pos + tamanho > total:       # último quadro cortado
            break
        segundos += duracao_quadro
        quadros += 1
        pos += tamanho
    if quadros < _MIN_QUADROS or lixo > limite_lixo or segundos <= 0:
        return None
    return segundos


# O cabeçalho é aceito como prova quando a medição concorda com ele. A
# folga cobre o quadro do próprio Xing e o atraso do codificador (dezenas
# de milissegundos), não erro de ordem de grandeza.
TOLERANCIA_DURACAO_S = 1.0
TOLERANCIA_DURACAO_FRACAO = 0.02


def _duracoes_batem(cabecalho: float, medida: float) -> bool:
    folga = max(TOLERANCIA_DURACAO_S, TOLERANCIA_DURACAO_FRACAO * medida)
    return abs(float(cabecalho or 0.0) - medida) <= folga


def duracao_confirmada(path, info: dict, medida: float | None = None,
                       do_transcritor: float = 0.0) -> float:
    """A duração em segundos que este programa consegue PROVAR — ou 0,0.

    0,0 é o valor que o resto do código já trata como "sem duração": o
    `_identificar`, o `_identificar_por_refrao` e o `escolher_candidato`
    não classificam por duração quando ela é falsa, e o `sem_conteudo` não
    mede densidade. Ou seja: sem prova, nada de decisão automática.

    Quando o cabeçalho concorda com a medição, devolve o número DO
    CABEÇALHO — assim nenhum arquivo saudável muda de duração por causa
    desta rotina.
    """
    if do_transcritor and do_transcritor > 0:
        return float(do_transcritor)
    if info.get("ilegivel"):
        return 0.0
    if medida is None:
        medida = medir_duracao_por_quadros(path)
    if not medida or medida <= 0:
        return 0.0
    cabecalho = float(info.get("duracao") or 0.0)
    return cabecalho if _duracoes_batem(cabecalho, medida) else float(medida)


def rotulo_letra(info: dict) -> str:
    """Coluna "letra" do relatório: NÃO, INSTRUMENTAL, SIM, SIM (transcrição),
    SIM (Vagalume) ou SIM (lyrics.ovh) — o selo de procedência
    (TXXX:LETRA_ORIGEM).

    "(transcrição)" continua EXCLUSIVO da letra saída do áudio (V5/F14):
    é o rótulo que o curador aprendeu a ler como "isto pode estar errado".
    "(Vagalume)" e "(lyrics.ovh)" são letra OFICIAL, mas de fontes que a
    duração não pôde confirmar (V6.1, V10) — e o lyrics.ovh não devolve nem
    o nome da música, então o casamento dele nunca foi conferido por
    ninguém. Origem desconhecida (arquivo gravado por uma versão futura)
    cai no SIM genérico, nunca em transcrição.

    Os rótulos são escritos aqui, e não lidos do `ORIGEM_ROTULOS` do
    embed_lyrics, de propósito: lá "transcrição automática" é uma frase de
    ficha; aqui "(transcrição)" é uma coluna estreita que o curador aprendeu
    a reconhecer. Unificar os dois trocaria um vocabulário estabelecido por
    economia de três linhas.

    V8/F17: INSTRUMENTAL toma o lugar do NÃO — informação, não cobrança,
    igualzinho ao que o player faz com o selo cinza "Sem letra". A letra
    registrada MANDA na coluna de letra: instrumental que ainda assim tem
    letra (raro, mas possível) aparece como SIM/SIM (transcrição) e não
    perde a marca por isso — quem quer o estado da marca lê o
    "N instrumentais" do resumo, o CSV ou o `embed_lyrics --check`."""
    if not info["letra"]:
        return "INSTRUMENTAL" if info.get("instrumental") else "NÃO"
    origem = info.get("letra_origem") or ""
    if origem == el.ORIGEM_TRANSCRICAO:
        return "SIM (transcrição)"
    if origem == el.ORIGEM_VAGALUME:
        return "SIM (Vagalume)"
    if origem == el.ORIGEM_LYRICS_OVH:
        return "SIM (lyrics.ovh)"
    return "SIM"


def gravar_csv(path: Path, colunas: list[str], linhas: list[list]) -> None:
    """CSV UTF-8 com BOM (utf-8-sig) — abre direto no Excel."""
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(colunas)
        writer.writerows(linhas)


# ---------------------------------------------------------------- relatorio

def cmd_relatorio(pasta: Path, csv_out: Path | None = None) -> None:
    itens = []
    for p in listar_mp3s(pasta):
        rel = p.relative_to(pasta).as_posix()
        itens.append((rel, ler_info(p)))

    header = ["arquivo", "título", "artista", "letra", "temas"]
    linhas_tabela = []
    com_letra = com_temas = instrumentais = 0
    for rel, info in itens:
        if info["ilegivel"]:
            titulo = "(ilegível)"
        else:
            titulo = info["titulo"] or "—"
        artista = info["artista"] or "—"
        letra = rotulo_letra(info)
        temas = "; ".join(info["temas"]) or "—"
        if info["letra"]:
            com_letra += 1
        if info["temas"]:
            com_temas += 1
        if info["instrumental"]:
            instrumentais += 1
        linhas_tabela.append([rel, titulo, artista, letra, temas])

    larguras = [max(len(linha[i]) for linha in [header] + linhas_tabela)
                for i in range(len(header))] if linhas_tabela else \
               [len(c) for c in header]
    for linha in [header] + linhas_tabela:
        print("  ".join(campo.ljust(larguras[i])
                        for i, campo in enumerate(linha)).rstrip())

    total = len(itens)
    # "instrumentais" é RECORTE, não balde: um instrumental sem letra também
    # é contado em "sem letra" (a conta de letra continua a mesma de antes).
    print(f"Resumo: {total} arquivos | {com_letra} com letra | "
          f"{total - com_letra} sem letra | {com_temas} com temas | "
          f"{instrumentais} instrumentais")

    if csv_out is not None:
        linhas_csv = []
        for rel, info in itens:
            linhas_csv.append([
                rel,
                info["titulo"],  # ilegível fica vazio: seguro p/ round-trip
                info["artista"],
                rotulo_letra(info),
                "; ".join(info["temas"]),
                "",  # letra_arquivo: o usuário preenche no fluxo de aplicar
            ])
        gravar_csv(csv_out, CSV_COLUNAS, linhas_csv)


# ---------------------------------------------------------------- aplicar

def _ler_letra_do_plano(letra_arquivo: str, csv_dir: Path) -> str | None:
    """Resolve o caminho (relativo ao CSV ou absoluto) e lê o texto."""
    lp = Path(letra_arquivo)
    if not lp.is_absolute():
        lp = csv_dir / lp
    if not lp.is_file():
        return None
    return lp.read_text(encoding="utf-8")


def cmd_aplicar(pasta: Path, csv_path: Path, dry_run: bool = False) -> None:
    if not csv_path.is_file():
        die(f"ERRO: CSV inválido ou não encontrado: {csv_path}")
    alterados = pulados = avisos = 0
    with open(csv_path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            arquivo = (row.get("arquivo") or "").strip()
            if not arquivo:
                continue
            alvo = pasta / arquivo
            if not alvo.is_file():
                print(f"AVISO: arquivo não encontrado: {arquivo}")
                avisos += 1
                continue
            titulo = (row.get("titulo") or "").strip()
            artista = (row.get("artista") or "").strip()
            temas_raw = (row.get("temas") or "").strip()
            letra_arquivo = (row.get("letra_arquivo") or "").strip()

            letra = None
            if letra_arquivo:
                letra = _ler_letra_do_plano(letra_arquivo, csv_path.parent)
                if letra is None:
                    print("AVISO: arquivo de letra não encontrado: "
                          f"{letra_arquivo}")
                    avisos += 1

            gravados = []
            if titulo:
                gravados.append("titulo")
            if artista:
                gravados.append("artista")
            if temas_raw:
                gravados.append("temas")
            if letra is not None:
                gravados.append("letra")
            if not gravados:
                pulados += 1
                continue

            if not dry_run:
                try:
                    if letra is not None:
                        # reuso: USLT (+TIT2/TPE1 opcionais) do embed_lyrics
                        el.embed_lyrics(alvo, letra, title=titulo or None,
                                        artist=artista or None)
                    elif titulo or artista:
                        tags = el.load_tags(alvo)
                        if titulo:
                            tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8,
                                                      text=[titulo])])
                        if artista:
                            tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8,
                                                      text=[artista])])
                        el.save_tags(tags, alvo)  # gravação atômica
                    if temas_raw:
                        el.write_temas(alvo, el.normalize_temas(
                            el.split_temas_input(temas_raw)))
                except Exception:
                    print(f"AVISO: falha ao gravar: {arquivo}")
                    avisos += 1
                    continue

            print(f"OK: {arquivo} ({', '.join(gravados)})")
            alterados += 1

    print(f"Resumo: {alterados} alterados | {pulados} sem mudanças | "
          f"{avisos} avisos")


# ---------------------------------------------------------------- buscar-letra

def default_fetcher(url: str) -> str:
    """GET com User-Agent e timeout; retorna o corpo (str). Levanta em erro."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8")


def fetch_lyrics(artist: str, title: str, fetcher=None) -> str | None:
    """Consulta o LRCLIB; retorna plainLyrics, None se não achou (404 ou
    faixa instrumental) e propaga erros de rede para o chamador tratar."""
    fetcher = fetcher or default_fetcher
    query = urllib.parse.urlencode({"artist_name": artist,
                                    "track_name": title})
    try:
        body = fetcher(f"{LRCLIB_URL}?{query}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    letra = json.loads(body).get("plainLyrics")
    return letra if letra else None


def cmd_buscar_letra(pasta: Path, aplicar: bool = False,
                     csv_out: Path | None = None, fetcher=None,
                     chave_vagalume: str = "", pausa: float = PAUSA_S,
                     forcar: bool = False, verboso: bool = False) -> None:
    """Busca a letra de cada MP3 sem letra que tenha título E artista.

    Duas fontes, nesta ordem: o LRCLIB (confirmável, etapa 2 do funil) e,
    só no que ele não tiver, o Vagalume (V6.1 — ver buscar_letra_vagalume,
    inclusive por que ele NÃO pode ser confirmado pela duração). Sem chave
    do Vagalume, o comando roda exatamente como antes, com uma linha
    dizendo o que foi pulado — e essa linha só sai quando houve mesmo um
    arquivo em que o Vagalume teria entrado.

    Arquivo que já tem letra nunca é tocado nem consultado: preencher o
    vazio é o trabalho, trocar letra curada não. --forcar abre a exceção
    que o acervo real exigiu (V6.2): quem já rodou o `transcrever` em tudo
    tem letra de MÁQUINA em cada arquivo, e sem isto a segunda fonte não
    alcança justamente o repertório para o qual foi ligada. A semântica é
    a mesma já estabelecida no `transcrever --forcar` — reprocessa SÓ o que
    veio de transcrição; letra OFICIAL (inclusive a do Vagalume) não é
    tocada. Achando letra oficial, o marcador de transcrição some junto."""
    encontradas = nao_encontradas = erros = por_vagalume = 0
    instrumentais = 0
    linhas_csv = []
    log = print if verboso else None
    chave_vagalume = (chave_vagalume or "").strip()
    estado_aviso = {"dito": False}

    def avisar_sem_chave():
        """O aviso é sobre uma consulta que teria acontecido — não sai em
        pasta vazia nem para quem nunca precisou do Vagalume."""
        if not estado_aviso["dito"]:
            print(MSG_VAGALUME_PULADO)
            estado_aviso["dito"] = True

    estado = {"primeira": True}

    def cortesia():
        """Pausa entre consultas ao Vagalume (a leg nova); a do LRCLIB
        segue como sempre foi."""
        if not estado["primeira"] and pausa:
            time.sleep(pausa)
        estado["primeira"] = False

    for p in listar_mp3s(pasta):
        rel = p.relative_to(pasta).as_posix()
        info = ler_info(p)
        if info["ilegivel"]:
            continue
        if info["instrumental"]:
            # V8/F17: música sem voz não tem letra a buscar, em fonte
            # nenhuma. Vem ANTES do --forcar de propósito: o --forcar fala
            # de letra de MÁQUINA a refazer, não de rediscutir a marca.
            print(f"PULADO: {rel} (instrumental)")
            instrumentais += 1
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "instrumental", ""])
            continue
        if info["letra"]:
            # com --forcar, letra de MÁQUINA volta para a fila; letra
            # oficial (sem marca ou marcada como Vagalume) nunca
            if not forcar:
                continue
            if info["letra_origem"] != el.ORIGEM_TRANSCRICAO:
                print(f"PULADO: {rel} (letra oficial — --forcar reprocessa "
                      "só transcrição)")
                continue
        if not (info["titulo"] and info["artista"]):
            continue
        try:
            letra = fetch_lyrics(info["artista"], info["titulo"],
                                 fetcher=fetcher)
        except Exception:
            print(f"ERRO DE REDE: {rel}")
            erros += 1
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "erro de rede", ""])
            continue
        fonte = "lrclib"
        if not letra and not chave_vagalume:
            avisar_sem_chave()
        if not letra and chave_vagalume:
            # o LRCLIB não tem: segunda fonte, com a disciplina de
            # casamento de buscar_letra_vagalume
            try:
                cortesia()
                letra = buscar_letra_vagalume(
                    info["titulo"], info["artista"], chave_vagalume,
                    fetcher=fetcher, log=log)
            except KeyboardInterrupt:
                raise
            except Exception:
                print(f"ERRO DE REDE: {rel} (Vagalume)")
                erros += 1
                linhas_csv.append([rel, info["titulo"], info["artista"],
                                   "erro de rede (vagalume)", ""])
                continue
            fonte = "vagalume"
        if letra:
            marca = "" if fonte == "lrclib" else " (Vagalume)"
            print(f"ENCONTRADA{marca}: {rel} ({len(letra)} caracteres)")
            encontradas += 1
            if fonte == "vagalume":
                por_vagalume += 1
            if aplicar:
                # reuso: USLT do embed_lyrics. A origem marca só o
                # Vagalume; letra do LRCLIB continua sem marca (e origem=""
                # LIMPA marca herdada, DECISIONS #54).
                el.embed_lyrics(p, letra,
                                origem=(el.ORIGEM_VAGALUME
                                        if fonte == "vagalume" else ""))
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "encontrada" if fonte == "lrclib"
                               else "encontrada (vagalume)", len(letra)])
        else:
            print(f"NÃO ENCONTRADA: {rel}")
            nao_encontradas += 1
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "não encontrada", ""])

    # "pelo Vagalume" é um recorte das encontradas, não um balde à parte:
    # encontradas = as do LRCLIB + as do Vagalume.
    print(f"Resumo: {encontradas} encontradas | "
          f"{nao_encontradas} não encontradas | {erros} erros de rede | "
          f"{por_vagalume} pelo Vagalume | "
          f"{instrumentais} instrumentais")

    if csv_out is not None:
        gravar_csv(csv_out, BUSCA_COLUNAS, linhas_csv)


# ---------------------------------------------------------------- enriquecer

def limpar_consulta(texto: str) -> str:
    """Limpa o texto para a busca q= do LRCLIB: remove pontuação e hífens
    soltos (a busca full-text é sensível a eles) e colapsa espaços,
    preservando acentos e caixa. Trabalha em NFC: texto NFD (nomes de
    arquivo do macOS) é recomposto antes, para o combining char não virar
    espaço e PARTIR a palavra ("Música" NFD ficava "Mu sica"); combining
    char que sobrar sem recompor é removido SEM inserir espaço."""
    texto = unicodedata.normalize("NFC", texto)
    base = "".join(
        "" if unicodedata.combining(c)
        else (c if (c.isalnum() or c.isspace()) else " ")
        for c in texto)
    return " ".join(base.split())


def fetch_search(query: str = "", fetcher=None, track_name: str = "",
                 artist_name: str = "") -> list:
    """Busca no LRCLIB (/api/search); retorna a lista de resultados.
    Com track_name/artist_name usa os parâmetros dedicados da API (busca
    por campo, mais precisa); senão, q= com o texto limpo
    (limpar_consulta). Propaga erros de rede para o chamador tratar."""
    fetcher = fetcher or default_fetcher
    if track_name or artist_name:
        qs = urllib.parse.urlencode({"track_name": track_name,
                                     "artist_name": artist_name})
    else:
        qs = urllib.parse.urlencode({"q": limpar_consulta(query)})
    dados = json.loads(fetcher(f"{LRCLIB_SEARCH_URL}?{qs}"))
    return dados if isinstance(dados, list) else []


def fetch_lyrics_by_id(lrclib_id: str, fetcher=None) -> str | None:
    """Busca uma faixa pelo id (/api/get/{id}); retorna plainLyrics, None se
    não achou (404 ou instrumental) e propaga erros de rede."""
    fetcher = fetcher or default_fetcher
    try:
        body = fetcher(f"{LRCLIB_URL}/{lrclib_id}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    letra = json.loads(body).get("plainLyrics")
    return letra if letra else None


def _norm_comparacao(texto: str) -> str:
    """Chave de similaridade: minúsculas, sem acento (NFD, reuso do
    embed_lyrics), sem pontuação, espaços colapsados."""
    base = el._sem_acento(texto)
    base = "".join(c if (c.isalnum() or c.isspace()) else " " for c in base)
    return " ".join(base.split())


def similaridade(a: str, b: str) -> float:
    """Similaridade textual (difflib) entre strings normalizadas."""
    return difflib.SequenceMatcher(None, _norm_comparacao(a),
                                   _norm_comparacao(b)).ratio()


# Placeholders de ripador/CDDB ("AudioTrack 02", "Faixa 8", "no artist"...):
# não identificam nada. Comparação sobre a chave _norm_comparacao (minúscula,
# sem acento, sem pontuação — "[Unknown Artist]" vira "unknown artist").
_RE_PLACEHOLDER_FAIXA = re.compile(
    r"^(?:\d+\s+)?(?:(?:audio\s?track|faixa|track)(?:\s?\d+)?|pista\s?\d+)$")
_PLACEHOLDERS_EXATOS = frozenset({
    "artist", "no artist", "unknown artist", "artista desconhecido",
    "artista desconhecida", "unknown", "desconhecido", "desconhecida",
    "no title", "sem titulo", "untitled", "unknown title",
    "titulo desconhecido",
})
# Expressões que, aparecendo em QUALQUER posição, denunciam tag de ripador —
# nenhum artista ou título real as contém. "artista desconheci" sem o final
# cobre o truncamento de campo do ID3 visto no acervo real.
_PLACEHOLDERS_TRECHO = (
    "artista desconheci", "artista desconhecida", "unknown artist",
    "no artist", "titulo desconheci", "unknown title",
)
# Palavras de maquinário: NÃO identificam a música, mas várias delas são
# título de verdade quando aparecem sozinhas ("Pista", "Gravação", "Nome",
# "Sem Nome" existem no repertório). Por isso esta lista sozinha NUNCA
# condena um texto — ver _MARCA_DE_RIPADOR abaixo.
_RUIDO_DE_ARQUIVO = frozenset({
    "audiotrack", "audio", "track", "faixa", "pista", "converted",
    "convertido", "copia", "copy", "mp3", "wav", "untitled", "new",
    "recording", "gravacao", "sem", "titulo", "nome",
})
# Marca de ripador: só ELA habilita a regra do _RUIDO_DE_ARQUIVO. Vale um
# número solto ("04", "2010"), uma corrida com cara de horário/data
# ("22-17-23") ou uma palavra que nenhuma canção usa como título.
#
# Regressão do 86e6e94 (achado ALTO do QA): sem esta exigência, "Gravação",
# "Nome" e "Sem Nome" viravam placeholder — ou seja, campo VAZIO — e o
# título REAL do curador era sobrescrito em silêncio pelo identificado, sem
# --sobrescrever-tags, sem CONFLITO e sem nota no CSV. Uma palavra comum
# sozinha nunca é lixo; precisa da companhia da marca.
_MARCA_DE_RIPADOR = frozenset({
    "audiotrack", "converted", "convertido", "mp3", "wav", "untitled",
})
_RE_CARA_DE_HORARIO = re.compile(r"^\d{1,4}(?:[-:.]\d{1,2}){1,}$")

# V10 — `Various Artists` NÃO é artista.
#
# É o rótulo que o ripador escreve no lugar do artista quando o CD é uma
# coletânea, e é dos mais comuns que existem. Não estava em lista nenhuma:
# passava por artista REAL, então a música era dada como COMPLETA, sumia da
# curadoria para sempre, e ainda virava CONFLITO contra o artista verdadeiro
# que a etapa do som identificasse. As duas pilhas erravam igual.
#
# Comparação sobre a chave _norm_comparacao — "V.A." vira "v a", "[Various
# Artists]" vira "various artists", "Coletânea" vira "coletanea".
#
# A LIÇÃO DA DECISÃO 89 vale aqui, e é o que limita a lista: ao completar o
# lixo de ripador, o Rust passou a marcar "Pista" sozinha como placeholder, e
# "Pista" é título real no repertório. Placeholder é tratado como campo VAZIO
# (decisão 65) — apagar um título de verdade é o pior modo de falha do
# projeto. Por isso só entram rótulos que NENHUMA canção usa como nome:
# "Vai", "Vamos", "Valsa", "Variações", "Compilado", "Artista" ficam de fora,
# e há teste fixando cada um deles.
_ROTULOS_DE_COLETANEA = frozenset({
    "various artists", "various artist", "various",
    "varios artistas", "varias artistas", "varios interpretes",
    "varias interpretes", "artistas variados", "artistas diversos",
    "interpretes diversos", "varios", "varias", "diversos",
    "v a", "compilation", "compilacao", "coletanea", "coletaneas",
})

# A abreviação escrita SEM acento. "VA" é coletânea; "Vá" é o verbo, e o
# _norm_comparacao tira o acento — as duas chegariam à mesma chave. Duas
# letras não dão margem a mais nada, então a única prova disponível é o acento
# do texto ORIGINAL.
_ROTULOS_DE_COLETANEA_SEM_ACENTO = frozenset({"va"})


def _tem_acento(texto: str) -> bool:
    """True quando o texto original traz algum diacrítico."""
    return any(unicodedata.combining(c)
               for c in unicodedata.normalize("NFD", texto))


def _eh_rotulo_de_coletanea(chave: str, bruto: str) -> bool:
    """True quando o texto é o rótulo de uma COLETÂNEA, e não um nome."""
    if chave in _ROTULOS_DE_COLETANEA:
        return True
    return (chave in _ROTULOS_DE_COLETANEA_SEM_ACENTO
            and not _tem_acento(bruto))


def _tem_marca_de_ripador(chave: str, bruto: str) -> bool:
    """True quando o texto traz prova de que saiu de uma máquina."""
    if any(p.isdigit() or p in _MARCA_DE_RIPADOR for p in chave.split()):
        return True
    # "1-2010 22-17-23)_converted": a pontuação some no _norm_comparacao,
    # então a cara de horário é conferida no texto original
    return any(_RE_CARA_DE_HORARIO.match(p) for p in bruto.split())


def eh_placeholder(texto: str) -> bool:
    """True se o texto é placeholder (tag-lixo ou entrada-lixo do LRCLIB):
    vazio, só dígitos/pontuação, "AudioTrack N"/"Faixa N"/"Track N"/
    "Pista N" (com ou sem prefixo numérico), "no artist", "[Unknown
    Artist]", "Artista Desconhecido", "sem título", "untitled" etc.
    Case/acento-insensitive."""
    chave = _norm_comparacao(texto)
    if not chave or chave.isdigit():
        return True  # vazio, só pontuação/# ou só dígitos
    if chave in _PLACEHOLDERS_EXATOS:
        return True
    if _eh_rotulo_de_coletanea(chave, texto):
        return True
    if bool(_RE_PLACEHOLDER_FAIXA.match(chave)):
        return True
    # Lixo de ripador com sujeira em volta, visto no acervo real:
    # "04 Faixa 4 Artista Desconheci" (truncado pelo limite do ID3) e
    # "1-2010 22-17-23)_converted". Nenhum artista ou título de verdade
    # contém estas expressões, então a busca por trecho é segura.
    if any(marca in chave for marca in _PLACEHOLDERS_TRECHO):
        return True
    # Só números e palavras de maquinário ("converted", "faixa", "track"…)
    # E com marca de ripador junto: não sobra nada que identifique a música.
    # Sem a marca, uma palavra comum sozinha ("Gravação", "Nome") é TÍTULO.
    partes = chave.split()
    if len(partes) < 2 or not _tem_marca_de_ripador(chave, texto):
        # uma palavra sozinha é TÍTULO, sempre. "Convertido", "Gravação",
        # "Nome", "Pista" viram lixo só acompanhadas da marca da máquina.
        return False
    palavras = [p for p in partes
                if not p.isdigit() and p not in _RUIDO_DE_ARQUIVO]
    return not palavras


def _sem_placeholder(texto: str) -> str:
    """Tag placeholder é tratada como campo VAZIO em todos os pontos:
    não vira palpite, não bloqueia proposta BAIXA, não pula arquivo."""
    return "" if eh_placeholder(texto) else texto


def limpar_nome_arquivo(nome: str) -> str:
    """Limpa um nome de arquivo para virar palpite: remove a extensão e o
    número de faixa inicial; remove TODO conteúdo entre colchetes e entre
    parênteses (regra simples — cobre "(ao vivo)", "[official]" etc.),
    exceto quando remover os parênteses deixaria o nome vazio;
    underscores viram espaço e espaços são colapsados. O resultado sai em
    NFC (nomes do macOS chegam NFD) para o palpite nunca partir palavra."""
    s = unicodedata.normalize("NFC", Path(nome).stem).replace("_", " ")
    s = _RE_COLCHETES.sub(" ", s)
    sem_parenteses = _RE_PARENTESES.sub(" ", s)
    if sem_parenteses.strip():
        s = sem_parenteses
    s = _RE_FAIXA.sub("", s)
    return " ".join(s.split())


def gerar_palpites(nome_arquivo: str, titulo: str = "",
                   artista: str = "") -> list:
    """Palpites (título, artista) na ordem do PRD: tags existentes (título de
    tag com " - " e artista vazio também é dividido nas duas ordens — caso
    "Hyldon - Musica Bonita"); nome de arquivo dividido no primeiro " - "
    nas duas ordens (com 3+ segmentos — prefixo de pasta/coleção — também
    os DOIS ÚLTIMOS segmentos nas duas ordens); nome inteiro como título.
    Tag placeholder ("02 AudioTrack 02", "no artist"...) é tratada como
    vazia: NUNCA vira palpite — vale o nome do arquivo."""
    titulo = _sem_placeholder(titulo)
    artista = _sem_placeholder(artista)
    palpites = []
    if titulo:
        palpites.append((titulo, artista))
        if not artista and " - " in titulo:
            a, b = (parte.strip() for parte in titulo.split(" - ", 1))
            if a and b:
                palpites.append((b, a))  # Artista - Título
                palpites.append((a, b))  # Título - Artista
    limpo = limpar_nome_arquivo(nome_arquivo)
    if " - " in limpo:
        a, b = (parte.strip() for parte in limpo.split(" - ", 1))
        if a and b:
            palpites.append((b, a))  # Artista - Título
            palpites.append((a, b))  # Título - Artista
        segmentos = [s.strip() for s in limpo.split(" - ") if s.strip()]
        if len(segmentos) >= 3:  # "coleção - Título - Artista"
            penultimo, ultimo = segmentos[-2], segmentos[-1]
            palpites.append((penultimo, ultimo))  # Título - Artista
            palpites.append((ultimo, penultimo))  # Artista - Título
    if limpo:
        palpites.append((limpo, ""))
    vistos = set()
    unicos = []
    for palpite in palpites:
        if palpite not in vistos:
            vistos.add(palpite)
            unicos.append(palpite)
    return unicos


def classificar(sim: float, dif_duracao: float | None) -> str:
    """Confiança da proposta a partir da similaridade e da diferença de
    duração (segundos). Sem duração comparável não há bônus nem
    desclassificação: similaridade >= 0.85 ainda rende MÉDIA."""
    if dif_duracao is None:
        return "MÉDIA" if sim >= 0.85 else "BAIXA"
    if dif_duracao <= 3 and sim >= 0.6:
        return "ALTA"
    if dif_duracao <= 8 and sim >= 0.85:
        return "ALTA"
    if dif_duracao <= 15 and sim >= 0.5:
        return "MÉDIA"
    return "BAIXA"


def _identificar(palpites: list, duracao_mp3: float, buscar,
                 log=None) -> dict | None:
    """Consulta o LRCLIB para cada palpite e devolve o melhor candidato
    ({"sim", "dif", "res"}) ou None. Palpite com artista tenta primeiro a
    busca por campo (track_name/artist_name, mais precisa) e só cai para
    q= (texto limpo) se ela voltar vazia. Resultado com trackName OU
    artistName placeholder ("AudioTrack 02"/"Faixa 8"/"Artista
    Desconhecido") é DESCARTADO antes do score — e busca precisa que só
    devolveu lixo não conta como achado (o fallback q= ainda roda).
    Resultados com duração divergente >15 s são desclassificados; sem
    duração comparável (do MP3 ou do resultado), sem bônus nem
    desclassificação. Para no primeiro palpite que render ALTA.
    log (opcional) recebe as linhas do modo verboso."""
    log = log or (lambda _msg: None)
    melhor = None
    for titulo, artista in palpites:
        alvo = f"{titulo} {artista}".strip()
        consultas = []
        if artista:
            consultas.append({"track_name": titulo, "artist_name": artista})
        consultas.append({"query": alvo})
        for kwargs in consultas:
            if "track_name" in kwargs:
                log(f'  busca: track="{titulo}" artista="{artista}"')
            else:
                log(f'  busca: "{limpar_consulta(alvo)}"')
            try:
                resultados = buscar(**kwargs)
            except Exception as exc:
                log(f"  erro: {exc}")
                raise
            log(f"  {len(resultados)} resultados")
            validos = [res for res in resultados
                       if not (eh_placeholder(res.get("trackName") or "")
                               or eh_placeholder(res.get("artistName")
                                                 or ""))]
            if len(validos) < len(resultados):
                log(f"  {len(resultados) - len(validos)} "
                    "descartados (placeholder)")
            for res in validos:
                if artista:
                    candidato = (f"{res.get('trackName') or ''} "
                                 f"{res.get('artistName') or ''}")
                else:
                    candidato = res.get("trackName") or ""
                sim = similaridade(alvo if artista else titulo, candidato)
                duracao = res.get("duration")
                dif = (abs(duracao_mp3 - float(duracao))
                       if duracao is not None and duracao_mp3 else None)
                if dif is not None and dif > 15:
                    continue  # homônimo/versão errada: desclassificado
                bonus = 0.0
                if dif is not None:
                    bonus = 0.3 if dif <= 3 else (0.15 if dif <= 8 else 0.0)
                if melhor is None or sim + bonus > melhor["score"]:
                    melhor = {"score": sim + bonus, "sim": sim, "dif": dif,
                              "res": res}
            if validos:
                break  # a forma precisa achou algo (válido): sem fallback q=
        if melhor is not None and classificar(melhor["sim"],
                                              melhor["dif"]) == "ALTA":
            break
    return melhor


def temas_da_pasta(rel: str) -> list[str]:
    """Temas do caminho relativo: cada subpasta vira um tema (normalizado
    pelas regras da V2). MP3 direto na raiz não ganha tema."""
    return el.normalize_temas(list(Path(rel).parts[:-1]))


def _gravar_enriquecimento(path: Path, info: dict, titulo: str, artista: str,
                           letra: str, temas_novos: list,
                           forcar: bool, so_temas: bool = False) -> None:
    """Grava a proposta num MP3. Letra existente não-vazia só é sobrescrita
    com forcar; temas SOMAM aos existentes (nunca substituem)."""
    if not so_temas:
        if letra and (forcar or not info["letra"]):
            el.embed_lyrics(path, letra, title=titulo or None,
                            artist=artista or None)
        elif titulo or artista:
            tags = el.load_tags(path)
            if titulo:
                tags.setall("TIT2", [TIT2(encoding=Encoding.UTF8,
                                          text=[titulo])])
            if artista:
                tags.setall("TPE1", [TPE1(encoding=Encoding.UTF8,
                                          text=[artista])])
            el.save_tags(tags, path)  # gravação atômica
    if temas_novos:
        existentes = el.read_temas(el.load_tags(path))
        el.write_temas(path, el.normalize_temas(existentes + temas_novos))


def cmd_enriquecer(pasta: Path, csv_out: Path | None = None,
                   interativo: bool = False, auto: bool = False,
                   forcar: bool = False, temas_pastas: bool = True,
                   fetcher=None, pausa: float = PAUSA_S,
                   verboso: bool = False) -> None:
    contagem = {"ALTA": 0, "MÉDIA": 0, "BAIXA": 0}
    aplicados = erros = instrumentais = 0
    linhas_csv = []
    estado = {"primeira": True}
    log = print if verboso else None

    def buscar(query="", track_name="", artist_name=""):
        if not estado["primeira"] and pausa:
            time.sleep(pausa)  # cortesia com a API entre buscas
        estado["primeira"] = False
        return fetch_search(query, fetcher=fetcher, track_name=track_name,
                            artist_name=artist_name)

    for p in listar_mp3s(pasta):
        rel = p.relative_to(pasta).as_posix()
        info = ler_info(p)
        if info["ilegivel"]:
            continue
        # tag placeholder ("AudioTrack 17", "no artist"...) conta como vazia:
        # não pula o arquivo, não vira palpite e não bloqueia a BAIXA
        titulo_tag = _sem_placeholder(info["titulo"])
        artista_tag = _sem_placeholder(info["artista"])
        if titulo_tag and artista_tag and info["letra"] and not forcar:
            print(f"PULADO: {rel} (já tem título, artista e letra)")
            continue
        temas_novos = temas_da_pasta(rel) if temas_pastas else []
        palpites = gerar_palpites(p.name, titulo_tag, artista_tag)
        # V8.2: a duração é PROVA do casamento no LRCLIB (é ela que sustenta
        # a tolerância de grafia do `_discorda`, decisão 63) — e a do
        # cabeçalho não é medição. Sem confirmação, `duracao_confirmada`
        # devolve 0,0 e o `classificar` deixa de dar o bônus de duração:
        # continua identificando por similaridade, nunca por número falso.
        dur_prova = duracao_confirmada(p, info)
        try:
            melhor = _identificar(palpites, dur_prova, buscar, log=log)
        except Exception:
            print(f"ERRO DE REDE: {rel}")
            erros += 1
            continue
        dur_mp3 = f"{(dur_prova or info['duracao']):.0f}"
        if verboso and melhor is not None:
            res_v = melhor["res"]
            dur_v = (f"{float(res_v.get('duration')):.0f}"
                     if res_v.get("duration") is not None else "?")
            print(f'  melhor: "{res_v.get("trackName") or ""}" / '
                  f'"{res_v.get("artistName") or ""}" '
                  f'(sim {melhor["sim"]:.2f}, dur mp3 {dur_mp3}s '
                  f'vs {dur_v}s)')
        conf = (classificar(melhor["sim"], melhor["dif"])
                if melhor is not None else "BAIXA")
        if conf == "BAIXA":
            # nada é proposto além do palpite de nome de arquivo; BAIXA
            # nunca sobrescreve tag REAL — só preenche campos vazios
            # (tag placeholder conta como vazia e PODE ser sobrescrita)
            do_nome = gerar_palpites(p.name)
            titulo_prop, artista_prop = do_nome[0] if do_nome else ("", "")
            if titulo_tag:
                titulo_prop = titulo_tag
            if artista_tag:
                artista_prop = artista_tag
            letra_prop = lrclib_id = dur_enc = ""
            print(f"BAIXA: {rel} → {titulo_prop} / {artista_prop} "
                  "(palpite de nome de arquivo)")
        else:
            res = melhor["res"]
            titulo_prop = res.get("trackName") or ""
            artista_prop = res.get("artistName") or ""
            letra_prop = res.get("plainLyrics") or ""
            lrclib_id = str(res.get("id") or "")
            dur_enc = (f"{float(res.get('duration')):.0f}"
                       if res.get("duration") is not None else "")
        # V8/F17, achado MÉDIO do QA: esta era a única perna de LETRA sem a
        # trava do instrumental — a proposta trazia a letra do LRCLIB e a
        # gravava dentro de uma música marcada como SEM VOZ. O arquivo NÃO
        # é pulado inteiro (como no buscar-letra): título, artista e temas
        # valem para instrumental também, e é o desenho do `identificar`.
        # Só a letra sai da proposta — e sai também do CSV, para o
        # aplicar-proposta não reabrir o buraco pelo lrclib_id.
        nota_instrumental = ""
        if info["instrumental"]:
            instrumentais += 1
            if letra_prop:
                letra_prop = ""
                nota_instrumental = ", instrumental: letra não aplicada"
        if conf != "BAIXA":
            print(f"{conf}: {rel} → {titulo_prop} / {artista_prop} "
                  f"(mp3 {dur_mp3}s, lrclib {dur_enc}s, "
                  f"letra {'SIM' if letra_prop else 'NÃO'}"
                  f"{nota_instrumental})")
        contagem[conf] += 1
        linhas_csv.append([rel, info["titulo"], info["artista"], titulo_prop,
                           artista_prop, conf, dur_mp3, dur_enc,
                           "SIM" if letra_prop else "NÃO",
                           "; ".join(temas_novos), lrclib_id,
                           "SIM" if conf == "ALTA" else ""])

        aplicar_agora = so_temas = sair = False
        if auto:
            aplicar_agora = conf == "ALTA"
        elif interativo:
            if temas_novos:
                print(f"  temas de pasta: {'; '.join(temas_novos)}")
            if conf == "BAIXA":
                # palpite fraco: Enter (reflexo) pula; aceitar exige "a"
                resposta = input(PROMPT_INTERATIVO_BAIXA).strip().lower()
                if resposta == "a":
                    aplicar_agora = True
                elif resposta == "t":
                    so_temas = True
                elif resposta == "q":
                    sair = True
            else:
                resposta = input(PROMPT_INTERATIVO).strip().lower()
                if resposta == "":
                    aplicar_agora = True
                elif resposta == "t":
                    so_temas = True
                elif resposta == "q":
                    sair = True
        if aplicar_agora or so_temas:
            _gravar_enriquecimento(p, info, titulo_prop, artista_prop,
                                   letra_prop, temas_novos, forcar,
                                   so_temas=so_temas)
            aplicados += 1
            print(f"APLICADO: {rel}" + (" (só temas)" if so_temas else ""))
        if sair:
            break

    print(f"Resumo: {contagem['ALTA']} confiança alta | "
          f"{contagem['MÉDIA']} média | {contagem['BAIXA']} baixa | "
          f"{aplicados} aplicados | {erros} erros de rede | "
          # RECORTE, não balde (mesma forma do identificar): o instrumental
          # é proposto como qualquer outro e cai na confiança que merecer;
          # o que ele não recebe é letra
          f"{instrumentais} instrumentais")
    if csv_out is not None:
        gravar_csv(csv_out, ENRIQUECER_COLUNAS, linhas_csv)


# ---------------------------------------------------------------- aplicar-proposta

def cmd_aplicar_proposta(pasta: Path, csv_path: Path, dry_run: bool = False,
                         forcar: bool = False, fetcher=None,
                         pausa: float = PAUSA_S) -> None:
    if not csv_path.is_file():
        die(f"ERRO: CSV inválido ou não encontrado: {csv_path}")
    aplicados = pulados = erros = 0
    primeira = True
    with open(csv_path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            arquivo = (row.get("arquivo") or "").strip()
            if not arquivo:
                continue
            if (row.get("aceitar") or "").strip().upper() != "SIM":
                pulados += 1
                continue
            alvo = pasta / arquivo
            if not alvo.is_file():
                print(f"AVISO: arquivo não encontrado: {arquivo}")
                pulados += 1
                continue
            titulo = (row.get("titulo_proposto") or "").strip()
            artista = (row.get("artista_proposto") or "").strip()
            temas_raw = (row.get("temas_propostos") or "").strip()
            lrclib_id = (row.get("lrclib_id") or "").strip()
            info = ler_info(alvo)
            if (row.get("confianca") or "").strip().upper() == "BAIXA":
                # BAIXA nunca sobrescreve tag REAL: só preenche campos
                # vazios (tag placeholder conta como vazia e cede lugar)
                if _sem_placeholder(info["titulo"]):
                    titulo = ""
                if _sem_placeholder(info["artista"]):
                    artista = ""
            temas_novos = (el.normalize_temas(el.split_temas_input(temas_raw))
                           if temas_raw else [])
            # letra re-buscada na hora de aplicar; nunca sobrescreve letra
            # existente não-vazia sem --forcar (nem gasta rede à toa).
            # V8/F17: e nunca em música marcada como SEM VOZ — o CSV pode
            # ser de antes da marca, ou ter sido editado à mão, e é aqui
            # que o round-trip reabriria o buraco fechado no enriquecer.
            busca_letra = (bool(lrclib_id) and (forcar or not info["letra"])
                           and not info["instrumental"])
            letra = ""
            if busca_letra and not dry_run:
                if not primeira and pausa:
                    time.sleep(pausa)  # cortesia com a API entre buscas
                primeira = False
                try:
                    letra = fetch_lyrics_by_id(lrclib_id,
                                               fetcher=fetcher) or ""
                except Exception:
                    print(f"ERRO DE REDE: {arquivo}")
                    erros += 1
                    continue
            gravados = []
            if titulo:
                gravados.append("titulo")
            if artista:
                gravados.append("artista")
            if temas_novos:
                gravados.append("temas")
            if letra or (dry_run and busca_letra):
                gravados.append("letra")
            if not gravados:
                pulados += 1
                continue
            if not dry_run:
                try:
                    _gravar_enriquecimento(alvo, info, titulo, artista,
                                           letra, temas_novos, forcar)
                except Exception:
                    print(f"AVISO: falha ao gravar: {arquivo}")
                    pulados += 1
                    continue
            print(f"OK: {arquivo} ({', '.join(gravados)})")
            aplicados += 1

    print(f"Resumo: {aplicados} aplicados | {pulados} pulados | "
          f"{erros} erros de rede")


# ---------------------------------------------------------------- temas-de-pastas

def cmd_temas_de_pastas(pasta: Path, aplicar: bool = False) -> None:
    com_novos = aplicados = 0
    for p in listar_mp3s(pasta):
        rel = p.relative_to(pasta).as_posix()
        info = ler_info(p)
        if info["ilegivel"]:
            continue
        da_pasta = temas_da_pasta(rel)
        if not da_pasta:
            continue  # MP3 direto na raiz não ganha tema
        existentes = el.normalize_temas(info["temas"])
        finais = el.normalize_temas(existentes + da_pasta)
        chaves = {el._sem_acento(t) for t in existentes}
        novos = [t for t in finais if el._sem_acento(t) not in chaves]
        if not novos:
            continue
        print(f"TEMAS: {rel} + {'; '.join(novos)}")
        com_novos += 1
        if aplicar:
            el.write_temas(p, finais)  # soma: existentes + pasta
            aplicados += 1
    print(f"Resumo: {com_novos} arquivos com temas novos | "
          f"{aplicados} aplicados")


# ---------------------------------------------------------------- transcrever

TRECHO_PADRAO_S = 90.0   # duração do trecho de identificação (F14.1)
TRECHO_INICIO_S = 20.0   # começa depois da introdução instrumental
MAX_CANDIDATOS = 5       # no máximo 5 consultas ao LRCLIB por música
MAX_PALAVRAS_REFRAO = 6  # título de canção é frase curta
MAX_PALAVRAS_PRIMEIRA = 8
# Um candidato vem do ÁUDIO, não da tag: ao contrário do enriquecer (cujo
# palpite nasce do próprio arquivo, o que torna o casamento auto-consistente),
# aqui casar não prova nada. Palavra solta e genérica ("amor", "aleluia")
# encontra qualquer coisa no LRCLIB: exigimos frase de verdade.
MIN_PALAVRAS_CANDIDATO = 2
MIN_CARACTERES_CANDIDATO = 8
MIN_REPETICOES_REFRAO = 2
# --- V8.1: o que a F14.1 precisa provar para IDENTIFICAR de verdade -------
#
# Medição em duas passadas completas do acervo real (94 arquivos):
#   modelo tiny  -> 0 identificações, 3 conflitos
#   modelo small -> 1 identificação,  5 conflitos
# A única identificação foi ERRADA e foi APLICADA: o refrão "não aguento"
# (2 palavras, 11 caracteres) casou com "Não aguento mais / Raça Negra",
# confiança MÉDIA, mp3 233 s contra lrclib 218 s. A prova da V6.1 ("o
# refrão tem de estar na letra devolvida") passou de graça — uma frase
# genérica aparece naturalmente na letra de uma música que se chama quase
# igual a ela. Os conflitos ("Lampejo" -> Roberto Carlos, "Velho barqueiro"
# -> banda punk espanhola, "canção dos herdeiros" -> Pato Fu) só foram
# barrados porque aqueles arquivos tinham tag real; arquivo sem tag recebe
# o dado errado calado.
#
# Duas travas, ambas calibradas nesses números:
#
# 1) Teto de duração da F14.1 em 8 s, não os 15 s da V3. O único erro
#    medido estava EXATAMENTE em 15 s. No `enriquecer` o palpite nasce da
#    própria tag (casar já implica consistência) e 15 s é tolerância
#    razoável; aqui o palpite vem do áudio e a duração é a única prova
#    objetiva que existe — ela tem de ser apertada. ALTA já vive dentro de
#    ±3 s (ou ≤8 s com título quase idêntico), então o teto não custa
#    nenhuma identificação forte.
MAX_DIF_DURACAO_REFRAO_S = 8.0
# 2) MÉDIA (confirmação fraca) exige refrão DISTINTIVO: 4 palavras e 20
#    caracteres. "não aguento" (2/11) e "me apresento" (2/12) acham
#    qualquer coisa no LRCLIB; "na beira do mar sagrado" (5/23) não. O
#    corte fica acima das frases de 2-3 palavras que produziram o erro e
#    abaixo do teto de 6 palavras que o próprio extrator já impõe ao
#    refrão — ou seja, a faixa 4-6 palavras continua servindo. ALTA não
#    passa por aqui: lá a duração bate em ±3 s e já é prova suficiente.
MIN_PALAVRAS_REFRAO_MEDIA = 4
MIN_CARACTERES_REFRAO_MEDIA = 20
# Alucinações conhecidas do faster-whisper em pt-BR: em trecho instrumental
# ou de voz baixa o modelo "ouve" legendas de vídeo e agradecimentos. Uma
# dessas frases NUNCA vira consulta — foi assim que uma faixa qualquer do
# LRCLIB entrou no lugar de tag boa no acervo real.
_ALUCINACOES_EXATAS = frozenset({
    "musica", "musicas", "a musica", "obrigado", "obrigada",
    "muito obrigado", "muito obrigada", "tchau", "tchau tchau",
    "ate a proxima", "ate mais", "fim", "the end",
})
# Trechos que denunciam a alucinação em qualquer posição da frase. Só entram
# aqui frases inconfundíveis: "obrigado" sozinho seria refrão devocional
# legítimo ("obrigado meu senhor") e fica na lista de comparação exata.
_ALUCINACOES_TRECHOS = (
    "legendas pela comunidade", "legendado pela comunidade", "amara org",
    "obrigado por assistir", "obrigada por assistir",
    "obrigado por assistirem", "inscreva se no canal",
    "se inscreva no canal", "deixe seu like",
)
MSG_SEM_WHISPER = ("ERRO: faster-whisper não instalado — instale com: "
                   "pip3 install faster-whisper")
# Quebra o trecho transcrito em frases: linhas e pontuação forte. Hífen NÃO
# divide (partiria palavras compostas).
_RE_FRASE = re.compile(r"[\n\r.,;:!?…]+")


def _frases_do_trecho(texto: str) -> list:
    """Frases do texto transcrito, em NFC (o motor pode devolver NFD, como
    o macOS faz com nomes de arquivo), sem pontuação e em minúsculas —
    acentos preservados, que o LRCLIB busca melhor com eles."""
    frases = []
    for bruto in _RE_FRASE.split(unicodedata.normalize("NFC", texto)):
        frase = limpar_consulta(bruto).lower()
        if frase:
            frases.append(frase)
    return frases


def eh_alucinacao(texto: str) -> bool:
    """True se a frase é uma alucinação típica do faster-whisper (áudio
    instrumental ou de voz baixa): "Música", "Obrigado por assistir",
    "Legendas pela comunidade Amara.org", "Inscreva-se no canal"…
    Comparação sobre a mesma chave normalizada do módulo
    (_norm_comparacao: minúscula, sem acento, sem pontuação — "Amara.org"
    vira "amara org")."""
    chave = _norm_comparacao(texto)
    if chave in _ALUCINACOES_EXATAS:
        return True
    return any(trecho in chave for trecho in _ALUCINACOES_TRECHOS)


def _candidato_fraco(frase: str) -> bool:
    """True se a frase é curta/genérica demais para virar consulta: menos de
    2 palavras ou menos de ~8 caracteres. Palavra solta acha qualquer coisa
    no LRCLIB e a "confirmação" pela duração vira sorteio."""
    chave = _norm_comparacao(frase)
    return (len(chave) < MIN_CARACTERES_CANDIDATO
            or len(chave.split()) < MIN_PALAVRAS_CANDIDATO)


def extrair_candidatos(texto: str, maximo: int = MAX_CANDIDATOS) -> list:
    """Candidatos a título a partir do trecho transcrito (F14.1): as frases
    curtas MAIS REPETIDAS (o refrão — e o título de uma canção é, quase
    sempre, a frase mais repetida dela), seguidas da primeira linha cantada.

    A contagem usa a chave normalizada (_norm_comparacao: minúscula, sem
    acento, sem pontuação), então "Me apresento!", "ME APRESENTO," e
    "me apresentó" são a MESMA frase. Placeholders e números soltos
    ("faixa 5", "12"), alucinações do motor ("música", "legendas pela
    comunidade Amara.org") e frases fracas (1 palavra ou < 8 caracteres)
    NUNCA viram candidato — são descartados aqui, antes de qualquer
    consulta ao LRCLIB."""
    frases = _frases_do_trecho(texto)
    if not frases:
        return []
    contagem = {}  # chave -> [ocorrências, ordem de aparição, frase]
    for ordem, frase in enumerate(frases):
        chave = _norm_comparacao(frase)
        if (_candidato_fraco(frase) or eh_placeholder(frase)
                or eh_alucinacao(frase)):
            continue
        if chave in contagem:
            contagem[chave][0] += 1
        else:
            contagem[chave] = [1, ordem, frase]
    repetidas = [v for v in contagem.values()
                 if v[0] >= MIN_REPETICOES_REFRAO
                 and len(v[2].split()) <= MAX_PALAVRAS_REFRAO]
    repetidas.sort(key=lambda v: (-v[0], v[1]))
    candidatos = [v[2] for v in repetidas]
    primeira = frases[0]
    if (len(primeira.split()) <= MAX_PALAVRAS_PRIMEIRA
            and not eh_placeholder(primeira)
            and not eh_alucinacao(primeira)
            and not _candidato_fraco(primeira)):
        candidatos.append(primeira)
    vistos = set()
    unicos = []
    for frase in candidatos:
        chave = _norm_comparacao(frase)
        if chave not in vistos:
            vistos.add(chave)
            unicos.append(frase)
    return unicos[:maximo]


def _refrao_distintivo(candidato: str) -> bool:
    """True quando o refrão é específico o bastante para sustentar sozinho
    uma identificação de confiança MÉDIA (V8.1).

    O extrator já barra frase de 1 palavra; isto é um degrau acima, e vale
    só onde a duração NÃO fecha a prova. "não aguento" e "me apresento"
    são frases que meio repertório contém — casar com elas é sorteio."""
    chave = _norm_comparacao(candidato)
    return (len(chave) >= MIN_CARACTERES_REFRAO_MEDIA
            and len(chave.split()) >= MIN_PALAVRAS_REFRAO_MEDIA)


def _identificar_por_refrao(candidatos: list, duracao_mp3: float, buscar,
                            log=None) -> dict | None:
    """Consulta o LRCLIB com cada candidato como track_name e devolve o
    melhor casamento ({"sim", "dif", "res", "candidato", "confianca"}) ou
    None. Para no primeiro ALTA.

    A confirmação usa `classificar` (±3s ALTA, ≤8s ALTA com texto quase
    idêntico, MÉDIA abaixo disso), mas com as travas da V8.1 por cima —
    aqui o palpite vem do ÁUDIO, não da tag:

    - sem duração comparável não há identificação nenhuma (decisão 64: o
      palpite do áudio precisa de prova OBJETIVA, e a duração é a única);
    - diferença de duração acima de MAX_DIF_DURACAO_REFRAO_S (8 s)
      desqualifica, contra os 15 s da V3;
    - MÉDIA só vale com refrão distintivo (>= 4 palavras e 20 caracteres);
    - BAIXA nunca é identificação.
    """
    log = log or (lambda _msg: None)
    melhor = None
    for candidato in candidatos:
        log(f'  busca: track="{candidato}"')
        resultados = buscar(track_name=candidato)
        validos = [res for res in resultados
                   if not (eh_placeholder(res.get("trackName") or "")
                           or eh_placeholder(res.get("artistName") or ""))]
        log(f"  {len(resultados)} resultados"
            + (f" ({len(resultados) - len(validos)} descartados: placeholder)"
               if len(validos) < len(resultados) else ""))
        for res in validos:
            # PROVA do casamento: o refrão que ouvimos tem de estar na letra
            # devolvida. Título parecido + duração próxima não prova nada —
            # no 2º teste real isso casou "Lampejo" com "Vou Chegar Mais
            # Cedo em Casa / Roberto Carlos" e mais três absurdos. Resultado
            # sem letra também não serve: a letra é o objetivo da F14.1.
            # (Sozinha esta prova NÃO basta: "não aguento" aparece na letra
            # de "Não aguento mais" — daí as travas abaixo.)
            if _norm_comparacao(candidato) not in _norm_comparacao(
                    res.get("plainLyrics") or ""):
                log(f'  descartado (refrão não está na letra): '
                    f'"{res.get("trackName")}"')
                continue
            sim = similaridade(candidato, res.get("trackName") or "")
            duracao = res.get("duration")
            dif = (abs(duracao_mp3 - float(duracao))
                   if duracao is not None and duracao_mp3 else None)
            if dif is None:
                log(f'  descartado (sem duração para confirmar): '
                    f'"{res.get("trackName")}"')
                continue
            if dif > MAX_DIF_DURACAO_REFRAO_S:
                # homônimo/versão errada: desqualificado
                log(f'  descartado (duração {dif:.0f}s fora do teto de '
                    f'{MAX_DIF_DURACAO_REFRAO_S:.0f}s): '
                    f'"{res.get("trackName")}"')
                continue
            confianca = classificar(sim, dif)
            if confianca == "BAIXA":
                continue
            if confianca == "MÉDIA" and not _refrao_distintivo(candidato):
                log(f'  descartado (MÉDIA com refrão genérico '
                    f'"{candidato}"): "{res.get("trackName")}"')
                continue
            bonus = 0.3 if dif <= 3 else 0.15
            if melhor is None or sim + bonus > melhor["score"]:
                melhor = {"score": sim + bonus, "sim": sim, "dif": dif,
                          "res": res, "candidato": candidato,
                          "confianca": confianca}
        if melhor is not None and melhor["confianca"] == "ALTA":
            break
    return melhor


# Laço de repetição do Whisper sobre música: uma sílaba ou palavra curta
# emendada dezenas de vezes ("Valalalala…" por 200 caracteres, visto no
# acervo real). Colapsa para duas ocorrências — refrão que repete de verdade
# continua legível, e o lixo para de poluir a letra e o índice de busca.
_RE_LACO_SILABA = re.compile(r"(.{1,10}?)\1{2,}", re.DOTALL)
# Só é laço quando a repetição é LONGA — da ordem do defeito de verdade
# (200+ caracteres), não uma ordem de grandeza abaixo dele.
#
# Achado MÉDIO do QA: com o piso em 20 o limpador causava dano permanente
# dentro dos MP3s do acervo. Repetição é a matéria-prima deste repertório
# (ponto, coco, ciranda, canto de trabalho): sequências de 20 a 40
# caracteres — dez sílabas percussivas antes da palavra, uma interjeição
# repetida, uma despedida em série — são letra legítima, e o corte as
# transformava em outra coisa. O laço do Whisper mede 200 a 600.
_MIN_LACO = 200
# Linha inteira repetida em série; duas bastam para o leitor entender.
_MAX_LINHAS_IGUAIS = 2


def _colapsar(m: "re.Match") -> str:
    trecho = m.group(0)
    if len(trecho) < _MIN_LACO:
        return trecho
    return m.group(1) * 2


def limpar_transcricao(texto: str) -> str:
    """Tira os laços de repetição do Whisper sem tocar no texto legítimo."""
    if not texto:
        return texto
    linhas = []
    repetidas = 0
    anterior = None
    for linha in texto.split("\n"):
        limpa = _RE_LACO_SILABA.sub(_colapsar, linha)
        chave = _norm_comparacao(limpa)
        if chave and chave == anterior:
            repetidas += 1
            if repetidas >= _MAX_LINHAS_IGUAIS:
                continue
        else:
            repetidas = 0
            anterior = chave
        linhas.append(limpa)
    return "\n".join(linhas)


# --- V8.1/F17: transcrição QUASE vazia é o mesmo caso da vazia -----------
#
# A F17 marca instrumental quando a transcrição volta VAZIA. Com o modelo
# `tiny` as duas faixas instrumentais do acervo real voltaram vazias e
# foram marcadas certo. Com o `small` elas voltaram como RUÍDO — e ruído
# gravado como letra polui o índice de busca e, pior, faz o arquivo "ter
# letra": toda etapa seguinte passa a pulá-lo, para sempre, e a F17 nunca
# mais tem a chance de marcá-lo.
#
# A separação é por DENSIDADE (caracteres por segundo de ÁUDIO), medida no
# acervo real de 94 arquivos com o modelo small:
#
#   instrumentais (ruído)     13 car / 175 s = 0,074 c/s
#                             29 car / 380 s = 0,076 c/s
#   letras legítimas + ralas  355 car / 290 s = 1,22 c/s
#                             481 car / 171 s = 2,81 c/s
#                             484 car / 156 s = 3,10 c/s
#
# Entre 0,076 e 1,22 há um fator de 16 sem nada no meio. O piso fica em
# 0,30 c/s, praticamente a média geométrica das duas bordas: 3,9x acima do
# pior instrumental e 4,1x abaixo da letra legítima mais rala.
#
# A folga simétrica é deliberada, mas os dois erros NÃO são simétricos:
# deixar ruído passar custa uma linha feia no índice, enquanto marcar uma
# música de verdade como instrumental a tira da fila de letra para sempre
# (a marca vence até --forcar-tudo, por decisão da F17). Por isso o piso
# não sobe: 4x de folga abaixo da letra mais rala JÁ MEDIDA é o que
# separa a regra de qualquer coisa vista no acervo real. Quem tiver
# repertório ainda mais rarefeito ajusta com --densidade-minima (0 desliga
# a regra e devolve o comportamento antigo: só a vazia marca).
DENSIDADE_MINIMA_LETRA = 0.30


def sem_conteudo(texto: str, duracao: float,
                 densidade_minima: float = DENSIDADE_MINIMA_LETRA) -> bool:
    """True quando a transcrição não carrega conteúdo nenhum: vazia, ou
    tão rala para o tamanho do áudio que é o motor ouvindo quase nada.

    Sem duração conhecida não há densidade a medir — e chutar aqui seria
    marcar instrumental por engano —, então só o texto vazio conta.
    """
    limpo = (texto or "").strip()
    if not limpo:
        return True
    if densidade_minima <= 0 or not duracao or duracao <= 0:
        return False
    return len(limpo) / float(duracao) < densidade_minima


def criar_transcritor(modelo: str = "small", idioma: str = "pt"):
    """Fábrica do transcritor real (faster-whisper na CPU). O import é
    PREGUIÇOSO: a biblioteca é dependência opcional; sem ela, explica em uma
    linha como instalar e sai com código 1 — sem tocar em arquivo nenhum, e
    com todos os outros subcomandos seguindo normais.

    O transcritor devolvido tem a assinatura injetável usada pelos testes:
    (caminho, inicio, duracao) -> (texto puro, segundos de áudio que o motor
    processou). Com inicio/duracao transcreve só o trecho (F14.1); sem eles,
    o arquivo inteiro (F14.2).

    Informar a duração é a correção CRÍTICA da V8.2: quem decodifica o áudio
    SABE quanto áudio existe, e isso não custa nada — o faster-whisper já
    devolve `info.duration` junto com os segmentos. É a fonte mais forte de
    duração que o programa tem, e a única que não depende de o MP3 ter um
    cabeçalho honesto (ver `duracao_confirmada`). Motor injetado que devolva
    só o texto continua valendo: quem normaliza é o `_texto_e_duracao`."""
    try:
        from faster_whisper import WhisperModel  # dependência opcional
    except ImportError:
        die(MSG_SEM_WHISPER)
    print(f"Carregando modelo {modelo}… (na primeira vez baixa o modelo, "
          "~500 MB, só desta vez)")
    model = WhisperModel(modelo, device="cpu", compute_type="int8")

    def transcritor(caminho: str, inicio=None, duracao=None) -> str:
        # vad_filter FICA DESLIGADO. O VAD do Whisper é detector de FALA;
        # sobre canto com instrumentação ele classifica quase tudo como
        # "sem voz". No 2º teste real (94 arquivos, modelo tiny) isso
        # produziu 33 "transcrição vazia", tempos absurdos (3 s para 3m24s
        # de áudio, porque quase nada chegava ao modelo) e músicas inteiras
        # resumidas a 13-51 caracteres. Sem VAD, o modelo ouve a música toda.
        # condition_on_previous_text=False corta os laços de repetição, a
        # outra praga conhecida do Whisper sobre música.
        kwargs = {"language": idioma, "vad_filter": False,
                  "condition_on_previous_text": False}
        if inicio is not None and duracao is not None:
            kwargs["clip_timestamps"] = f"{inicio:.0f},{inicio + duracao:.0f}"
        segmentos, info_motor = model.transcribe(str(caminho), **kwargs)
        texto = "\n".join(s.text.strip() for s in segmentos if s.text.strip())
        # `info.duration` é a duração do ÁUDIO que o motor abriu, medida na
        # decodificação. Versão de biblioteca que não a traga devolve 0,0 e
        # o programa cai nas outras fontes — nunca quebra por causa disto.
        try:
            medida = float(getattr(info_motor, "duration", 0.0) or 0.0)
        except (TypeError, ValueError):
            medida = 0.0
        return texto, max(0.0, medida)

    return transcritor


def _texto_e_duracao(saida) -> tuple:
    """Normaliza o retorno do transcritor em (texto, duração medida).

    O motor pode devolver só o TEXTO — assinatura histórica, e a que
    qualquer transcritor injetado (ou de outro projeto) cumpre — ou a tupla
    (texto, segundos de áudio processados). Sem o número, a duração medida
    é 0,0 e quem decide cai nas outras fontes de prova."""
    if isinstance(saida, tuple):
        texto = saida[0] if saida else ""
        try:
            medida = float(saida[1] or 0.0) if len(saida) > 1 else 0.0
        except (TypeError, ValueError):
            medida = 0.0
        return (texto or ""), max(0.0, medida)
    return (saida or ""), 0.0


def _fmt_milhar(n: int) -> str:
    """1842 -> "1.842" (padrão pt-BR, sem depender de locale)."""
    return "{:,}".format(n).replace(",", ".")


def _fmt_decimal(valor: float, casas: int = 2) -> str:
    """0.0743 -> "0,07" (vírgula decimal do pt-BR, sem depender de locale)."""
    return f"{valor:.{casas}f}".replace(".", ",")


def _fmt_dur(segundos: float) -> str:
    """252.4 -> "4m12s"; 38.2 -> "38s"."""
    total = int(round(segundos or 0))
    if total >= 60:
        return f"{total // 60}m{total % 60:02d}s"
    return f"{total}s"


def _ou_travessao(texto: str) -> str:
    """Campo vazio vira "—" nas linhas de saída (padrão do relatorio)."""
    return texto if texto else "—"


# Acima disto, duas grafias são a MESMA coisa e não há o que conferir.
# Calibrado no acervo real: "Raízes de América"/"Raíces de América" (0,94) e
# "Toinho do Alagoas"/"Toinho de Alagoas" (0,94) passam; "Satania"/"Sabrina"
# (0,57), músicas diferentes do mesmo artista, continua conflito.
LIMIAR_MESMA_GRAFIA = 0.85
# Comprimento mínimo para o teste de contenção não absolver coincidência
# ("Sol" dentro de "Sol Nascente" seriam músicas diferentes).
_MIN_CONTENCAO = 5


def _discorda(atual: str, identificado: str) -> bool:
    """True quando a tag REAL existente contradiz o que foi identificado.

    Campo vazio ou placeholder não contradiz nada — só espera ser preenchido.
    Variação de grafia também não: no teste real com 94 arquivos, 6 dos 8
    conflitos eram a mesma música escrita de outro jeito ("Milionário y José
    Rico" x "Milionário & José Rico"), e tratá-las como contradição
    desperdiçava identificação boa. São a mesma coisa quando as chaves
    normalizadas são muito parecidas OU quando uma contém a outra ("Lampejo"
    dentro de "Adventício - Lampejo", "Marinheiro So" dentro de "Marinheiro
    So (dj mitsu remix)"). Diferença de verdade continua conflito."""
    if not atual or not identificado:
        return False
    a, b = _norm_comparacao(atual), _norm_comparacao(identificado)
    if a == b:
        return False
    curta, longa = sorted((a, b), key=len)
    if len(curta) >= _MIN_CONTENCAO and curta in longa:
        return False
    return similaridade(a, b) < LIMIAR_MESMA_GRAFIA


def _instantaneo(info: dict) -> tuple:
    """O que uma gravação desta rotina pode mudar num arquivo."""
    return (info["titulo"], info["artista"], info["letra"],
            info["instrumental"])


def cmd_transcrever(pasta: Path, transcritor=None, fetcher=None,
                    modelo: str = "small", idioma: str = "pt",
                    trecho: float = TRECHO_PADRAO_S,
                    inicio: float = TRECHO_INICIO_S,
                    identificar_por_refrao: bool = False,
                    so_identificar: bool = False,
                    so_transcrever: bool = False, forcar: bool = False,
                    forcar_tudo: bool = False,
                    sobrescrever_tags: bool = False,
                    densidade_minima: float = DENSIDADE_MINIMA_LETRA,
                    csv_out: Path | None = None, verboso: bool = False,
                    pausa: float = PAUSA_S) -> None:
    """F14: grava a transcrição completa como letra (F14.2) e, se pedirem,
    tenta antes identificar a música pelo refrão (F14.1).

    A F14.1 é OPT-IN desde a V8.1 (`identificar_por_refrao`): em duas
    passadas completas do acervo real ela rendeu 0 e 1 identificação
    (a única, errada e aplicada), contra 3 e 5 conflitos, cobrando uma
    transcrição de trecho de 90 s por arquivo. `so_identificar` a implica —
    sem isso pediria "só a etapa que não roda" e o lote não faria nada. Na
    contradição `identificar_por_refrao` + `so_transcrever`, quem pula
    manda: é a escolha conservadora (a linha de comando recusa a
    combinação antes de chegar aqui).

    Invioláveis: nunca renomeia, nunca toca no áudio e NUNCA sobrescreve
    dado real. O candidato vem do ÁUDIO — casar no LRCLIB não prova nada —,
    então título/artista reais existentes são preservados em qualquer
    confiança (regra da V3.1, uniforme): só campo vazio ou placeholder é
    preenchido, salvo --sobrescrever-tags (destrutivo, só para ALTA).
    Divergência entre a tag real e o identificado vira CONFLITO: nada é
    gravado e a linha aparece no relatório e no CSV. Letra existente só é
    reprocessada com --forcar (se veio de transcrição) ou --forcar-tudo
    (qualquer letra, inclusive oficial)."""
    mp3s = listar_mp3s(pasta)
    total = len(mp3s)
    log = print if verboso else None
    estado = {"primeira": True}
    # V8.1: a etapa cara e improdutiva só roda quando alguém a pede; e
    # quem manda pular vence quem manda tentar.
    fazer_identificacao = ((identificar_por_refrao or so_identificar)
                           and not so_transcrever)

    def buscar(track_name=""):
        if not estado["primeira"] and pausa:
            time.sleep(pausa)  # cortesia com a API entre buscas
        estado["primeira"] = False
        return fetch_search(fetcher=fetcher, track_name=track_name)

    # o modelo (≈500 MB) só é carregado quando há trabalho a fazer
    if total and transcritor is None:
        transcritor = criar_transcritor(modelo, idioma)

    contagem = {"identificadas": 0, "transcritas": 0, "nao_identificadas": 0,
                "pulados": 0, "conflitos": 0, "erros": 0, "instrumentais": 0,
                "adiadas": 0}
    linhas_csv = []
    interrompido = None   # (arquivo, índice) onde o Ctrl-C parou o lote
    posicao = ("", 0)

    try:
        for indice, p in enumerate(mp3s, 1):
            rel = p.relative_to(pasta).as_posix()
            posicao = (rel, indice)
            prefixo = f"[{indice}/{total}] "
            info = ler_info(p)
            if info["ilegivel"]:
                print(f"{prefixo}ERRO: {rel} — áudio ilegível")
                contagem["erros"] += 1
                linhas_csv.append([rel, "ERRO", "", "", "", "", "",
                                   "áudio ilegível"])
                continue
            if info["instrumental"]:
                # V8/F17. A ESCOLHA HUMANA MANDA — e vence até o
                # --forcar-tudo, por isso este teste vem antes de tudo:
                # essas flags falam de LETRA a refazer, não de rediscutir se
                # a música tem voz. Se a marca cedesse a elas, o arquivo
                # voltaria para a fila de horas de CPU em cada execução,
                # que é exatamente o que a F17 veio eliminar. Para
                # reprocessar, desmarque antes:
                # embed_lyrics.py ARQUIVO --nao-instrumental.
                print(f"{prefixo}INSTRUMENTAL: {rel} (já marcado como "
                      "instrumental — nada a transcrever)")
                contagem["instrumentais"] += 1
                linhas_csv.append([rel, "INSTRUMENTAL", info["titulo"],
                                   info["artista"], "", "", "",
                                   "já marcado como instrumental"])
                continue
            if info["letra"] and not forcar_tudo:
                # --forcar reprocessa só o que a MÁQUINA escreveu (rodar de
                # novo com um modelo maior); letra oficial exige --forcar-tudo
                de_transcricao = (info.get("letra_origem")
                                  == el.ORIGEM_TRANSCRICAO)
                if not (forcar and de_transcricao):
                    motivo = ("letra oficial — use --forcar-tudo para "
                              "substituir" if forcar else "já tem letra")
                    print(f"{prefixo}PULADO: {rel} ({motivo})")
                    contagem["pulados"] += 1
                    linhas_csv.append([rel, "PULADO", info["titulo"],
                                       info["artista"], "", "",
                                       len(info["letra"]), motivo])
                    continue

            candidatos = []
            melhor = None
            antes = _instantaneo(info)
            gravou = False
            fase = "transcrição do áudio"
            try:
                # V8.2: a duração do cabeçalho não é prova (ver
                # `duracao_confirmada`). Medida UMA vez por arquivo, aqui —
                # depois dos pulos, para não gastar leitura com quem nem
                # vai ser processado, dentro do try para o Ctrl-C cair no
                # mesmo lugar do resto, e antes de qualquer decisão que
                # dependa dela.
                dur_prova = duracao_confirmada(p, info)
                if fazer_identificacao:
                    # a duração informada pelo motor no TRECHO não entra na
                    # conta: recorte não é o arquivo, e o que a F14.1
                    # precisa confirmar é a duração da MÚSICA
                    texto_trecho, _ = _texto_e_duracao(
                        transcritor(str(p), inicio, trecho))
                    if verboso:
                        print("  trecho transcrito:")
                        for linha in (texto_trecho or "").strip().splitlines():
                            print(f"    {linha}")
                    candidatos = extrair_candidatos(texto_trecho or "")
                    if verboso:
                        print("  candidatos: "
                              + (", ".join(candidatos) or "(nenhum)"))
                    if candidatos:  # sem candidato não há o que consultar
                        try:
                            melhor = _identificar_por_refrao(
                                candidatos, dur_prova, buscar, log=log)
                        except KeyboardInterrupt:
                            raise
                        except Exception:
                            # o trecho já custou CPU: erro de rede não
                            # descarta o arquivo, só desiste da
                            # identificação e segue para a F14.2
                            print(f"{prefixo}AVISO: {rel} — erro de rede na "
                                  "identificação")

                if melhor is not None:
                    res = melhor["res"]
                    confianca = melhor["confianca"]
                    titulo_id = res.get("trackName") or ""
                    artista_id = res.get("artistName") or ""
                    letra_id = res.get("plainLyrics") or ""
                    # tag placeholder ("Faixa 5", "no artist") conta como
                    # vazia: pode ser preenchida
                    titulo_atual = _sem_placeholder(info["titulo"])
                    artista_atual = _sem_placeholder(info["artista"])
                    # nesta linha a duração sai em segundos puros (padrão do
                    # enriquecer: "mp3 214s, lrclib 216s")
                    duracao_res = res.get("duration")
                    durs = (f"mp3 {dur_prova:.0f}s, lrclib "
                            + (f"{float(duracao_res):.0f}s"
                               if duracao_res is not None else "?"))
                    pode_sobrescrever = (sobrescrever_tags
                                         and confianca == "ALTA")
                    if not pode_sobrescrever and (
                            _discorda(titulo_atual, titulo_id)
                            or _discorda(artista_atual, artista_id)):
                        # a identificação contradiz dado real: silêncio aqui
                        # é o que torna o lote perigoso
                        print(f"{prefixo}CONFLITO: {rel} — tag atual "
                              f'"{_ou_travessao(info["titulo"])} / '
                              f'{_ou_travessao(info["artista"])}" difere do '
                              f'identificado "{titulo_id} / {artista_id}" '
                              "(não alterado)")
                        contagem["conflitos"] += 1
                        linhas_csv.append(
                            [rel, "CONFLITO", info["titulo"], info["artista"],
                             confianca, "; ".join(candidatos), "",
                             f'identificado "{titulo_id} / {artista_id}" não '
                             f"aplicado ({durs})"])
                        continue
                    if pode_sobrescrever:
                        titulo, artista = titulo_id, artista_id
                    else:  # regra da V3.1: só preenche campo vazio
                        titulo = "" if titulo_atual else titulo_id
                        artista = "" if artista_atual else artista_id
                    fase = "gravação das tags no arquivo"
                    if letra_id:
                        # letra OFICIAL: sai limpa e sem marca de transcrição
                        el.embed_lyrics(p, letra_id, title=titulo or None,
                                        artist=artista or None, origem="")
                        gravou = True
                    elif titulo or artista:
                        el.write_title_artist(p, title=titulo or None,
                                              artist=artista or None)
                        gravou = True
                    # a linha e o CSV mostram o que FICOU no arquivo, não o
                    # que veio do LRCLIB: o CSV é para conferência
                    titulo_final = titulo or info["titulo"]
                    artista_final = artista or info["artista"]
                    preservou = ((titulo_atual and not titulo)
                                 or (artista_atual and not artista))
                    print(f"{prefixo}IDENTIFICADA: {rel} → "
                          f"{_ou_travessao(titulo_final)} / "
                          f"{_ou_travessao(artista_final)} "
                          f'({confianca}, refrão "{melhor["candidato"]}", '
                          f"{durs})")
                    contagem["identificadas"] += 1
                    linhas_csv.append(
                        [rel, "IDENTIFICADA", titulo_final, artista_final,
                         confianca, "; ".join(candidatos), len(letra_id),
                         durs + ("; título/artista preservados"
                                 if preservou else "")])
                    continue

                if so_identificar:
                    print(f"{prefixo}NÃO IDENTIFICADA: {rel}")
                    contagem["nao_identificadas"] += 1
                    linhas_csv.append([rel, "NÃO IDENTIFICADA", info["titulo"],
                                       info["artista"], "",
                                       "; ".join(candidatos), "",
                                       "não identificada"])
                    continue

                comeco = time.monotonic()
                texto_motor, dur_motor = _texto_e_duracao(
                    transcritor(str(p), None, None))
                bruto = unicodedata.normalize("NFC", texto_motor or "")
                gasto = time.monotonic() - comeco
                # o motor decodificou o áudio: se ele disse quanto ouviu,
                # essa é a melhor prova que existe (V8.2)
                if dur_motor > 0:
                    dur_prova = duracao_confirmada(p, info,
                                                   do_transcritor=dur_motor)
                # a saída só cita a fonte quando ela CONTRADIZ o cabeçalho:
                # é o único caso em que o número surpreende quem lê
                nota_dur = ""
                if dur_prova and not _duracoes_batem(info["duracao"],
                                                     dur_prova):
                    fonte = ("medida pelo transcritor" if dur_motor > 0
                             else "medida no fluxo do MP3")
                    nota_dur = (f" [duração {fonte}; o cabeçalho do MP3 diz "
                                f"{_fmt_dur(info['duracao'])}]")
                dur_saida = dur_prova or info["duracao"]
                # limpar_transcricao vive AQUI, não no transcritor: assim a
                # letra gravada vem sem laço de repetição seja qual for o
                # motor por trás (e o teste consegue provar isso).
                texto = limpar_transcricao(bruto)
                # A densidade é medida no texto CRU, ANTES do limpador: ele
                # colapsa linha repetida em série, e neste repertório
                # (ponto, coco, ciranda) uma faixa de 15 minutos pode ser um
                # refrão repetido cinquenta vezes — depois de colapsado
                # sobrariam 200 caracteres e a música viraria "instrumental".
                # O que se quer medir é quanto o MOTOR ouviu.
                caracteres = len(bruto.strip())
                # V8.2: a densidade só decide com duração PROVADA. Texto
                # vazio não depende de duração nenhuma e continua marcando
                # como sempre; texto ralo medido contra duração provada
                # marca; texto ralo SEM prova de duração não marca nem vira
                # letra — fica para o humano (ver ADIADA, logo abaixo).
                rala_com_prova = bool(dur_prova) and sem_conteudo(
                    bruto, dur_prova, densidade_minima)
                if (caracteres and not dur_prova
                        and sem_conteudo(bruto, info["duracao"],
                                         densidade_minima)):
                    # A ÚNICA coisa que acusa "instrumental" aqui é a
                    # duração do cabeçalho — e ela não é medição. Marcar
                    # tira o arquivo da fila para sempre (a marca vence até
                    # o --forcar-tudo) e desfazer é comando de terminal:
                    # errar para este lado é destruir dado de alguém que
                    # não tem a quem recorrer. Nada é gravado; o arquivo
                    # continua na fila e a linha explica o que fazer.
                    print(f"{prefixo}ADIADA: {rel} — "
                          f"{_fmt_milhar(caracteres)} caracteres seriam "
                          "pouco para a duração deste áudio, mas a duração "
                          "NÃO pôde ser confirmada: o cabeçalho do MP3 diz "
                          f"{_fmt_dur(info['duracao'])} e o fluxo do "
                          "arquivo não pôde ser medido. Nada foi gravado. "
                          "Se a música realmente não tem voz, marque como "
                          "instrumental no editor do player, ou com "
                          "embed_lyrics.py ARQUIVO --instrumental")
                    contagem["adiadas"] += 1
                    linhas_csv.append(
                        [rel, "ADIADA", info["titulo"], info["artista"], "",
                         "; ".join(candidatos), caracteres,
                         "transcrição rala, mas a duração do áudio não pôde "
                         "ser confirmada — nada gravado"])
                    continue
                if not caracteres or rala_com_prova:
                    # V8/F17 + V8.1. O áudio foi LIDO até o fim (ilegível
                    # teria parado lá em cima, e motor que explode cai no
                    # except como erro): voltar vazio — ou quase — daqui é
                    # música SEM VOZ, não defeito. Marcar tira o arquivo da
                    # fila para sempre; gravar o ruído como letra também
                    # tirava, só que mentindo e sem a marca.
                    fase = "gravação da marca de instrumental"
                    if not caracteres:
                        motivo = "transcrição vazia com áudio legível"
                        motivo_csv = "transcrição vazia"
                    else:
                        # a linha DIZ a regra, e DIZ qual duração usou: o
                        # curador precisa ver por que este arquivo saiu da
                        # fila de letra
                        densidade = caracteres / float(dur_prova)
                        motivo = (f"{_fmt_milhar(caracteres)} caracteres em "
                                  f"{_fmt_dur(dur_prova)} de áudio"
                                  f"{nota_dur} = "
                                  f"{_fmt_decimal(densidade)} caractere por "
                                  "segundo, abaixo do mínimo de "
                                  f"{_fmt_decimal(densidade_minima)}")
                        motivo_csv = (f"transcrição rala "
                                      f"({_fmt_decimal(densidade)} c/s, "
                                      "mínimo "
                                      f"{_fmt_decimal(densidade_minima)})")
                    el.write_instrumental(p, True)
                    gravou = True
                    print(f"{prefixo}INSTRUMENTAL: {rel} ({motivo} — "
                          "marcado como instrumental)")
                    contagem["instrumentais"] += 1
                    linhas_csv.append(
                        [rel, "INSTRUMENTAL", info["titulo"], info["artista"],
                         "", "; ".join(candidatos), caracteres or "",
                         f"{motivo_csv} — marcado como instrumental"])
                    continue
                # letra limpa (sem cabeçalho, que poluiria a busca por
                # trecho) e título/artista intocados: transcrição não
                # inventa identificação
                fase = "gravação da letra no arquivo"
                el.embed_lyrics(p, texto, origem=el.ORIGEM_TRANSCRICAO)
                gravou = True
                print(f"{prefixo}TRANSCRITA: {rel} "
                      f"({_fmt_milhar(len(texto))} caracteres, "
                      f"{_fmt_dur(dur_saida)} de áudio em "
                      f"{_fmt_dur(gasto)}){nota_dur}")
                contagem["transcritas"] += 1
                linhas_csv.append([rel, "TRANSCRITA", info["titulo"],
                                   info["artista"], "", "; ".join(candidatos),
                                   len(texto), "transcricao"])
            except KeyboardInterrupt:
                # a gravação é atômica (embed_lyrics.save_tags), então o
                # arquivo em andamento está íntegro; o que não dá para fazer
                # é MENTIR sobre ter gravado — confere no disco
                if not gravou:
                    gravou = _instantaneo(ler_info(p)) != antes
                situacao = ("gravação já concluída neste arquivo" if gravou
                            else "nada gravado")
                print(f"{prefixo}INTERROMPIDO: {rel} ({situacao})")
                linhas_csv.append([rel, "INTERROMPIDO", info["titulo"],
                                   info["artista"], "", "; ".join(candidatos),
                                   "", situacao])
                interrompido = posicao
                break
            except Exception as exc:
                print(f"{prefixo}ERRO: {rel} — falha na {fase}")
                if verboso:  # a mensagem original costuma vir em inglês
                    print(f"  detalhe técnico: {exc}")
                contagem["erros"] += 1
                linhas_csv.append([rel, "ERRO", info["titulo"],
                                   info["artista"], "", "; ".join(candidatos),
                                   "", f"falha na {fase}"])
                continue
    except KeyboardInterrupt:
        # Ctrl-C fora do processamento de um arquivo (entre um e outro)
        if interrompido is None:
            interrompido = posicao
    finally:
        # o resumo e o CSV SEMPRE saem: em acervo grande são horas de
        # trabalho, e perdê-las por um Ctrl-C seria pior que não ter CSV
        print(f"Resumo: {total} arquivos | "
              f"{contagem['identificadas']} identificadas | "
              f"{contagem['transcritas']} transcritas | "
              f"{contagem['nao_identificadas']} não identificadas | "
              f"{contagem['pulados']} puladas | "
              f"{contagem['conflitos']} conflitos | "
              f"{contagem['erros']} erros | "
              # balde próprio (F17): quem foi marcado agora e quem já
              # estava marcado — nenhum deles é erro nem pulo de letra
              f"{contagem['instrumentais']} instrumentais | "
              # balde próprio (V8.2): transcrição rala que NÃO virou marca
              # porque a duração do áudio não pôde ser confirmada. Não é
              # erro (o arquivo está inteiro), não é pulo (foi ouvido) e
              # não é instrumental (ninguém provou que não tem voz)
              f"{contagem['adiadas']} adiadas")
        if interrompido is not None:
            parou_em, indice_parada = interrompido
            print(f"Interrompido em: {parou_em} (arquivo {indice_parada} de "
                  f"{total}) — {total - indice_parada} não processados")
        if csv_out is not None:
            gravar_csv(csv_out, TRANSCREVER_COLUNAS, linhas_csv)


# ---------------------------------------------------------------- identificar

ACOUSTID_URL = "https://api.acoustid.org/v2/lookup"
# Pontuação mínima da impressão digital (PRD V6). Abaixo disso o AcoustID
# está chutando — e chute vindo do ÁUDIO não encosta em tag de curador.
PONTUACAO_MINIMA = 0.7
# O AcoustID pede no máximo ~3 consultas por segundo.
PAUSA_ACOUSTID_S = 0.34
# Acima disto a duração denuncia outra gravação (regra da V3, uniforme).
MAX_DIF_DURACAO_S = 15.0
TIMEOUT_FPCALC_S = 120
IDENTIFICAR_COLUNAS = ["arquivo", "acao", "titulo", "artista", "confianca",
                       "pontuacao", "caracteres", "detalhe"]
MSG_SEM_FPCALC = (
    'ERRO: fpcalc (Chromaprint) não encontrado no PATH — instale com "brew '
    'install chromaprint" (macOS), "sudo apt install libchromaprint-tools" '
    "(Linux) ou baixe o binário oficial em https://acoustid.org/chromaprint "
    "(Windows)")
MSG_SEM_CHAVE = (
    "ERRO: chave da API do AcoustID ausente — a chave é gratuita (cadastro "
    "de um minuto) em https://acoustid.org/new-application; informe em "
    "--chave ou na variável de ambiente ACOUSTID_API_KEY (o Cancioneiro "
    "nunca grava a chave em disco)")


def _nfc(texto: str) -> str:
    """Normaliza para NFC. O macOS entrega NFD em nome de arquivo e o motor
    de transcrição também — o projeto já foi mordido duas vezes por isso.
    Tudo que é comparado, gravado ou enviado a uma API passa por aqui."""
    return unicodedata.normalize("NFC", texto or "")


def criar_impressao_digital(programa: str = "fpcalc"):
    """Fábrica do calculador real de impressão digital (fpcalc, do
    Chromaprint). O binário é dependência externa OPCIONAL e é procurado
    SÓ aqui: sem ele, uma linha em pt-BR explicando como instalar e saída
    com código 1, sem tocar em arquivo nenhum — e todos os outros
    subcomandos seguem funcionando normalmente.

    O calculador devolvido tem a assinatura injetável usada pelos testes:
    (caminho) -> (duracao_em_segundos, impressao_digital)."""
    caminho = shutil.which(programa)
    if caminho is None:
        die(MSG_SEM_FPCALC)

    def impressao_digital(caminho_mp3: str) -> tuple:
        saida = subprocess.run([caminho, "-json", str(caminho_mp3)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=TIMEOUT_FPCALC_S)
        if saida.returncode != 0:
            detalhe = saida.stderr.decode("utf-8", "replace").strip()
            raise RuntimeError(detalhe or "fpcalc terminou com erro")
        dados = json.loads(saida.stdout.decode("utf-8", "replace"))
        return float(dados["duration"]), str(dados["fingerprint"])

    return impressao_digital


def _artista_da_gravacao(gravacao: dict) -> str:
    """Nome do artista de uma gravação do MusicBrainz, respeitando a
    "joinphrase" das participações ("Gal Costa & Caetano Veloso"). Sai em
    NFC, como tudo que vai virar tag ou consulta."""
    nomes = []
    for artista in gravacao.get("artists") or []:
        nome = _nfc(str(artista.get("name") or "")).strip()
        if nome:
            nomes.append((nome, str(artista.get("joinphrase") or "")))
    partes = []
    for indice, (nome, junta) in enumerate(nomes):
        partes.append(nome)
        if indice < len(nomes) - 1:
            partes.append(junta or " & ")
    return "".join(partes).strip()


def consultar_acoustid(duracao: float, fingerprint: str, chave: str,
                       fetcher=None) -> list:
    """Consulta o AcoustID (/v2/lookup) e devolve a lista de resultados
    (pontuação + gravações do MusicBrainz). Erro de rede sobe para o
    chamador; erro da própria API vira exceção com a mensagem dela. A
    chave entra na URL e NUNCA é impressa nem gravada."""
    fetcher = fetcher or default_fetcher
    qs = urllib.parse.urlencode({
        "client": chave,
        "meta": "recordings",
        "duration": str(int(round(duracao or 0))),
        "fingerprint": fingerprint,
    })
    dados = json.loads(fetcher(f"{ACOUSTID_URL}?{qs}"))
    if not isinstance(dados, dict):
        return []
    if dados.get("status") != "ok":
        erro = dados.get("error") or {}
        raise RuntimeError(str(erro.get("message") or "resposta inesperada"))
    return dados.get("results") or []


def escolher_candidato(resultados: list, duracao_mp3: float,
                       log=None) -> dict | None:
    """Melhor candidato do AcoustID ({"confianca", "pontuacao", "titulo",
    "artista", "duracao", "dif"}) ou None.

    Duas travas antes de qualquer coisa: pontuação mínima 0,7 (abaixo disso
    é chute) e confirmação pela duração com as MESMAS regras da V3
    (classificar: ±3s ALTA, ≤8s ALTA quando a pontuação é altíssima, ≤15s
    MÉDIA, >15s desqualifica). Gravação com título OU artista de
    placeholder ("AudioTrack 05", "Unknown Artist", artista ausente) é
    descartada antes do score. BAIXA não é identificação. Empate de
    pontuação decide pela duração mais próxima."""
    log = log or (lambda _msg: None)
    melhor = None
    for res in resultados:
        try:
            pontuacao = float(res.get("score") or 0.0)
        except (TypeError, ValueError):
            pontuacao = 0.0
        if pontuacao < PONTUACAO_MINIMA:
            log(f"  descartado: pontuação {pontuacao:.2f} abaixo de "
                f"{PONTUACAO_MINIMA}")
            continue
        gravacoes = res.get("recordings") or []
        if not gravacoes:
            # A impressão digital casou, mas o AcoustID não tem título/artista
            # ligados a ela. Sem esta linha o --verboso dizia "1 resultados" e
            # depois "SEM RESULTADO", sem explicar nada (teste real).
            log(f"  descartado: resultado sem metadados de gravação "
                f"(pontuação {pontuacao:.2f})")
            continue
        for gravacao in gravacoes:
            titulo = _nfc(str(gravacao.get("title") or "")).strip()
            artista = _artista_da_gravacao(gravacao)
            if eh_placeholder(titulo) or eh_placeholder(artista):
                log(f'  descartado (placeholder): "{titulo} / {artista}"')
                continue
            duracao = gravacao.get("duration")
            dif = (abs(duracao_mp3 - float(duracao))
                   if duracao is not None and duracao_mp3 else None)
            if dif is not None and dif > MAX_DIF_DURACAO_S:
                log(f'  descartado (duração {dif:.0f}s fora): "{titulo}"')
                continue
            confianca = classificar(pontuacao, dif)
            if confianca == "BAIXA":
                log(f'  descartado (confirmação fraca): "{titulo}"')
                continue
            ordem = (pontuacao, -(dif if dif is not None else 1e9))
            if melhor is None or ordem > melhor["ordem"]:
                melhor = {"ordem": ordem, "pontuacao": pontuacao, "dif": dif,
                          "confianca": confianca, "titulo": titulo,
                          "artista": artista, "duracao": duracao}
    return melhor


def buscar_letra_oficial(titulo: str, artista: str, duracao_mp3: float,
                         fetcher=None, log=None) -> str | None:
    """Letra OFICIAL do LRCLIB para uma identificação já confirmada (F15,
    --com-letra). Reusa a busca por campo (track_name/artist_name, mais
    precisa) e o classificar da V3 para confirmar pela duração; resultado
    com placeholder, sem letra ou de confirmação BAIXA não vale. O texto
    volta limpo — quem grava usa embed_lyrics sem origem, então a letra
    NÃO recebe o marcador de transcrição."""
    log = log or (lambda _msg: None)
    log(f'  letra: track="{titulo}" artista="{artista}"')
    resultados = fetch_search(fetcher=fetcher, track_name=_nfc(titulo),
                              artist_name=_nfc(artista))
    alvo = f"{titulo} {artista}".strip()
    melhor = None
    for res in resultados:
        track = _nfc(str(res.get("trackName") or ""))
        nome = _nfc(str(res.get("artistName") or ""))
        if eh_placeholder(track) or eh_placeholder(nome):
            continue
        letra = res.get("plainLyrics") or ""
        if not letra:
            continue
        sim = similaridade(alvo, f"{track} {nome}")
        duracao = res.get("duration")
        dif = (abs(duracao_mp3 - float(duracao))
               if duracao is not None and duracao_mp3 else None)
        if dif is not None and dif > MAX_DIF_DURACAO_S:
            continue
        if classificar(sim, dif) == "BAIXA":
            continue
        bonus = 0.0
        if dif is not None:
            bonus = 0.3 if dif <= 3 else (0.15 if dif <= 8 else 0.0)
        if melhor is None or sim + bonus > melhor[0]:
            melhor = (sim + bonus, _nfc(letra))
    log("  letra: " + ("encontrada" if melhor else "não encontrada"))
    return melhor[1] if melhor else None


# ---------------------------------------------------------------- vagalume

# V6.1. SEGUNDA fonte de letra OFICIAL, sempre depois do LRCLIB e sempre
# antes da transcrição. Existe por medição: no acervo real (94 arquivos de
# repertório brasileiro regional/devocional) o LRCLIB cobriu ~3%; o
# Vagalume é base comunitária brasileira e cobre justamente esse buraco.
VAGALUME_URL = "https://api.vagalume.com.br/search.php"
# A API responde por tipo. "exact" é a ÚNICA resposta aproveitável:
# "aprox" é literalmente a API dizendo "isto NÃO é a música que você pediu,
# é a mais parecida que eu tenho", e "notfound"/"song_notfound" não trazem
# letra nenhuma. Achado CRÍTICO do QA: tratar "aprox" como "exact" gravou a
# letra de OUTRA música ("Ponto de Ogum" no lugar de "Ponto de Oxum") com a
# marca de letra oficial. Resposta sem campo `type` também é recusada — sem
# o veredito da API não há em que se apoiar.
_VAGALUME_TIPO_EXATO = "exact"
MSG_VAGALUME_PULADO = (
    "Vagalume: pulado (sem chave) — a chave é gratuita em "
    "https://auth.vagalume.com.br/settings/api/; informe em "
    "--chave-vagalume ou na variável de ambiente VAGALUME_API_KEY (a chave "
    "nunca entra no banco de músicas nem em log, e nunca é enviada a lugar "
    "nenhum além do próprio Vagalume; no aplicativo ela fica guardada nas "
    "preferências locais, na sua máquina)")
# Texto de "não temos esta letra" que a base comunitária às vezes devolve
# no lugar da letra. Comparado sobre a chave normalizada do módulo (sem
# acento, sem pontuação, minúsculas), então cobre as variações de acento.
# A lista cresceu com o que o QA viu passando: são convites para o visitante
# CONTRIBUIR com a letra, não a letra. Todos falam de "a letra" no singular
# e em posição de objeto — texto de canção de verdade que menciona "letra"
# ("escrevi a letra dessa canção") não bate com nenhum destes.
_VAGALUME_INDISPONIVEL = (
    "ainda nao temos a letra", "nao temos a letra",
    "nao possui letra", "nao possuimos a letra", "sem letra cadastrada",
    "letra nao cadastrada", "letra nao disponivel", "letra indisponivel",
    "letra em breve", "aguardando revisao", "envie a letra",
    "enviar a letra", "enviando a letra", "adicione a letra",
    "cadastre a letra", "colabore com a letra",
)


def consultar_vagalume(titulo: str, artista: str, chave: str,
                       fetcher=None) -> dict:
    """Consulta o Vagalume (/search.php?art=&mus=&apikey=) e devolve o
    dicionário da resposta. Texto enviado em NFC (o macOS entrega NFD).
    404 vira resposta vazia; erro de rede sobe para o chamador. A chave
    entra na URL e NUNCA é impressa nem gravada."""
    fetcher = fetcher or default_fetcher
    qs = urllib.parse.urlencode({"art": _nfc(artista), "mus": _nfc(titulo),
                                 "apikey": chave})
    try:
        body = fetcher(f"{VAGALUME_URL}?{qs}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {}
        raise
    try:
        dados = json.loads(body)
    except ValueError:
        return {}
    return dados if isinstance(dados, dict) else {}


def _letra_indisponivel(letra: str) -> bool:
    """True quando o "texto" devolvido é um recado da base, não a letra."""
    chave = _norm_comparacao(letra)
    return any(marca in chave for marca in _VAGALUME_INDISPONIVEL)


# Conectivos que só mudam a GRAFIA de um nome composto: "Milionário y José
# Rico" x "Milionário & José Rico" x "Sandy e Junior" são o mesmo artista.
# ("&" já vira espaço no _norm_comparacao.) A lista é curta de propósito:
# tudo que não estiver aqui é palavra que distingue.
_CONECTIVOS = frozenset({"e", "y", "and", "feat", "ft", "featuring"})
_RE_TRACO = re.compile(r"\s+[-–—]\s+")


def _palavras_significativas(texto: str) -> list:
    return [p for p in _norm_comparacao(texto).split() if p not in _CONECTIVOS]


def _confere_estrito(pedido: str, devolvido: str) -> bool:
    """Casamento do VAGALUME: as MESMAS palavras, na mesma ordem.

    Por que não reusa o _discorda: aquela régua (similaridade ≥ 0,85 e
    contenção de 5 caracteres) foi afrouxada para o LRCLIB/AcoustID, onde a
    DURAÇÃO confirma o casamento — um homônimo com duração errada já caiu
    antes de chegar lá. O Vagalume não tem campo de duração: a prova
    textual é a ÚNICA que existe, e sob essa régua o QA mediu colisões
    graves — "Ponto de Oxum" x "Ponto de Ogum" (0,923), "Ponto de Iansã" x
    "Ponto de Iemanjá" (0,867), "Cantiga" x "Cantigas" (0,933) — e a
    contenção aceitava "A Volta da Asa Branca" para "Asa Branca",
    "Canoeiro II" para "Canoeiro", "Aquarela do Brasil" para "Aquarela".
    O _discorda segue como está para quem tem duração; aqui a régua é esta.

    Passa: acento, caixa, pontuação e conectivo ("&" x "y" x "e").
    Não passa: qualquer palavra a mais, a menos ou trocada.

    Única flexibilidade, e do lado do PEDIDO: tag de título no formato
    "Artista - Título" (visto no acervo real) vale também por cada segmento
    do traço — mas por IGUALDADE de palavras, nunca por contenção."""
    alvo = _palavras_significativas(devolvido)
    if not alvo:
        return False
    if _palavras_significativas(pedido) == alvo:
        return True
    return any(_palavras_significativas(parte) == alvo
               for parte in _RE_TRACO.split(pedido))


def buscar_letra_vagalume(titulo: str, artista: str, chave: str,
                          fetcher=None, log=None) -> str | None:
    """Letra do Vagalume para um título+artista JÁ conhecidos (tag real ou
    identificação confirmada). Devolve o texto em NFC ou None.

    ATENÇÃO — esta fonte NÃO PODE SER CONFIRMADA COMO O LRCLIB. A API do
    Vagalume não tem campo de duração, então a trava que sustenta todo o
    resto do funil (±3s = ALTA, >15s desqualifica) simplesmente não existe
    aqui. A única prova disponível é textual, e por isso ela é exigida dos
    DOIS lados, e por uma régua PRÓPRIA e estrita (_confere_estrito — as
    mesmas palavras, na mesma ordem), NÃO pela do _discorda: aquela foi
    afrouxada para o caminho em que a duração confirma o casamento, e aqui
    ela deixava passar música errada. Só o tipo "exact" é aceito: "aprox" é
    a API dizendo que NÃO é a música pedida. Sem artista para conferir, não
    se consulta — foi um casamento sem prova ("Lampejo" com uma faixa do
    Roberto Carlos) que ensinou isso ao projeto. Placeholder dos dois lados
    e recado de "ainda não temos a letra" são descartados antes de tudo.
    Entre as entradas que passam, vence a MELHOR (igualdade literal do
    título primeiro), não a primeira da lista.

    Sem chave, devolve None sem tocar na rede — o chamador avisa uma vez."""
    log = log or (lambda _msg: None)
    if not chave:
        return None
    titulo = _nfc(titulo).strip()
    artista = _nfc(artista).strip()
    if not (titulo and artista):
        # sem os dois lados não há o que conferir: não se consulta
        log("  vagalume: sem título E artista para conferir — não consultado")
        return None
    if eh_placeholder(titulo) or eh_placeholder(artista):
        log("  vagalume: título/artista de placeholder — não consultado")
        return None
    log(f'  vagalume: mus="{titulo}" art="{artista}"')
    dados = consultar_vagalume(titulo, artista, chave, fetcher=fetcher)
    if not dados:
        log("  vagalume: sem letra (resposta vazia)")
        return None
    tipo = str(dados.get("type") or "")
    if tipo != _VAGALUME_TIPO_EXATO:
        # "aprox" é a própria API avisando que devolveu OUTRA música;
        # resposta sem `type` não traz veredito nenhum.
        log(f"  vagalume: descartado (type={tipo or 'ausente'} — só "
            f'"{_VAGALUME_TIPO_EXATO}" é aceito)')
        return None
    artista_res = _nfc(str((dados.get("art") or {}).get("name") or "")).strip()
    musicas = dados.get("mus")
    if not isinstance(musicas, list):
        log("  vagalume: descartado (campo mus não veio como lista: "
            f"{type(musicas).__name__})")
        return None
    melhor = None
    for musica in musicas:
        if not isinstance(musica, dict):
            continue
        titulo_res = _nfc(str(musica.get("name") or "")).strip()
        # a base devolve entidades HTML no texto ("&quot;", "&#39;"); sem
        # desescapar, elas entram no MP3 e no índice de busca do player
        letra = _nfc(html.unescape(str(musica.get("text") or ""))).strip()
        if not letra or _letra_indisponivel(letra):
            log(f'  vagalume: descartado (sem letra útil): "{titulo_res}"')
            continue
        if eh_placeholder(titulo_res) or eh_placeholder(artista_res):
            log(f'  vagalume: descartado (placeholder): '
                f'"{titulo_res} / {artista_res}"')
            continue
        if not (_confere_estrito(titulo, titulo_res)
                and _confere_estrito(artista, artista_res)):
            log(f'  vagalume: descartado (não confere com o pedido): '
                f'"{titulo_res} / {artista_res}"')
            continue
        # `mus` é uma LISTA: a exata pode estar depois de uma variação que
        # também passou ("Canoeiro" atrás de "Canoeiro II"). Vence a melhor,
        # não a primeira — mesma disciplina do buscar_letra_oficial.
        nota = (1 if _norm_comparacao(titulo) == _norm_comparacao(titulo_res)
                else 0, similaridade(titulo, titulo_res))
        if melhor is None or nota > melhor[0]:
            melhor = (nota, letra, titulo_res)
    if melhor is None:
        return None
    log(f'  vagalume: encontrada ({tipo}) "{melhor[2]} / {artista_res}"')
    return melhor[1]


def resolver_chave_vagalume(chave: str | None) -> str:
    """A chave vem de --chave-vagalume ou do ambiente, NUNCA de disco."""
    return (chave or os.environ.get("VAGALUME_API_KEY", "") or "").strip()


def cmd_identificar(pasta: Path, impressao_digital=None, fetcher=None,
                    chave: str = "", com_letra: bool = False,
                    sobrescrever_tags: bool = False,
                    csv_out: Path | None = None, verboso: bool = False,
                    pausa: float = PAUSA_ACOUSTID_S,
                    chave_vagalume: str = "") -> None:
    """F15: identifica a gravação pela impressão digital acústica.

    Etapa 3 do funil (~1–2 s por música, contra 30–80 s da transcrição):
    calcula a impressão com o fpcalc, consulta o AcoustID e aplica o melhor
    candidato — pontuação ≥ 0,7 E duração compatível pelas regras da V3.

    Invioláveis: nunca renomeia, nunca toca no áudio e NUNCA sobrescreve
    dado real. Como no transcrever, o candidato vem do ÁUDIO: título e
    artista REAIS existentes são preservados em qualquer confiança (só
    campo vazio ou placeholder é preenchido), salvo --sobrescrever-tags
    (destrutivo, só para ALTA), e divergência entre a tag real e o
    identificado vira CONFLITO — nada gravado, com balde próprio no resumo
    e ação própria no CSV. Com --com-letra, a letra OFICIAL do LRCLIB entra
    sem o marcador de transcrição, e letra existente nunca é substituída;
    não achando no LRCLIB, o Vagalume é consultado com o título/artista JÁ
    confirmados (V6.1) — letra oficial também, mas com a marca "vagalume",
    porque essa fonte não pode ser confirmada pela duração."""
    if not chave:
        die(MSG_SEM_CHAVE)
    if impressao_digital is None:
        impressao_digital = criar_impressao_digital()
    chave_vagalume = (chave_vagalume or "").strip()
    if com_letra and not chave_vagalume:
        print(MSG_VAGALUME_PULADO)

    mp3s = listar_mp3s(pasta)
    total = len(mp3s)
    log = print if verboso else None
    registrar = log or (lambda _msg: None)
    estado = {"primeira": True}

    def cortesia():
        if not estado["primeira"] and pausa:
            time.sleep(pausa)  # o AcoustID pede no máximo 3 consultas/s
        estado["primeira"] = False

    contagem = {"identificadas": 0, "letras": 0, "sem_resultado": 0,
                "conflitos": 0, "erros": 0, "vagalume": 0,
                "instrumentais": 0}
    linhas_csv = []
    interrompido = None   # (arquivo, índice) onde o Ctrl-C parou o lote
    posicao = ("", 0)

    try:
        for indice, p in enumerate(mp3s, 1):
            rel = p.relative_to(pasta).as_posix()
            posicao = (rel, indice)
            prefixo = f"[{indice}/{total}] "
            info = ler_info(p)
            if info["ilegivel"]:
                print(f"{prefixo}ERRO: {rel} — áudio ilegível")
                contagem["erros"] += 1
                linhas_csv.append([rel, "ERRO", "", "", "", "", "",
                                   "áudio ilegível"])
                continue
            if info["instrumental"]:
                # V8/F17: só a LETRA é pulada. A impressão digital continua
                # rodando — instrumental sem letra ainda pode (e deve) ter
                # título e artista corretos, e é justamente esta etapa que
                # os descobre. O aviso só sai quando havia mesmo uma busca
                # de letra para pular.
                contagem["instrumentais"] += 1
                if com_letra:
                    print(f"{prefixo}INSTRUMENTAL: {rel} (letra não buscada; "
                          "a impressão digital segue)")

            antes = _instantaneo(info)
            gravou = False
            fase = "leitura da impressão digital"
            try:
                duracao_fp, fingerprint = impressao_digital(str(p))
                # V8.2: e quando nem o fpcalc dá o número, o que vale é a
                # duração CONFIRMADA (medida no fluxo), nunca o cabeçalho
                # cru — aqui a duração é a trava que desqualifica o
                # homônimo, e trava calibrada por número falso não é trava.
                # o fpcalc devolve a duração REAL do arquivo; sem ela, vale
                # a medida no fluxo (e 0,0 quando nem essa dá, o que faz o
                # `escolher_candidato` simplesmente não classificar por
                # duração, em vez de classificar errado)
                duracao = (float(duracao_fp or 0.0)
                           or duracao_confirmada(p, info))
                fase = "consulta ao AcoustID"
                cortesia()
                resultados = consultar_acoustid(duracao, fingerprint, chave,
                                                fetcher=fetcher)
                registrar(f"  {len(resultados)} resultados do AcoustID")
                melhor = escolher_candidato(resultados, duracao, log=log)
                if melhor is None:
                    print(f"{prefixo}SEM RESULTADO: {rel}")
                    contagem["sem_resultado"] += 1
                    linhas_csv.append([rel, "SEM RESULTADO", info["titulo"],
                                       info["artista"], "", "", "",
                                       "nenhum candidato confirmado"])
                    continue

                confianca = melhor["confianca"]
                titulo_id = melhor["titulo"]
                artista_id = melhor["artista"]
                pontos = f"{melhor['pontuacao']:.2f}"
                dur_ac = ("?" if melhor["duracao"] is None
                          else f"{float(melhor['duracao']):.0f}s")
                durs = f"mp3 {duracao:.0f}s, acoustid {dur_ac}"
                # tag placeholder ("Faixa 5", "no artist") conta como vazia:
                # pode ser preenchida
                titulo_atual = _sem_placeholder(info["titulo"])
                artista_atual = _sem_placeholder(info["artista"])
                pode_sobrescrever = sobrescrever_tags and confianca == "ALTA"
                if not pode_sobrescrever and (
                        _discorda(titulo_atual, titulo_id)
                        or _discorda(artista_atual, artista_id)):
                    # a identificação contradiz dado real: silêncio aqui é o
                    # que torna o lote perigoso
                    print(f"{prefixo}CONFLITO: {rel} — tag atual "
                          f'"{_ou_travessao(info["titulo"])} / '
                          f'{_ou_travessao(info["artista"])}" difere do '
                          f'identificado "{titulo_id} / {artista_id}" '
                          "(não alterado)")
                    contagem["conflitos"] += 1
                    linhas_csv.append(
                        [rel, "CONFLITO", info["titulo"], info["artista"],
                         confianca, pontos, "",
                         f'identificado "{titulo_id} / {artista_id}" não '
                         f"aplicado ({durs})"])
                    continue

                if pode_sobrescrever:
                    titulo, artista = titulo_id, artista_id
                else:  # regra da V3.1: só preenche campo vazio
                    titulo = "" if titulo_atual else titulo_id
                    artista = "" if artista_atual else artista_id

                letra = ""
                letra_do_vagalume = False
                if (com_letra and not info["letra"]
                        and not info["instrumental"]):
                    # letra existente nunca é substituída (nem consultada à
                    # toa): trocar letra curada por outra é apagar trabalho.
                    # Instrumental (F17) também não se consulta: não há
                    # letra a achar, e as duas fontes custam rede
                    fase = "busca da letra no LRCLIB"
                    try:
                        cortesia()
                        letra = buscar_letra_oficial(
                            titulo_id, artista_id, duracao, fetcher=fetcher,
                            log=log) or ""
                    except KeyboardInterrupt:
                        raise
                    except Exception as exc:
                        # a identificação já está paga: erro de rede na letra
                        # não descarta o que foi identificado
                        print(f"{prefixo}AVISO: {rel} — erro de rede na "
                              "busca da letra")
                        if verboso:
                            print(f"  detalhe técnico: {exc}")
                        letra = ""
                    if not letra and chave_vagalume:
                        # segunda fonte, com o título/artista JÁ confirmados
                        # pela impressão digital — é isso que dá ao
                        # casamento textual do Vagalume algo firme para
                        # conferir. A queda de uma fonte não leva a outra.
                        fase = "busca da letra no Vagalume"
                        try:
                            cortesia()
                            letra = buscar_letra_vagalume(
                                titulo_id, artista_id, chave_vagalume,
                                fetcher=fetcher, log=log) or ""
                            letra_do_vagalume = bool(letra)
                        except KeyboardInterrupt:
                            raise
                        except Exception as exc:
                            print(f"{prefixo}AVISO: {rel} — erro de rede na "
                                  "busca da letra no Vagalume")
                            if verboso:
                                print(f"  detalhe técnico: {exc}")
                            letra = ""

                fase = "gravação das tags no arquivo"
                if letra:
                    # letra OFICIAL nos dois casos: NUNCA leva o marcador de
                    # transcrição. A do Vagalume leva a marca da própria
                    # fonte (não confirmável pela duração); a do LRCLIB
                    # continua sem marca, como sempre foi.
                    el.embed_lyrics(p, letra, title=titulo or None,
                                    artist=artista or None,
                                    origem=(el.ORIGEM_VAGALUME
                                            if letra_do_vagalume else ""))
                    gravou = True
                    contagem["letras"] += 1
                    if letra_do_vagalume:
                        contagem["vagalume"] += 1
                elif titulo or artista:
                    el.write_title_artist(p, title=titulo or None,
                                          artist=artista or None)
                    gravou = True

                # a linha e o CSV mostram o que FICOU no arquivo, não o que
                # veio do AcoustID: o CSV é para conferência
                titulo_final = titulo or info["titulo"]
                artista_final = artista or info["artista"]
                preservou = ((titulo_atual and not titulo)
                             or (artista_atual and not artista))
                print(f"{prefixo}IDENTIFICADA: {rel} → "
                      f"{_ou_travessao(titulo_final)} / "
                      f"{_ou_travessao(artista_final)} "
                      f"({confianca}, pontuação {pontos}, {durs})"
                      + ((" + letra (Vagalume)" if letra_do_vagalume
                          else " + letra") if letra else ""))
                contagem["identificadas"] += 1
                linhas_csv.append(
                    [rel, "IDENTIFICADA", titulo_final, artista_final,
                     confianca, pontos, len(letra) if letra else "",
                     durs + ("; título/artista preservados"
                             if preservou else "")
                     + ("; letra do Vagalume" if letra_do_vagalume else "")])
            except KeyboardInterrupt:
                # a gravação é atômica (embed_lyrics.save_tags), então o
                # arquivo em andamento está íntegro; o que não dá é MENTIR
                # sobre ter gravado — confere no disco
                if not gravou:
                    gravou = _instantaneo(ler_info(p)) != antes
                situacao = ("gravação já concluída neste arquivo" if gravou
                            else "nada gravado")
                print(f"{prefixo}INTERROMPIDO: {rel} ({situacao})")
                linhas_csv.append([rel, "INTERROMPIDO", info["titulo"],
                                   info["artista"], "", "", "", situacao])
                interrompido = posicao
                break
            except Exception as exc:
                print(f"{prefixo}ERRO: {rel} — falha na {fase}")
                if verboso:  # a mensagem original costuma vir em inglês
                    print(f"  detalhe técnico: {exc}")
                contagem["erros"] += 1
                linhas_csv.append([rel, "ERRO", info["titulo"],
                                   info["artista"], "", "", "",
                                   f"falha na {fase}"])
                continue
    except KeyboardInterrupt:
        # Ctrl-C fora do processamento de um arquivo (entre um e outro)
        if interrompido is None:
            interrompido = posicao
    finally:
        # o resumo e o CSV SEMPRE saem: em acervo grande são horas de
        # trabalho, e perdê-las por um Ctrl-C seria pior que não ter CSV
        print(f"Resumo: {total} arquivos | "
              f"{contagem['identificadas']} identificadas | "
              f"{contagem['letras']} letras oficiais | "
              f"{contagem['sem_resultado']} sem resultado | "
              f"{contagem['conflitos']} conflitos | "
              f"{contagem['erros']} erros | "
              # recorte das letras oficiais, não balde à parte:
              # letras oficiais = as do LRCLIB + as do Vagalume
              f"{contagem['vagalume']} pelo Vagalume | "
              # também RECORTE (F17): o instrumental é identificado como
              # qualquer outro e cai no balde do seu resultado; o que ele
              # pula é só a busca de letra
              f"{contagem['instrumentais']} instrumentais")
        if interrompido is not None:
            parou_em, indice_parada = interrompido
            print(f"Interrompido em: {parou_em} (arquivo {indice_parada} de "
                  f"{total}) — {total - indice_parada} não processados")
        if csv_out is not None:
            gravar_csv(csv_out, IDENTIFICAR_COLUNAS, linhas_csv)


# ---------------------------------------------------------------- estimar

AMOSTRA_PADRAO = 10
# Média publicada do Chromaprint (o PRD mede 1–2 s por música). Só entra em
# cena quando não há fpcalc para medir aqui — e a saída DIZ isso.
SEGUNDOS_IDENTIFICAR_PADRAO = 1.5
# Segundos de CPU por segundo de áudio, por modelo do faster-whisper
# (proporção publicada). Serve para projetar sem baixar modelo nenhum e
# para converter uma medição de um modelo nos outros.
RAZAO_TRANSCRICAO = {"tiny": 0.06, "base": 0.10, "small": 0.25,
                     "medium": 0.70}
MODELOS_NA_ESTIMATIVA = ("small", "tiny")


def _fmt_estimativa(segundos: float) -> str:
    """Tempo projetado em linguagem de estimativa: "~45 s", "~4 min",
    "~1h20"."""
    total = max(0.0, float(segundos or 0.0))
    if total < 90:
        return f"~{max(1, int(round(total)))} s"  # "~0 s" não informa nada
    minutos = int(round(total / 60.0))
    if minutos < 60:
        return f"~{minutos} min"
    return f"~{minutos // 60}h{minutos % 60:02d}"


def _incompleto(info: dict) -> bool:
    """Falta letra, título ou artista REAIS (placeholder conta como vazio).

    V8/F17: música marcada como INSTRUMENTAL não tem letra a buscar — para
    ela, completo é ter título e artista. Contá-la como pendência inflava a
    estimativa com arquivos que todas as etapas de letra vão PULAR, e com
    40 pessoas curando cada uma o seu acervo em máquinas modestas, a conta
    de horas de CPU precisa ser honesta (PRD V8)."""
    tem_letra = bool(info["letra"]) or bool(info.get("instrumental"))
    return not (tem_letra and _sem_placeholder(info["titulo"])
                and _sem_placeholder(info["artista"]))


def _amostrar(itens: list, quantos: int) -> list:
    """Amostra espalhada pelo acervo — não só o começo, que costuma ser uma
    pasta só — e determinística (mesma pasta, mesma amostra)."""
    if quantos <= 0:
        return []
    if quantos >= len(itens):
        return list(itens)
    passo = len(itens) / float(quantos)
    return [itens[int(i * passo)] for i in range(quantos)]


def cmd_estimar(pasta: Path, amostra: int = AMOSTRA_PADRAO,
                impressao_digital=None, transcritor=None,
                modelo: str = "small", relogio=None,
                trecho: float = TRECHO_PADRAO_S,
                verboso: bool = False) -> None:
    """F15.1: conta o acervo, mede uma amostra e projeta o tempo de cada
    etapa do funil NESTE computador — para o curador decidir com número na
    mão em vez de descobrir depois de seis horas.

    Nada é gravado e NADA é baixado. Sem `fpcalc`, a identificação é
    projetada pela média publicada; a transcrição é sempre projetada pela
    proporção publicada do faster-whisper, a não ser que o chamador injete
    um transcritor já carregado (o comando jamais carrega o modelo por
    conta própria — seriam ~500 MB para dar um palpite). Os dois casos são
    DITOS na saída: estimativa apresentada como medição seria pior que não
    estimar."""
    relogio = relogio or time.monotonic
    mp3s = listar_mp3s(pasta)
    total = len(mp3s)
    if total == 0:
        print("Acervo: 0 arquivos")
        return

    infos = [(p, ler_info(p)) for p in mp3s]
    legiveis = [(p, info) for p, info in infos if not info["ilegivel"]]
    incompletos = sum(1 for _p, info in legiveis if _incompleto(info))
    instrumentais = sum(1 for _p, info in legiveis if info["instrumental"])
    # "sem letra" é a fila da TRANSCRIÇÃO, e é ela que vira horas de CPU:
    # o instrumental (F17) não entra nessa fila, e contá-lo aqui inflava a
    # projeção com arquivos que o funil pula.
    sem_letra = sum(1 for _p, info in legiveis
                    if not info["letra"] and not info["instrumental"])
    print(f"Acervo: {total} arquivos | {incompletos} incompletos | "
          f"{sem_letra} sem letra | {instrumentais} instrumentais")

    escolhidos = _amostrar(legiveis, amostra)
    if impressao_digital is None and shutil.which("fpcalc"):
        impressao_digital = criar_impressao_digital()

    avisos = []
    medidos = gasto_id = 0
    duracao_amostra = 0.0
    com_duracao = sem_prova = 0
    for p, info in escolhidos:
        # V8.2: a duração do cabeçalho não é medição (ver
        # `duracao_confirmada`). Um único MP3 remontado na amostra —
        # 300 s reais lidos como 2260 s — multiplicava por 7 a projeção da
        # média, e a estimativa existe justamente para a pessoa DECIDIR.
        confirmada = duracao_confirmada(p, info)
        if confirmada > 0:
            duracao_amostra += confirmada
            com_duracao += 1
        else:
            sem_prova += 1
        if impressao_digital is None:
            continue
        comeco = relogio()
        try:
            impressao_digital(str(p))
        except Exception:
            continue  # arquivo problemático não estraga a amostra
        gasto_id += relogio() - comeco
        medidos += 1
        if verboso:
            print(f"  medido: {p.relative_to(pasta).as_posix()}")

    n_amostra = len(escolhidos)
    if com_duracao:
        media_duracao = duracao_amostra / com_duracao
        if sem_prova:
            avisos.append(
                f"AVISO: {sem_prova} arquivo(s) da amostra ficaram de fora "
                "da média — a duração deles não pôde ser confirmada.")
    else:
        # nenhuma duração confirmada: dizer o número do cabeçalho é melhor
        # que não dizer número nenhum, DESDE QUE a saída avise que ele
        # pode estar muito errado
        media_duracao = ((sum(info["duracao"] for _p, info in escolhidos)
                          / n_amostra) if n_amostra else 0.0)
        if n_amostra:
            avisos.append(
                "AVISO: a duração dos arquivos da amostra não pôde ser "
                "confirmada — a projeção usa a duração declarada no "
                "cabeçalho do MP3, que em arquivo remontado ou cortado "
                "erra por muito.")
    if medidos:
        por_musica = gasto_id / medidos
    else:
        por_musica = SEGUNDOS_IDENTIFICAR_PADRAO
        media = f"{SEGUNDOS_IDENTIFICAR_PADRAO:.1f}".replace(".", ",")
        avisos.append(
            f"AVISO: fpcalc não encontrado — identificar foi projetado pela "
            f"média publicada (~{media} s por música), não medido nesta "
            "máquina.")

    razao_base = RAZAO_TRANSCRICAO.get(modelo, RAZAO_TRANSCRICAO["small"])
    nota = ("transcrever: projetado pela proporção publicada do "
            "faster-whisper (não medido nesta máquina — estimar não baixa "
            "modelo).")
    if transcritor is not None:
        gasto_tr = 0.0
        medidos_tr = 0
        for p, _info in escolhidos:
            comeco = relogio()
            try:
                transcritor(str(p), 0.0, trecho)
            except Exception:
                continue
            gasto_tr += relogio() - comeco
            medidos_tr += 1
        if medidos_tr:
            razao_base = (gasto_tr / medidos_tr) / max(trecho, 1.0)
            nota = (f"transcrever: medido nesta máquina em {medidos_tr} "
                    f"trecho(s) de {trecho:.0f}s com o modelo {modelo}; os "
                    "demais modelos saem da razão conhecida entre eles.")

    projecoes = []
    for nome_modelo in MODELOS_NA_ESTIMATIVA:
        fator = (RAZAO_TRANSCRICAO[nome_modelo]
                 / RAZAO_TRANSCRICAO.get(modelo, RAZAO_TRANSCRICAO["small"]))
        segundos = razao_base * fator * media_duracao * sem_letra
        projecoes.append(f"{_fmt_estimativa(segundos)} (modelo "
                         f"{nome_modelo})")

    print(f"Amostra: {n_amostra} arquivos (média de "
          f"{_fmt_dur(media_duracao)} por música)")
    print(f"Projeção: identificar: {_fmt_estimativa(por_musica * total)} | "
          "transcrever o restante: " + " ou ".join(projecoes))
    for aviso in avisos:
        print(aviso)
    print(nota)
    print("São ESTIMATIVAS, não promessas: o tempo real varia com o "
          "processador, a rede, a duração das músicas e quanto o "
          "identificar resolver antes.")


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Curadoria em massa do acervo (relatório, aplicação de "
                    "plano CSV e busca de letras no LRCLIB)."
    )
    sub = parser.add_subparsers(dest="comando", required=True)

    p_rel = sub.add_parser("relatorio",
                           help="varre a pasta e imprime/exporta o estado")
    p_rel.add_argument("pasta", help="pasta do acervo")
    p_rel.add_argument("--csv", default=None, metavar="SAIDA",
                       help="grava CSV editável (UTF-8 com BOM)")

    p_apl = sub.add_parser("aplicar",
                           help="aplica em massa um plano CSV editado")
    p_apl.add_argument("pasta", help="pasta do acervo")
    p_apl.add_argument("--csv", required=True, metavar="PLANO",
                       help="plano CSV (colunas do relatorio)")
    p_apl.add_argument("--dry-run", action="store_true",
                       help="só relata o que faria; não grava nada")

    p_bus = sub.add_parser("buscar-letra",
                           help="busca letras no LRCLIB para MP3s sem letra")
    p_bus.add_argument("pasta", help="pasta do acervo")
    p_bus.add_argument("--aplicar", action="store_true",
                       help="grava a letra encontrada no USLT")
    p_bus.add_argument("--chave-vagalume", default=None, dest="chave_vagalume",
                       metavar="CHAVE",
                       help="chave da API do Vagalume, usada como SEGUNDA "
                            "fonte no que o LRCLIB não tiver (padrão: "
                            "variável de ambiente VAGALUME_API_KEY). "
                            "Gratuita em "
                            "https://auth.vagalume.com.br/settings/api/; "
                            "nunca é gravada em disco pelo projeto. Sem "
                            "ela, o Vagalume é simplesmente pulado")
    p_bus.add_argument("--forcar", action="store_true",
                       help="reprocessa SOMENTE as músicas cuja letra veio "
                            "de transcrição automática (quem já rodou o "
                            "transcrever em todo o acervo precisa disto "
                            "para as fontes oficiais alcançarem os "
                            "arquivos); letra oficial não é tocada")
    p_bus.add_argument("--csv", default=None, metavar="SAIDA",
                       help="grava CSV com o resultado da busca")
    p_bus.add_argument("--verboso", action="store_true",
                       help="mostra cada consulta ao Vagalume e por que um "
                            "resultado foi recusado")

    p_enr = sub.add_parser("enriquecer",
                           help="identifica MP3s via LRCLIB e propõe/aplica "
                                "título, artista, letra e temas de pastas")
    p_enr.add_argument("pasta", help="pasta do acervo")
    p_enr.add_argument("--csv", default=None, metavar="PROPOSTA",
                       help="grava a proposta em CSV (revisar e usar em "
                            "aplicar-proposta)")
    modo = p_enr.add_mutually_exclusive_group()
    modo.add_argument("--interativo", action="store_true",
                      help="valida por arquivo no terminal e aplica na hora")
    modo.add_argument("--auto", action="store_true",
                      help="aplica na hora somente as de confiança ALTA")
    p_enr.add_argument("--forcar", action="store_true",
                       help="reprocessa arquivos completos e permite "
                            "sobrescrever letra existente")
    p_enr.add_argument("--sem-temas-de-pastas", action="store_true",
                       dest="sem_temas",
                       help="não propõe temas a partir das subpastas")
    p_enr.add_argument("--verboso", action="store_true",
                       help="mostra cada consulta enviada, quantos "
                            "resultados voltaram e o melhor candidato")

    p_apr = sub.add_parser("aplicar-proposta",
                           help="aplica as linhas aceitar=SIM de uma "
                                "proposta do enriquecer")
    p_apr.add_argument("pasta", help="pasta do acervo")
    p_apr.add_argument("--csv", required=True, metavar="PROPOSTA",
                       help="CSV gerado por enriquecer --csv (revisado)")
    p_apr.add_argument("--dry-run", action="store_true",
                       help="só relata o que faria; não grava nem usa rede")
    p_apr.add_argument("--forcar", action="store_true",
                       help="permite sobrescrever letra existente")

    p_trs = sub.add_parser("transcrever",
                           help="transcreve o áudio localmente (F14) e grava "
                                "a transcrição como letra")
    p_trs.add_argument("pasta", help="pasta do acervo")
    p_trs.add_argument("--modelo", default="small",
                       choices=["tiny", "base", "small", "medium"],
                       help="modelo do faster-whisper (padrão: small)")
    p_trs.add_argument("--idioma", default="pt",
                       help="idioma do áudio (padrão: pt)")
    # default=None para o programa SABER se a pessoa digitou a flag: sem
    # isso não dá para avisar que ela virou no-op (ver a validação em main)
    p_trs.add_argument("--trecho", type=float, default=None,
                       metavar="SEGUNDOS",
                       help="duração do trecho de identificação "
                            "(padrão: 90, a partir de 20s); só vale com "
                            "--identificar-por-refrao")
    p_trs.add_argument("--identificar-por-refrao", action="store_true",
                       dest="identificar_por_refrao",
                       help="liga a identificação pelo refrão (F14.1), "
                            "desligada por padrão: em dois acervos reais "
                            "de 94 arquivos ela rendeu 0 e 1 identificação "
                            "(a única, errada) contra 3 e 5 conflitos, e "
                            "cobra uma transcrição de trecho de 90 s por "
                            "arquivo")
    gate = p_trs.add_mutually_exclusive_group()
    gate.add_argument("--so-identificar", action="store_true",
                      dest="so_identificar",
                      help="só F14.1 (implica --identificar-por-refrao); "
                           "nunca transcreve a música inteira")
    gate.add_argument("--so-transcrever", action="store_true",
                      dest="so_transcrever",
                      help="pula a identificação e transcreve direto (é o "
                           "padrão desde que a F14.1 saiu do caminho)")
    p_trs.add_argument("--forcar", action="store_true",
                       help="reprocessa SOMENTE as músicas cuja letra veio de "
                            "transcrição (para rodar de novo com um modelo "
                            "maior); letra oficial não é tocada")
    p_trs.add_argument("--forcar-tudo", action="store_true",
                       dest="forcar_tudo",
                       help="reprocessa qualquer letra: as letras oficiais "
                            "serão substituídas pela transcrição")
    p_trs.add_argument("--sobrescrever-tags", action="store_true",
                       dest="sobrescrever_tags",
                       help="DESTRUTIVO: permite que uma identificação de "
                            "confiança ALTA substitua título/artista reais "
                            "já gravados (o padrão é só preencher campo "
                            "vazio)")
    p_trs.add_argument("--densidade-minima", type=float,
                       default=DENSIDADE_MINIMA_LETRA,
                       dest="densidade_minima", metavar="C_POR_S",
                       help="caracteres por segundo de áudio abaixo dos "
                            "quais a transcrição é ruído, e o arquivo é "
                            "marcado como instrumental em vez de receber "
                            "letra (padrão: "
                            f"{_fmt_decimal(DENSIDADE_MINIMA_LETRA)}; "
                            "0 desliga a regra e só a transcrição vazia "
                            "marca)")
    p_trs.add_argument("--csv", default=None, metavar="SAIDA",
                       help="registra o que foi feito, para conferência")
    p_trs.add_argument("--verboso", action="store_true",
                       help="mostra o trecho transcrito e os candidatos")

    p_ide = sub.add_parser("identificar",
                           help="identifica pela impressão digital acústica "
                                "(AcoustID) e grava título/artista (V6)")
    p_ide.add_argument("pasta", help="pasta do acervo")
    p_ide.add_argument("--chave", default=None, metavar="CHAVE",
                       help="chave da API do AcoustID (padrão: variável de "
                            "ambiente ACOUSTID_API_KEY). Gratuita em "
                            "https://acoustid.org/new-application; nunca é "
                            "gravada em disco pelo projeto")
    p_ide.add_argument("--com-letra", action="store_true", dest="com_letra",
                       help="após identificar, busca a letra OFICIAL no "
                            "LRCLIB pelo título/artista confirmados (e, no "
                            "que ele não tiver, no Vagalume)")
    p_ide.add_argument("--chave-vagalume", default=None, dest="chave_vagalume",
                       metavar="CHAVE",
                       help="chave da API do Vagalume para a busca de letra "
                            "de --com-letra (padrão: variável de ambiente "
                            "VAGALUME_API_KEY). Gratuita em "
                            "https://auth.vagalume.com.br/settings/api/; "
                            "nunca é gravada em disco pelo projeto")
    p_ide.add_argument("--sobrescrever-tags", action="store_true",
                       dest="sobrescrever_tags",
                       help="DESTRUTIVO: permite que uma identificação de "
                            "confiança ALTA substitua título/artista reais "
                            "já gravados (o padrão é só preencher campo "
                            "vazio)")
    p_ide.add_argument("--csv", default=None, metavar="SAIDA",
                       help="registra o que foi aplicado, com a confiança")
    p_ide.add_argument("--verboso", action="store_true",
                       help="mostra a pontuação e os candidatos descartados")

    p_est = sub.add_parser("estimar",
                           help="mede uma amostra e projeta o tempo de cada "
                                "etapa do funil neste computador")
    p_est.add_argument("pasta", help="pasta do acervo")
    p_est.add_argument("--amostra", type=int, default=AMOSTRA_PADRAO,
                       metavar="N",
                       help="quantos arquivos medir (padrão: "
                            f"{AMOSTRA_PADRAO})")
    p_est.add_argument("--verboso", action="store_true",
                       help="mostra cada arquivo medido")

    p_tdp = sub.add_parser("temas-de-pastas",
                           help="soma às tags os temas vindos das subpastas")
    p_tdp.add_argument("pasta", help="pasta do acervo")
    p_tdp.add_argument("--aplicar", action="store_true",
                       help="grava os temas (sem isto, só mostra o que faria)")

    args = parser.parse_args(argv)
    pasta = Path(args.pasta)
    validar_pasta(pasta)

    if args.comando == "relatorio":
        cmd_relatorio(pasta, csv_out=Path(args.csv) if args.csv else None)
    elif args.comando == "aplicar":
        cmd_aplicar(pasta, Path(args.csv), dry_run=args.dry_run)
    elif args.comando == "buscar-letra":
        # a chave do Vagalume nunca é lida nem escrita em disco: só
        # --chave-vagalume ou ambiente
        cmd_buscar_letra(pasta, aplicar=args.aplicar,
                         chave_vagalume=resolver_chave_vagalume(
                             args.chave_vagalume),
                         forcar=args.forcar, verboso=args.verboso,
                         csv_out=Path(args.csv) if args.csv else None)
    elif args.comando == "enriquecer":
        cmd_enriquecer(pasta, csv_out=Path(args.csv) if args.csv else None,
                       interativo=args.interativo, auto=args.auto,
                       forcar=args.forcar, temas_pastas=not args.sem_temas,
                       verboso=args.verboso)
    elif args.comando == "aplicar-proposta":
        cmd_aplicar_proposta(pasta, Path(args.csv), dry_run=args.dry_run,
                             forcar=args.forcar)
    elif args.comando == "transcrever":
        # combinação sem sentido: uma manda tentar a F14.1, a outra manda
        # pulá-la. Recusar é melhor que escolher em silêncio por quem pediu.
        if args.identificar_por_refrao and args.so_transcrever:
            die("ERRO: --identificar-por-refrao e --so-transcrever se "
                "contradizem — escolha um dos dois")
        # V8.2, achado MÉDIO do QA: com a F14.1 opt-in, --sobrescrever-tags
        # e --trecho só significam alguma coisa quando a identificação pelo
        # refrão roda. Sozinhas, não faziam NADA — e não faziam nada em
        # SILÊNCIO. As duas recebem tratamento diferente de propósito:
        #
        #  --sobrescrever-tags é AUTORIZAÇÃO DESTRUTIVA. Quem a digita
        #    acredita ter permitido trocar título/artista reais; ignorá-la
        #    calado deixa a pessoa com uma crença falsa sobre o que este
        #    comando pode fazer com o acervo dela. Por isso RECUSA, como a
        #    contradição acima.
        #  --trecho só regula o tamanho do trecho de identificação: não
        #    autoriza nem destrói nada, e recusar quebraria linha de comando
        #    antiga (ou copiada do README) que ainda faz a coisa certa. Por
        #    isso AVISA, alto e claro, e segue.
        fara_identificacao = ((args.identificar_por_refrao
                               or args.so_identificar)
                              and not args.so_transcrever)
        if args.sobrescrever_tags and not fara_identificacao:
            die("ERRO: --sobrescrever-tags só tem efeito com "
                "--identificar-por-refrao (ou --so-identificar) — sem a "
                "identificação pelo refrão o transcrever não grava título "
                "nem artista, e a flag não autorizaria nada. Acrescente "
                "--identificar-por-refrao ou tire a flag")
        if args.trecho is not None and not fara_identificacao:
            print("AVISO: --trecho vale só para a identificação pelo refrão "
                  "(--identificar-por-refrao), que está desligada — o valor "
                  "foi ignorado e a música é transcrita inteira.")
        cmd_transcrever(pasta, modelo=args.modelo, idioma=args.idioma,
                        trecho=(TRECHO_PADRAO_S if args.trecho is None
                                else args.trecho),
                        identificar_por_refrao=args.identificar_por_refrao,
                        so_identificar=args.so_identificar,
                        so_transcrever=args.so_transcrever,
                        forcar=args.forcar, forcar_tudo=args.forcar_tudo,
                        sobrescrever_tags=args.sobrescrever_tags,
                        densidade_minima=args.densidade_minima,
                        verboso=args.verboso,
                        csv_out=Path(args.csv) if args.csv else None)
    elif args.comando == "identificar":
        # a chave nunca é lida nem escrita em disco: só --chave ou ambiente
        cmd_identificar(pasta,
                        chave=(args.chave
                               or os.environ.get("ACOUSTID_API_KEY", "")),
                        com_letra=args.com_letra,
                        chave_vagalume=resolver_chave_vagalume(
                            args.chave_vagalume),
                        sobrescrever_tags=args.sobrescrever_tags,
                        verboso=args.verboso,
                        csv_out=Path(args.csv) if args.csv else None)
    elif args.comando == "estimar":
        cmd_estimar(pasta, amostra=args.amostra, verboso=args.verboso)
    elif args.comando == "temas-de-pastas":
        cmd_temas_de_pastas(pasta, aplicar=args.aplicar)


if __name__ == "__main__":
    main()
