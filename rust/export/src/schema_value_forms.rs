// SPDX-License-Identifier: MPL-2.0
//! Values a target slot cannot hold, after conversion (#10847). The slots and
//! their rejected forms are `generated/value_forms.rs`, written by
//! `scripts/generate-value-forms.mjs` from the TypeScript policy
//! (`schema-value-form-policy.ts`, which documents the forms). A value of a
//! rejected form is written `$` and counted dropped; one a row converts is
//! wrapped (`R>T:NAME`), unwrapped (`T:NAME>U`) or written as an integer
//! (`R>I`); anything else stays. An aggregate loses only its rejected
//! members. Twin of `packages/export/src/schema-converter-value-forms.ts`.
use std::collections::BTreeMap;
use ifc_lite_core::parser::skip_step_trivia;
use crate::generated::value_forms::{ValueFormSlot, VALUE_FORM_SLOTS};
use crate::schema_structural_axes::list_items;
use crate::step_slot::split_top_level_args;

/// The form of one STEP value as written, or `None` for `$`, `*` and anything unread.
fn value_form(value: &str) -> Option<String> {
    let v = value.trim();
    let first = *v.as_bytes().first()?;
    match first {
        b'$' | b'*' => None,
        b'#' => Some("#".into()),
        b'\'' => Some("S".into()),
        b'"' => Some("B".into()),
        // A STEP real starts with a digit, so a leading `.` opens an enumeration.
        b'.' => Some("E".into()),
        b'A'..=b'Z' | b'a'..=b'z' => {
            let name = v.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
            v[name..].trim_start().starts_with('(').then(|| format!("T:{}", v[..name].to_ascii_uppercase()))
        }
        _ => {
            let number = v.strip_prefix(['+', '-']).unwrap_or(v).bytes().next().is_some_and(|b| b.is_ascii_digit());
            number.then(|| if v.contains(['.', 'e', 'E']) { "R" } else { "I" }.into())
        }
    }
}

/// What a row says of `form`: `Some(None)` drop, `Some(Some(to))` convert, `None` keep.
fn rule<'a>(rows: &'a [&'a str], form: &str) -> Option<Option<&'a str>> {
    rows.iter().find_map(|row| match row.split_once('>') {
        Some((from, to)) => (from == form).then_some(Some(to)),
        None => (*row == form).then_some(None),
    })
}

/// Whether a STEP real is a whole number, read from its digits: float rounding
/// would make `2.0000000000000001` whole. Every digit after the point, once the
/// exponent moves it, is 0. Twin of `wholeDecimal`.
fn whole_decimal(token: &str) -> bool {
    // The shared STEP number grammar gates the token; only the digits are read here.
    if ifc_lite_core::parser::step_numeric_literal_len(token.as_bytes()) != Some(token.len()) { return false; }
    let unsigned = token.strip_prefix(['+', '-']).unwrap_or(token);
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let Ok(exponent) = exponent.parse::<i64>() else { return false };
    let point = (int.len() as i64).saturating_add(exponent).max(0) as usize;
    int.bytes().chain(frac.bytes()).skip(point).all(|b| b == b'0')
}

/// `value` in the target's form (`None` to drop it), and how many values that lost.
fn fix(value: &str, prefix: &str, rows: &[&str]) -> (Option<String>, usize) {
    let Some(start) = skip_step_trivia(value.as_bytes(), 0) else { return (Some(value.to_owned()), 0) };
    if value[start..].starts_with('(') {
        let Some(members) = list_items(value) else { return (Some(value.to_owned()), 0) };
        let (mut kept, mut lost) = (Vec::new(), 0);
        for member in &members {
            let (fixed, n) = fix(member, &format!("{prefix}A"), rows);
            lost += n;
            kept.extend(fixed);
        }
        if lost == 0 && kept == members { return (Some(value.to_owned()), 0); }
        return ((!kept.is_empty()).then(|| format!("({})", kept.join(","))), lost);
    }
    // Classified and converted without comments, so a trailing `/* .. */` changes nothing.
    let body = crate::step_slot::without_comments(value);
    let Some(to) = value_form(&body).and_then(|form| rule(rows, &format!("{prefix}{form}"))) else { return (Some(value.to_owned()), 0) };
    let fixed = match to {
        None => None,
        Some(to) if to.starts_with("T:") => Some(format!("{}({body})", &to[2..])),
        Some("U") => body.find('(').zip(body.rfind(')')).map(|(open, close)| body[open + 1..close].trim().to_owned()),
        Some(_) => body.parse::<f64>().ok().filter(|n| whole_decimal(&body) && n.abs() < 9_007_199_254_740_992.0).map(|n| format!("{}", n as i64)),
    };
    let lost = usize::from(fixed.is_none());
    (fixed, lost)
}

/// Value-form reconciliation for one export: rewrites, and names what it dropped.
#[derive(Default)]
pub(crate) struct ValueForms {
    /// Per `TYPE.Attribute`: values dropped, and those that left a required slot `$`.
    dropped: BTreeMap<String, usize>,
    emptied: BTreeMap<String, usize>,
}

impl ValueForms {
    /// `line`, already converted from `cfrom` to `cto`, with every slot in a
    /// form the target accepts; each value dropped is added to `dropped`.
    pub(crate) fn apply(&mut self, line: String, cfrom: &str, cto: &str, dropped: &mut usize) -> String {
        let Some(frame) = crate::step_record_frame::record_frame(&line) else { return line };
        let written = frame.head.type_name(&line);
        // The converter writes the type in upper case; anything else is copied once.
        let ty: std::borrow::Cow<str> = if written.bytes().any(|b| b.is_ascii_lowercase()) { written.to_ascii_uppercase().into() } else { written.into() };
        let Ok(at) = VALUE_FORM_SLOTS.binary_search_by(|(f, t, name, _)| (*f, *t, *name).cmp(&(cfrom, cto, &*ty))) else { return line };
        let slots: &[ValueFormSlot] = VALUE_FORM_SLOTS[at].3;
        let Some(mut args) = split_top_level_args(frame.args(&line)) else { return line };
        // A record whose arity is not the target's is left alone: slot i need not be attribute i.
        if crate::schema_convert::schema_attribute_names(cto, &ty).map(<[_]>::len) != Some(args.len()) { return line; }
        let mut changed = false;
        for &(index, attribute, required, rows) in slots {
            let Some(slot) = args.get_mut(usize::from(index)) else { continue };
            let (fixed, lost) = fix(slot, "", rows);
            if lost > 0 {
                *dropped += lost;
                let into = if fixed.is_none() && required { &mut self.emptied } else { &mut self.dropped };
                *into.entry(format!("{ty}.{attribute}")).or_default() += lost;
            }
            let value = fixed.unwrap_or_else(|| "$".to_owned());
            if value != *slot {
                *slot = value;
                changed = true;
            }
        }
        if changed { frame.with_args(&line, &args.join(",")) } else { line }
    }

    /// One warning per kind, naming every slot a value was dropped from (#10847).
    pub(crate) fn warnings(&self) -> Vec<String> {
        let line = |where_: &BTreeMap<String, usize>, what: &str| {
            let total: usize = where_.values().sum();
            let sites: Vec<&str> = where_.keys().map(String::as_str).collect();
            (!where_.is_empty()).then(|| format!("{total} value(s) of a type the target slot does not accept {what}: {} (#10847).", sites.join(", ")))
        };
        line(&self.dropped, "were written as $").into_iter()
            .chain(line(&self.emptied, "left a slot the target requires as $, so the file is not valid against its header"))
            .collect()
    }
}

#[cfg(test)]
#[path = "schema_value_forms_tests.rs"]
mod tests;
