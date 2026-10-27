// SPDX-License-Identifier: MPL-2.0
//! Independent source authority for bounded mapped Boolean prism trees (#7955).
//! Uses only STEP decoding and M3's exact line/arc clipping integrals.
use super::{
    clipping::{clipped_area, convex_planes},
    math::*,
};
#[path = "mapped_source.rs"]
mod source;
use ifc_lite_core::{EntityDecoder, IfcType, SourceBundle};
use source::{Frame, Leaf};
use std::collections::BTreeMap;

#[derive(Debug)]
pub struct MappedExpectation {
    pub volume: f64,
    pub bbox: [f64; 6],
    pub curved: bool,
    pub parts: usize,
}
struct Tree {
    // Boolean indicators are multilinear polynomials: A union B=A+B-AB,
    // A minus B=A-AB, A intersection B=AB. A repeated leaf is idempotent.
    terms: BTreeMap<u8, i32>,
    bbox: [f64; 6],
}
struct Walk<'a, 'b> {
    decoder: &'a mut EntityDecoder<'b>,
    leaves: Vec<Leaf>,
    work: usize,
}
impl Walk<'_, '_> {
    fn item(&mut self, id: u32, frame: &Frame, depth: usize, map_depth: usize) -> Option<Tree> {
        self.work = self.work.checked_sub(1)?;
        if depth > 3 || map_depth > 8 {
            return None;
        }
        let e = self.decoder.decode_by_id(id).ok()?;
        match e.ifc_type {
            IfcType::IfcMappedItem => {
                let (mapping, items) = source::mapping(self.decoder, e.get_ref(0)?, e.get_ref(1)?)?;
                if items.len() != 1 {
                    return None;
                }
                self.item(items[0], &multiply(frame, &mapping), depth, map_depth + 1)
            }
            IfcType::IfcCsgSolid => self.item(e.get_ref(0)?, frame, depth, map_depth + 1),
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                let a = self.item(e.get_ref(1)?, frame, depth + 1, map_depth)?;
                let b = self.item(e.get_ref(2)?, frame, depth + 1, map_depth)?;
                let mut terms = BTreeMap::new();
                let op = e.get(0)?.as_enum()?;
                let sign = match op {
                    "INTERSECTION" => 1,
                    "UNION" | "DIFFERENCE" => -1,
                    _ => return None,
                };
                if op != "INTERSECTION" {
                    terms.extend(a.terms.iter().map(|(k, v)| (*k, *v)));
                }
                if op == "UNION" {
                    for (k, v) in &b.terms {
                        *terms.entry(*k).or_default() += v;
                    }
                }
                for (ka, va) in a.terms {
                    for (kb, vb) in &b.terms {
                        *terms.entry(ka | kb).or_default() += sign * va * vb;
                    }
                }
                let mut bbox = a.bbox;
                if op == "UNION" {
                    extend_bbox(&mut bbox, b.bbox[..3].try_into().ok()?);
                    extend_bbox(&mut bbox, b.bbox[3..].try_into().ok()?);
                }
                Some(Tree { terms, bbox })
            }
            IfcType::IfcExtrudedAreaSolid => {
                if self.leaves.len() == 8 {
                    return None;
                }
                let leaf = source::leaf(self.decoder, id, frame)?;
                if !leaf.curved {
                    convex_planes(&leaf.edges)?;
                }
                let tree = Tree {
                    terms: BTreeMap::from([(1 << self.leaves.len(), 1)]),
                    bbox: leaf.bbox,
                };
                self.leaves.push(leaf);
                Some(tree)
            }
            _ => None,
        }
    }
    fn volume(&self, tree: &Tree) -> Option<f64> {
        let mut result = 0.;
        let mut work = 100_000;
        for (&mask, &coefficient) in &tree.terms {
            if coefficient == 0 {
                continue;
            }
            let active: Vec<_> = self
                .leaves
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, p)| p)
                .collect();
            let low = active
                .iter()
                .map(|p| p.low)
                .fold(f64::NEG_INFINITY, f64::max);
            let high = active.iter().map(|p| p.high).fold(f64::INFINITY, f64::min);
            if high <= low {
                continue;
            }
            // One circular boundary can be clipped by any number of convex
            // polygons. Multiple circular leaves are deliberately unsupported.
            if active.iter().filter(|p| p.curved).count() > 1 {
                return None;
            }
            let boundary = active.iter().position(|p| p.curved).unwrap_or(0);
            let mut planes = Vec::new();
            for (i, p) in active.iter().enumerate() {
                if i != boundary {
                    planes.extend(convex_planes(&p.edges)?);
                }
            }
            result += f64::from(coefficient)
                * (high - low)
                * clipped_area(&active[boundary].edges, &planes, &mut work)?;
        }
        (result.is_finite() && result >= -1e-10).then_some(result.max(0.))
    }
}
/// Metre-based synthetic fixtures only. Unsupported source trees return None,
/// never a fabricated zero. Product placement is applied after map-space volume
/// integration, preserving small cuts at survey coordinates.
pub fn expected(bytes: &[u8], product: u32) -> Option<MappedExpectation> {
    let bundle = SourceBundle::new(bytes.to_vec());
    let mut decoder = bundle.decoder();
    let e = decoder.decode_by_id(product).ok()?;
    let world = source::placement(&mut decoder, e.get_ref(5))?;
    let shape = decoder.decode_by_id(e.get_ref(6)?).ok()?;
    let mut result = MappedExpectation {
        volume: 0.,
        bbox: [
            f64::INFINITY,
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        curved: false,
        parts: 0,
    };
    for id in shape.get_refs(2)? {
        let rep = decoder.decode_by_id(id).ok()?;
        if rep.get_string(1) != Some("Body") {
            continue;
        }
        for item in rep.get_refs(3)? {
            let mut walk = Walk {
                decoder: &mut decoder,
                leaves: Vec::new(),
                work: 256,
            };
            let tree = walk.item(item, &IDENTITY, 0, 0)?;
            result.volume += walk.volume(&tree)?;
            result.curved |= walk.leaves.iter().any(|p| p.curved);
            result.parts += 1;
            for i in 0..8 {
                extend_bbox(
                    &mut result.bbox,
                    transform(
                        &world,
                        std::array::from_fn(|axis| {
                            tree.bbox[axis + if i & (1 << axis) == 0 { 0 } else { 3 }]
                        }),
                    ),
                );
            }
        }
    }
    // Local placements are rigid; mapping determinants already act on leaf
    // cross-sections and heights (uniform s gives area s², height |s|).
    (result.parts > 0).then_some(result)
}
