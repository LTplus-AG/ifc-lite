// SPDX-License-Identifier: MPL-2.0
use super::durations;
use crate::schema_project_time_unit::{project_time_scale, scale_for_projects};
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;
use ifc_lite_core::{EntityDecoder, EntityScanner};
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct WorkControlDurations {
    pending: HashMap<u32, Vec<(u8, bool)>>,
    model_upgrades: Vec<u32>,
    model_downgrades: Vec<u32>,
    downgrade_groups: Vec<(Vec<u32>, Vec<u32>)>,
    model_scale: HashMap<u32, Option<f64>>,
    unresolved: bool,
    overflow: bool,
}

impl WorkControlDurations {
    pub(super) fn capture(&mut self, id: u32, index: u8, up: bool) {
        self.pending.entry(id).or_default().push((index, up));
        if up {
            self.model_upgrades.push(id);
        } else {
            self.model_downgrades.push(id);
        }
    }

    pub(crate) fn finish_model(&mut self, source_scale: impl FnOnce() -> Option<f64>) {
        if self.model_upgrades.is_empty() {
            return;
        }
        let scale = source_scale();
        for id in self.model_upgrades.drain(..) {
            self.model_scale.insert(id, scale);
        }
    }

    /// The merge plan maps folded projects to the primary and offsets retained projects.
    pub(crate) fn finish_merged_model(&mut self, source: &[u8], projects: impl Iterator<Item = u32>) {
        self.finish_model(|| project_time_scale(source));
        if !self.model_downgrades.is_empty() {
            self.downgrade_groups.push((std::mem::take(&mut self.model_downgrades), projects.collect()));
        }
    }

    pub(super) fn finish(&mut self, text: &str) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        if !self.downgrade_groups.is_empty() {
            let mut decoder = EntityDecoder::new(text.as_bytes());
            for (controls, projects) in self.downgrade_groups.drain(..) {
                let factor = scale_for_projects(&mut decoder, projects);
                self.model_scale.extend(controls.into_iter().map(|id| (id, factor)));
            }
        }
        let effective = if self.model_scale.len() < self.pending.len() { project_time_scale(text.as_bytes()) } else { None };
        let mut scanner = EntityScanner::new(text);
        let mut output = String::new();
        let mut last = 0;
        while let Some((id, _, start, end)) = scanner.next_entity() {
            let Some(slots) = self.pending.remove(&id) else {
                continue;
            };
            let factor = self.model_scale.get(&id).copied().unwrap_or(effective);
            let Some(factor) = factor else {
                self.unresolved = true;
                continue;
            };
            if factor == 1.0 {
                continue;
            }
            let line = &text[start..end];
            let Some(frame) = record_frame(line) else {
                continue;
            };
            let Some(mut args) = split_top_level_args(frame.args(line)) else {
                continue;
            };
            for (index, up) in slots {
                let Some(slot) = args.get_mut(usize::from(index)) else {
                    continue;
                };
                let seconds = if up {
                    durations::to_seconds(slot)
                } else {
                    Some(slot.clone())
                };
                let Some(seconds) = seconds.and_then(|s| s.parse::<f64>().ok()) else {
                    continue;
                };
                let scaled = if up {
                    seconds * factor
                } else {
                    seconds / factor
                };
                *slot = if scaled.is_finite() {
                    let number = crate::step_log::format_step_real(scaled);
                    if up {
                        durations::from_seconds(&number).expect("finite STEP real")
                    } else {
                        number
                    }
                } else {
                    self.overflow = true;
                    "$".to_owned()
                };
            }
            output.push_str(&text[last..start]);
            output.push_str(&frame.with_args(line, &args.join(",")));
            last = end;
        }
        if last == 0 {
            return None;
        }
        output.push_str(&text[last..]);
        Some(output)
    }

    pub(super) fn warnings(&self) -> impl Iterator<Item = String> {
        [self.unresolved.then_some("Work-control duration conversion assumed seconds because the applicable project TIMEUNIT was unresolved or conflicting (#11192)."),
         self.overflow.then_some("A work-control duration or total float overflowed during project TIMEUNIT conversion and was omitted (#11192).")]
            .into_iter().flatten().map(str::to_owned)
    }
}
