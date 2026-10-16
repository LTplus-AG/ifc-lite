// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Brace-counting function scanner behind `function_length_ratchet` (the
//! workspace has no `syn`). Two passes:
//!
//!  1. [`mask`] blanks comments, string / byte-string / C-string / raw-string
//!     literals and char literals to spaces (newlines kept, so line numbers
//!     survive). A `{` or `fn` inside any of them can no longer be seen.
//!  2. [`scan`] walks the masked text with a brace stack. `fn <ident>` arms a
//!     pending header; the first `{` at the same paren/bracket depth is its
//!     body, a `;` there means a bodiless declaration. `impl` / `trait` / `mod`
//!     arm a header the same way, only to label the scope for the key.
//!
//! Closures are not functions: they have no `fn` token, so their lines count
//! toward the enclosing function. A nested `fn` is measured on its own AND
//! still counts toward its parent. Anything under `#[cfg(test)]` / `#[test]`
//! is skipped, so an inline `mod tests` never produces a row.

/// One function with a body.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct FnSpan {
    /// Stable identity within a file: the enclosing `fn` / `impl` / `trait`
    /// labels joined by `::` then the name, e.g. `Router::apply`. Inherent
    /// impls are labelled by the type, trait impls by `Type@Trait`. A second
    /// function with the same key gets `#2`, `#3`, ... in source order.
    pub key: String,
    /// 1-based line of the `fn` keyword.
    pub start: usize,
    /// 1-based line of the closing `}`.
    pub end: usize,
}

impl FnSpan {
    /// Inclusive line count, `fn` line through closing brace line.
    pub fn lines(&self) -> usize {
        self.end - self.start + 1
    }
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c.is_alphabetic()
}

fn is_ident_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric()
}

/// Replace comments and literal contents with spaces, keeping newlines.
pub fn mask(src: &str) -> Vec<char> {
    let c: Vec<char> = src.chars().collect();
    let mut out = c.clone();
    let blank = |out: &mut Vec<char>, from: usize, to: usize| {
        for ch in out.iter_mut().take(to.min(c.len())).skip(from) {
            if *ch != '\n' {
                *ch = ' ';
            }
        }
    };
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '/' && c.get(i + 1) == Some(&'/') {
            let mut j = i;
            while j < c.len() && c[j] != '\n' {
                j += 1;
            }
            blank(&mut out, i, j);
            i = j;
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            let (mut j, mut depth) = (i + 2, 1);
            while j < c.len() && depth > 0 {
                if c[j] == '/' && c.get(j + 1) == Some(&'*') {
                    depth += 1;
                    j += 2;
                } else if c[j] == '*' && c.get(j + 1) == Some(&'/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i, j);
            i = j;
        } else if ch == '"' {
            let j = end_of_string(&c, i + 1);
            blank(&mut out, i, j);
            i = j;
        } else if ch == '\'' {
            match char_literal_end(&c, i) {
                Some(j) => {
                    blank(&mut out, i, j);
                    i = j;
                }
                None => i += 1, // a lifetime or label: leave it
            }
        } else if is_ident_start(ch) {
            let mut j = i;
            while j < c.len() && is_ident_char(c[j]) {
                j += 1;
            }
            let word: String = c[i..j].iter().collect();
            match word.as_str() {
                // r"..", r#".."#, br#".."#, cr#".."#
                "r" | "br" | "cr" => {
                    let mut k = j;
                    while c.get(k) == Some(&'#') {
                        k += 1;
                    }
                    if c.get(k) == Some(&'"') {
                        let hashes = k - j;
                        let end = end_of_raw_string(&c, k + 1, hashes);
                        blank(&mut out, i, end);
                        i = end;
                        continue;
                    }
                }
                // b"..", c".." (b'x' is reached via the `'` arm next round)
                "b" | "c" if c.get(j) == Some(&'"') => {
                    let end = end_of_string(&c, j + 1);
                    blank(&mut out, i, end);
                    i = end;
                    continue;
                }
                _ => {}
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Index just past the closing `"` of a cooked string whose body starts at `i`.
fn end_of_string(c: &[char], mut i: usize) -> usize {
    while i < c.len() {
        match c[i] {
            '\\' => i += 2,
            '"' => return i + 1,
            _ => i += 1,
        }
    }
    c.len()
}

/// Index just past `"` + `hashes` `#`s, for a raw string whose body starts at `i`.
fn end_of_raw_string(c: &[char], mut i: usize, hashes: usize) -> usize {
    while i < c.len() {
        if c[i] == '"' && (1..=hashes).all(|h| c.get(i + h) == Some(&'#')) {
            return i + 1 + hashes;
        }
        i += 1;
    }
    c.len()
}

/// `Some(end)` if the `'` at `i` opens a char literal, `None` for a lifetime.
fn char_literal_end(c: &[char], i: usize) -> Option<usize> {
    match c.get(i + 1)? {
        '\\' => {
            let mut j = i + 2;
            while j < c.len() && c[j] != '\'' && c[j] != '\n' {
                j += 1;
            }
            (c.get(j) == Some(&'\'')).then_some(j + 1)
        }
        '\'' | '\n' => None,
        _ => (c.get(i + 2) == Some(&'\'')).then_some(i + 3),
    }
}

#[derive(Clone)]
enum Header {
    Fn { name: String, line: usize },
    Block { kind: &'static str, from: usize },
}

struct Pending {
    header: Header,
    depth: usize,
    test: bool,
}

struct Scope {
    /// Label contributed to child keys (`impl` / `trait` / `fn` scopes).
    label: Option<String>,
    /// `(key base, start line)` when this scope is a function body.
    func: Option<(String, usize)>,
    test: bool,
}

/// Last path segment of a type, e.g. `a::b::Foo<T>` -> `Foo`.
fn type_name(text: &str) -> String {
    let text = text.trim();
    let mut name = String::new();
    let mut angle = 0usize;
    for ch in text.chars() {
        match ch {
            '<' => angle += 1,
            '>' => angle = angle.saturating_sub(1),
            _ if angle > 0 => {}
            ':' => name.clear(), // new path segment
            c if is_ident_char(c) => name.push(c),
            _ if !name.is_empty() => break,
            _ => {}
        }
    }
    name
}

/// Drop one leading `<...>` generics group.
fn strip_leading_generics(text: &str) -> &str {
    let t = text.trim_start();
    if !t.starts_with('<') {
        return t;
    }
    let mut depth = 0usize;
    for (i, ch) in t.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return t[i + 1..].trim_start();
                }
            }
            _ => {}
        }
    }
    t
}

/// Label an `impl` header: `Type` or `Type@Trait`.
fn impl_label(header: &str) -> String {
    let h = strip_leading_generics(header);
    let h = h.split(" where ").next().unwrap_or(h);
    // ` for ` at generic depth 0 splits `Trait for Type`.
    let mut depth = 0usize;
    let mut split = None;
    let bytes = h.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'<' => depth += 1,
            b'>' => depth = depth.saturating_sub(1),
            b' ' if depth == 0 && h[i..].starts_with(" for ") => {
                split = Some(i);
                break;
            }
            _ => {}
        }
    }
    let clean = |s: &str| {
        s.trim()
            .trim_start_matches(|c: char| matches!(c, '&' | '*') || c.is_whitespace())
            .split_whitespace()
            .filter(|w| !matches!(*w, "mut" | "dyn" | "const") && !w.starts_with('\''))
            .collect::<Vec<_>>()
            .join(" ")
    };
    match split {
        Some(i) => format!("{}@{}", type_name(&clean(&h[i + 5..])), type_name(&h[..i])),
        None => type_name(&clean(h)),
    }
}

/// Every non-test function with a body in `src`, in order of its closing brace.
pub fn scan(src: &str) -> Vec<FnSpan> {
    let c = mask(src);
    let mut spans: Vec<FnSpan> = Vec::new();
    let mut stack: Vec<Scope> = Vec::new();
    let mut pending: Option<Pending> = None;
    let mut attr_test = false;
    let (mut line, mut depth, mut i) = (1usize, 0usize, 0usize);
    while i < c.len() {
        let ch = c[i];
        match ch {
            '\n' => line += 1,
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            '#' => {
                // Attribute: `#[..]` / `#![..]`; remember `cfg(test)` and `test`.
                let mut j = i + 1;
                if c.get(j) == Some(&'!') {
                    j += 1;
                }
                if c.get(j) == Some(&'[') {
                    let (mut k, mut d) = (j, 0usize);
                    while k < c.len() {
                        match c[k] {
                            '[' => d += 1,
                            ']' => {
                                d -= 1;
                                if d == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        k += 1;
                    }
                    let text: String =
                        c[j + 1..k.min(c.len())].iter().filter(|x| !x.is_whitespace()).collect();
                    if text == "test" || text.starts_with("cfg(test)") {
                        attr_test = true;
                    }
                    line += c[i..k.min(c.len())].iter().filter(|x| **x == '\n').count();
                    i = k + 1;
                    continue;
                }
            }
            ';' => {
                if pending.as_ref().is_some_and(|p| p.depth == depth) {
                    pending = None;
                }
                attr_test = false;
            }
            '{' => {
                let parent_test = stack.last().is_some_and(|s| s.test);
                let scope = match pending.take() {
                    Some(p) if p.depth == depth => match p.header {
                        Header::Fn { name, line: start } => Scope {
                            label: Some(name.clone()),
                            func: Some((name, start)),
                            test: parent_test || p.test,
                        },
                        Header::Block { kind, from } => {
                            let text: String = c[from..i].iter().collect();
                            let label = match kind {
                                "impl" => Some(Some(impl_label(&text)).filter(|l| !l.is_empty()).unwrap_or_else(|| "_".into())),
                                "trait" => Some(type_name(&text)),
                                _ => None,
                            };
                            let named_tests = kind == "mod" && {
                                let n = text.trim();
                                n == "tests" || n == "test"
                            };
                            Scope { label, func: None, test: parent_test || p.test || named_tests }
                        }
                    },
                    other => {
                        pending = other;
                        Scope { label: None, func: None, test: parent_test }
                    }
                };
                attr_test = false;
                stack.push(scope);
            }
            '}' => {
                if let Some(scope) = stack.pop() {
                    if let (Some((name, start)), false) = (scope.func, scope.test) {
                        let prefix: Vec<&str> =
                            stack.iter().filter_map(|s| s.label.as_deref()).collect();
                        let key = if prefix.is_empty() {
                            name
                        } else {
                            format!("{}::{name}", prefix.join("::"))
                        };
                        spans.push(FnSpan { key, start, end: line });
                    }
                }
                attr_test = false;
            }
            c0 if is_ident_start(c0) && (i == 0 || !is_ident_char(c[i - 1])) => {
                let mut j = i;
                while j < c.len() && is_ident_char(c[j]) {
                    j += 1;
                }
                let word: String = c[i..j].iter().collect();
                if pending.is_none() {
                    let test = std::mem::take(&mut attr_test);
                    match word.as_str() {
                        "fn" => {
                            let mut k = j;
                            while k < c.len() && c[k].is_whitespace() {
                                k += 1;
                            }
                            if k < c.len() && is_ident_start(c[k]) {
                                let mut e = k;
                                while e < c.len() && is_ident_char(c[e]) {
                                    e += 1;
                                }
                                let name: String = c[k..e].iter().collect();
                                let start = line;
                                line += c[j..e].iter().filter(|x| **x == '\n').count();
                                pending = Some(Pending {
                                    header: Header::Fn { name, line: start },
                                    depth,
                                    test,
                                });
                                i = e;
                                continue;
                            }
                        }
                        "impl" | "trait" | "mod" => {
                            let kind = match word.as_str() {
                                "impl" => "impl",
                                "trait" => "trait",
                                _ => "mod",
                            };
                            pending = Some(Pending {
                                header: Header::Block { kind, from: j },
                                depth,
                                test,
                            });
                        }
                        _ => attr_test = test,
                    }
                }
                i = j;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    disambiguate(&mut spans);
    spans
}

/// Suffix repeated keys `#2`, `#3`, ... in source (start-line) order, so every
/// key is unique and independent of closing-brace order.
fn disambiguate(spans: &mut [FnSpan]) {
    spans.sort_by_key(|s| s.start);
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for span in spans.iter_mut() {
        let n = seen.entry(span.key.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            span.key = format!("{}#{n}", span.key);
        }
    }
}
