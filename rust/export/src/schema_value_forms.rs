// SPDX-License-Identifier: MPL-2.0
//! Values a target slot cannot hold, after conversion (#10847). The slots and
//! their rejected forms are `generated/value_forms.rs`, written by
//! `scripts/generate-value-forms.mjs` from the TypeScript policy
//! (`schema-value-form-policy.ts`, which documents the forms). A value of a
//! rejected form is written `$` and counted dropped; one a row converts is
//! wrapped (`R>T:NAME`), unwrapped (`T:NAME>U`) or written as an integer
//! (`R>I`, and `T:NAME(R)>I` for a typed member whose defined type became an
//! INTEGER), or written as its one member (`T:NAME>U1`); anything else stays.
//! An aggregate loses only its rejected members, unless they are positional:
//! then it and the slots it pairs with are emptied, each as below. A required
//! aggregate that may be empty and loses every member is written `()`. Twin of
//! `packages/export/src/schema-converter-value-forms.ts`.
use std::collections::BTreeMap;
use ifc_lite_core::parser::skip_step_trivia;
use crate::generated::value_forms::{ValueFormSlot, VALUE_FORM_SLOTS};
use crate::schema_structural_axes::list_items;
use crate::step_slot::split_top_level_args;

#[path = "schema_durations.rs"]
mod durations;

#[path = "schema_calendar_dates.rs"]
mod calendar_dates;

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

/// How many values a slot holds: its members, or one unless it is `$`.
fn value_count(slot: &str) -> usize {
    list_items(slot).map_or_else(|| usize::from(value_form(&crate::step_slot::without_comments(slot)).is_some()), |m| m.len())
}

/// A whole STEP real as an integer token; `None` for a fraction or one past
/// the safe range. Twin of `asInteger`.
fn as_integer(token: &str) -> Option<String> {
    token.parse::<f64>().ok().filter(|n| whole_decimal(token) && n.abs() < 9_007_199_254_740_992.0).map(|n| format!("{}", n as i64))
}

/// A typed `NAME(payload)` whose payload form a `T:NAME(F)` row converts
/// (`I`) or drops. Twin of `narrowed`.
fn narrowed(value: &str, body: &str, form: &str, rows: &[&str]) -> (Option<String>, usize) {
    let Some((name, arg)) = typed_arg(body) else { return (Some(value.to_owned()), 0) };
    let Some(to) = value_form(arg).and_then(|p| rule(rows, &format!("{form}({p})"))) else { return (Some(value.to_owned()), 0) };
    match to.filter(|to| *to == "I").and_then(|_| as_integer(arg)) {
        Some(int) => (Some(format!("{name}({int})")), 0),
        None => (None, 1),
    }
}

/// A typed value's name and argument, `NAME(arg)` -> (`NAME`, `arg`). Twin of `unwrapped`.
fn typed_arg(body: &str) -> Option<(&str, &str)> {
    body.find('(').zip(body.rfind(')')).map(|(open, close)| (body[..open].trim_end(), body[open + 1..close].trim()))
}

/// `value` in the target's form (`None` to drop it), and how many values that lost.
fn fix(value: &str, prefix: &str, rows: &[&str], duration_converted: &mut bool) -> (Option<String>, usize) {
    let Some(start) = skip_step_trivia(value.as_bytes(), 0) else { return (Some(value.to_owned()), 0) };
    if value[start..].starts_with('(') {
        let Some(members) = list_items(value) else { return (Some(value.to_owned()), 0) };
        let (mut kept, mut lost) = (Vec::new(), 0);
        for member in &members {
            let (fixed, n) = fix(member, &format!("{prefix}A"), rows, duration_converted);
            lost += n;
            kept.extend(fixed);
        }
        if lost == 0 && kept == members { return (Some(value.to_owned()), 0); }
        return ((!kept.is_empty()).then(|| format!("({})", kept.join(","))), lost);
    }
    // Classified and converted without comments, so a trailing `/* .. */` changes nothing.
    let body = crate::step_slot::without_comments(value);
    let Some(form) = value_form(&body) else { return (Some(value.to_owned()), 0) };
    let key = format!("{prefix}{form}");
    let Some(to) = rule(rows, &key) else {
        // Only a typed value with a payload row (`T:NAME(F)`) is read further.
        let payload = form.starts_with("T:") && rows.iter().any(|r| r.strip_prefix(key.as_str()).is_some_and(|rest| rest.starts_with('(')));
        return if payload { narrowed(value, &body, &key, rows) } else { (Some(value.to_owned()), 0) };
    };
    let inner = || typed_arg(&body).map(|(_, arg)| arg);
    let fixed = match to {
        None => None,
        Some(to) if to.starts_with("T:") => Some(format!("{}({body})", &to[2..])),
        Some("TEXT") => inner().filter(|arg| arg.starts_with('\'') && ifc_lite_core::parser::is_step_value(arg.as_bytes())).map(|arg| format!("IFCTEXT({arg})")),
        Some("D+") => durations::from_seconds(&body),
        Some("D-") => durations::to_seconds(&body),
        Some("U") => inner().map(str::to_owned),
        Some("U1") => inner().and_then(list_items).filter(|m| m.len() == 1).map(|m| m[0].trim().to_owned()),
        Some(_) => as_integer(&body),
    };
    // A set of references that could not be unwrapped loses each of them, and
    // at least one value, so an emptied slot is always named.
    if fixed.is_some() && matches!(to, Some("D+" | "D-")) { *duration_converted = true; }
    let lost = match (fixed.is_none(), to) {
        (false, _) => 0,
        (true, Some("U1")) => inner().map_or(1, value_count).max(1),
        (true, _) => 1,
    };
    (fixed, lost)
}

/// Value-form reconciliation for one export: rewrites, and names what it dropped.
#[derive(Default)]
pub(crate) struct ValueForms {
    /// Per `TYPE.Attribute`: values dropped, and those that left a required slot `$`.
    dropped: BTreeMap<String, usize>,
    emptied: BTreeMap<String, usize>,
    dates: calendar_dates::CalendarDates,
    duration_converted: bool,
}

impl ValueForms {
    pub(crate) fn enable_dates(&mut self) {
        self.dates.enabled = true;
    }

    /// Legacy date carriers must be visible to the final pass after edits and ref remapping.
    pub(crate) fn buffer_for_dates(content: &[u8], from: &str, to: &str) -> bool {
        crate::schema_convert::canon(from) == "IFC2X3"
            && matches!(crate::schema_convert::canon(to), "IFC4" | "IFC4X3")
            && calendar_dates::has_carriers(content)
    }

    pub(crate) fn finish_dates(&mut self, text: &str, dropped: &mut usize) -> Option<(String, isize)> {
        self.dates.finish(text, |required, site| {
            *dropped += 1;
            let into = if required { &mut self.emptied } else { &mut self.dropped };
            *into.entry(site).or_default() += 1;
        })
    }

    /// `line`, already converted from `cfrom` to `cto`, with every slot in a
    /// form the target accepts; each value dropped is added to `dropped`.
    pub(crate) fn apply(&mut self, line: String, cfrom: &str, cto: &str, id: u32, dropped: &mut usize) -> String {
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
        for &(index, attribute, required, empty, whole, rows) in slots {
            let Some(slot) = args.get(usize::from(index)) else { continue };
            if self.dates.enabled && rows.iter().any(|row| row.contains(">C")) {
                let body = crate::step_slot::without_comments(slot);
                let op = value_form(&body).and_then(|form| rule(rows, &form).flatten());
                if op.is_some_and(|op| self.dates.defer(id, index, op, required, || format!("{ty}.{attribute}"))) {
                    continue;
                }
            }
            let (mut fixed, lost) = fix(slot, "", rows, &mut self.duration_converted);
            if lost > 0 && !whole.is_empty() {
                // Positional members: every slot of the group goes whole, each named for what it held.
                for &i in whole {
                    // The generator gives every slot of a group a row like this one.
                    let Some(&(_, own, own_required, own_empty, _, _)) = slots.iter().find(|s| s.0 == i) else { continue };
                    let Some(partner) = args.get_mut(usize::from(i)) else { continue };
                    let held = value_count(partner);
                    if held == 0 { continue; }
                    let emptied = if own_empty && own_required { "()" } else { "$" };
                    *dropped += held;
                    let into = if emptied == "$" && own_required { &mut self.emptied } else { &mut self.dropped };
                    *into.entry(format!("{ty}.{own}")).or_default() += held;
                    *partner = emptied.to_owned();
                    changed = true;
                }
                continue;
            }
            if fixed.is_none() && empty && required { fixed = Some("()".to_owned()); }
            if lost > 0 {
                *dropped += lost;
                let into = if fixed.is_none() && required { &mut self.emptied } else { &mut self.dropped };
                *into.entry(format!("{ty}.{attribute}")).or_default() += lost;
            }
            let value = fixed.unwrap_or_else(|| "$".to_owned());
            let slot = &mut args[usize::from(index)];
            if value != *slot {
                *slot = value;
                changed = true;
            }
        }
        if changed { frame.with_args(&line, &args.join(",")) } else { line }
    }

    pub(crate) fn duration_warning<'a>(&self, mut sources: impl Iterator<Item = &'a [u8]>) -> Option<String> {
        (self.duration_converted && sources.any(durations::has_non_second_project_time_unit))
            .then(|| durations::TIME_UNIT_WARNING.to_owned())
    }

    /// One warning per kind, naming every slot a value was dropped from (#10847).
    pub(crate) fn warnings(&self) -> Vec<String> {
        let line = |where_: &BTreeMap<String, usize>, what: &str| {
            let total: usize = where_.values().sum();
            let sites: Vec<&str> = where_.keys().map(String::as_str).collect();
            (!where_.is_empty()).then(|| format!("{total} value(s) of a type the target slot does not accept {what}: {} (#10847).", sites.join(", ")))
        };
        line(&self.dropped, "were dropped").into_iter()
            .chain(line(&self.emptied, "left a slot the target requires as $, so the file is not valid against its header"))
            .chain(self.dates.warning())
            .collect()
    }
}

#[cfg(test)]
#[path = "schema_value_forms_tests.rs"]
mod tests;
