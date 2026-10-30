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
        if de_texto && !especial && !dados.is_empty() && dados[0] > 3 {
            let novo_tam = tam + 1;
            corpo.extend_from_slice(id);
            if versao == 4 {
                corpo.extend_from_slice(&escrever_syncsafe(novo_tam)?);
            } else {
                corpo.extend_from_slice(&(u32::try_from(novo_tam).ok()?).to_be_bytes());
            }
            corpo.extend_from_slice(&flags_do_quadro);
            corpo.push(0); // Latin-1: todo byte é um caractere, nada se perde
            corpo.extend_from_slice(dados);
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

/// O erro do lofty é do TEXTO de um quadro — a família que este conserto cobre?
pub fn e_erro_de_texto(e: &lofty::error::LoftyError) -> bool {
    use lofty::error::ErrorKind;
    matches!(
        e.kind(),
        ErrorKind::TextDecode(_) | ErrorKind::StringFromUtf8(_) | ErrorKind::StrFromUtf8(_)
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

    #[test]
    fn etiqueta_dessincronizada_nao_e_adivinhada() {
        let mut a = etiqueta(3, &[quadro(b"TYER", b"1982", false)], b"\xff\xfb");
        a[5] = 0x80;
        assert_eq!(consertar_codificacao_ausente(&a), None);
    }
}
