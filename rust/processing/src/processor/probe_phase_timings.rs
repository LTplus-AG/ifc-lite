// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::resolve::Times;
use std::time::Duration;

pub(super) fn record(times: &Times, geometry_time: Duration, total_time: Duration) {
    tracing::trace!(
        target: "ifc_lite_processing::probe_phase_timings",
        parse_ns = times.parse.as_nanos() as u64,
        scan_ns = times.entity_scan.as_nanos() as u64,
        lookup_ns = times.lookup.as_nanos() as u64,
        preprocess_ns = times.preprocess.as_nanos() as u64,
        geometry_ns = geometry_time.as_nanos() as u64,
        total_ns = total_time.as_nanos() as u64,
    );
}
