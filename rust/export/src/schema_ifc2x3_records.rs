// SPDX-License-Identifier: MPL-2.0
//! The records [`crate::schema_ifc2x3_placements`] reads, and where a grid
//! placement resolves to, by the geometry reader's rules
//! (`ifc_lite_geometry`'s `placement/grid.rs`): the intersection of the two
//! axes' chords, each shifted along its left normal by its offset, lifted by
//! the third offset, its +X turned towards a second intersection. Twin of the
//! `Records` class in `packages/export/src/schema-ifc2x3-placements.ts`.

use std::collections::HashMap;

use crate::step_log::format_step_real;
use crate::step_record_frame::{record_frame, record_head};
use crate::step_slot::slots_of;

pub(crate) const LOCAL: &str = "IFCLOCALPLACEMENT";
pub(crate) const GRID_PLACEMENT: &str = "IFCGRIDPLACEMENT";
pub(crate) const INTERSECTION: &str = "IFCVIRTUALGRIDINTERSECTION";
/// `IfcProduct.ObjectPlacement`, the same slot on every IFC2X3 product.
pub(crate) const OBJECT_PLACEMENT: usize = 5;
/// IfcGrid's `UAxes`, `VAxes`, `WAxes`.
const GRID_AXIS_SLOTS: [usize; 3] = [7, 8, 9];
/// The reader's tolerance for a degenerate axis, direction or crossing.
const EPS: f64 = 1e-9;

pub(crate) struct Rec<'a> {
    pub(crate) id: u32,
    pub(crate) ty: String,
    pub(crate) text: &'a str,
    pub(crate) open: usize,
    pub(crate) start: usize,
}

/// A grid placement's frame in its grid's: where it is, and the +X turn, if any.
pub(crate) struct GridFrame {
    pub(crate) at: [f64; 3],
    pub(crate) turn: Option<[f64; 2]>,
}

pub(crate) fn ref_id(token: Option<&str>) -> Option<u32> {
    token?.trim().strip_prefix('#')?.trim().parse().ok()
}

pub(crate) fn num(token: &str) -> Option<f64> {
    let t = token.trim();
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'-' | b'+')));
    let digits = |i: &mut usize| {
        let from = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - from
    };
    let int = digits(&mut i);
    let frac = if b.get(i) == Some(&b'.') {
        i += 1;
        digits(&mut i)
    } else if int == 0 {
        return None;
    } else {
        0
    };
    if int == 0 && frac == 0 {
        return None;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        i += usize::from(matches!(b.get(i), Some(b'-' | b'+')));
        if digits(&mut i) == 0 {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

pub(crate) fn list(token: Option<&str>) -> Option<Vec<&str>> {
    let inner = token?.trim().strip_prefix('(')?.strip_suffix(')')?;
    slots_of(inner)
}

pub(crate) fn numbers(token: Option<&str>, min: usize, max: usize) -> Option<Vec<f64>> {
    let items = list(token)?;
    if items.len() < min || items.len() > max {
        return None;
    }
    items.iter().map(|m| num(m)).collect()
}

pub(crate) fn triple(v: &[f64]) -> String {
    format!("({})", v.iter().map(|x| format_step_real(*x)).collect::<Vec<_>>().join(","))
}

pub(crate) fn is_dollar(token: &str) -> bool {
    token.trim() == "$"
}

pub(crate) struct Records<'a> {
    pub(crate) list: Vec<Option<Rec<'a>>>,
    by_id: HashMap<u32, usize>,
    pub(crate) max_id: u32,
}

impl<'a> Records<'a> {
    pub(crate) fn scan(body: &'a str) -> Self {
        let mut records = Records { list: Vec::new(), by_id: HashMap::new(), max_id: 0 };
        let mut scanner = ifc_lite_core::EntityScanner::new(body.as_bytes());
        while let Some((id, _, start, end)) = scanner.next_entity() {
            let text = &body[start..end];
            let rec = record_head(text).map(|head| Rec {
                id,
                ty: head.type_name(text).to_ascii_uppercase(),
                text,
                open: head.open,
                start,
            });
            if let Some(rec) = &rec {
                records.by_id.insert(rec.id, records.list.len());
                records.max_id = records.max_id.max(rec.id);
            }
            records.list.push(rec);
        }
        records
    }

    pub(crate) fn get(&self, id: Option<u32>, ty: Option<&str>) -> Option<&Rec<'a>> {
        let rec = self.list[*self.by_id.get(&id?)?].as_ref()?;
        ty.is_none_or(|t| rec.ty == t).then_some(rec)
    }

    pub(crate) fn slots(rec: Option<&Rec<'a>>) -> Option<Vec<&'a str>> {
        let text = rec?.text;
        let frame = record_frame(text)?;
        slots_of(&text[frame.head.open + 1..frame.close])
    }

    /// The coordinates of a point or the ratios of a direction, by reference.
    pub(crate) fn vector(&self, token: Option<&str>, ty: &str) -> Option<Vec<f64>> {
        let slots = Self::slots(self.get(ref_id(token), Some(ty)))?;
        numbers(slots.first().copied(), 2, 3)
    }

    /// An axis's chord, with its sense, as origin and direction; `None` when
    /// `straight` and the polyline bends.
    fn axis_line(&self, id: u32, straight: bool) -> Option<([f64; 2], [f64; 2])> {
        let axis = Self::slots(self.get(Some(id), Some("IFCGRIDAXIS")))?;
        let curve = Self::slots(self.get(ref_id(axis.get(1).copied()), Some("IFCPOLYLINE")))?;
        let points = list(curve.first().copied())?;
        if points.len() < 2 || (straight && points.len() != 2) {
            return None;
        }
        let a = self.vector(points.first().copied(), "IFCCARTESIANPOINT")?;
        let b = self.vector(points.last().copied(), "IFCCARTESIANPOINT")?;
        let mut d = [b[0] - a[0], b[1] - a[1]];
        if (d[0] * d[0] + d[1] * d[1]).sqrt() < EPS {
            return None;
        }
        if axis.get(2).is_some_and(|s| s.trim().eq_ignore_ascii_case(".F.")) {
            d = [-d[0], -d[1]];
        }
        Some(([a[0], a[1]], d))
    }

    /// An intersection's point in its grid's frame, as the geometry reader
    /// takes it (each axis by its chord).
    pub(crate) fn crossing(&self, id: Option<u32>) -> Option<[f64; 3]> {
        self.crossing_on(id, false)
    }

    /// [`Self::crossing`], and with `straight` also `None` when an axis bends,
    /// where another reader may follow the bend.
    fn crossing_on(&self, id: Option<u32>, straight: bool) -> Option<[f64; 3]> {
        let s = Self::slots(self.get(id, Some(INTERSECTION)))?;
        let axes: Vec<Option<u32>> = list(s.first().copied())?.into_iter().map(|m| ref_id(Some(m))).collect();
        if axes.len() != 2 || axes.contains(&None) {
            return None;
        }
        let offsets = match s.get(1) {
            Some(o) if is_dollar(o) => vec![0.0, 0.0],
            o => numbers(o.copied(), 2, 3)?,
        };
        let (ao, ad) = self.axis_line(axes[0]?, straight)?;
        let (bo, bd) = self.axis_line(axes[1]?, straight)?;
        let shifted = |o: [f64; 2], d: [f64; 2], by: f64| {
            let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
            [o[0] + (-d[1] / len) * by, o[1] + (d[0] / len) * by]
        };
        let pa = shifted(ao, ad, offsets[0]);
        let pb = shifted(bo, bd, offsets[1]);
        let denom = ad[0] * bd[1] - ad[1] * bd[0];
        if denom.abs() < EPS {
            return None;
        }
        let t = ((pb[0] - pa[0]) * bd[1] - (pb[1] - pa[1]) * bd[0]) / denom;
        Some([pa[0] + t * ad[0], pa[1] + t * ad[1], offsets.get(2).copied().unwrap_or(0.0)])
    }

    /// Where a grid placement (IFC2X3 layout) sits in its grid's frame, to
    /// write as a plain position: `None` over a bent axis, left as it was.
    pub(crate) fn grid_frame(&self, g: &[&str]) -> Option<GridFrame> {
        let at = self.crossing_on(ref_id(Some(g[0])), true)?;
        if is_dollar(g[1]) {
            return Some(GridFrame { at, turn: None });
        }
        let v = match self.crossing_on(ref_id(Some(g[1])), true) {
            Some(toward) => vec![toward[0] - at[0], toward[1] - at[1]],
            None => self.vector(Some(g[1]), "IFCDIRECTION")?,
        };
        let norm = (v[0] * v[0] + v[1] * v[1]).sqrt();
        if !norm.is_finite() {
            return None;
        }
        Some(GridFrame { at, turn: (norm >= EPS).then(|| [v[0] / norm, v[1] / norm]) })
    }

    /// The `ObjectPlacement` of the first grid listing an axis of the intersection.
    pub(crate) fn grid_placement_of(&self, intersection: Option<u32>) -> String {
        let axis = Self::slots(self.get(intersection, Some(INTERSECTION)))
            .and_then(|s| list(s.first().copied()))
            .and_then(|axes| ref_id(axes.first().copied()));
        for rec in self.list.iter().flatten().filter(|r| r.ty == "IFCGRID") {
            let Some(s) = Self::slots(Some(rec)) else { continue };
            let lists = |i: &usize| list(s.get(*i).copied()).is_some_and(|m| m.iter().any(|t| ref_id(Some(t)) == axis));
            if axis.is_some() && GRID_AXIS_SLOTS.iter().any(lists) {
                return ref_id(s.get(OBJECT_PLACEMENT).copied()).map_or("$".to_string(), |p| format!("#{p}"));
            }
        }
        "$".to_string()
    }
}
