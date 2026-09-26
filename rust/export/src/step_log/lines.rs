// SPDX-License-Identifier: MPL-2.0
//! Record-level text operations shared by the phases: reading a record's
//! slots (`readStepSlots`), replacing one (`replaceStepArgument`), and the
//! relationship-line filter the source pass applies whenever a session is
//! active (`filterHiddenRefsFromRelationshipLine`).

/// `replaceStepArgument`: slot `index` of the record replaced, or `None` when
/// the record does not read as `#id=TYPE(args);` with that slot.
pub(crate) fn replace_argument(text: &str, index: usize, replacement: &str) -> Option<String> {
    let (prefix_end, attrs, suffix) = record_parts(text)?;
    let mut args = split_args(attrs)?;
    if index >= args.len() {
        return None;
    }
    args[index] = replacement.to_string();
    Some(format!("{}{}{}", &text[..prefix_end], args.join(","), suffix))
}

/// `RECORD_PREFIX_RE`: `(end of "#id=TYPE(", argument text, ")<ws>;")`.
fn record_parts(text: &str) -> Option<(usize, &str, &str)> {
    let t = text.trim_end();
    let b = t.as_bytes();
    if !t.starts_with('#') || !t.ends_with(';') {
        return None;
    }
    let digits = 1 + t[1..].find(|c: char| !c.is_ascii_digit())?;
    if digits == 1 {
        return None;
    }
    let after_eq = t[digits..].trim_start().strip_prefix('=')?.trim_start();
    let type_start = t.len() - after_eq.len();
    let type_len = after_eq.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?;
    if type_len == 0 {
        return None;
    }
    let mut i = type_start + type_len;
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if b.get(i) != Some(&b'(') {
        return None;
    }
    let prefix_end = i + 1;
    let mut k = t.len() - 1;
    while k > 0 && b[k - 1].is_ascii_whitespace() {
        k -= 1;
    }
    if k == 0 || b[k - 1] != b')' || k - 1 < prefix_end {
        return None;
    }
    Some((prefix_end, &t[prefix_end..k - 1], &t[k - 1..]))
}

/// `readStepSlots`: the record's argument slots, or `None` when it does not
/// read as `#id=TYPE(args);` with a splittable list.
pub(crate) fn read_slots(text: &str) -> Option<Vec<String>> {
    let (_, attrs, _) = record_parts(text)?;
    split_args(attrs)
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
    let mut g = Grammar { c: &chars, i: 0 };
    if !g.value(0) {
        return false;
    }
    g.trivia();
    g.i == chars.len()
}

struct Grammar<'c> {
    c: &'c [char],
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
            '\'' => {
                self.i += 1;
                while let Some(ch) = self.at(self.i) {
                    if ch == '\'' {
                        if self.at(self.i + 1) == Some('\'') {
                            self.i += 2;
                            continue;
                        }
                        self.i += 1;
                        return true;
                    }
                    self.i += 1;
                }
                false
            }
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

/// Record types whose line the source pass filters like a relationship
/// (`STYLE_RESCUE_TYPES`, texture maps included).
const STYLE_RESCUE_TYPES: &[&str] = &[
    "IFCSTYLEDITEM",
    "IFCSTYLEDREPRESENTATION",
    "IFCPRESENTATIONLAYERASSIGNMENT",
    "IFCPRESENTATIONLAYERWITHSTYLE",
    "IFCINDEXEDTRIANGLETEXTUREMAP",
    "IFCINDEXEDPOLYGONALTEXTUREMAP",
    "IFCTEXTUREMAP",
];

/// What the source pass does with one line when a session is active.
pub(crate) enum Filtered {
    Keep,
    /// Withheld, with the warning that says so.
    Withhold(String),
}

/// `filterHiddenRefsFromRelationshipLine` for a pass that omits nothing: the
/// line survives unless it is a relationship (or rescued style record) whose
/// argument list does not read, which the TypeScript filter withholds rather
/// than risk shipping a reference it could not see.
pub(crate) fn filter_relationship(text: &str, id: u32, upper: &str) -> Filtered {
    let is_rel = upper.starts_with("IFCREL");
    if !is_rel && !STYLE_RESCUE_TYPES.contains(&upper) {
        return Filtered::Keep;
    }
    if read_slots(text).is_some() || !starts_with_record_id(text) {
        return Filtered::Keep;
    }
    let display = upper;
    Filtered::Withhold(if is_rel {
        format!(
            "Relationship #{id} ({display}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted). Anything else that relationship associated is no longer associated in the output."
        )
    } else {
        format!(
            "Entity #{id} ({display}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted)."
        )
    })
}

/// `/^\s*#\d+\s*=/`.
fn starts_with_record_id(text: &str) -> bool {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('#') else { return false };
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    digits > 0 && rest[digits..].trim_start().starts_with('=')
}
