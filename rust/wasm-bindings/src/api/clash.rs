// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM surface for the clash kernel.
//!
//! Thin wrapper over `ifc_lite_clash::ClashSession`. The JS<->WASM contract is
//! deliberately pure numeric arrays: selection, exclusions, severity and
//! identity all live in the TypeScript orchestrator, so this layer only ingests
//! geometry and runs one rule's broad + narrow phase at a time.

use ifc_lite_clash::ClashSession as CoreSession;
use wasm_bindgen::prelude::*;

/// A clash session: ingest element geometry once, then run rules repeatedly.
#[wasm_bindgen]
pub struct ClashSession {
    inner: CoreSession,
}

#[wasm_bindgen]
impl ClashSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CoreSession::new(),
        }
    }

    /// Ingest N elements from flat arenas.
    ///
    /// - `positions`: concatenated per-element vertex coords (x,y,z,...)
    /// - `pos_ranges`: 2 per element = [float_offset, float_len]
    /// - `indices`: concatenated per-element LOCAL (0-based) triangle indices
    /// - `idx_ranges`: 2 per element = [idx_offset, idx_len]
    /// - `aabbs`: 6 per element = [minx,miny,minz,maxx,maxy,maxz]
    #[wasm_bindgen]
    pub fn ingest(
        &mut self,
        positions: &[f32],
        pos_ranges: &[u32],
        indices: &[u32],
        idx_ranges: &[u32],
        aabbs: &[f32],
    ) {
        self.inner
            .ingest(positions, pos_ranges, indices, idx_ranges, aabbs);
    }

    /// Run one rule. `group_a`/`group_b` are GLOBAL element indices; an empty
    /// `group_b` means a self-clash within `group_a`. `mode`: 0 = hard,
    /// 1 = clearance. Records carry GLOBAL element indices.
    #[wasm_bindgen(js_name = runRule)]
    pub fn run_rule(
        &self,
        group_a: &[u32],
        group_b: &[u32],
        mode: u8,
        tolerance: f64,
        clearance: f64,
        report_touch: bool,
    ) -> ClashRunResult {
        let result =
            self.inner
                .run_rule(group_a, group_b, mode, tolerance, clearance, report_touch);

        let n = result.records.len();
        let mut a = Vec::with_capacity(n);
        let mut b = Vec::with_capacity(n);
        let mut status = Vec::with_capacity(n);
        let mut distance = Vec::with_capacity(n);
        let mut points = Vec::with_capacity(n * 3);
        let mut bounds = Vec::with_capacity(n * 6);

        for record in &result.records {
            a.push(record.a);
            b.push(record.b);
            status.push(record.status as u8);
            distance.push(record.distance);
            points.extend_from_slice(&record.point);
            bounds.extend_from_slice(&record.bounds);
        }

        ClashRunResult {
            a,
            b,
            status,
            distance,
            points,
            bounds,
        }
    }
}

impl Default for ClashSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Packed result of one rule run. Parallel arrays, one entry per clash record;
/// `points` has 3 per record and `bounds` has 6 per record.
#[wasm_bindgen]
pub struct ClashRunResult {
    a: Vec<u32>,
    b: Vec<u32>,
    status: Vec<u8>,
    distance: Vec<f64>,
    points: Vec<f64>,
    bounds: Vec<f64>,
}

#[wasm_bindgen]
impl ClashRunResult {
    #[wasm_bindgen(getter)]
    pub fn a(&self) -> Vec<u32> {
        self.a.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn b(&self) -> Vec<u32> {
        self.b.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn status(&self) -> Vec<u8> {
        self.status.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn distance(&self) -> Vec<f64> {
        self.distance.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn points(&self) -> Vec<f64> {
        self.points.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn bounds(&self) -> Vec<f64> {
        self.bounds.clone()
    }
}
