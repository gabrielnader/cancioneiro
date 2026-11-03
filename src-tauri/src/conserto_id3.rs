//! O quadro de texto SEM o byte de codificação (V15.1).
//!
//! Medido num arquivo real com o `tools/diagnosticar_mp3.py`: TYER (ano) e TENC
//! (programa que gravou) começavam direto pelo texto — o "2" de "1982" e o "r"
//! de "r1.4" ocupavam o lugar do byte que declara a codificação (valores 50 e
//! 114, que não existem no padrão). Algum programa antigo simplesmente não o
//! escreveu.
//!
//! O lofty 0.22 derruba a leitura do arquivo INTEIRO por um quadro assim, em
//! qualquer modo de leitura: o modo tolerante só pula quadro com CABEÇALHO
//! quebrado, e aqui o cabeçalho está certo. Sem ler, o app não via o título nem
//! o artista verdadeiros (mostrava o nome do arquivo e "(vazio)") — e a
//! curadoria oferecia "preencher" o que nunca esteve vazio. E não gravava nada.
//!
//! **O conserto não perde um byte.** Acrescenta, na frente do texto, o byte que
//! declara Latin-1 — a codificação em que TODO byte é um caractere válido. O
//! texto continua exatamente o mesmo; só passa a dizer como deve ser lido. É a
//! mesma escolha do idioma `und` (V10.1): consertar o quadro alheio em vez de
//! descartá-lo, porque descartar apaga o que alguém gravou.
//!
//! O conserto acontece na MEMÓRIA, sobre uma cópia dos bytes, e só quando a
//! leitura normal já falhou. O arquivo só muda quando a pessoa manda gravar —
//! e aí a etiqueta é regravada inteira, como em toda gravação.

/// Até onde a etiqueta ID3v2 vai, contando o cabeçalho de 10 bytes.
fn fim_da_etiqueta(dados: &[u8]) -> Option<usize> {
    if dados.len() < 10 || &dados[..3] != b"ID3" {
        return None;
    }
    let b = &dados[6..10];
    if b.iter().any(|x| x & 0x80 != 0) {
        return None;
    }
    let tam = ((b[0] as usize) << 21) | ((b[1] as usize) << 14) | ((b[2] as usize) << 7) | b[3] as usize;
    Some(10 + tam)
}

fn ler_syncsafe(b: &[u8]) -> usize {
    ((b[0] as usize) << 21) | ((b[1] as usize) << 14) | ((b[2] as usize) << 7) | b[3] as usize
}

fn escrever_syncsafe(n: usize) -> Option<[u8; 4]> {
    if n >= 1 << 28 {
        return None;
    }
    Some([((n >> 21) & 0x7F) as u8, ((n >> 14) & 0x7F) as u8, ((n >> 7) & 0x7F) as u8, (n & 0x7F) as u8])
}

/// Devolve uma CÓPIA do arquivo com os quadros de texto sem codificação
/// consertados, e os identificadores dos quadros consertados. `None` quando não
/// há o que consertar — ou quando a etiqueta usa um recurso que este código não
/// sabe percorrer com segurança (dessincronização, compressão, cifra): aí a
/// recusa original continua valendo, e nada é inventado.
pub fn consertar_codificacao_ausente(arquivo: &[u8]) -> Option<(Vec<u8>, Vec<String>)> {
    let fim = fim_da_etiqueta(arquivo)?;
    if fim > arquivo.len() {
        return None;
    }
    let versao = arquivo[3];
    let flags = arquivo[5];
    if !(versao == 3 || versao == 4) || flags & 0x80 != 0 {
        // v2.2 tem outro formato de quadro; dessincronização embaralha os bytes
        return None;
    }
    // o cabeçalho estendido é copiado como está
    let mut pos = 10;
    if flags & 0x40 != 0 {
        if arquivo.len() < 14 {
            return None;
        }
        pos = if versao == 4 {
            10 + ler_syncsafe(&arquivo[10..14])
        } else {
            14 + u32::from_be_bytes(arquivo[10..14].try_into().ok()?) as usize
        };
        if pos > fim {
            return None;
        }
    }

    let mut corpo: Vec<u8> = arquivo[10..pos].to_vec();
    let mut consertados = Vec::new();
    while pos + 10 <= fim {
        let id = &arquivo[pos..pos + 4];
        if id[0] == 0 || !id.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
            break; // o resto é preenchimento
        }
        let tam = if versao == 4 {
            ler_syncsafe(&arquivo[pos + 4..pos + 8])
        } else {
            u32::from_be_bytes(arquivo[pos + 4..pos + 8].try_into().ok()?) as usize
        };
        let flags_do_quadro = [arquivo[pos + 8], arquivo[pos + 9]];
        let inicio = pos + 10;
        let fim_do_quadro = inicio.checked_add(tam)?;
        if fim_do_quadro > fim {
            return None;
        }
        let dados = &arquivo[inicio..fim_do_quadro];
        // compressão, cifra, dessincronização ou indicador de tamanho no
        // quadro: o primeiro byte não é o da codificação, e não se adivinha
        let especial = if versao == 4 { flags_do_quadro[1] & 0x0F != 0 } else { flags_do_quadro[1] & 0xC0 != 0 };
        let de_texto = id[0] == b'T';
        // o quadro consertado: (identificador, conteúdo novo)
        let conserto: Option<([u8; 4], Vec<u8>)> = if !de_texto || especial || dados.is_empty() {
            None
        } else if dados[0] > 3 {
            // Latin-1: todo byte é um caractere, nada se perde
            let mut novo = vec![0];
            novo.extend_from_slice(dados);
            // V15.7 — e o texto devolvido ainda pode ser uma data que o lofty
            // recusa (medido: o TYER do "Deckard's Dream" é só "2")
            if QUADROS_DE_DATA.contains(&id) && data_que_o_lofty_recusa(&novo) {
                Some((*b"TXXX", data_como_anotacao(id, &novo)?))
            } else {
                Some((id.try_into().ok()?, novo))
            }
        } else if dados[0] == 3 && e_latin1_rotulado_como_utf8(&dados[1..]) {
            // V15.5 — declara UTF-8 e é Latin-1: só o rótulo troca
            let mut novo = dados.to_vec();
            novo[0] = 0;
            Some((id.try_into().ok()?, novo))
        } else if versao == 3 && (id == b"TDAT" || id == b"TIME") && dia_ou_hora_impossivel(id, dados) {
            // V15.7 — o dia/mês (ou hora) da v2.3 que o lofty junta ao ano
            // numa data que ele mesmo recusa gravar: vira anotação, mesmo texto
            Some((*b"TXXX", data_como_anotacao(id, dados)?))
        } else if QUADROS_DE_DATA.contains(&id) && data_que_o_lofty_recusa(dados) {
            // V15.5 — data que o lofty não lê (ou não grava): vira anotação
            // TXXX com o nome do quadro como descrição e o MESMO texto
            Some((*b"TXXX", data_como_anotacao(id, dados)?))
        } else {
            None
        };
        if let Some((novo_id, novo)) = conserto {
            corpo.extend_from_slice(&novo_id);
            if versao == 4 {
                corpo.extend_from_slice(&escrever_syncsafe(novo.len())?);
            } else {
                corpo.extend_from_slice(&(u32::try_from(novo.len()).ok()?).to_be_bytes());
            }
            corpo.extend_from_slice(&flags_do_quadro);
            corpo.extend_from_slice(&novo);
            consertados.push(String::from_utf8_lossy(id).into_owned());
        } else {
            corpo.extend_from_slice(&arquivo[pos..fim_do_quadro]);
        }
        pos = fim_do_quadro;
    }
    if consertados.is_empty() {
        return None;
    }
    // o preenchimento que sobrava continua lá (só encolhe o que coube a mais)
    corpo.extend_from_slice(&arquivo[pos.min(fim)..fim]);

    let mut novo = Vec::with_capacity(arquivo.len() + consertados.len());
    novo.extend_from_slice(&arquivo[..6]);
    novo.extend_from_slice(&escrever_syncsafe(corpo.len())?);
    novo.extend_from_slice(&corpo);
    novo.extend_from_slice(&arquivo[fim..]);
    Some((novo, consertados))
}

/// Os quadros que o lofty lê como DATA (e recusa quando a data não é dele).
/// V15.6 — o TYER (o ano da v2.3) também: o lofty o converte em data ao ler, e
/// "1978/79" ou "c. 1978" derrubavam o arquivo inteiro (22 no acervo medido).
const QUADROS_DE_DATA: [&[u8]; 6] = [b"TDEN", b"TDOR", b"TDRC", b"TDRL", b"TDTG", b"TYER"];

/// V15.5 — declara UTF-8, não é UTF-8, e não tem NENHUM caractere UTF-8 de
/// vários bytes: é Latin-1 com o rótulo errado (medido: "Lavf54.20.4" seguido
/// de um byte solto, gravado pelo ffmpeg). Trocar só o rótulo devolve o texto
/// que o programa escreveu.
///
/// Se houver um "ç" em UTF-8 válido junto do byte estragado, o texto É UTF-8
/// com defeito, e trocar o rótulo transformaria o "ç" em lixo: não se adivinha.
fn e_latin1_rotulado_como_utf8(texto: &[u8]) -> bool {
    if std::str::from_utf8(texto).is_ok() {
        return false;
    }
    let mut i = 0;
    while i < texto.len() {
        if texto[i] >= 0x80 {
            for largura in 2..=4 {
                if let Some(pedaco) = texto.get(i..i + largura) {
                    if std::str::from_utf8(pedaco).is_ok() {
                        return false; // há UTF-8 de verdade aqui
                    }
                }
            }
        }
        i += 1;
    }
    true
}

/// O texto de um quadro, decodificado pela codificação que ele declara.
fn texto_do_quadro(dados: &[u8]) -> Option<String> {
    let (cod, bruto) = dados.split_first()?;
    let texto = match cod {
        0 => bruto.iter().map(|&b| b as char).collect(),
        3 => String::from_utf8(bruto.to_vec()).ok()?,
        1 | 2 => {
            let mut unidades: Vec<u16> = bruto
                .chunks_exact(2)
                .map(|p| if *cod == 2 { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) })
                .collect();
            if *cod == 1 {
                match unidades.first() {
                    Some(0xFEFF) => drop(unidades.remove(0)),
                    Some(0xFFFE) => {
                        unidades = unidades.iter().map(|u| u.swap_bytes()).skip(1).collect();
                    }
                    _ => return None,
                }
            }
            String::from_utf16(&unidades).ok()?
        }
        _ => return None,
    };
    Some(texto.trim_end_matches('\0').to_string())
}

/// V15.5 — a data que o lofty 0.22 recusa: a que ele não consegue ler
/// ("Tue, 01 Jan 2008", "2008/01/01" — derruba a LEITURA do arquivo inteiro) e
/// a que ele lê mas não grava (mês 13, dia 32 — derruba a GRAVAÇÃO). Medido no
/// próprio lofty, e não suposto: ver os testes.
fn data_que_o_lofty_recusa(dados: &[u8]) -> bool {
    let Some(texto) = texto_do_quadro(dados) else {
        return false; // o texto em si é o problema; não é caso de data
    };
    // V15.7 — só o texto VAZIO passa: o lofty não apara, e um ano feito só de
    // espaços ("    ", medido em dois arquivos) é recusado como os outros
    if texto.is_empty() {
        return false;
    }
    match texto.parse::<lofty::tag::items::Timestamp>() {
        Err(_) => true,
        Ok(t) => {
            let fora = |v: Option<u8>, limite: u8| v.is_some_and(|v| v > limite);
            fora(t.month, 12) || fora(t.day, 31) || fora(t.hour, 23) || fora(t.minute, 59) || fora(t.second, 59)
        }
    }
}

/// V15.7 — TDAT (DDMM) e TIME (HHMM) da v2.3, com a regra do lofty
/// (`construct_tdrc_from_v3`): exatamente 4 caracteres que viram dois números
/// são USADOS, sem conferir limite — e a data montada com mês 19 é recusada só
/// na gravação. Medido no campo: TDAT "1019", gravado como MMDD (Sound Forge).
/// Fora dessa forma o lofty mantém o quadro como está, e não há o que consertar.
fn dia_ou_hora_impossivel(id: &[u8], dados: &[u8]) -> bool {
    let Some(texto) = texto_do_quadro(dados) else {
        return false;
    };
    if texto.len() != 4 || !texto.is_ascii() {
        return false;
    }
    let (Ok(a), Ok(b)) = (texto[..2].parse::<u8>(), texto[2..].parse::<u8>()) else {
        return false;
    };
    if id == b"TDAT" {
        a > 31 || b > 12 // dia, mês
    } else {
        a > 23 || b > 59 // hora, minuto
    }
}

/// O conteúdo de um TXXX com o identificador do quadro de data como descrição,
/// na MESMA codificação do quadro original, e o texto byte a byte igual.
fn data_como_anotacao(id: &[u8], dados: &[u8]) -> Option<Vec<u8>> {
    let (cod, texto) = dados.split_first()?;
    let mut novo = vec![*cod];
    match cod {
        0 | 3 => {
            novo.extend_from_slice(id);
            novo.push(0);
        }
        1 => {
            novo.extend_from_slice(&[0xFF, 0xFE]);
            id.iter().for_each(|&b| novo.extend_from_slice(&[b, 0]));
            novo.extend_from_slice(&[0, 0]);
        }
        2 => {
            id.iter().for_each(|&b| novo.extend_from_slice(&[0, b]));
            novo.extend_from_slice(&[0, 0]);
        }
        _ => return None,
    }
    novo.extend_from_slice(texto);
    Some(novo)
}

/// V15.5 — a etiqueta JÁ LIDA tem uma data que o lofty leu mas vai recusar
/// ao gravar (mês 13, dia 32)? A leitura passa, e a falha só viria no fim da
/// gravação: é o mesmo defeito medido, por isso aciona o mesmo conserto.
pub fn tem_data_que_nao_grava(tag: &lofty::id3::v2::Id3v2Tag) -> bool {
    let fora = |v: Option<u8>, limite: u8| v.is_some_and(|v| v > limite);
    tag.into_iter().any(|quadro| match quadro {
        lofty::id3::v2::Frame::Timestamp(f) => {
            let t = &f.timestamp;
            fora(t.month, 12) || fora(t.day, 31) || fora(t.hour, 23) || fora(t.minute, 59) || fora(t.second, 59)
        }
        _ => false,
    })
}

/// O erro do lofty é de uma família que este conserto cobre? O TEXTO de um
/// quadro (V15.1) ou uma DATA que ele não aceita (V15.5).
pub fn e_erro_de_texto(e: &lofty::error::LoftyError) -> bool {
    use lofty::error::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::TextDecode(_)
            | ErrorKind::StringFromUtf8(_)
            | ErrorKind::StrFromUtf8(_)
            | ErrorKind::BadTimestamp(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quadro(id: &[u8; 4], corpo: &[u8], v4: bool) -> Vec<u8> {
        let mut q = id.to_vec();
        if v4 {
            q.extend_from_slice(&escrever_syncsafe(corpo.len()).unwrap());
        } else {
            q.extend_from_slice(&(corpo.len() as u32).to_be_bytes());
        }
        q.extend_from_slice(&[0, 0]);
        q.extend_from_slice(corpo);
        q
    }

    fn etiqueta(versao: u8, quadros: &[Vec<u8>], audio: &[u8]) -> Vec<u8> {
        let corpo: Vec<u8> = quadros.concat();
        let mut a = vec![b'I', b'D', b'3', versao, 0, 0];
        a.extend_from_slice(&escrever_syncsafe(corpo.len()).unwrap());
        a.extend(corpo);
        a.extend_from_slice(audio);
        a
    }

    #[test]
    fn etiqueta_saudavel_nao_e_tocada() {
        let a = etiqueta(3, &[quadro(b"TIT2", b"\x00Asa Branca", false)], b"\xff\xfbAUDIO");
        assert_eq!(consertar_codificacao_ausente(&a), None);
    }

    #[test]
    fn o_quadro_sem_codificacao_ganha_latin1_e_o_texto_fica_igual() {
        let audio = b"\xff\xfbAUDIO DE VERDADE";
        let a = etiqueta(
            3,
            &[quadro(b"TIT2", b"\x00Deckard's Dream", false), quadro(b"TYER", b"1982", false)],
            audio,
        );
        let (novo, ids) = consertar_codificacao_ausente(&a).unwrap();
        assert_eq!(ids, vec!["TYER"]);
        // o texto continua, byte por byte, com o byte de Latin-1 na frente
        let i = novo.windows(4).position(|j| j == b"TYER").unwrap();
        assert_eq!(&novo[i + 4..i + 8], &5u32.to_be_bytes());
        assert_eq!(&novo[i + 10..i + 15], b"\x001982");
        // o áudio é exatamente o mesmo, e só a etiqueta cresceu 1 byte
        assert!(novo.ends_with(audio));
        assert_eq!(novo.len(), a.len() + 1);
    }

    #[test]
    fn versao_4_usa_tamanho_syncsafe() {
        let texto: Vec<u8> = std::iter::repeat(b'x').take(127).collect(); // vira 128: muda de byte em syncsafe
        let a = etiqueta(4, &[quadro(b"TENC", &texto, true)], b"\xff\xfb");
        let (novo, _) = consertar_codificacao_ausente(&a).unwrap();
        assert_eq!(&novo[14..18], &escrever_syncsafe(128).unwrap());
    }

    #[test]
    fn quadro_comprimido_nao_e_adivinhado() {
        let mut q = quadro(b"TYER", b"1982", false);
        q[9] = 0x80; // v2.3: comprimido
        let a = etiqueta(3, &[q], b"\xff\xfb");
        assert_eq!(consertar_codificacao_ausente(&a), None);
    }

    // --- V15.5 — os dois casos novos do campo --------------------------------

    #[test]
    fn utf8_que_e_latin1_ganha_o_rotulo_certo_e_os_bytes_ficam() {
        // "Lavf54.20.4" + um byte solto (0xF9): declara UTF-8 e não é
        let a = etiqueta(4, &[quadro(b"TSSE", b"\x03Lavf54.20.4\xf9", true)], b"\xff\xfb");
        let (novo, ids) = consertar_codificacao_ausente(&a).unwrap();
        assert_eq!(ids, vec!["TSSE"]);
        assert!(novo.windows(13).any(|j| j == b"\x00Lavf54.20.4\xf9"), "Latin-1, bytes iguais");
        assert_eq!(novo.len(), a.len(), "só o byte do rótulo trocou");
    }

    #[test]
    fn utf8_de_verdade_com_um_byte_estragado_nao_e_adivinhado() {
        // tem "ç" em UTF-8 válido: trocar o rótulo transformaria o "ç" em lixo
        let a = etiqueta(4, &[quadro(b"TIT2", b"\x03Can\xc3\xa7\xe3o\xff", true)], b"\xff\xfb");
        assert_eq!(consertar_codificacao_ausente(&a), None);
    }

    #[test]
    fn data_fora_do_padrao_vira_anotacao_com_o_mesmo_texto() {
        let a = etiqueta(
            3,
            &[quadro(b"TIT2", b"\x00O Peregrino", false), quadro(b"TDRL", b"\x00Tue, 01 Jan 2008", false)],
            b"\xff\xfb",
        );
        let (novo, ids) = consertar_codificacao_ausente(&a).unwrap();
        assert_eq!(ids, vec!["TDRL"]);
        assert!(!novo.windows(4).any(|j| j == b"TDRL\x00\x00"), "o quadro de data saiu");
        // virou TXXX, com o nome do quadro antigo como descrição e o texto igual
        assert!(novo.windows(22).any(|j| j == b"\x00TDRL\x00Tue, 01 Jan 2008"));
    }

    #[test]
    fn data_impossivel_tambem_vira_anotacao_e_data_boa_fica() {
        let a = etiqueta(
            3,
            &[quadro(b"TDRL", b"\x002008-13-01", false), quadro(b"TDRC", b"\x002008-01-01T10:00", false)],
            b"\xff\xfb",
        );
        let (novo, ids) = consertar_codificacao_ausente(&a).unwrap();
        assert_eq!(ids, vec!["TDRL"]);
        assert!(novo.windows(4).any(|j| j == b"TDRC"), "a data boa continua no lugar");
    }

    #[test]
    fn data_em_utf16_vira_anotacao_em_utf16() {
        let texto: Vec<u8> = b"\x01\xff\xfeT\x00u\x00e\x00".to_vec(); // "Tue"
        let a = etiqueta(3, &[quadro(b"TDRL", &texto, false)], b"\xff\xfb");
        let (novo, _) = consertar_codificacao_ausente(&a).unwrap();
        // descrição "TDRL" em UTF-16 com BOM, terminador duplo, e o texto igual
        let esperado = b"\x01\xff\xfeT\x00D\x00R\x00L\x00\x00\x00\xff\xfeT\x00u\x00e\x00";
        assert!(novo.windows(esperado.len()).any(|j| j == esperado));
    }

    #[test]
    fn dia_e_mes_do_formato_antigo_so_mudam_quando_impossiveis() {
        let com = |tdat: &[u8]| {
            etiqueta(3, &[quadro(b"TYER", b"\x002016", false), quadro(b"TDAT", tdat, false)], b"\xff\xfb")
        };
        // 1019 = mês 19: vira anotação; 1910 = 19 de outubro: fica
        assert_eq!(consertar_codificacao_ausente(&com(b"\x001019\x00")).unwrap().1, vec!["TDAT"]);
        assert_eq!(consertar_codificacao_ausente(&com(b"\x001910")), None);
        // fora da forma de 4 números o lofty mantém o quadro: nada a consertar
        assert_eq!(consertar_codificacao_ausente(&com(b"\x0010/19")), None);
    }

    #[test]
    fn ano_so_de_espacos_e_ano_de_um_digito_viram_anotacao() {
        for ano in [&b"\x00    "[..], b"\x00 "] {
            let a = etiqueta(3, &[quadro(b"TYER", ano, false)], b"\xff\xfb");
            assert_eq!(consertar_codificacao_ausente(&a).unwrap().1, vec!["TYER"], "{ano:?}");
        }
        // o "Deckard's Dream": sem o byte de codificação E com ano "2"
        let a = etiqueta(3, &[quadro(b"TYER", b"2", false)], b"\xff\xfb");
        let (novo, _) = consertar_codificacao_ausente(&a).unwrap();
        assert!(novo.windows(7).any(|j| j == b"\x00TYER\x002"), "anotação com o mesmo texto");
    }

    #[test]
    fn etiqueta_dessincronizada_nao_e_adivinhada() {
        let mut a = etiqueta(3, &[quadro(b"TYER", b"1982", false)], b"\xff\xfb");
        a[5] = 0x80;
        assert_eq!(consertar_codificacao_ausente(&a), None);
    }
}
