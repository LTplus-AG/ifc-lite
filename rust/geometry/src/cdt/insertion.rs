/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Progress-aware incremental point insertion for untrusted PSLGs.

use super::{ekey, in_circle_sign, orient, Cdt, NONE};
use super::predicates::strictly_between;
use crate::terrain_cdt::TerrainCdtError;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

impl Cdt {
    /// Insertion reaches walk location, the exact-predicate cavity walk, and
    /// Lawson legalization; every potentially unbounded walk shares the
    /// caller's work/cancellation budget.
    pub(super) fn insert_point_with_progress(
        &mut self,
        vi: usize,
        progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
    ) -> Result<(), TerrainCdtError> {
        let p = self.points[vi];
        let start = match self.walk_strict_with_progress(self.last_loc, p, progress)? {
            Some(t) => t,
            None => match self.locate_with_progress(p, progress)? {
                Some(t) => t,
                None => return Ok(()),
            },
        };
        self.insert_point_at_with_progress(vi, start, progress)
    }

    /// Insert with the containing triangle already located. The incremental
    /// refinement entry skips the O(T) `locate` scan by passing its walk seed.
    pub(super) fn insert_point_at_with_progress(
        &mut self,
        vi: usize,
        start: usize,
        progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
    ) -> Result<(), TerrainCdtError> {
        if self.failed {
            return Ok(());
        }
        let p = self.points[vi];
        let region = self.inside.get(start).copied().unwrap_or(false);

        // The constrained Bowyer-Watson cavity never crosses a constraint;
        // that preserves boundary/hole rings during insertion.
        let mut bad = Vec::new();
        let mut in_bad = BTreeSet::new();
        let mut queue = VecDeque::from([start]);
        let mut visited = BTreeSet::from([start]);
        while let Some(ti) = queue.pop_front() {
            progress()?;
            if !self.tris[ti].alive {
                continue;
            }
            let v = self.tris[ti].v;
            if in_circle_sign(self.points[v[0]], self.points[v[1]], self.points[v[2]], p) <= 0 {
                continue;
            }
            bad.push(ti);
            in_bad.insert(ti);
            for e in 0..3 {
                let a = v[e];
                let b = v[(e + 1) % 3];
                if self.cset.contains(&ekey(a, b)) {
                    continue;
                }
                let nb = self.tris[ti].n[e];
                if nb != NONE && visited.insert(nb) {
                    queue.push_back(nb);
                }
            }
        }
        if bad.is_empty() {
            self.split_at_with_progress(start, vi, progress)?;
            self.last_loc = self.tris.len() - 1;
            return Ok(());
        }

        let mut boundary = Vec::new();
        for &ti in &bad {
            progress()?;
            let v = self.tris[ti].v;
            for e in 0..3 {
                progress()?;
                let nb = self.tris[ti].n[e];
                if nb == NONE || !in_bad.contains(&nb) {
                    boundary.push((v[e], v[(e + 1) % 3], nb));
                }
            }
        }
        // Charge sorting before its non-interruptible standard-library call.
        for _ in 0..boundary.len().saturating_mul(boundary.len().ilog2() as usize + 1) {
            progress()?;
        }
        boundary.sort_unstable();

        if let Some(&(a, b, _)) = boundary.iter().find(|&&(a, b, _)| orient(self.points[a], self.points[b], p) == 0) {
            if strictly_between(self.points[a], self.points[b], p) {
                let mut on = None;
                for &ti in &bad {
                    progress()?;
                    if let Some(e) = self.tris[ti].edge_of(a, b) {
                        on = Some((ti, e));
                        break;
                    }
                }
                if let Some((ti, e)) = on {
                    self.split_on_edge_with_progress(ti, e, vi, progress)?;
                    self.last_loc = self.tris.len() - 1;
                }
            }
            return Ok(());
        }

        for &ti in &bad {
            progress()?;
            self.tris[ti].alive = false;
        }
        let mut owner = BTreeMap::new();
        let mut new_tris = Vec::with_capacity(boundary.len());
        for &(a, b, outside) in &boundary {
            progress()?;
            let ti = self.tris.len();
            self.tris.push(super::Tri { v: [a, b, vi], n: [NONE; 3], alive: true });
            self.inside.push(region);
            new_tris.push(ti);
            self.tris[ti].n[0] = outside;
            if outside != NONE {
                if let Some(e) = self.tris[outside].edge_of(a, b) {
                    self.tris[outside].n[e] = ti;
                }
            }
            self.link_internal(&mut owner, ekey(b, vi), ti, 1);
            self.link_internal(&mut owner, ekey(vi, a), ti, 2);
        }
        let mut stack = new_tris.iter().map(|&t| (t, 0usize)).collect();
        self.legalize_with_progress(&mut stack, progress)?;
        for t in new_tris {
            progress()?;
            self.track_tri(t);
        }
        self.last_loc = self.tris.len() - 1;
        Ok(())
    }
}
