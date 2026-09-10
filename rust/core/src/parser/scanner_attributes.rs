// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `EntityScanner::has_non_null_attribute`, the scanner's one per-ATTRIBUTE
//! read.
//!
//! A sibling file for the same reason `scanner_header.rs` and
//! `scanner_tests.rs` are: `scanner.rs` is at its `module_size_ratchet`
//! budget, and this method shares no state or control flow with the record
//! scan it sat next to — it walks one already-located span, comma by comma,
//! rather than hunting the next record. Splitting it is what bought
//! `find_entity_end` room to document the #4179 record-boundary rules.

impl<'a> super::EntityScanner<'a> {
    /// Fast check if attribute at given index is non-null (not '$')
    /// This is used to filter building elements that don't have representation
    /// without full entity decode. Index 0 is first attribute after '('.
    ///
    /// Returns true if attribute exists and is not '$', false otherwise.
    #[inline]
    pub fn has_non_null_attribute(&self, start: usize, end: usize, attr_index: usize) -> bool {
        let content = &self.bytes[start..end];

        // Find the opening parenthesis
        let paren_pos = match memchr::memchr(b'(', content) {
            Some(p) => p + 1,
            None => return false,
        };

        let mut pos = paren_pos;
        let mut current_attr = 0;
        let mut depth = 0; // Track nested parentheses
        let mut in_string = false;

        // Helper to check if we're at target attribute and return result
        let check_target = |pos: usize, current_attr: usize, depth: usize| -> Option<bool> {
            if current_attr == attr_index && depth == 0 {
                // Skip whitespace AND comments (`skip_step_trivia`, shared with
                // the scanner's other trivia points): `/* c1 */ $` is still the
                // null slot, not a non-null value starting with '/'. An
                // unterminated comment leaves nothing certain after it, so
                // treat the slot as absent rather than reading into the void.
                return Some(match crate::parser::lexical::skip_step_trivia(content, pos) {
                    Some(p) if p < content.len() => content[p] != b'$',
                    _ => false,
                });
            }
            None
        };

        // Check if target is first attribute (index 0)
        if let Some(result) = check_target(pos, current_attr, depth) {
            return result;
        }

        while pos < content.len() {
            let b = content[pos];

            if in_string {
                if b == b'\'' {
                    // Check for escaped quote ('')
                    if pos + 1 < content.len() && content[pos + 1] == b'\'' {
                        pos += 2;
                        continue;
                    }
                    in_string = false;
                }
                pos += 1;
                continue;
            }

            match b {
                b'\'' => {
                    in_string = true;
                    pos += 1;
                }
                b'/' if content.get(pos + 1) == Some(&b'*') => {
                    // A comment is consumed as a region -- the other half of
                    // the rule the quote branch above gives in the opposite
                    // direction. A ',', '(' or ')' inside it must not move
                    // current_attr or depth, or `#1=IFCWALL($, /* a, b */ 'x');`
                    // would count the comment's comma as an attribute
                    // separator. Unterminated: nothing after it is certain, so
                    // give up rather than guess.
                    match crate::parser::lexical::skip_step_comment(content, pos) {
                        Some(next) => pos = next,
                        None => return false,
                    }
                }
                b'(' => {
                    depth += 1;
                    pos += 1;
                }
                b')' => {
                    if depth == 0 {
                        // End of entity - attribute not found
                        return false;
                    }
                    depth -= 1;
                    pos += 1;
                }
                b',' if depth == 0 => {
                    current_attr += 1;
                    pos += 1;
                    // Skip whitespace and comments after the comma (same rule
                    // as check_target's leading skip).
                    match crate::parser::lexical::skip_step_trivia(content, pos) {
                        Some(p) => pos = p,
                        None => return false,
                    }
                    // Check if we're now at target attribute
                    if let Some(result) = check_target(pos, current_attr, depth) {
                        return result;
                    }
                }
                _ => {
                    pos += 1;
                }
            }
        }

        false
    }
}
