// SPDX-License-Identifier: MPL-2.0
//! THE CSV cell escaper for this repository's Rust.
//!
//! Every Rust producer of CSV calls [`escape_csv_cell`] and nothing else. The
//! TypeScript half lives in `packages/export/src/csv-cell.ts`; both are pinned
//! to the shared vectors in `tests/fixtures/csv_cell_vectors.json` by
//! `tests/csv_cell_parity.rs` and `csv-cell.parity.test.ts`, so the two
//! languages cannot drift apart silently.
//!
//! Two things it does that the previous hand-rolled copies did not:
//!
//! * The formula-injection guard (CWE-1236) looks *past* leading invisibles.
//!   Testing the trigger anchored at offset 0 — as this crate did — means a
//!   BOM, ZWSP, LRM, NBSP or U+2028 in front of `=` walks straight through,
//!   because none of those stops a spreadsheet evaluating the cell.
//! * It looks past them without DELETING them, so a benign `"   Wall A"` keeps
//!   its spaces (RFC 4180 §2.4: "Spaces are considered part of a field and
//!   should not be ignored").

/// Code points a spreadsheet importer swallows, or renders as pure spacing, yet
/// which do NOT stop a following `=`/`+`/`-`/`@` being evaluated as a formula.
///
/// Exactly Unicode general categories `Cf` (format) + `Z` (separator: `Zs`,
/// `Zl`, `Zp`). Spelled as a const table because this crate compiles to wasm
/// and deliberately carries no Unicode-property dependency; the parity sweep in
/// `tests/csv_cell_parity.rs` walks all 0x110000 code points against the same
/// table the TypeScript side is checked against, so the hand-maintained form
/// cannot quietly fall behind.
///
/// Regenerate with `node scripts/gen-csv-cell-vectors.mjs` (which rewrites the
/// shared fixture) and mirror the result here.
const INVISIBLE_PREFIX_RANGES: &[(u32, u32)] = &[
    (0x0020, 0x0020),   // SPACE
    (0x00A0, 0x00A0),   // NO-BREAK SPACE
    (0x00AD, 0x00AD),   // SOFT HYPHEN
    (0x0600, 0x0605),   // Arabic number signs
    (0x061C, 0x061C),   // ARABIC LETTER MARK
    (0x06DD, 0x06DD),   // ARABIC END OF AYAH
    (0x070F, 0x070F),   // SYRIAC ABBREVIATION MARK
    (0x0890, 0x0891),   // Arabic pound/piastre marks
    (0x08E2, 0x08E2),   // ARABIC DISPUTED END OF AYAH
    (0x1680, 0x1680),   // OGHAM SPACE MARK
    (0x180E, 0x180E),   // MONGOLIAN VOWEL SEPARATOR
    (0x2000, 0x200F),   // EN QUAD .. RIGHT-TO-LEFT MARK (incl. ZWSP/ZWNJ/ZWJ)
    (0x2028, 0x202F),   // LINE/PARAGRAPH SEPARATOR, bidi embedding, NNBSP
    (0x205F, 0x2064),   // MEDIUM MATHEMATICAL SPACE .. INVISIBLE PLUS
    (0x2066, 0x206F),   // bidi isolates and deprecated format controls
    (0x3000, 0x3000),   // IDEOGRAPHIC SPACE
    (0xFEFF, 0xFEFF),   // ZERO WIDTH NO-BREAK SPACE (the BOM)
    (0xFFF9, 0xFFFB),   // interlinear annotation controls
    (0x110BD, 0x110BD), // KAITHI NUMBER SIGN
    (0x110CD, 0x110CD), // KAITHI NUMBER SIGN ABOVE
    (0x13430, 0x1343F), // Egyptian hieroglyph format controls
    (0x1BCA0, 0x1BCA3), // shorthand format controls
    (0x1D173, 0x1D17A), // musical symbol beam/phrase/tie controls
    (0xE0001, 0xE0001), // LANGUAGE TAG
    (0xE0020, 0xE007F), // tag characters
];

/// Characters a spreadsheet reads as the start of a formula. `\t` and `\r` are
/// in the set because Excel/Sheets strip them and evaluate what follows.
const TRIGGERS: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

/// Whitespace for the opt-in [`CsvCellOptions::quote_whitespace_padded`] rule.
///
/// Deliberately NOT `char::is_whitespace`: that is Unicode `White_Space`, which
/// includes U+0085 NEL and excludes U+FEFF, while JavaScript's `\s` — which the
/// TypeScript half uses — is the exact reverse. Left implicit, that asymmetry
/// would be a silent cross-language behaviour split on two code points; spelled
/// out here, `tests/csv_cell_parity.rs` sweeps it against the shared table.
#[must_use]
pub fn is_padding(c: char) -> bool {
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{FEFF}'
}

/// Is `c` an invisible that can hide a formula trigger behind it?
///
/// Public for the parity sweep, which is the only thing that keeps the table
/// above honest.
#[must_use]
pub fn is_invisible_prefix(c: char) -> bool {
    let cp = c as u32;
    INVISIBLE_PREFIX_RANGES
        .binary_search_by(|&(lo, hi)| {
            if cp < lo {
                std::cmp::Ordering::Greater
            } else if cp > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Options for [`escape_csv_cell`].
pub struct CsvCellOptions<'a> {
    /// Column delimiter the cell will be joined with.
    pub delimiter: &'a str,
    /// Exempt a cell that is wholly a signed number (`-0.35`, `+1`, `-1.5e-3`)
    /// from the `+`/`-` trigger, so spreadsheet `SUM()` still works on exported
    /// measures (#1772).
    ///
    /// A PRODUCT policy, not a security one. The exemption cannot weaken the
    /// guard: the accepted language is built from `+ - . e E 0-9` and nothing
    /// else, which cannot spell a function name, a cell reference or a `(`, so
    /// every string it exempts is inert in a spreadsheet. `=`, `@`, TAB and CR
    /// are never exempted.
    ///
    /// **Defaults to `true`**, in lockstep with the TypeScript half. The two
    /// defaults are pinned together by a shared vector that passes NO options
    /// (see `csv_cell_parity.rs`), because a harness that always sets every
    /// field explicitly cannot see the defaults drift apart.
    pub exempt_numbers: bool,
    /// Also quote a cell whose first or last character is whitespace, so an
    /// importer that would otherwise trim the padding cannot (RFC 4180 §2.4
    /// from the other side). See [`is_padding`] for the exact class.
    ///
    /// No Rust caller sets this today; it exists so the TypeScript half's
    /// zones-table rule is expressible in the SAME escaper rather than being a
    /// reason to hand-roll one. Defaults to `false`.
    pub quote_whitespace_padded: bool,
}

impl Default for CsvCellOptions<'_> {
    fn default() -> Self {
        Self { delimiter: ",", exempt_numbers: true, quote_whitespace_padded: false }
    }
}

/// Does the cell begin — past any run of invisibles — with a formula trigger?
fn starts_with_trigger(s: &str) -> bool {
    s.chars()
        .find(|&c| !is_invisible_prefix(c))
        .is_some_and(|c| TRIGGERS.contains(&c))
}

/// Is the cell WHOLLY a signed decimal number, optionally in exponent form?
///
/// Mirrors the TypeScript `^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`, ASCII
/// digits only. Anchored at both ends on purpose: `-0.35=cmd` is not a number
/// and must stay guarded.
fn is_wholly_numeric(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }

    // Mantissa: `\d+\.?\d*` or `\.\d+`.
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    if int_digits > 0 {
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
    } else {
        // No integer part: require `.` followed by at least one digit.
        if i >= bytes.len() || bytes[i] != b'.' {
            return false;
        }
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac_start {
            return false;
        }
    }

    // Optional exponent: `[eE][+-]?\d+`.
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }

    i == bytes.len()
}

/// Escape one CSV cell: neutralise spreadsheet formula injection (CWE-1236),
/// then apply RFC 4180 quoting.
///
/// The guard is non-destructive — it looks past leading invisibles rather than
/// stripping them — and runs BEFORE quoting, so a value that both starts with a
/// trigger and contains the delimiter still gets wrapped.
#[must_use]
pub fn escape_csv_cell(value: &str, opts: &CsvCellOptions) -> String {
    let guarded = starts_with_trigger(value) && !(opts.exempt_numbers && is_wholly_numeric(value));

    let mut s = if guarded {
        let mut out = String::with_capacity(value.len() + 1);
        out.push('\'');
        out.push_str(value);
        out
    } else {
        value.to_string()
    };

    let padded = opts.quote_whitespace_padded
        && (s.chars().next().is_some_and(is_padding) || s.chars().next_back().is_some_and(is_padding));

    if padded || s.contains(opts.delimiter) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        s = format!("\"{}\"", s.replace('"', "\"\""));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_table_is_sorted_and_disjoint() {
        // `is_invisible_prefix` binary-searches the table, so an unsorted or
        // overlapping entry would silently return the wrong answer for some
        // code points rather than failing outright.
        for w in INVISIBLE_PREFIX_RANGES.windows(2) {
            assert!(w[0].0 <= w[0].1, "range {:?} is inverted", w[0]);
            assert!(w[1].0 > w[0].1, "ranges {:?} and {:?} overlap or abut", w[0], w[1]);
        }
    }

    #[test]
    fn wholly_numeric_rejects_payloads_glued_to_a_number() {
        assert!(is_wholly_numeric("-0.35"));
        assert!(is_wholly_numeric("+1"));
        assert!(is_wholly_numeric(".5"));
        assert!(is_wholly_numeric("1."));
        assert!(is_wholly_numeric("-1.5e-3"));
        assert!(!is_wholly_numeric("-0.35=cmd"));
        assert!(!is_wholly_numeric("-"));
        assert!(!is_wholly_numeric(""));
        assert!(!is_wholly_numeric("1e"));
        assert!(!is_wholly_numeric("."));
        assert!(!is_wholly_numeric("1 "));
    }
}
