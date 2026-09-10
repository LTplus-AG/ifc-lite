// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded opaque straight-edge fills. Unsupported paint refuses the whole page.
use super::{PdfVectorPaint, PreparedPdfVectorPage};
use ifc_lite_geometry::{boolean_2d_fixed_grid, BooleanOp2D, ContourFillRule, ContourSet, Ring2D};

pub(crate) struct FillShape {
    pub ordinal: u32,
    pub rgb: [f64; 3],
    pub rings: Vec<Ring2D>,
}
pub(crate) struct FillGeometry {
    pub shapes: Vec<FillShape>,
    pub grid_metres: f64,
    pub work: u64,
}
struct Budget {
    remaining: u64,
    vertices: usize,
}
impl Budget {
    fn charge(&mut self, count: u64) -> Result<(), String> {
        self.remaining = self
            .remaining
            .checked_sub(count)
            .ok_or("PDF fill composition exceeds shared work budget")?;
        Ok(())
    }
    fn overlay(
        &mut self,
        a: &[Ring2D],
        b: &[Ring2D],
        op: BooleanOp2D,
        rule: ContourFillRule,
        grid: f64,
    ) -> Result<ContourSet, String> {
        let n = a.iter().chain(b).map(Vec::len).sum::<usize>() as u64;
        // Precharge the worst pairwise edge intersections, not only observed
        // output; each uninterruptible native overlay has its own edge cap too.
        self.charge(
            n.checked_mul(n)
                .and_then(|n| n.checked_mul(16))
                .ok_or("PDF fill edge budget overflow")?
                .max(1),
        )?;
        let result = boolean_2d_fixed_grid(a, b, op, rule, grid)?;
        self.vertices = self
            .vertices
            .checked_add(result.rings.iter().map(Vec::len).sum::<usize>())
            .ok_or("PDF fill vertex budget overflow")?;
        if self.vertices > 16_384 {
            return Err("PDF fill composition exceeds cumulative vertex budget".into());
        }
        Ok(result)
    }
}
fn point(m: [f64; 6], p: [f64; 2]) -> Result<[f64; 2], String> {
    let q = [
        m[0] * p[0] + m[2] * p[1] + m[4],
        m[1] * p[0] + m[3] * p[1] + m[5],
    ];
    if q.iter().any(|v| !v.is_finite() || v.abs() > 1e8) {
        return Err("PDF fill coordinate exceeds finite metric range".into());
    }
    Ok(q)
}
fn rings(commands: &[f64], m: [f64; 6]) -> Result<Vec<Ring2D>, String> {
    let mut rings = vec![];
    let mut ring = vec![];
    let mut cursor = 0;
    while cursor < commands.len() {
        let op = commands[cursor];
        cursor += 1;
        match op as u8 {
            0 => {
                if !ring.is_empty() {
                    rings.push(std::mem::take(&mut ring));
                }
                ring.push(point(m, [commands[cursor], commands[cursor + 1]])?);
                cursor += 2;
            }
            1 => {
                ring.push(point(m, [commands[cursor], commands[cursor + 1]])?);
                cursor += 2;
            }
            4 => {
                if let Some(first) = ring.first().copied() {
                    rings.push(std::mem::take(&mut ring));
                    ring.push(first);
                }
            }
            _ => return Err("PDF fill-page creation does not yet support painted curves".into()),
        }
    }
    if !ring.is_empty() {
        rings.push(ring);
    }
    Ok(rings)
}
/// The fixed-grid output is a declared approximation. Grid error accumulates
/// through classification, clipping and paint-order booleans; reserve a grid
/// substantially finer than the requested tolerance for every possible pass.
pub(crate) fn compose(
    prepared: &PreparedPdfVectorPage,
    model_metres_from_pdf: [f64; 6],
) -> Result<FillGeometry, String> {
    if !prepared.state_qualified {
        return Err("PDF page contains unsupported painted content or graphics state; no partial annotation is created".into());
    }
    if prepared.paths.is_empty() || prepared.paths.len() > 128 {
        return Err("PDF fill-page creation requires 1..128 painted paths".into());
    }
    for path in &prepared.paths {
        if !matches!(
            path.paint,
            PdfVectorPaint::Fill | PdfVectorPaint::EvenOddFill
        ) {
            return Err(format!(
                "PDF operator {} paints a stroke; fill-page creation cannot publish partial output",
                path.operator_ordinal
            ));
        }
    }
    let grid = prepared.tolerance_metres / ((prepared.paths.len() * 4 + 4) as f64 * 16.);
    let mut budget = Budget {
        remaining: 4_000_000,
        vertices: 0,
    };
    let [x0, y0, x1, y1] = prepared.page_clip_pdf;
    let clip = vec![vec![
        point(model_metres_from_pdf, [x0, y0])?,
        point(model_metres_from_pdf, [x1, y0])?,
        point(model_metres_from_pdf, [x1, y1])?,
        point(model_metres_from_pdf, [x0, y1])?,
    ]];
    let mut occluded = ContourSet::default();
    let mut shapes = vec![];
    for path in prepared.paths.iter().rev() {
        budget.charge(path.commands.len() as u64)?;
        if path.commands.len() > 4096 {
            return Err("PDF fill path exceeds command budget".into());
        }
        let input = rings(&path.commands, path.state.model_metres_from_path)?;
        let rule = if path.paint == PdfVectorPaint::EvenOddFill {
            ContourFillRule::EvenOdd
        } else {
            ContourFillRule::NonZero
        };
        let classified = budget.overlay(&input, &[], BooleanOp2D::Union, rule, grid)?;
        let clipped = budget.overlay(
            &classified.rings,
            &clip,
            BooleanOp2D::Intersection,
            ContourFillRule::NonZero,
            grid,
        )?;
        let visible = budget.overlay(
            &clipped.rings,
            &occluded.rings,
            BooleanOp2D::Difference,
            ContourFillRule::NonZero,
            grid,
        )?;
        for i in 0..visible.shape_count() {
            let rings = visible.shape(i).ok_or("Missing PDF fill shape")?;
            if rings.len() > 64 || rings.iter().map(|r| r.len() + 1).sum::<usize>() > 2048 {
                return Err("PDF fill shape exceeds canonical annotation boundary budget".into());
            }
            shapes.push(FillShape {
                ordinal: path.operator_ordinal,
                rgb: path.state.fill_rgb,
                rings: rings.to_vec(),
            });
            if shapes.len() > 256 {
                return Err("PDF page exceeds 256 visible fill regions".into());
            }
        }
        occluded = budget.overlay(
            &occluded.rings,
            &clipped.rings,
            BooleanOp2D::Union,
            ContourFillRule::NonZero,
            grid,
        )?;
    }
    if shapes.is_empty() {
        return Err(
            "PDF page has no visible fill area after clipping and paint composition".into(),
        );
    }
    Ok(FillGeometry {
        shapes,
        grid_metres: grid,
        work: 4_000_000 - budget.remaining,
    })
}
