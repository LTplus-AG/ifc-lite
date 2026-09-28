// SPDX-License-Identifier: MPL-2.0
//! Bounded diagnostics for attacker-controlled quantity relationships.

use std::collections::HashSet;

const MAX_DIAGNOSTIC_MESSAGES: usize = 1_024;
const TRUNCATED: &str = "authored quantity diagnostics exceed work budget";

#[derive(Default)]
pub(super) struct Diagnostics {
    messages: Vec<String>,
    record_messages: usize,
    static_messages: HashSet<&'static str>,
    truncated: bool,
}

impl Diagnostics {
    pub(super) fn push(&mut self, message: String) {
        if self.record_messages < MAX_DIAGNOSTIC_MESSAGES {
            self.messages.push(message);
            self.record_messages += 1;
        } else if !self.truncated {
            self.messages.push(TRUNCATED.into());
            self.truncated = true;
        }
    }

    pub(super) fn report_once(&mut self, message: &'static str) {
        // Specific refusal reasons must remain visible even after file-level
        // diagnostics are capped. The set of static reasons is finite.
        if self.static_messages.insert(message) { self.messages.push(message.into()); }
    }

    pub(super) fn finish(self) -> Vec<String> { self.messages }
}
