// SPDX-License-Identifier: MPL-2.0
//! Record-level text operations shared by the phases: reading a record's
//! slots (`readStepSlots`) and replacing one (`replaceStepArgument`), under the
//! TypeScript slot grammar.

use crate::step_record_frame::record_frame;

/// `replaceStepArgument`: slot `index` of the record replaced, or `None` when
/// the record does not read as `#id=TYPE(args);` with that slot.
pub(crate) fn replace_argument(text: &str, index: usize, replacement: &str) -> Option<String> {
    let frame = record_frame(text)?;
    let mut args = split_args(frame.args(text))?;
    if index >= args.len() {
        return None;
    }
    args[index] = replacement.to_string();
    Some(frame.with_args(text, &args.join(",")))
}

/// `readStepSlots`: the record's UPPERCASE type and argument slots, or `None`
/// when it does not read as `#id=TYPE(args);` with a splittable list.
pub(crate) fn read_slots(text: &str) -> Option<(String, Vec<String>)> {
    let frame = record_frame(text)?;
    let slots = split_args(frame.args(text))?;
    Some((frame.head.type_name(text).to_ascii_uppercase(), slots))
}

/// `splitTopLevelStepArguments`: the shared splitter, then every part held to
/// the TypeScript slot grammar (`isWellFormedStepSlot`). The Rust splitter
/// accepts two shapes that grammar refuses (an empty element inside a nested
/// list, nesting past 64 — see `crate::step_slot`'s module doc), and which
/// records this writer withholds or edits must be the ones the TypeScript
/// exporter does.
pub(crate) fn split_args(attrs: &str) -> Option<Vec<String>> {
    let parts = crate::step_slot::split_top_level_args(attrs)?;
    parts.iter().all(|p| well_formed_slot(p)).then_some(parts)
}

const MAX_SLOT_NESTING_DEPTH: usize = 64;

/// `isWellFormedStepSlot`.
fn well_formed_slot(part: &str) -> bool {
    if part.trim().is_empty() {
        return true;
    }
    let chars: Vec<char> = part.chars().collect();
    let ascii = crate::step_slot::ascii_projection(&chars);
    let mut g = Grammar { c: &chars, a: &ascii, i: 0 };
    if !g.value(0) {
        return false;
    }
    g.trivia();
    g.i == chars.len()
}

struct Grammar<'c> {
    c: &'c [char],
    /// `c` projected to one byte per char, for the shared literal-end rule.
    a: &'c [u8],
    i: usize,
}

impl Grammar<'_> {
    fn at(&self, k: usize) -> Option<char> {
        self.c.get(k).copied()
    }

    fn trivia(&mut self) {
        loop {
            while self.at(self.i).is_some_and(char::is_whitespace) {
                self.i += 1;
            }
            if self.at(self.i) == Some('/') && self.at(self.i + 1) == Some('*') {
                match (self.i + 2..self.c.len().saturating_sub(1)).find(|&k| self.c[k] == '*' && self.c[k + 1] == '/') {
                    Some(end) => self.i = end + 2,
                    None => {
                        self.i = self.c.len();
                        return;
                    }
                }
                continue;
            }
            break;
        }
    }

    fn list(&mut self, depth: usize) -> bool {
        if depth > MAX_SLOT_NESTING_DEPTH {
            return false;
        }
        self.trivia();
        if self.at(self.i) == Some(')') {
            self.i += 1;
            return true;
        }
        loop {
            if !self.value(depth) {
                return false;
            }
            self.trivia();
            match self.at(self.i) {
                Some(',') => {
                    self.i += 1;
                    self.trivia();
                }
                Some(')') => {
                    self.i += 1;
                    return true;
                }
                _ => return false,
            }
        }
    }

    fn value(&mut self, depth: usize) -> bool {
        self.trivia();
        let Some(c) = self.at(self.i) else { return false };
        match c {
            // The shared rule for where a literal ends: a `\S\'` operand is
            // text, not the closing quote (#7589).
            '\'' => match ifc_lite_core::step_encoding::step_string_literal_end(self.a, self.i) {
                Some(end) => {
                    self.i = end;
                    true
                }
                None => false,
            },
            '(' => {
                self.i += 1;
                self.list(depth + 1)
            }
            '"' => {
                self.i += 1;
                while self.at(self.i).is_some_and(|ch| ch != '"') {
                    self.i += 1;
                }
                if self.i >= self.c.len() {
                    return false;
                }
                self.i += 1;
                true
            }
            '$' | '*' => {
                self.i += 1;
                true
            }
            _ => {
                let start = self.i;
                while self.at(self.i).is_some_and(|ch| ch.is_ascii_alphanumeric() || "_.+-#".contains(ch)) {
                    self.i += 1;
                }
                if self.i == start {
                    return false;
                }
                self.trivia();
                if self.at(self.i) == Some('(') {
                    self.i += 1;
                    return self.list(depth + 1);
                }
                true
            }
        }
    }
}

#[cfg(test)]
#[path = "lines_tests.rs"]
mod tests;
