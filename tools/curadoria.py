#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""curadoria.py — CLI de curadoria em massa do acervo do Cancioneiro (V2+V3).

Subcomandos:
    relatorio PASTA [--csv saida.csv]
        Varre a pasta recursivamente (*.mp3, case-insensitive), imprime uma
        tabela alinhada com arquivo/título/artista/letra/temas e, com --csv,
        grava um plano editável (UTF-8 com BOM, para abrir direto no Excel).

    aplicar PASTA --csv plano.csv [--dry-run]
        Aplica em massa o CSV editado: título (TIT2), artista (TPE1), temas
        (TXXX:TEMAS, normalizados) e letra (USLT, lida de letra_arquivo).
        Campos vazios nunca são tocados. --dry-run só relata, não grava.

    buscar-letra PASTA [--aplicar] [--csv saida.csv]
        Para cada MP3 sem letra com título E artista, consulta o LRCLIB
        (https://lrclib.net/api/get) e relata/grava o plainLyrics.

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
                [--so-identificar | --so-transcrever] [--forcar]
                [--csv saida.csv] [--verboso]
        V5/F14. Transcreve um trecho (90 s a partir de 20 s) com o
        faster-whisper (dependência OPCIONAL, na CPU), extrai o refrão —
        as frases curtas mais repetidas — e tenta identificar a música no
        LRCLIB por track_name + duração (F14.1); casando, grava título,
        artista e letra OFICIAIS. Sem casar, transcreve a música inteira e
        grava o texto no USLT com TXXX:LETRA_ORIGEM="transcricao" (F14.2).
        Nunca sobrescreve letra existente sem --forcar e nunca inventa
        título/artista a partir da transcrição.

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
import json
import re
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
TRANSCREVER_COLUNAS = ["arquivo", "acao", "titulo", "artista", "candidatos",
                       "caracteres", "detalhe"]
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
                "letra": "", "temas": [], "duracao": 0.0, "letra_origem": ""}
    uslt = tags.getall("USLT")
    return {
        "ilegivel": False,
        "titulo": str(tags["TIT2"]) if "TIT2" in tags else "",
        "artista": str(tags["TPE1"]) if "TPE1" in tags else "",
        "letra": str(uslt[0].text) if uslt and uslt[0].text else "",
        "temas": el.read_temas(tags),
        "duracao": float(audio.info.length or 0.0),
        "letra_origem": el.read_letra_origem(tags),
    }


def rotulo_letra(info: dict) -> str:
    """Coluna "letra" do relatório: NÃO, SIM ou SIM (transcrição) — o selo
    de procedência da V5/F14 (TXXX:LETRA_ORIGEM)."""
    if not info["letra"]:
        return "NÃO"
    if info.get("letra_origem") == el.ORIGEM_TRANSCRICAO:
        return "SIM (transcrição)"
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
    com_letra = com_temas = 0
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
        linhas_tabela.append([rel, titulo, artista, letra, temas])

    larguras = [max(len(linha[i]) for linha in [header] + linhas_tabela)
                for i in range(len(header))] if linhas_tabela else \
               [len(c) for c in header]
    for linha in [header] + linhas_tabela:
        print("  ".join(campo.ljust(larguras[i])
                        for i, campo in enumerate(linha)).rstrip())

    total = len(itens)
    print(f"Resumo: {total} arquivos | {com_letra} com letra | "
          f"{total - com_letra} sem letra | {com_temas} com temas")

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
                        tags.save(str(alvo), v2_version=4)
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
                     csv_out: Path | None = None, fetcher=None) -> None:
    encontradas = nao_encontradas = erros = 0
    linhas_csv = []
    for p in listar_mp3s(pasta):
        rel = p.relative_to(pasta).as_posix()
        info = ler_info(p)
        if info["ilegivel"] or info["letra"]:
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
        if letra:
            print(f"ENCONTRADA: {rel} ({len(letra)} caracteres)")
            encontradas += 1
            if aplicar:
                el.embed_lyrics(p, letra)  # reuso: USLT do embed_lyrics
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "encontrada", len(letra)])
        else:
            print(f"NÃO ENCONTRADA: {rel}")
            nao_encontradas += 1
            linhas_csv.append([rel, info["titulo"], info["artista"],
                               "não encontrada", ""])

    print(f"Resumo: {encontradas} encontradas | "
          f"{nao_encontradas} não encontradas | {erros} erros de rede")

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
    r"^(?:\d+\s+)?(?:audio\s?track|faixa|track|pista)(?:\s?\d+)?$")
_PLACEHOLDERS_EXATOS = frozenset({
    "artist", "no artist", "unknown artist", "artista desconhecido",
    "artista desconhecida", "unknown", "desconhecido", "desconhecida",
    "no title", "sem titulo", "untitled", "unknown title",
    "titulo desconhecido",
})


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
    return bool(_RE_PLACEHOLDER_FAIXA.match(chave))


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
            tags.save(str(path), v2_version=4)
    if temas_novos:
        existentes = el.read_temas(el.load_tags(path))
        el.write_temas(path, el.normalize_temas(existentes + temas_novos))


def cmd_enriquecer(pasta: Path, csv_out: Path | None = None,
                   interativo: bool = False, auto: bool = False,
                   forcar: bool = False, temas_pastas: bool = True,
                   fetcher=None, pausa: float = PAUSA_S,
                   verboso: bool = False) -> None:
    contagem = {"ALTA": 0, "MÉDIA": 0, "BAIXA": 0}
    aplicados = erros = 0
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
        try:
            melhor = _identificar(palpites, info["duracao"], buscar, log=log)
        except Exception:
            print(f"ERRO DE REDE: {rel}")
            erros += 1
            continue
        dur_mp3 = f"{info['duracao']:.0f}"
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
            print(f"{conf}: {rel} → {titulo_prop} / {artista_prop} "
                  f"(mp3 {dur_mp3}s, lrclib {dur_enc}s, "
                  f"letra {'SIM' if letra_prop else 'NÃO'})")
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
          f"{aplicados} aplicados | {erros} erros de rede")
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
            # existente não-vazia sem --forcar (nem gasta rede à toa)
            busca_letra = bool(lrclib_id) and (forcar or not info["letra"])
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


def extrair_candidatos(texto: str, maximo: int = MAX_CANDIDATOS) -> list:
    """Candidatos a título a partir do trecho transcrito (F14.1): as frases
    curtas MAIS REPETIDAS (o refrão — e o título de uma canção é, quase
    sempre, a frase mais repetida dela), seguidas da primeira linha cantada.

    A contagem usa a chave normalizada (_norm_comparacao: minúscula, sem
    acento, sem pontuação), então "Me apresento!", "ME APRESENTO," e
    "me apresentó" são a MESMA frase. Placeholders e números soltos
    ("faixa 5", "12") nunca viram candidato."""
    frases = _frases_do_trecho(texto)
    if not frases:
        return []
    contagem = {}  # chave -> [ocorrências, ordem de aparição, frase]
    for ordem, frase in enumerate(frases):
        chave = _norm_comparacao(frase)
        if len(chave) < 4 or eh_placeholder(frase):
            continue
        if chave in contagem:
            contagem[chave][0] += 1
        else:
            contagem[chave] = [1, ordem, frase]
    repetidas = [v for v in contagem.values()
                 if v[0] >= 2 and len(v[2].split()) <= MAX_PALAVRAS_REFRAO]
    repetidas.sort(key=lambda v: (-v[0], v[1]))
    candidatos = [v[2] for v in repetidas]
    primeira = frases[0]
    if (len(primeira.split()) <= MAX_PALAVRAS_PRIMEIRA
            and not eh_placeholder(primeira)
            and len(_norm_comparacao(primeira)) >= 4):
        candidatos.append(primeira)
    vistos = set()
    unicos = []
    for frase in candidatos:
        chave = _norm_comparacao(frase)
        if chave not in vistos:
            vistos.add(chave)
            unicos.append(frase)
    return unicos[:maximo]


def _identificar_por_refrao(candidatos: list, duracao_mp3: float, buscar,
                            log=None) -> dict | None:
    """Consulta o LRCLIB com cada candidato como track_name e devolve o
    melhor casamento ({"sim", "dif", "res", "candidato", "confianca"}) ou
    None. Confirmação pela duração com as MESMAS regras da V3 (classificar:
    ±3s ALTA, ≤8s ALTA com texto quase idêntico, ≤15s MÉDIA, >15s
    desqualifica); BAIXA não é identificação. Para no primeiro ALTA."""
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
            sim = similaridade(candidato, res.get("trackName") or "")
            duracao = res.get("duration")
            dif = (abs(duracao_mp3 - float(duracao))
                   if duracao is not None and duracao_mp3 else None)
            if dif is not None and dif > 15:
                continue  # homônimo/versão errada: desqualificado
            bonus = 0.0
            if dif is not None:
                bonus = 0.3 if dif <= 3 else (0.15 if dif <= 8 else 0.0)
            if melhor is None or sim + bonus > melhor["score"]:
                melhor = {"score": sim + bonus, "sim": sim, "dif": dif,
                          "res": res, "candidato": candidato}
        if melhor is not None and classificar(melhor["sim"],
                                              melhor["dif"]) == "ALTA":
            break
    if melhor is None:
        return None
    melhor["confianca"] = classificar(melhor["sim"], melhor["dif"])
    return None if melhor["confianca"] == "BAIXA" else melhor


def criar_transcritor(modelo: str = "small", idioma: str = "pt"):
    """Fábrica do transcritor real (faster-whisper na CPU). O import é
    PREGUIÇOSO: a biblioteca é dependência opcional; sem ela, explica em uma
    linha como instalar e sai com código 1 — sem tocar em arquivo nenhum, e
    com todos os outros subcomandos seguindo normais.

    O transcritor devolvido tem a assinatura injetável usada pelos testes:
    (caminho, inicio, duracao) -> texto puro. Com inicio/duracao transcreve
    só o trecho (F14.1); sem eles, o arquivo inteiro (F14.2)."""
    try:
        from faster_whisper import WhisperModel  # dependência opcional
    except ImportError:
        die(MSG_SEM_WHISPER)
    print(f"Carregando modelo {modelo}… (na primeira vez baixa o modelo, "
          "~500 MB, só desta vez)")
    model = WhisperModel(modelo, device="cpu", compute_type="int8")

    def transcritor(caminho: str, inicio=None, duracao=None) -> str:
        kwargs = {"language": idioma, "vad_filter": True}
        if inicio is not None and duracao is not None:
            kwargs["clip_timestamps"] = f"{inicio:.0f},{inicio + duracao:.0f}"
        segmentos, _info = model.transcribe(str(caminho), **kwargs)
        return "\n".join(s.text.strip() for s in segmentos if s.text.strip())

    return transcritor


def _fmt_milhar(n: int) -> str:
    """1842 -> "1.842" (padrão pt-BR, sem depender de locale)."""
    return "{:,}".format(n).replace(",", ".")


def _fmt_dur(segundos: float) -> str:
    """252.4 -> "4m12s"; 38.2 -> "38s"."""
    total = int(round(segundos or 0))
    if total >= 60:
        return f"{total // 60}m{total % 60:02d}s"
    return f"{total}s"


def cmd_transcrever(pasta: Path, transcritor=None, fetcher=None,
                    modelo: str = "small", idioma: str = "pt",
                    trecho: float = TRECHO_PADRAO_S,
                    inicio: float = TRECHO_INICIO_S,
                    so_identificar: bool = False,
                    so_transcrever: bool = False, forcar: bool = False,
                    csv_out: Path | None = None, verboso: bool = False,
                    pausa: float = PAUSA_S) -> None:
    """F14: identifica pelo refrão (F14.1) e, falhando, grava a transcrição
    completa como letra (F14.2). Nunca renomeia, nunca toca no áudio, nunca
    sobrescreve letra existente sem --forcar e nunca inventa título/artista
    a partir da transcrição."""
    if transcritor is None:
        transcritor = criar_transcritor(modelo, idioma)
    log = print if verboso else None
    estado = {"primeira": True}

    def buscar(track_name=""):
        if not estado["primeira"] and pausa:
            time.sleep(pausa)  # cortesia com a API entre buscas
        estado["primeira"] = False
        return fetch_search(fetcher=fetcher, track_name=track_name)

    mp3s = listar_mp3s(pasta)
    total = len(mp3s)
    identificadas = transcritas = pulados = erros = 0
    linhas_csv = []

    for indice, p in enumerate(mp3s, 1):
        rel = p.relative_to(pasta).as_posix()
        prefixo = f"[{indice}/{total}] "
        info = ler_info(p)
        if info["ilegivel"]:
            print(f"{prefixo}ERRO: {rel} — áudio ilegível")
            erros += 1
            linhas_csv.append([rel, "ERRO", "", "", "", "", "áudio ilegível"])
            continue
        if info["letra"] and not forcar:
            print(f"{prefixo}PULADO: {rel} (já tem letra)")
            pulados += 1
            linhas_csv.append([rel, "PULADO", info["titulo"], info["artista"],
                               "", len(info["letra"]), "já tem letra"])
            continue

        candidatos = []
        melhor = None
        try:
            if not so_transcrever:
                texto_trecho = transcritor(str(p), inicio, trecho)
                if verboso:
                    print("  trecho transcrito:")
                    for linha in (texto_trecho or "").strip().splitlines():
                        print(f"    {linha}")
                candidatos = extrair_candidatos(texto_trecho or "")
                if verboso:
                    print("  candidatos: "
                          + (", ".join(candidatos) or "(nenhum)"))
                try:
                    melhor = _identificar_por_refrao(candidatos,
                                                     info["duracao"], buscar,
                                                     log=log)
                except KeyboardInterrupt:
                    raise
                except Exception:
                    # o trecho já custou CPU: erro de rede não descarta o
                    # arquivo, só desiste da identificação e segue p/ F14.2
                    print(f"{prefixo}AVISO: {rel} — erro de rede na "
                          "identificação")

            if melhor is not None:
                res = melhor["res"]
                titulo = res.get("trackName") or ""
                artista = res.get("artistName") or ""
                letra = res.get("plainLyrics") or ""
                if melhor["confianca"] != "ALTA":
                    # confirmação mais fraca (regra da V3.1): só preenche
                    # campo vazio, nunca sobrescreve tag real existente
                    if _sem_placeholder(info["titulo"]):
                        titulo = ""
                    if _sem_placeholder(info["artista"]):
                        artista = ""
                if letra:
                    # letra OFICIAL: sai limpa e sem marca de transcrição
                    el.embed_lyrics(p, letra, title=titulo or None,
                                    artist=artista or None, origem="")
                elif titulo or artista:
                    el.write_title_artist(p, title=titulo or None,
                                          artist=artista or None)
                # nesta linha a duração sai em segundos puros (padrão do
                # enriquecer: "mp3 214s, lrclib 216s")
                dur_mp3 = f"{info['duracao']:.0f}s"
                duracao_res = res.get("duration")
                dur_res = (f"{float(duracao_res):.0f}s"
                           if duracao_res is not None else "?")
                print(f"{prefixo}IDENTIFICADA: {rel} → "
                      f"{res.get('trackName') or ''} / "
                      f"{res.get('artistName') or ''} "
                      f'(refrão "{melhor["candidato"]}", '
                      f"mp3 {dur_mp3}, lrclib {dur_res})")
                identificadas += 1
                linhas_csv.append([rel, "IDENTIFICADA",
                                   res.get("trackName") or "",
                                   res.get("artistName") or "",
                                   "; ".join(candidatos), len(letra),
                                   f"mp3 {dur_mp3}, lrclib {dur_res}"])
                continue

            if so_identificar:
                print(f"{prefixo}PULADO: {rel} (não identificada)")
                pulados += 1
                linhas_csv.append([rel, "PULADO", info["titulo"],
                                   info["artista"], "; ".join(candidatos), "",
                                   "não identificada"])
                continue

            comeco = time.monotonic()
            texto = unicodedata.normalize(
                "NFC", transcritor(str(p), None, None) or "")
            gasto = time.monotonic() - comeco
        except KeyboardInterrupt:
            # Ctrl-C: a gravação só acontece DEPOIS da transcrição completa,
            # então o arquivo em andamento fica exatamente como estava.
            print(f"{prefixo}INTERROMPIDO: {rel} (nada gravado)")
            break
        except Exception as exc:
            print(f"{prefixo}ERRO: {rel} — falha na transcrição: {exc}")
            erros += 1
            linhas_csv.append([rel, "ERRO", info["titulo"], info["artista"],
                               "; ".join(candidatos), "",
                               f"falha na transcrição: {exc}"])
            continue

        if not texto.strip():
            print(f"{prefixo}ERRO: {rel} — transcrição vazia")
            erros += 1
            linhas_csv.append([rel, "ERRO", info["titulo"], info["artista"],
                               "; ".join(candidatos), "", "transcrição vazia"])
            continue
        # letra limpa (sem cabeçalho, que poluiria a busca por trecho) e
        # título/artista intocados: transcrição não inventa identificação
        el.embed_lyrics(p, texto, origem=el.ORIGEM_TRANSCRICAO)
        print(f"{prefixo}TRANSCRITA: {rel} "
              f"({_fmt_milhar(len(texto))} caracteres, "
              f"{_fmt_dur(info['duracao'])} de áudio em {_fmt_dur(gasto)})")
        transcritas += 1
        linhas_csv.append([rel, "TRANSCRITA", info["titulo"], info["artista"],
                           "; ".join(candidatos), len(texto), "transcricao"])

    print(f"Resumo: {total} arquivos | {identificadas} identificadas | "
          f"{transcritas} transcritas | {pulados} puladas | {erros} erros")
    if csv_out is not None:
        gravar_csv(csv_out, TRANSCREVER_COLUNAS, linhas_csv)


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
    p_bus.add_argument("--csv", default=None, metavar="SAIDA",
                       help="grava CSV com o resultado da busca")

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
                           help="transcreve o áudio localmente (F14): "
                                "identifica pelo refrão no LRCLIB e, "
                                "falhando, grava a transcrição como letra")
    p_trs.add_argument("pasta", help="pasta do acervo")
    p_trs.add_argument("--modelo", default="small",
                       choices=["tiny", "base", "small", "medium"],
                       help="modelo do faster-whisper (padrão: small)")
    p_trs.add_argument("--idioma", default="pt",
                       help="idioma do áudio (padrão: pt)")
    p_trs.add_argument("--trecho", type=float, default=TRECHO_PADRAO_S,
                       metavar="SEGUNDOS",
                       help="duração do trecho de identificação "
                            "(padrão: 90, a partir de 20s)")
    gate = p_trs.add_mutually_exclusive_group()
    gate.add_argument("--so-identificar", action="store_true",
                      dest="so_identificar",
                      help="só F14.1; nunca transcreve a música inteira")
    gate.add_argument("--so-transcrever", action="store_true",
                      dest="so_transcrever",
                      help="pula a identificação; transcreve direto")
    p_trs.add_argument("--forcar", action="store_true",
                       help="reprocessa quem já tem letra (sobrescreve)")
    p_trs.add_argument("--csv", default=None, metavar="SAIDA",
                       help="registra o que foi feito, para conferência")
    p_trs.add_argument("--verboso", action="store_true",
                       help="mostra o trecho transcrito e os candidatos")

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
        cmd_buscar_letra(pasta, aplicar=args.aplicar,
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
        cmd_transcrever(pasta, modelo=args.modelo, idioma=args.idioma,
                        trecho=args.trecho,
                        so_identificar=args.so_identificar,
                        so_transcrever=args.so_transcrever,
                        forcar=args.forcar, verboso=args.verboso,
                        csv_out=Path(args.csv) if args.csv else None)
    elif args.comando == "temas-de-pastas":
        cmd_temas_de_pastas(pasta, aplicar=args.aplicar)


if __name__ == "__main__":
    main()
