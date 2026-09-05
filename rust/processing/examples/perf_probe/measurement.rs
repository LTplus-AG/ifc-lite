// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native timing windows. Cold mode skips preparatory scans; it does not purge
//! the OS file cache. Use a new process for each single-fixture measurement.

use std::time::Instant;
use ifc_lite_core::build_entity_index;
use ifc_lite_geometry::csg::reset_csg_census;
use ifc_lite_processing::{process_geometry, ProcessingStats};
use super::{fingerprint, summarize_census, CensusSummary, Probe};

pub(super) struct ColdTiming {
    pub(super) file_read_ms: f64,
    pub(super) full_load_wall_ms: f64,
}

pub(super) fn validate_cold(cold: bool, iters: usize, fixtures: usize) -> Result<(), &'static str> {
    if cold && (iters != 1 || fixtures != 1) {
        Err("--cold requires --iters 1 and exactly one fixture; launch a new process for every measurement")
    } else {
        Ok(())
    }
}

pub(super) fn run(path: &str, iters: usize, want_census: bool, want_fingerprint: bool, cold: bool) -> Option<Probe> {
    let read_started = Instant::now();
    let content = match std::fs::read(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skip {path}: {e}");
            return None;
        }
    };
    let file_read_ms = read_started.elapsed().as_secs_f64() * 1e3;
    let file_mb = content.len() as f64 / 1.048_576e6;

    // Isolated scan: build_entity_index alone times the pure structural scan
    // that the pipeline otherwise folds into entity_scan_ms. Best-of-3.
    let mut index_build_ms = f64::INFINITY;
    let mut entities = 0usize;
    for _ in 0..if cold { 0 } else { 3 } {
        let t = Instant::now();
        let idx = build_entity_index(&content);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        entities = idx.len();
        index_build_ms = index_build_ms.min(ms);
    }

    // Full pipeline, best-of-N by total_time_ms. Census (if requested) is
    // drained from the run that was kept, so the op counts match the timing.
    let mut best: Option<ProcessingStats> = None;
    let mut best_total = u64::MAX;
    let mut best_census: Option<CensusSummary> = None;
    let mut all_totals_ms = Vec::with_capacity(iters);
    let mut all_wall_ms = Vec::with_capacity(iters);
    let mut fingerprints = want_fingerprint.then(Vec::new);
    for _ in 0..iters.max(1) {
        if want_census {
            reset_csg_census();
        }
        let started = Instant::now();
        let result = process_geometry(&content);
        all_wall_ms.push(started.elapsed().as_secs_f64() * 1e3);
        if cold { entities = result.metadata.entity_count; }
        if let Some(hashes) = &mut fingerprints {
            hashes.push(fingerprint::mesh_fingerprint(&result.meshes));
        }
        let census = if want_census {
            Some(summarize_census())
        } else {
            None
        };
        all_totals_ms.push(result.stats.total_time_ms);
        if result.stats.total_time_ms <= best_total {
            best_total = result.stats.total_time_ms;
            best = Some(result.stats);
            best_census = census;
        }
    }

    Some(Probe {
        path: path.to_string(),
        file_mb,
        entities,
        index_build_ms: (!cold).then_some(index_build_ms),
        cold_timing: cold.then(|| ColdTiming {
            file_read_ms, full_load_wall_ms: file_read_ms + all_wall_ms[0],
        }),
        stats: best?,
        all_totals_ms,
        all_wall_ms,
        fingerprints,
        census: best_census,
    })
}


#[cfg(test)]
mod tests {
    use super::validate_cold;

    #[test]
    fn cold_rejects_repetition_or_multiple_fixtures() {
        assert!(validate_cold(true, 1, 1).is_ok());
        assert!(validate_cold(true, 3, 1).is_err());
        assert!(validate_cold(true, 1, 2).is_err());
        assert!(validate_cold(true, 1, 0).is_err());
        assert!(validate_cold(false, 3, 6).is_ok());
    }
}
