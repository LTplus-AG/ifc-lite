// SPDX-License-Identifier: MPL-2.0
use super::durations;
use crate::schema_project_time_unit::{project_time_scale, scale_for_projects};
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;
use ifc_lite_core::{EntityDecoder, EntityScanner};
use std::collections::HashMap;

// A merge has one source schema and one applicable project group per input model.
enum ProjectUnits {
    Source(Option<f64>),
    Written(Vec<u32>),
}

struct Control {
    slots: Vec<u8>,
    up: bool,
    model: usize,
}

#[derive(Default)]
pub(crate) struct WorkControlDurations {
    controls: Vec<Control>,
    by_id: HashMap<u32, usize>,
    models: Vec<ProjectUnits>,
    model_start: usize,
    unresolved: bool,
    overflow: bool,
}

impl WorkControlDurations {
    pub(super) fn capture(&mut self, id: u32, index: u8, up: bool) {
        let control = *self.by_id.entry(id).or_insert_with(|| {
            self.controls.push(Control { slots: Vec::new(), up, model: self.models.len() });
            self.controls.len() - 1
        });
        self.controls[control].slots.push(index);
    }

    pub(crate) fn finish_model(&mut self, source_scale: impl FnOnce() -> Option<f64>) {
        if self.controls.get(self.model_start).is_some_and(|control| control.up) {
            self.models.push(ProjectUnits::Source(source_scale()));
        }
        self.model_start = self.controls.len();
    }

    pub(crate) fn finish_merged_model(&mut self, source: &[u8], projects: impl Iterator<Item = u32>) {
        if let Some(control) = self.controls.get(self.model_start) {
            let units = if control.up {
                ProjectUnits::Source(project_time_scale(source))
            } else {
                ProjectUnits::Written(projects.collect())
            };
            self.models.push(units);
            self.model_start = self.controls.len();
        }
    }

    pub(super) fn finish(&mut self, text: &str) -> Option<String> {
        if self.controls.is_empty() {
            return None;
        }
        let mut decoder = EntityDecoder::new(text.as_bytes());
        let mut scales = Vec::new();
        for units in &self.models {
            scales.push(match units {
                ProjectUnits::Source(scale) => *scale,
                ProjectUnits::Written(projects) => scale_for_projects(&mut decoder, projects),
            });
        }
        if scales.is_empty() {
            scales.push(project_time_scale(text.as_bytes()));
        }
        let mut scanner = EntityScanner::new(text);
        let mut output = String::new();
        let mut last = 0;
        while let Some((id, _, start, end)) = scanner.next_entity() {
            let Some(index) = self.by_id.remove(&id) else {
                continue;
            };
            let control = &self.controls[index];
            let factor = scales[control.model];
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
            for &index in &control.slots {
                let Some(slot) = args.get_mut(usize::from(index)) else {
                    continue;
                };
                let seconds = if control.up {
                    durations::to_seconds(slot)
                } else {
                    Some(slot.clone())
                };
                let Some(seconds) = seconds.and_then(|s| s.parse::<f64>().ok()) else {
                    continue;
                };
                let scaled = if control.up {
                    seconds * factor
                } else {
                    seconds / factor
                };
                *slot = if scaled.is_finite() {
                    let number = crate::step_log::format_step_real(scaled);
                    if control.up {
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
