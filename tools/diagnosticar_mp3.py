#!/usr/bin/env python3
"""Diz por que o Cancioneiro não consegue GRAVAR etiquetas num arquivo.

Nasceu de um relato de campo: 7 músicas de uma pasta falharam todas com a
mesma frase — "não foi possível ler este MP3 até o fim [...] o arquivo pode
estar danificado, ou o disco onde ele está pode ter sido desconectado". Essa
frase cobria OITO situações diferentes da biblioteca de etiquetas, e algumas
delas não têm nada a ver com arquivo danificado nem com disco. Quem lê não
tem como saber qual aconteceu — e é justamente quem não tem a quem
perguntar.

A frase citada acima **não existe mais no produto** (V10.7): as oito situações
foram separadas em duas famílias, com frases que dizem a verdade de cada uma —
a estrutura do arquivo que a biblioteca não entende e o texto de etiqueta que
não pôde ser decodificado —, e nenhuma delas fala de disco, porque o disco
tem caminho próprio. O que este script continua fazendo é o que a mensagem
não pode fazer sozinha: dizer QUAL das situações aconteceu neste arquivo.

Este script não conserta nada e **não escreve em nenhum arquivo**: abre para
leitura, mede, e imprime. É a mesma promessa do produto (a reprodução nunca
escreve; nada é gravado sem alguém conferir e clicar).

A medição que este script fez sobre a SOBRA entre a etiqueta declarada e o
primeiro quadro MPEG virou conserto no produto (V10.8): ver
`descreve_a_sobra`. Ele continua sendo o que separa a sobra que tem conserto
das duas que não têm.

Uso:

    python3 tools/diagnosticar_mp3.py "/caminho/da/pasta"
    python3 tools/diagnosticar_mp3.py arquivo1.mp3 arquivo2.mp3
"""

from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Assinaturas de CONTAINER. O ponto do script.
#
# Um arquivo com extensão .mp3 que na verdade é MPEG-4/AAC, FLAC, Ogg ou WAV
# TOCA no Cancioneiro — quem decodifica o áudio é o WebView, e ele aceita
# vários formatos. Mas gravar etiqueta ID3 exige fluxo MPEG, e a biblioteca
# recusa. O sintoma que a pessoa vê é "não foi possível salvar", e o motivo
# real é que o arquivo nunca foi um MP3.
# ---------------------------------------------------------------------------
ASSINATURAS: list[tuple[int, bytes, str]] = [
    (4, b"ftyp", "MPEG-4 / AAC (.m4a, .mp4) com nome de .mp3"),
    (0, b"fLaC", "FLAC"),
    (0, b"OggS", "Ogg (Vorbis/Opus)"),
    (0, b"RIFF", "RIFF/WAVE"),
    (0, b"FORM", "AIFF"),
    (0, b"\x1aE\xdf\xa3", "Matroska / WebM"),
    (0, b"MAC ", "Monkey's Audio"),
    (0, b"wvpk", "WavPack"),
]


def container(dados: bytes) -> str | None:
    """O formato REAL do arquivo, quando não é MPEG."""
    for deslocamento, marca, nome in ASSINATURAS:
        if dados[deslocamento : deslocamento + len(marca)] == marca:
            return nome
    return None


def tamanho_do_id3(dados: bytes) -> int:
    """Bytes do cabeçalho ID3v2 no começo do arquivo (0 se não houver).

    O tamanho vem em "synchsafe": sete bits por byte, para o valor nunca
    imitar um sync de MPEG.
    """
    if len(dados) < 10 or dados[:3] != b"ID3":
        return 0
    b = dados[6:10]
    if any(x & 0x80 for x in b):
        return 0  # tamanho inválido; tratado como "não sei"
    return 10 + ((b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3])


def acha_sync_mpeg(dados: bytes, inicio: int) -> int | None:
    """Posição do primeiro quadro MPEG plausível a partir de `inicio`."""
    i = inicio
    limite = min(len(dados) - 1, inicio + 512 * 1024)
    while i < limite:
        if dados[i] == 0xFF and (dados[i + 1] & 0xE0) == 0xE0:
            versao = (dados[i + 1] >> 3) & 0x03
            camada = (dados[i + 1] >> 1) & 0x03
            # versão 01 é reservada; camada 00 é reservada
            if versao != 1 and camada != 0:
                return i
        i += 1
    return None


# Marcas que explicam uma sobra entre o fim da etiqueta e o começo do áudio.
# Cada uma tem consequência DIFERENTE para a gravação, e é por isso que vale
# nomeá-las em vez de dizer só "tem lixo aqui".
MARCAS_DA_SOBRA: list[tuple[bytes, str]] = [
    (b"ID3", "uma SEGUNDA etiqueta ID3v2 grudada na primeira"),
    (b"3DI", "o RODAPÉ de uma etiqueta ID3v2 (a etiqueta declarou tamanho menor)"),
    (b"APETAGEX", "uma etiqueta APE"),
    (b"Xing", "um cabeçalho Xing solto (fora de quadro MPEG)"),
    (b"Info", "um cabeçalho Info solto (fora de quadro MPEG)"),
    (b"LAME", "assinatura do codificador LAME"),
    (b"TAG", "uma etiqueta ID3v1 no lugar errado"),
    (b"\xff\xf1", "um quadro AAC/ADTS"),
    (b"\xff\xf9", "um quadro AAC/ADTS"),
]


def sobra_e_inocente(sobra: bytes) -> str | None:
    """A sobra tem explicação BENIGNA? Devolve o motivo, ou `None`.

    Este script já mediu errado uma vez, e vale registrar como: num arquivo
    feito com LAME o PRIMEIRO quadro de áudio carrega o cabeçalho Xing/Info,
    com enchimento de `0x55` e a assinatura do codificador. O detector daqui
    procura o primeiro `FF Fx` DEPOIS do fim da etiqueta; quando o quadro real
    começa antes desse ponto, ele acha o SEGUNDO quadro e acusa uma sobra que
    é, na verdade, o miolo do primeiro. O arquivo estava perfeito.

    Ferramenta de diagnóstico que grita lobo é pior que nenhuma: ela manda a
    pessoa (ou a mim) mexer no que está certo.
    """
    if b"LAME" in sobra or b"Xing" in sobra or b"Info" in sobra:
        return "é o cabeçalho Xing/Info dentro do primeiro quadro (arquivo normal)"
    # o enchimento de 0x55 é a marca do mesmo cabeçalho, mesmo sem a assinatura
    if sobra.count(0x55) > len(sobra) // 4:
        return "tem o enchimento 0x55 do cabeçalho do codificador (arquivo normal)"
    return None


def descreve_a_sobra(dados: bytes, inicio: int, sync: int) -> None:
    """Diz o que há entre o fim declarado da etiqueta e o primeiro quadro.

    É o pedaço que decide o conserto. A mesma sobra pode ser uma etiqueta
    mal-declarada (o arquivo está bom, o TAMANHO está errado), lixo de um
    editor antigo, ou áudio de outro formato — e cada um desses casos merece
    uma frase diferente na tela de quem não tem a quem perguntar.

    **V10.8 — o primeiro desses casos passou a ter conserto no produto**, e ele
    acontece junto com a gravação que a pessoa pediu: quando a gravação falha
    por não reconhecer o formato, o aplicativo corrige o campo de tamanho da
    etiqueta para alcançar o primeiro quadro, grava, e CONFERE que o áudio não
    mudou (se mudou, o arquivo volta ao que era e a gravação vira recusa). O
    desfecho é dito na linha da revisão.
    Duas sobras continuam SEM conserto, e este script é o que as separa: a que
    carrega outra etiqueta (`ID3`, `3DI`, `APETAGEX`, `TAG` abaixo — absorvê-la
    apagaria dado de alguém) e a de um arquivo que nunca foi MPEG.
    """
    sobra = dados[inicio:sync]
    inocente = sobra_e_inocente(sobra)
    if inocente is not None:
        print(f"    a sobra é EXPLICADA: {inocente}")
        return
    print(f"    o que há na sobra ({len(sobra)} bytes) — sem explicação benigna:")
    for marca, o_que_e in MARCAS_DA_SOBRA:
        pos = sobra.find(marca)
        if pos != -1:
            print(f"      - em +{pos}: {o_que_e}")
    zeros = sobra.count(0)
    print(f"      - {zeros} de {len(sobra)} bytes são zero ({100 * zeros // len(sobra)}%)")
    # os primeiros bytes em hexa e em texto: é o que identifica o programa que
    # gravou, quando ele deixou assinatura legível
    amostra = sobra[:48]
    hexa = " ".join(f"{b:02x}" for b in amostra)
    texto = "".join(chr(b) if 32 <= b < 127 else "." for b in amostra)
    print(f"      - começo: {hexa}")
    print(f"                {texto}")
    legivel = bytes(b for b in sobra if 32 <= b < 127)
    if len(legivel) >= 8:
        print(f"      - texto achado na sobra: {legivel[:120]!r}")


def texto_das_etiquetas(caminho: Path) -> list[str]:
    """Problemas de TEXTO nas etiquetas — uma família inteira, sozinha.

    `StringFromUtf8`, `StrFromUtf8` e `TextDecode` caíam na mensagem que falava
    de arquivo danificado, e não são isso: são bytes de texto que não
    correspondem à codificação declarada no quadro. Desde a V10.7 elas têm frase
    própria no produto (`writer::ERRO_TEXTO_DA_ETIQUETA`), que diz que o
    problema é só do texto — o que este bloco confere arquivo por arquivo.
    """
    achados: list[str] = []
    try:
        from mutagen.id3 import ID3  # type: ignore[import-not-found]
    except ImportError:
        return ["(mutagen não instalado — `pip install mutagen` para esta parte)"]
    try:
        tag = ID3(caminho)
    except Exception as e:  # noqa: BLE001 — qualquer falha aqui É o achado
        return [f"o ID3 não pôde ser lido pelo mutagen: {type(e).__name__}: {e}"]
    for quadro in tag.values():
        nome = getattr(quadro, "FrameID", type(quadro).__name__)
        # o campo de idioma de USLT/COMM foi causa de recusa de gravação antes
        idioma = getattr(quadro, "lang", None)
        if idioma is not None and (
            len(idioma) != 3 or not all(c.isascii() and c.isalpha() for c in idioma)
        ):
            achados.append(f"{nome}: campo de idioma fora do padrão ({idioma!r})")
        for texto in getattr(quadro, "text", []) or []:
            if not isinstance(texto, str):
                continue
            try:
                texto.encode("utf-8")
            except UnicodeEncodeError as e:
                achados.append(f"{nome}: texto que não vira UTF-8 ({e})")
    return achados


def _partes(carga: bytes, nulo: bytes) -> list[bytes]:
    """Separa as strings de um quadro pelo terminador da codificação."""
    if len(nulo) == 1:
        return carga.split(nulo)
    partes, atual = [], 0
    for i in range(0, len(carga) - 1, 2):  # nulo de UTF-16 só vale alinhado
        if carga[i : i + 2] == nulo:
            partes.append(carga[atual:i])
            atual = i + 2
    partes.append(carga[atual:])
    return partes


def _legivel(carga: bytes) -> str:
    """Um pedaço do texto, do jeito que der, para a pessoa reconhecer QUAL é."""
    texto = carga.replace(b"\x00", b"").decode("latin-1", errors="replace")
    texto = "".join(c if c.isprintable() else "·" for c in texto).strip()
    return texto[:60] + ("…" if len(texto) > 60 else "")


def quadros_que_o_programa_nao_le(dados: bytes) -> list[str]:
    """Os quadros ID3v2 cujo TEXTO o app não consegue ler — medidos byte a byte.

    O app usa o lofty 0.22, que derruba a leitura do arquivo INTEIRO quando o
    texto de um único quadro não bate com a codificação que o próprio quadro
    declara, em qualquer modo de leitura. E sem ler, não grava: um comentário
    estragado por um programa antigo bloqueia o arquivo todo. O mutagen
    (`texto_das_etiquetas`) é tolerante e lê o mesmo arquivo sem reclamar — por
    isso esta leitura própria, com as regras do lofty, só para dizer QUAL.
    """
    if len(dados) < 10 or dados[:3] != b"ID3":
        return []
    versao, flags = dados[3], dados[5]
    if versao not in (3, 4):
        return []  # v2.2 tem outro formato de quadro; não é o caso medido
    fim = min(tamanho_do_id3(dados), len(dados))  # já conta o cabeçalho
    pos = 10
    if flags & 0x40:  # cabeçalho estendido: pula
        tam = int.from_bytes(dados[10:14], "big")
        if versao == 4:
            tam = (dados[10] << 21) | (dados[11] << 14) | (dados[12] << 7) | dados[13]
            pos = 10 + tam
        else:
            pos = 14 + tam
    achados: list[str] = []
    while pos + 10 <= fim:
        ident = dados[pos : pos + 4]
        if ident[0] == 0 or not all(48 <= b <= 57 or 65 <= b <= 90 for b in ident):
            break  # preenchimento (zeros) ou fim dos quadros
        nome = ident.decode("ascii")
        if versao == 4:
            b = dados[pos + 4 : pos + 8]
            tam = (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]
        else:
            tam = int.from_bytes(dados[pos + 4 : pos + 8], "big")
        flag2 = dados[pos + 9]
        corpo = dados[pos + 10 : pos + 10 + tam]
        pos += 10 + tam
        if versao == 4 and flag2 & 0x01:  # indicador de tamanho: 4 bytes antes
            corpo = corpo[4:]
        if flag2 & 0x0C:  # comprimido ou cifrado: não dá para medir o texto
            continue
        com_texto = nome.startswith("T") or nome in ("COMM", "USLT", "WXXX")
        if not com_texto or not corpo:
            continue
        cod, carga = corpo[0], corpo[1:]
        if nome in ("COMM", "USLT"):
            carga = carga[3:]  # o campo de idioma não é texto codificado
        if cod > 3:
            achados.append(f"{nome}: codificação {cod}, que não existe no padrão — \"{_legivel(carga)}\"")
            continue
        if cod == 3:
            for parte in _partes(carga, b"\x00"):
                try:
                    parte.decode("utf-8")
                except UnicodeDecodeError:
                    achados.append(
                        f"{nome}: declara UTF-8, mas os bytes não são UTF-8 "
                        f"(costuma ser Latin-1 gravado por programa antigo) — \"{_legivel(parte)}\""
                    )
                    break
        elif cod in (1, 2):
            if len(carga) % 2:
                achados.append(f"{nome}: texto UTF-16 com tamanho ímpar — \"{_legivel(carga)}\"")
                continue
            if cod == 1:
                for parte in _partes(carga, b"\x00\x00"):
                    if parte and parte[:2] not in (b"\xff\xfe", b"\xfe\xff"):
                        achados.append(
                            f"{nome}: texto UTF-16 sem a marca de ordem dos bytes (BOM) — "
                            f"\"{_legivel(parte)}\""
                        )
                        break
    return achados


def diagnosticar(caminho: Path) -> None:
    print(f"\n=== {caminho.name}")
    try:
        with caminho.open("rb") as f:  # leitura, e só
            dados = f.read()
    except OSError as e:
        print(f"  NÃO DEU PARA ABRIR: {e}")
        return

    print(f"  tamanho: {len(dados):,} bytes")
    if len(dados) < 512:
        print("  PROBLEMA: arquivo minúsculo — download interrompido?")
        return

    real = container(dados)
    if real is not None:
        print(f"  >>> NÃO É UM MP3. É {real}.")
        print("      O player toca (quem decodifica é o sistema), mas gravar")
        print("      etiqueta exige fluxo MPEG — daí a recusa ao salvar.")
        return

    inicio = tamanho_do_id3(dados)
    print(f"  ID3v2 no começo: {inicio:,} bytes" if inicio else "  sem ID3v2 no começo")
    if inicio > len(dados):
        print("  >>> PROBLEMA: o ID3 diz ser MAIOR que o arquivo inteiro.")
        print("      É a assinatura de download interrompido no meio da etiqueta.")
        return

    sync = acha_sync_mpeg(dados, inicio)
    if sync is None:
        print("  >>> PROBLEMA: nenhum quadro MPEG encontrado depois da etiqueta.")
        print("      O arquivo tem etiqueta, mas não tem áudio MPEG reconhecível.")
        return
    if sync != inicio:
        print(f"  quadro MPEG começa em {sync:,} (e não em {inicio:,}) — {sync - inicio} bytes de sobra")
        descreve_a_sobra(dados, inicio, sync)
    else:
        print(f"  quadro MPEG começa em {sync:,}, como esperado")

    # V15 — a leitura com as regras do app vem PRIMEIRO: é ela que diz qual
    # quadro faz o app recusar "o texto de uma etiqueta deste MP3"
    problemas = quadros_que_o_programa_nao_le(dados) + texto_das_etiquetas(caminho)
    if problemas:
        print("  etiquetas:")
        for p in problemas:
            print(f"    - {p}")
    else:
        print("  etiquetas: nada fora do padrão encontrado")
        print("  (se este arquivo ainda falha ao salvar, me mande esta saída:")
        print("   a causa não está nas coisas que este script sabe medir)")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    alvos: list[Path] = []
    for arg in argv[1:]:
        p = Path(arg).expanduser()
        if p.is_dir():
            alvos.extend(sorted(q for q in p.rglob("*") if q.suffix.lower() == ".mp3"))
        elif p.exists():
            alvos.append(p)
        else:
            print(f"não achei: {p}")
    if not alvos:
        print("nenhum .mp3 encontrado")
        return 1
    print(f"{len(alvos)} arquivo(s) — NADA é modificado, só lido")
    for a in alvos:
        diagnosticar(a)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
