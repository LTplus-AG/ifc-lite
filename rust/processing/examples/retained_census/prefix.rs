// SPDX-License-Identifier: MPL-2.0
//! Authenticate the bounded prefix that the recovery scanner skips.

use ifc_lite_core::parser::{header, skip_step_trivia};
use ifc_lite_core::step_encoding::step_string_literal_end;

pub(super) fn data_start(content: &[u8]) -> Option<usize> {
    let window = &content[..content.len().min(header::MAX_HEADER_BYTES)];
    let start = if window.starts_with(b"\xef\xbb\xbf") {
        3
    } else {
        0
    };
    let mut at = keyword(window, start, b"ISO-10303-21", header::Then::Semicolon)? + 1;
    at = keyword(window, at, b"HEADER", header::Then::Semicolon)? + 1;
    // These three records form the supported header. Extra header extensions
    // conservatively refuse completeness; this is not an EXPRESS validator.
    for name in [b"FILE_DESCRIPTION".as_slice(), b"FILE_NAME", b"FILE_SCHEMA"] {
        let open = keyword(window, at, name, header::Then::Paren)?;
        at = record_end(window, open)?;
    }
    at = keyword(window, at, b"ENDSEC", header::Then::Semicolon)? + 1;
    let delimiter = keyword(window, at, b"DATA", header::Then::ParenOrSemicolon)?;
    if window[delimiter] == b';' {
        Some(delimiter + 1)
    } else {
        // Preserve the scanner's ed.3 DATA('name',('schema', ...)); framing.
        record_end(window, delimiter)
    }
}

// The shared finder is recovery-capable: an exact start match is essential.
// Every search stays inside the shared bounded header window.
fn keyword(bytes: &[u8], at: usize, name: &[u8], then: header::Then) -> Option<usize> {
    let start = skip_step_trivia(bytes, at)?;
    let hit = header::find_keyword_then(bytes.get(start..)?, name, then)?;
    (hit.start == 0).then_some(start + hit.then)
}

fn record_end(bytes: &[u8], open: usize) -> Option<usize> {
    let close = header::close_paren(bytes, open)?;
    // A balanced list alone could swallow a misplaced declaration or marker.
    // Reject structural separators inside it, but never their quoted/commented
    // spellings. Use exactly the header reader's literal and trivia rules.
    let mut at = open + 1;
    while at < close {
        at = skip_step_trivia(bytes, at)?;
        match bytes.get(at)? {
            b'\'' => at = step_string_literal_end(bytes, at)?,
            b'#' | b'=' | b';' => return None,
            _ => at += 1,
        }
    }
    let semicolon = skip_step_trivia(bytes, close + 1)?;
    (bytes.get(semicolon) == Some(&b';')).then_some(semicolon + 1)
}
