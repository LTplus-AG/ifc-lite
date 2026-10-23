// SPDX-License-Identifier: MPL-2.0
//! Text and attribute escaping shared by the XML writers (KML, LandXML).

/// Escape `s` for an XML 1.0 attribute value or text node.
///
/// IFC strings are file-controlled, and a STEP `\X2\` escape can decode to a
/// C0 control character that XML 1.0 forbids even as a character reference
/// (§2.2 `Char`). Such a character becomes U+FFFD rather than an unparseable
/// document; tab, line feed and carriage return are legal and kept.
pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => out.push('\u{FFFD}'),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape;

    #[test]
    fn escapes_markup_and_replaces_characters_xml_forbids() {
        assert_eq!(escape(r#"a&b<c>"d'"#), "a&amp;b&lt;c&gt;&quot;d&apos;");
        assert_eq!(escape("x\u{1}y\u{FFFF}"), "x\u{FFFD}y\u{FFFD}");
        assert_eq!(escape("tab\tline\nret\r"), "tab\tline\nret\r");
        assert_eq!(escape("Höhe \u{1F600}"), "Höhe \u{1F600}");
    }
}
