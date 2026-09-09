// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Aggregate limits include repeated references to shared source coordinate lists.
pub(super) const MAX_COORDINATE_ROWS: usize = 1_000_000;
pub(super) const BUDGET_ERROR: &str = "Appearance plan exceeds its geometry/output budget. Choose fewer objects or simplify the source mesh.";
#[derive(Default)]
pub(super) struct PlanBudget {
    points: usize,
    corners: usize,
    uvs: usize,
    items: usize,
    pub exhausted: bool,
}
impl PlanBudget {
    pub fn reserve(&mut self, points: usize, triangles: usize, uvs: usize) -> Result<(), String> {
        let acceptable = points <= MAX_COORDINATE_ROWS
            && self.points.checked_add(points).is_some_and(|v| v <= 2_000_000)
            && triangles.checked_mul(3).and_then(|v| self.corners.checked_add(v)).is_some_and(|v| v <= 1_500_000)
            && self.uvs.checked_add(uvs).is_some_and(|v| v <= 500_000)
            && self.items < 10_000;
        if !acceptable { self.exhausted = true; return Err(BUDGET_ERROR.into()); }
        self.points += points;
        self.corners += triangles * 3;
        self.uvs += uvs;
        self.items += 1;
        Ok(())
    }
}
