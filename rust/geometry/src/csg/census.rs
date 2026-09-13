// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// One recorded invocation of a CSG kernel op (perf-census diagnostics).
/// `op`: 0=subtract 1=union 2=intersection
/// 3=clip. `a_tris`/`b_tris` are the operand triangle counts — the arrangement
/// cost driver — of the committed route. Rejected staged attempts do not publish
/// records; resource-budget peaks still measure all actual kernel work.
#[derive(Clone, Copy, Debug)]
pub struct CsgOpRecord {
    pub op: u8,
    pub a_tris: u32,
    pub b_tris: u32,
}

// Global (Mutex) so it captures ops on rayon worker threads, not just the caller.
static CSG_CENSUS: std::sync::Mutex<Vec<CsgOpRecord>> = std::sync::Mutex::new(Vec::new());

/// Clear the CSG op census (call before a measured run).
pub fn reset_csg_census() {
    if let Ok(mut g) = CSG_CENSUS.lock() {
        g.clear();
    }
}

/// Drain the CSG op census (call after a measured run).
pub fn take_csg_census() -> Vec<CsgOpRecord> {
    CSG_CENSUS
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[inline]
pub(super) fn record_csg_op(op: u8, a_tris: usize, b_tris: usize) {
    crate::telemetry_transaction::record(move || {
        if let Ok(mut g) = CSG_CENSUS.lock() {
            g.push(CsgOpRecord {
                op,
                a_tris: a_tris as u32,
                b_tris: b_tris as u32,
            });
        }
    });
}
