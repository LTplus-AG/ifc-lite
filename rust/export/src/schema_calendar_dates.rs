// SPDX-License-Identifier: MPL-2.0

#[path = "schema_calendar_date_values.rs"]
mod values;

use std::collections::{HashMap, HashSet, VecDeque};

use ifc_lite_core::EntityScanner;

use crate::step_slot::without_comments;
use crate::step_ids::IdAllocator;
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;
use crate::step_text::refs_in_line;
use values::{from_legacy, to_legacy, DateRecord, Kind, DATE_CARRIERS};

fn carrier(ty: &str) -> bool {
    DATE_CARRIERS.iter().any(|name| ty.eq_ignore_ascii_case(name))
}

pub(super) fn has_carriers(content: &[u8]) -> bool {
    let mut scanner = EntityScanner::new(content);
    std::iter::from_fn(|| scanner.next_entity()).any(|(_, ty, _, _)| carrier(ty))
}

struct PendingDate {
    slot: u8,
    kind: Kind,
    up: bool,
    required: bool,
    site: String,
}

#[derive(Default)]
pub(super) struct CalendarDates {
    pub(super) enabled: bool,
    /// An IFC2X3 upgrade wrote a legacy date record, so those nothing references
    /// go even when no slot converts (#11199).
    carriers_written: bool,
    pending: HashMap<u32, Vec<PendingDate>>,
    retained: usize,
    /// `(id, TYPE)` of each legacy date record no written record reached
    /// before slots converted, so it was left out (#11199).
    omitted: Vec<(u32, String)>,
}

/// What a deferred date slot lost: all of it, its time (kept the date), or
/// nothing but a clock precision it filled (#11199).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DateLoss {
    Dropped,
    Narrowed,
    Filled,
}

impl CalendarDates {
    /// Note an IFC2X3 upgrade's record of `ty`: a legacy date record arms the finishing pass.
    pub(super) fn note_upgraded(&mut self, ty: &str) {
        if carrier(ty) { self.carriers_written = true; }
    }

    pub(super) fn defer(&mut self, id: u32, slot: u8, operator: &str, required: bool, site: impl FnOnce() -> String) -> bool {
        if !self.enabled {
            return false;
        }
        let Some((way, kind)) = operator.split_once(':') else { return false };
        if !matches!(way, "C+" | "C-") {
            return false;
        }
        let Some(kind) = Kind::read(kind) else { return false };
        self.pending.entry(id).or_default().push(PendingDate { slot, kind, up: way == "C+", required, site: site() });
        true
    }

    pub(super) fn finish(&mut self, text: &str, mut loss: impl FnMut(bool, DateLoss, String), pruned: impl FnMut(&str)) -> Option<(String, isize)> {
        if !self.enabled || (self.pending.is_empty() && !self.carriers_written) {
            return None;
        }
        let upgrade = self.carriers_written || self.pending.values().any(|dates| dates.iter().any(|date| date.up));
        let (carriers, maximum) = collect_carriers(text, upgrade);
        // What no written record reaches before slots convert carries no value anywhere: it is omitted, and named (#11199).
        let reached = retained_carriers(text, &carriers, &HashMap::new());
        let mut ids = IdAllocator::after(maximum);
        let mut appended = Vec::new();
        let mut rewrites = HashMap::new();
        let mut scanner = EntityScanner::new(text);
        while let Some((id, _, begin, end)) = scanner.next_entity() {
            let Some(dates) = self.pending.remove(&id) else { continue };
            let line = &text[begin..end];
            let Some(frame) = record_frame(line) else { continue };
            let Some(mut slots) = split_top_level_args(frame.args(line)) else { continue };
            for date in dates {
                let Some(value) = slots.get_mut(usize::from(date.slot)) else { continue };
                let fixed = if date.up {
                    from_legacy(value, date.kind, |id| carriers.get(&id?))
                } else {
                    restored_date(value, date.kind, &mut ids, &mut appended).map(|value| (value, false, false))
                };
                let lost = match fixed {
                    None => Some(DateLoss::Dropped),
                    Some((_, true, _)) => Some(DateLoss::Narrowed),
                    Some((_, _, true)) => Some(DateLoss::Filled),
                    Some(_) => None,
                };
                if let Some(lost) = lost {
                    loss(date.required, lost, date.site);
                }
                *value = fixed.map_or_else(|| "$".to_owned(), |(value, _, _)| value);
            }
            rewrites.insert(id, frame.with_args(line, &slots.join(",")));
        }
        self.pending.clear();
        self.omitted.extend(carriers.iter().filter(|(id, _)| !reached.contains(id)).map(|(id, date)| (*id, date.ty.clone())));
        let used = retained_carriers(text, &carriers, &rewrites);
        self.retained = used.len();
        Some(finish_text(text, &carriers, &used, &rewrites, &appended, pruned))
    }
    pub(super) fn warnings(&self) -> impl Iterator<Item = String> + '_ {
        let retained = (self.retained != 0).then(|| format!(
            "{} legacy IFC2X3 date record(s) are still referenced by unconverted slots, so the file is not valid against its header (#10879).",
            self.retained,
        ));
        let mut omitted: Vec<_> = self.omitted.iter().collect();
        omitted.sort_unstable();
        let omitted = (!omitted.is_empty()).then(|| format!(
            "{} legacy IFC2X3 date record(s) were omitted because no written record references them and the target schema does not declare their type: {} (#11199).",
            omitted.len(),
            omitted.iter().map(|(id, ty)| format!("#{id} ({ty})")).collect::<Vec<_>>().join(", "),
        ));
        retained.into_iter().chain(omitted)
    }
}

fn collect_carriers(text: &str, upgrade: bool) -> (HashMap<u32, DateRecord>, u32) {
    let mut out = HashMap::new();
    let mut maximum = 0;
    let mut scanner = EntityScanner::new(text);
    while let Some((id, ty, a, b)) = scanner.next_entity() {
        maximum = maximum.max(id);
        if upgrade && carrier(ty) {
            let line = &text[a..b];
            if let Some(slots) = record_frame(line).and_then(|frame| split_top_level_args(frame.args(line))) {
                out.insert(id, DateRecord { ty: ty.to_ascii_uppercase(), slots: slots.iter().map(|slot| without_comments(slot)).collect() });
            }
        }
    }
    (out, maximum)
}

fn restored_date(token: &str, kind: Kind, ids: &mut IdAllocator, appended: &mut Vec<String>) -> Option<String> {
    // Reserve atomically. At exhaustion, the previous slot remains a reported loss.
    let mut candidate = *ids;
    let mut records = Vec::new();
    let reference = to_legacy(&without_comments(token), kind, |body| {
        let id = candidate.allocate()?;
        records.push(format!("#{id}={body};"));
        Some(id)
    })?;
    appended.extend(records);
    *ids = candidate;
    Some(format!("#{reference}"))
}

fn retained_carriers(text: &str, carriers: &HashMap<u32, DateRecord>, rewrites: &HashMap<u32, String>) -> HashSet<u32> {
    let mut retained = HashSet::new();
    if carriers.is_empty() {
        return retained;
    }
    let mut queue = VecDeque::new();
    let mut refs = Vec::new();
    let mut scanner = EntityScanner::new(text);
    while let Some((id, _, a, b)) = scanner.next_entity() {
        if carriers.contains_key(&id) {
            continue;
        }
        let line = rewrites.get(&id).map_or(&text[a..b], String::as_str);
        refs_in_line(line.as_bytes(), &mut refs);
        for id in refs.drain(..) {
            if carriers.contains_key(&id) && retained.insert(id) {
                queue.push_back(id);
            }
        }
    }
    while let Some(id) = queue.pop_front() {
        for slot in &carriers[&id].slots {
            refs_in_line(slot.as_bytes(), &mut refs);
            for child in refs.drain(..) {
                if carriers.contains_key(&child) && retained.insert(child) {
                    queue.push_back(child);
                }
            }
        }
    }
    retained
}

fn finish_text(
    text: &str, carriers: &HashMap<u32, DateRecord>, retained: &HashSet<u32>,
    rewrites: &HashMap<u32, String>, appended: &[String], mut pruned: impl FnMut(&str),
) -> (String, isize) {
    let mut cut = 0;
    let mut output = String::with_capacity(text.len());
    let mut removed = 0;
    let mut scanner = EntityScanner::new(text);
    while let Some((id, _, a, b)) = scanner.next_entity() {
        if let Some(date) = carriers.get(&id).filter(|_| !retained.contains(&id)) {
            pruned(&date.ty);
            output.push_str(&text[cut..a]);
            let tail = &text[b..];
            let separator = if tail.starts_with("\r\n") { 2 } else { usize::from(tail.starts_with('\n')) };
            cut = b + separator;
            removed += 1;
        } else if let Some(replacement) = rewrites.get(&id) {
            output.push_str(&text[cut..a]);
            output.push_str(replacement);
            cut = b;
        }
    }
    output.push_str(&text[cut..]);
    for line in appended {
        output.push_str(line);
        output.push('\n');
    }
    (output, appended.len() as isize - removed)
}
