// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::engine::{build_welded, signature_keys, verify, Welded, AMBIG_SPACING, SAFE_TOL};
use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

const TOL_SWEEP: [f64; 6] = [1.0e-6, 1.0e-5, 3.0e-5, 1.0e-4, 3.0e-4, 1.0e-3];

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

/// The Phase-0 decision metrics.
pub struct RigidDedupReport {
    pub total_occurrences: usize,
    pub distinct_exact: usize,
    pub analyzed: usize,
    pub skipped_large_or_tiny: usize,
    /// distinct templates after SAFE rigid merging (connectivity-gated).
    pub distinct_after_rigid: usize,
    pub exact_dedup: f64,
    pub safe_rigid_dedup: f64,
    /// merges accepted at SAFE_TOL with connectivity.
    pub safe_merges: usize,
    /// position-passed (<=SAFE_TOL) but connectivity FAILED — the false merges a
    /// naive position-only gate would have accepted (corruption avoided).
    pub connectivity_rejected: usize,
    /// reflection-only fits (chiral pairs correctly kept separate).
    pub reflection_only: usize,
    /// excluded for ambiguous (sub-tol) vertex spacing.
    pub ambiguous_excluded: usize,
    /// residual histogram: log10-binned max_dev of corresponded+connectivity-ok pairs.
    pub residual_hist: Vec<(String, usize)>,
    /// safe dedup at each swept tolerance (connectivity-gated).
    pub dedup_by_tol: Vec<(f64, f64)>,
    pub wall_ms: u128,
}

impl std::fmt::Display for RigidDedupReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "===== Rigid-congruence dedup (Phase 0 measurement) =====")?;
        writeln!(
            f,
            "occurrences={} distinct_exact={} analyzed={} skipped(tiny/large)={}",
            self.total_occurrences, self.distinct_exact, self.analyzed, self.skipped_large_or_tiny
        )?;
        writeln!(
            f,
            "EXACT dedup        = {:.3}x  (baseline, shipped)",
            self.exact_dedup
        )?;
        writeln!(
            f,
            "SAFE RIGID dedup   = {:.3}x  (distinct {} -> {} after {} verified merges @ {:.0}µm + connectivity)",
            self.safe_rigid_dedup,
            self.distinct_exact,
            self.distinct_after_rigid,
            self.safe_merges,
            SAFE_TOL * 1.0e6
        )?;
        writeln!(
            f,
            "connectivity-rejected (naive false merges avoided) = {}",
            self.connectivity_rejected
        )?;
        writeln!(
            f,
            "reflection-only (chiral, kept separate) = {} | ambiguous-spacing excluded = {}",
            self.reflection_only, self.ambiguous_excluded
        )?;
        writeln!(f, "-- residual histogram (corresponded+connectivity-ok max-dev) --")?;
        for (bin, n) in &self.residual_hist {
            writeln!(f, "   {:<14} {}", bin, n)?;
        }
        writeln!(f, "-- safe dedup vs tolerance (connectivity-gated) --")?;
        for (tol, dd) in &self.dedup_by_tol {
            writeln!(f, "   tol={:>8.0}µm  -> {:.3}x", tol * 1.0e6, dd)?;
        }
        writeln!(f, "wall={}ms", self.wall_ms)?;
        write!(f, "========================================================")
    }
}

/// Run the rigid-congruence dedup measurement over the collected distinct local
/// meshes. `occ_counts` maps rep_identity -> streamed-occurrence count (from the
/// engine tally) so the dedup ratio is against true occurrences, not distinct.
pub fn analyze_rigid_dedup(
    locals: Vec<(u128, Mesh)>,
    occ_counts: &std::collections::HashMap<u128, usize>,
    elapsed_ms: u128,
) -> RigidDedupReport {
    let distinct_exact = locals.len();
    let total_occurrences: usize = locals
        .iter()
        .map(|(id, _)| occ_counts.get(id).copied().unwrap_or(1))
        .sum();

    // Build welded representations (skip tiny/large).
    let mut welded: Vec<(usize, Welded)> = Vec::new();
    let mut skipped = 0usize;
    for (i, (_, m)) in locals.iter().enumerate() {
        match build_welded(m) {
            Some(w) => welded.push((i, w)),
            None => skipped += 1,
        }
    }

    // Bucket by signature.
    let mut buckets: FxHashMap<u64, Vec<usize>> = FxHashMap::default();
    for (wi, (_, w)) in welded.iter().enumerate() {
        for k in signature_keys(w) {
            buckets.entry(k).or_default().push(wi);
        }
    }

    // Union-find over welded indices.
    let n = welded.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while parent[r] != r {
            r = parent[r];
        }
        let mut c = x;
        while parent[c] != c {
            let next = parent[c];
            parent[c] = r;
            c = next;
        }
        r
    }

    // Informational: meshes too dense for the NN-fallback path (the permutation
    // path can still verify them when bounded).
    let ambiguous_excluded = welded
        .iter()
        .filter(|(_, w)| w.min_spacing < AMBIG_SPACING)
        .count();
    let mut safe_merges = 0usize;
    let mut connectivity_rejected = 0usize;
    let mut reflection_only = 0usize;
    // residual log bins
    let bin_edges = [1e-6, 3e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2];
    let mut hist = vec![0usize; bin_edges.len() + 1];
    // record corresponded pairs (a<b welded idx, max_dev, connectivity_ok) for tol sweep
    let mut corr_pairs: Vec<(usize, usize, f64, bool)> = Vec::new();

    // Within each bucket, template-match: compare each member against established
    // representatives (the bucket's current union roots we've seen).
    let mut seen_in_pass: FxHashMap<u64, Vec<usize>> = FxHashMap::default();
    // Deduplicate bucket membership work: process each unordered pair at most once.
    let mut tried: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();

    for (key, members) in &buckets {
        let reps = seen_in_pass.entry(*key).or_default();
        for &m in members {
            let mut matched = false;
            // compare against representatives already promoted in this bucket
            let reps_snapshot: Vec<usize> = reps.clone();
            for &rep in &reps_snapshot {
                let (a, b) = if rep < m { (rep, m) } else { (m, rep) };
                if a == b || !tried.insert((a, b)) {
                    continue;
                }
                let out = verify(&welded[a].1, &welded[b].1);
                if out.reflection_only {
                    reflection_only += 1;
                }
                if out.corresponded {
                    // histogram (connectivity-ok only — honest congruent residual)
                    if out.connectivity_ok {
                        let mut bi = bin_edges.len();
                        for (k, &edge) in bin_edges.iter().enumerate() {
                            if out.max_dev < edge {
                                bi = k;
                                break;
                            }
                        }
                        hist[bi] += 1;
                    }
                    corr_pairs.push((a, b, out.max_dev, out.connectivity_ok));
                    // SAFE merge decision
                    if out.max_dev <= SAFE_TOL {
                        if out.connectivity_ok {
                            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                            if ra != rb {
                                parent[ra] = rb;
                                safe_merges += 1;
                            }
                            matched = true;
                        } else {
                            connectivity_rejected += 1;
                        }
                    }
                }
                if matched {
                    break;
                }
            }
            if !matched {
                reps.push(m);
            }
        }
    }

    // distinct after rigid merge
    let mut roots: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for i in 0..n {
        roots.insert(find(&mut parent, i));
    }
    let distinct_after_rigid = roots.len() + skipped;

    let exact_dedup = total_occurrences as f64 / distinct_exact.max(1) as f64;
    let safe_rigid_dedup = total_occurrences as f64 / distinct_after_rigid.max(1) as f64;

    // dedup by tol (connectivity-gated) via fresh union-find over corr_pairs
    let mut dedup_by_tol = Vec::new();
    for &tol in &TOL_SWEEP {
        let mut p2: Vec<usize> = (0..n).collect();
        for &(a, b, dev, conn) in &corr_pairs {
            if conn && dev <= tol {
                let ra = find(&mut p2, a);
                let rb = find(&mut p2, b);
                if ra != rb {
                    p2[ra] = rb;
                }
            }
        }
        let mut rs: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for i in 0..n {
            rs.insert(find(&mut p2, i));
        }
        let distinct = rs.len() + skipped;
        dedup_by_tol.push((tol, total_occurrences as f64 / distinct.max(1) as f64));
    }

    let labels = [
        "<1µm", "1-3µm", "3-10µm", "10-30µm", "30-100µm", "100-300µm", "300µm-1mm", "1-3mm",
        "3-10mm", ">10mm",
    ];
    let residual_hist: Vec<(String, usize)> = labels
        .iter()
        .zip(hist.iter())
        .map(|(l, &n)| (l.to_string(), n))
        .collect();

    RigidDedupReport {
        total_occurrences,
        distinct_exact,
        analyzed: welded.len(),
        skipped_large_or_tiny: skipped,
        distinct_after_rigid,
        exact_dedup,
        safe_rigid_dedup,
        safe_merges,
        connectivity_rejected,
        reflection_only,
        ambiguous_excluded,
        residual_hist,
        dedup_by_tol,
        wall_ms: elapsed_ms,
    }
}
