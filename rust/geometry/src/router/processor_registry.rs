// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Router-local processors, initialized only for representation families used.
//! Custom registrations retain the public per-type replacement contract.

use super::GeometryProcessor;
use crate::processors::{
    AdvancedBrepProcessor, BSplineSurfaceProcessor, BlockProcessor, BooleanClippingProcessor,
    CsgSolidProcessor, ExtrudedAreaSolidProcessor, ExtrudedAreaSolidTaperedProcessor,
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, IfcAlignmentProcessor,
    PolygonalFaceSetProcessor, RevolvedAreaSolidProcessor, SectionedSolidHorizontalProcessor,
    ShellBasedSurfaceModelProcessor, SphereProcessor, SurfaceCurveSweptAreaSolidProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
use ifc_lite_core::{IfcSchema, IfcType};
use std::cell::OnceCell;
use std::collections::HashMap;
use std::rc::Rc;

const TYPES: [&[IfcType]; 18] = [
    &[IfcType::IfcExtrudedAreaSolid],
    &[IfcType::IfcExtrudedAreaSolidTapered],
    &[IfcType::IfcTriangulatedFaceSet, IfcType::IfcTriangulatedIrregularNetwork],
    &[IfcType::IfcPolygonalFaceSet],
    &[IfcType::IfcFacetedBrep],
    &[IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult],
    &[IfcType::IfcSweptDiskSolid],
    &[IfcType::IfcRevolvedAreaSolid],
    &[IfcType::IfcSurfaceCurveSweptAreaSolid, IfcType::IfcFixedReferenceSweptAreaSolid],
    &[IfcType::IfcSectionedSolidHorizontal],
    &[IfcType::IfcAdvancedBrep, IfcType::IfcAdvancedBrepWithVoids],
    &[IfcType::IfcBSplineSurfaceWithKnots, IfcType::IfcRationalBSplineSurfaceWithKnots],
    &[IfcType::IfcShellBasedSurfaceModel],
    &[IfcType::IfcFaceBasedSurfaceModel],
    &[IfcType::IfcBlock],
    &[IfcType::IfcSphere],
    &[IfcType::IfcCsgSolid],
    &[IfcType::IfcAlignment],
];

fn slot(ifc_type: IfcType) -> Option<usize> {
    Some(match ifc_type {
        IfcType::IfcExtrudedAreaSolid => 0,
        IfcType::IfcExtrudedAreaSolidTapered => 1,
        IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork => 2,
        IfcType::IfcPolygonalFaceSet => 3,
        IfcType::IfcFacetedBrep => 4,
        IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => 5,
        IfcType::IfcSweptDiskSolid => 6,
        IfcType::IfcRevolvedAreaSolid => 7,
        IfcType::IfcSurfaceCurveSweptAreaSolid | IfcType::IfcFixedReferenceSweptAreaSolid => 8,
        IfcType::IfcSectionedSolidHorizontal => 9,
        IfcType::IfcAdvancedBrep | IfcType::IfcAdvancedBrepWithVoids => 10,
        IfcType::IfcBSplineSurfaceWithKnots | IfcType::IfcRationalBSplineSurfaceWithKnots => 11,
        IfcType::IfcShellBasedSurfaceModel => 12,
        IfcType::IfcFaceBasedSurfaceModel => 13,
        IfcType::IfcBlock => 14,
        IfcType::IfcSphere => 15,
        IfcType::IfcCsgSolid => 16,
        IfcType::IfcAlignment => 17,
        _ => return None,
    })
}

fn create(index: usize, schema: &IfcSchema) -> Rc<dyn GeometryProcessor> {
    match index {
        0 => Rc::new(ExtrudedAreaSolidProcessor::new(schema.clone())),
        1 => Rc::new(ExtrudedAreaSolidTaperedProcessor::new(schema.clone())),
        2 => Rc::new(TriangulatedFaceSetProcessor::new()),
        3 => Rc::new(PolygonalFaceSetProcessor::new()),
        4 => Rc::new(FacetedBrepProcessor::new()),
        5 => Rc::new(BooleanClippingProcessor::new()),
        6 => Rc::new(SweptDiskSolidProcessor::new(schema.clone())),
        7 => Rc::new(RevolvedAreaSolidProcessor::new(schema.clone())),
        8 => Rc::new(SurfaceCurveSweptAreaSolidProcessor::new(schema.clone())),
        9 => Rc::new(SectionedSolidHorizontalProcessor::new(schema.clone())),
        10 => Rc::new(AdvancedBrepProcessor::new()),
        11 => Rc::new(BSplineSurfaceProcessor::new()),
        12 => Rc::new(ShellBasedSurfaceModelProcessor::new()),
        13 => Rc::new(FaceBasedSurfaceModelProcessor::new()),
        14 => Rc::new(BlockProcessor::new()),
        15 => Rc::new(SphereProcessor::new()),
        16 => Rc::new(CsgSolidProcessor::new()),
        17 => Rc::new(IfcAlignmentProcessor::new()),
        _ => unreachable!("built-in processor slot"),
    }
}

pub(super) struct ProcessorRegistry {
    defaults: [OnceCell<Rc<dyn GeometryProcessor>>; TYPES.len()],
    overrides: HashMap<IfcType, Rc<dyn GeometryProcessor>>,
}

impl ProcessorRegistry {
    pub(super) fn new() -> Self {
        Self {
            defaults: std::array::from_fn(|_| OnceCell::new()),
            overrides: HashMap::new(),
        }
    }

    pub(super) fn get(&self, ifc_type: &IfcType, schema: &IfcSchema) -> Option<&Rc<dyn GeometryProcessor>> {
        if let Some(processor) = self.overrides.get(ifc_type) {
            return Some(processor);
        }
        let index = slot(*ifc_type)?;
        Some(self.defaults[index].get_or_init(|| create(index, schema)))
    }

    pub(super) fn insert(&mut self, ifc_type: IfcType, processor: Rc<dyn GeometryProcessor>) {
        self.overrides.insert(ifc_type, processor);
        if let Some(index) = slot(ifc_type) {
            // Match eager map replacement: an instance loses its failure log
            // and allocation when its last supported type is overridden.
            if TYPES[index].iter().all(|t| self.overrides.contains_key(t)) {
                self.defaults[index].take();
            }
        }
    }

    pub(super) fn values(&self) -> impl Iterator<Item = &Rc<dyn GeometryProcessor>> {
        // Draining must not initialize unused processors. Multi-type built-ins
        // share one cell and are drained once; custom aliases share an Rc as
        // before (subsequent visits drain an empty log).
        self.overrides.values().chain(self.defaults.iter().filter_map(OnceCell::get))
    }
}

#[cfg(test)]
#[path = "processor_registry_tests.rs"]
mod tests;
