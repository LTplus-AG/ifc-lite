// SPDX-License-Identifier: MPL-2.0
//! Reading a STEP record's top-level argument list out of its text, for a
//! caller that then reads or writes one slot BY INDEX.
//!
//! The failure this module exists to prevent is silent. A scanner that loses
//! track of quote state or paren depth still produces parts; they are just not
//! the record's arguments any more, because the commas it swallowed took every
//! following slot with them. A write by index then lands on whatever the
//! mis-scan accumulated and the caller reports a success that did not happen
//! (LTplus-AG/ifc-lite#2470, #4125). So the split returns `None` rather than
//! parts it does not believe in, and both call sites in
//! [`crate::step_text`] treat `None` as "this edit cannot be made".
//!
//! This module deliberately grows no permissive variant. Both its callers
//! ([`crate::step_text::apply_attr_mutations_counted`] and
//! [`crate::step_text::attribute_of`]) index into the parts, and text that
//! reaches them comes from the user's file, so a permissive sibling here would
//! be a footgun with no consumer.
//!
//! The crate still HAS one, though, and this module does not replace it:
//! `schema_convert.rs`'s `split_top_level` (`schema_convert.rs:203`) is the same
//! quote/depth/comma state machine in its older `bytes[i] as char` form, and its
//! callers `trim_attributes` and `remap_attrs_by_name` both rewrite records by
//! pairing values with slots by POSITION — the failure above, in another file.
//! Out of scope for #4125, which is the three by-index writers; tracked in
//! LTplus-AG/ifc-lite#4200.
//!
//! The TypeScript twin is `packages/export/src/step-argument-parser.ts`'s
//! `splitTopLevelStepArguments`. The two cannot share code, so the inputs both
//! must refuse are pinned to one shared fixture,
//! `tests/fixtures/step_refuse_vectors.json` (see `step_slot_tests.rs`'s
//! `refuses_every_shared_cross_language_vector`
//! and `packages/export/src/step-refuse.parity.test.ts`) — the same arrangement
//! `step_escape_vectors.json` gives the two escapers (#3300). Only the REFUSE
//! side is shared, because the splitters in this repo diverge on what they
//! ACCEPT: this module and the export twin both keep a `/* ... */` comment's
//! bytes inside the slot that carries them, while the CLI's
//! `splitTopLevelStepArgs` refuses any slot carrying one — each contract is its
//! own caller's choice, and pinning an accept would freeze a divergence as if it
//! were agreement.
//!
//! One accept-side divergence from the export twin is NOT a chosen contract, and
//! is recorded here so the next reader does not have to measure it again: an
//! empty element INSIDE a nested list. `'g',(1,,2),'b'` is accepted by this
//! module as three slots and refused (`null`) by `splitTopLevelStepArguments`,
//! because this module extends the empty-slot rule below into nested lists and
//! the twin does not. Both measured directly, 2026-09-09. Changing either moves
//! one language's grammar with nothing pinning the other, so it is out of scope
//! for #4125 and tracked in LTplus-AG/ifc-lite#4200 with the rest of the
//! splitter unification.

/// Split a STEP attribute list into its top-level arguments, or `None` when
/// the text is not an argument list this can scan.
///
/// `attrs` is the text BETWEEN a record's outermost parentheses. Nothing is
/// trimmed, so for accepted input `parts.join(",")` reproduces `attrs` byte for
/// byte and a caller that replaces one part leaves every other byte alone —
/// with ONE exception, the whitespace-only early return below. `"   "` splits to
/// `[]`, so `join(",")` is `""` and
/// [`crate::step_text::apply_attr_mutations_counted`] rewrites `#1=IFCFOO(   );`
/// to `#1=IFCFOO();`. That is deliberate: the TypeScript twin returns `[]` for
/// any input whose `trim()` is empty (measured directly, 2026-09-09), and a
/// record with no arguments has no slot for a by-index caller to write, so the
/// only bytes the exception can drop are padding that carries no value. Every
/// OTHER accepted input rejoins byte for byte, which
/// `accepted_parts_rejoin_to_the_input` pins.
///
/// Rejected:
///   - a quote still open at the end (unterminated string);
///   - a paren depth that does not return to zero, or that ever goes below it
///     (both ends matter: a depth that dips negative and climbs back looks
///     balanced at the end while every comma in between was read as nested);
///   - a part that is not one well-formed STEP value (see
///     [`is_well_formed_step_slot`]), which is what catches the mis-scans the
///     three checks above cannot see.
///
/// An EMPTY top-level slot (`a,,b`, or a trailing comma) is NOT rejected. It is
/// invalid STEP that costs no alignment: an empty argument is ONE part, exactly
/// as the entity parser counts it, so every index still names the attribute it
/// is meant to. An empty INPUT is not an empty slot: `#1=IFCFOO();` is a record
/// with no arguments, so it splits to `[]` and any slot request then fails the
/// caller's own bounds check.
///
/// A `/* ... */` COMMENT is KEPT, not refused: its bytes stay inside whichever
/// slot they sit in, and the scan steps over the whole region as one unit so a
/// comma, paren or apostrophe inside it cannot be read as structure. Comments
/// are valid ISO 10303-21 and this repo has met them in real files (#3789,
/// #4162); refusing a slot that carries one made every by-index write on such a
/// record drop, and made [`crate::step_text::attribute_of`] return `None` so
/// `step_cow`'s copy-on-write refused the whole copy when the REFERRER line
/// carried a comment. The export twin does the same thing with the same bytes.
/// A slot that is ONLY a comment is still refused — a comment is not a value, so
/// counting it as one more empty slot shifts every index after it, which is what
/// the third and fourth shared refuse vectors pin.
pub(crate) fn split_top_level_args(attrs: &str) -> Option<Vec<String>> {
    if attrs.trim().is_empty() {
        return Some(Vec::new());
    }

    // Over chars, not bytes. `bytes[i] as char` reads a UTF-8 continuation byte
    // as a Latin-1 character and re-encodes it, so a property name like
    // `Größe` came back as `GrÃ¶ÃŸe` in any record this rewrote. Every
    // delimiter STEP cares about is ASCII, so indexing chars costs nothing and
    // leaves the rest of the text alone.
    let text: Vec<char> = attrs.chars().collect();
    let n = text.len();
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut current = String::new();
    let mut i = 0usize;
    while i < n {
        let ch = text[i];

        // A comment's content is unrestricted ISO 10303-21 text — a comma, an
        // unbalanced paren, or an odd number of `'` inside one would otherwise
        // corrupt this scan's comma/paren/quote state even though the comment is
        // not an argument boundary. Copy the whole region (open marker through
        // the matching `*/`, or to the end when unterminated) into the current
        // slot as one atomic unit; the per-slot grammar check below still gets
        // the last word on whether that slot is a value.
        if !in_string && ch == '/' && i + 1 < n && text[i + 1] == '*' {
            let stop = comment_end(&text, i).unwrap_or(n);
            current.extend(text[i..stop].iter());
            i = stop;
            continue;
        }

        if ch == '\'' {
            current.push(ch);
            if in_string && i + 1 < n && text[i + 1] == '\'' {
                current.push('\'');
                i += 2;
                continue;
            }
            in_string = !in_string;
            i += 1;
            continue;
        }

        if !in_string {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth < 0 {
                    // Already past the record's own closing paren: every comma
                    // from here would be read as nested and the split is
                    // meaningless.
                    return None;
                }
            } else if ch == ',' && depth == 0 {
                out.push(std::mem::take(&mut current));
                i += 1;
                continue;
            }
        }
        current.push(ch);
        i += 1;
    }
    if in_string || depth != 0 {
        return None;
    }
    out.push(current);

    // The three checks above track SCAN state, not slot CONTENT. A phantom
    // string can swallow a real boundary — an undoubled `'` inside two
    // different string-typed arguments reads as one string spanning both, so
    // the text between them gets folded into a single part while quote parity
    // and paren depth both stay clean. Every check above is satisfied on a slot
    // list that is not the record's arguments.
    if out.iter().any(|part| !is_well_formed_step_slot(part)) {
        return None;
    }
    Some(out)
}

/// Whether `part` — one slot [`split_top_level_args`] already separated on a
/// top-level comma, raw text including any surrounding whitespace or comments —
/// is a single well-formed STEP value, or is empty.
///
/// The forms, per ISO 10303-21: a string literal (`'...'`, `''` escaping an
/// apostrophe), a binary literal (`"..."`, which has no doubled-quote escape),
/// `$`, `*`, a bare token (keyword, enumeration, number, `#`-reference), or a
/// typed value / list (`NAME(...)` or `(...)`). Empty is accepted, matching the
/// empty-slot rule above.
///
/// A `/* ... */` comment is TRIVIA here, skipped wherever whitespace is skipped,
/// so a slot that carries one around its value is accepted with the comment's
/// bytes still in it. A slot that is ONLY a comment is not: `skip_trivia` runs
/// it out and the value the scan then expects is missing, so the part fails —
/// which is the point, since a comment is not a value and counting it as one
/// more empty slot would shift every index after it.
///
/// A `/` that is NOT opening a comment cannot be swallowed into a bare token: it
/// is outside [`is_bare_token_char`]'s set, so the run stops there and the
/// "consumed to the end" check at the bottom fails the part.
fn is_well_formed_step_slot(part: &str) -> bool {
    let text: Vec<char> = part.chars().collect();
    let n = text.len();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut expect_value = true;

    // Whitespace AND comments, so `IFCLABEL /* c */ ('x')` reads as one typed
    // value. An UNTERMINATED comment runs to the end rather than failing here:
    // in a value position that leaves nothing to read and the part is refused a
    // line later, and in a trailing position the twin accepts it too (measured,
    // 2026-09-09) — matching it is what keeps the two grammars comparable.
    let skip_trivia = |i: &mut usize| loop {
        while *i < n && text[*i].is_whitespace() {
            *i += 1;
        }
        if *i + 1 < n && text[*i] == '/' && text[*i + 1] == '*' {
            match comment_end(&text, *i) {
                Some(end) => *i = end,
                None => {
                    *i = n;
                    return;
                }
            }
            continue;
        }
        return;
    };

    // Whitespace only, deliberately NOT trivia: an all-comment part must not
    // take this early accept, or a comment-only slot becomes an empty slot and
    // every index after it shifts.
    if text.iter().all(|c| c.is_whitespace()) {
        return true; // empty (or whitespace-only) slot
    }

    loop {
        skip_trivia(&mut i);
        if expect_value {
            // A list element may be empty (`(1,,2)`), as a top-level slot may be.
            if depth > 0 && i < n && (text[i] == ',' || text[i] == ')') {
                expect_value = false;
                continue;
            }
            if i >= n {
                return false;
            }
            match text[i] {
                '\'' => {
                    i += 1;
                    loop {
                        if i >= n {
                            return false; // unterminated string
                        }
                        if text[i] == '\'' {
                            if i + 1 < n && text[i + 1] == '\'' {
                                i += 2;
                                continue;
                            }
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                }
                '"' => {
                    // No doubled-quote escape inside a binary literal: the first
                    // following `"` ends it, matching ifcopenshell's tokenizer.
                    i += 1;
                    while i < n && text[i] != '"' {
                        i += 1;
                    }
                    if i >= n {
                        return false; // unterminated binary literal
                    }
                    i += 1;
                }
                '(' => {
                    depth += 1;
                    i += 1;
                    continue; // the list's first element is still a value to read
                }
                '$' | '*' => i += 1,
                _ => {
                    let start = i;
                    while i < n && is_bare_token_char(text[i]) {
                        i += 1;
                    }
                    if i == start {
                        return false;
                    }
                    // A typed value: `NAME(...)`, trivia tolerated before the `(`.
                    let mut after = i;
                    skip_trivia(&mut after);
                    if after < n && text[after] == '(' {
                        depth += 1;
                        i = after + 1;
                        continue;
                    }
                }
            }
            expect_value = false;
            continue;
        }

        // A value just closed, so only `,` or `)` may follow. At depth zero the
        // value was the whole slot, and nothing but whitespace may remain.
        if depth == 0 {
            return i == n;
        }
        if i >= n {
            return false;
        }
        if text[i] == ')' {
            depth -= 1;
            i += 1;
            continue;
        }
        if text[i] != ',' {
            return false;
        }
        i += 1;
        expect_value = true;
    }
}

/// Characters a bare STEP token (keyword, enumeration, number, `#`-reference)
/// is made of — the same set as the export twin's `/[A-Za-z0-9_.+\-#]/`. `/` is
/// absent, so a `/` the trivia skipper did not consume (one not opening a
/// comment) breaks the run short of the slot's end and the slot is refused.
fn is_bare_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-' | '#')
}

/// Index just past the `*/` closing the comment that opens at `open` (which
/// points at its `/`), or `None` when the comment is never closed.
fn comment_end(text: &[char], open: usize) -> Option<usize> {
    let mut i = open + 2;
    while i + 1 < text.len() {
        if text[i] == '*' && text[i + 1] == '/' {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
#[path = "step_slot_tests.rs"]
mod tests;
