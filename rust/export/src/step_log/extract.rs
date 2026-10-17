// SPDX-License-Identifier: MPL-2.0
//! `EntityExtractor.extractEntity`: one record's attributes in the shape the
//! TypeScript exporter reads them (see [`super::jsval::JsVal`]).

use ifc_lite_core::decode_ifc_string;
use ifc_lite_core::step_encoding::step_string_literal_end;

use super::jsval::JsVal;

/// `isCompleteStepNumericLiteral` (`@ifc-lite/data`).
fn is_complete_numeric(token: &str) -> bool {
    let b = token.as_bytes();
    let n = b.len();
    let mut i = 0;
    if i < n && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < n && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < n && b[i] == b'.' {
        i += 1;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < n {
        if b[i] != b'E' && b[i] != b'e' {
            return false;
        }
        i += 1;
        if i < n && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let mut exp = 0;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
            exp += 1;
        }
        if exp == 0 {
            return false;
        }
    }
    i == n
}

/// `parseFloat` over a token `is_complete_numeric` accepted.
fn parse_float(token: &str) -> f64 {
    // Rust rejects a bare trailing `.` before the exponent (`1.E-5`) in some
    // positions only in older toolchains; normalise it to be safe.
    let normalised = token.replacen(".E", ".0E", 1).replacen(".e", ".0e", 1);
    let normalised = if normalised.ends_with('.') { format!("{normalised}0") } else { normalised };
    normalised.parse::<f64>().unwrap_or(f64::NAN)
}

/// `isUnrepresentableNumericValue` (`attribute-helpers.ts`) over the shape
/// [`extract_entity`] yields: a raw token kept as text because it is a
/// malformed numeric literal (`1.52.3`) or one `parseFloat` reads as an
/// infinity (`1.E400`, `Infinity`). `$`, enumerations and labels are not.
pub(crate) fn is_unrepresentable_numeric(value: &JsVal) -> bool {
    let s = match value {
        JsVal::Num(n) => return !n.is_finite(),
        JsVal::Str(s) => s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'),
        _ => return false,
    };
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    let b = unsigned.as_bytes();
    let numeric_attempt = b.first().is_some_and(u8::is_ascii_digit)
        || (b.first() == Some(&b'.') && b.get(1).is_some_and(u8::is_ascii_digit));
    if numeric_attempt {
        return !is_complete_numeric(s) || parse_float(s).is_infinite();
    }
    unsigned.starts_with("Infinity")
}

/// One record as `EntityExtractor.extractEntity` reads it:
/// `(express id, UPPERCASE type, attributes)`.
pub(crate) fn extract_entity(line: &str) -> Option<(u32, String, Vec<JsVal>)> {
    let rest = line.trim_start().strip_prefix('#')?;
    let digits_end = rest.find(|c: char| !c.is_ascii_digit())?;
    let id: u32 = rest[..digits_end].parse().ok()?;
    let rest = rest[digits_end..].trim_start().strip_prefix('=')?.trim_start();
    let type_end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?;
    if type_end == 0 {
        return None;
    }
    let type_name = rest[..type_end].to_ascii_uppercase();
    let after_type = skip_trivia(&rest[type_end..]);
    let after_open = after_type.strip_prefix('(')?;
    let params = balanced_params(after_open)?;
    Some((id, type_name, parse_list_items(params, 0)))
}

/// Whitespace and `/* … */` comments, skipped.
fn skip_trivia(mut s: &str) -> &str {
    loop {
        let t = s.trim_start();
        if let Some(body) = t.strip_prefix("/*") {
            match body.find("*/") {
                Some(end) => s = &body[end + 2..],
                None => return t,
            }
        } else {
            return t;
        }
    }
}

/// The text up to the `)` that closes the argument list opened just before
/// `s`, honouring strings and comments (`entityParameters`).
fn balanced_params(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let mut depth = 1usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' => {
                // The shared rule for where a literal ends (#7589).
                i = step_string_literal_end(b, i)?;
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                if let Some(end) = s[i + 2..].find("*/") {
                    i += end + 3;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Split a comma-separated list at depth 0 and parse each item, the way
/// `parseAttributes` does for the top level and `parseAttributeValue` for a
/// nested list: empty items are dropped inside a nested list only.
fn parse_list_items(text: &str, depth: usize) -> Vec<JsVal> {
    let mut out = Vec::new();
    if text.trim().is_empty() {
        return out;
    }
    let mut current = String::new();
    let mut paren = 0i32;
    let chars: Vec<char> = text.chars().collect();
    let ascii = crate::step_slot::ascii_projection(&chars);
    let mut i = 0;
    let push = |current: &mut String, out: &mut Vec<JsVal>| {
        let token = current.trim().to_string();
        if depth == 0 || !token.is_empty() {
            out.push(parse_value(&token, depth));
        }
        current.clear();
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            if let Some(end) = find_comment_end(&chars, i + 2) {
                current.push(' ');
                i = end;
                continue;
            }
        }
        if c == '\'' {
            // A literal is copied whole; where it ends is the shared rule, so a
            // `\S\'` operand stays inside it (#7589). Unterminated: the rest.
            let end = step_string_literal_end(&ascii, i).unwrap_or(chars.len());
            current.extend(&chars[i..end]);
            i = end;
            continue;
        } else if c == '(' {
            paren += 1;
            current.push(c);
        } else if c == ')' {
            paren -= 1;
            current.push(c);
        } else if c == ',' && paren == 0 {
            push(&mut current, &mut out);
        } else {
            current.push(c);
        }
        i += 1;
    }
    if !current.trim().is_empty() {
        push(&mut current, &mut out);
    }
    out
}

fn find_comment_end(chars: &[char], from: usize) -> Option<usize> {
    (from..chars.len().saturating_sub(1)).find(|&j| chars[j] == '*' && chars[j + 1] == '/').map(|j| j + 2)
}

/// `parseAttributeValue`.
fn parse_value(raw: &str, depth: usize) -> JsVal {
    if depth > 100 {
        return JsVal::Null;
    }
    let value = raw.trim();
    if value.is_empty() || value == "$" {
        return JsVal::Null;
    }
    if let Some((type_name, inner)) = typed_value(value) {
        return JsVal::Arr(vec![JsVal::Str(type_name.to_string()), parse_value(inner.trim(), depth + 1)]);
    }
    if value.starts_with('(') && value.ends_with(')') {
        let inner = value[1..value.len() - 1].trim();
        if inner.is_empty() {
            return JsVal::Arr(Vec::new());
        }
        return JsVal::Arr(parse_list_items(inner, depth + 1));
    }
    if let Some(digits) = value.strip_prefix('#') {
        let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
        return match digits[..end].parse::<u32>() {
            Ok(id) if id > 0 => JsVal::Num(f64::from(id)),
            _ => JsVal::Null,
        };
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        let raw = value[1..value.len() - 1].replace("''", "'");
        return JsVal::Str(decode_ifc_string(&raw).into_owned());
    }
    if is_complete_numeric(value) {
        let n = parse_float(value);
        if n.is_finite() {
            return JsVal::Num(n);
        }
    }
    JsVal::Str(value.to_string())
}

/// `TYPED_VALUE_RE`: `^([A-Z][A-Z0-9_]*)<trivia>\((.+)\)$`, case-insensitive,
/// with the greedy `.+` running to the LAST `)`.
fn typed_value(value: &str) -> Option<(&str, &str)> {
    let first = value.chars().next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let name_end = value.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?;
    let name = &value[..name_end];
    let rest = skip_trivia(&value[name_end..]);
    let body = rest.strip_prefix('(')?.strip_suffix(')')?;
    if body.is_empty() {
        return None;
    }
    Some((name, body))
}

#[cfg(test)]
#[path = "extract_tests.rs"]
mod tests;
