// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const MAX_TYPE_LINK_DIAGNOSTICS: usize = 128;

pub(super) fn report(diagnostics: &mut Vec<String>, count: &mut usize, kind: &'static str, id: u32, reason: &'static str) {
    if *count < MAX_TYPE_LINK_DIAGNOSTICS {
        diagnostics.push(format!("{kind} #{id}: {reason}"));
    } else if *count == MAX_TYPE_LINK_DIAGNOSTICS {
        diagnostics.push("further type-link diagnostics omitted".to_string());
    }
    *count = count.saturating_add(1);
}
