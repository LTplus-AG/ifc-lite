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
    IfcEdgeProcessor, IfcFaceSurfaceProcessor, PolygonalFaceSetProcessor,
    RevolvedAreaSolidProcessor, SectionedSolidHorizontalProcessor,
    ShellBasedSurfaceModelProcessor, SphereProcessor,
    SurfaceCurveSweptAreaSolidProcessor, SurfaceOfLinearExtrusionProcessor, SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
use ifc_lite_core::{IfcSchema, IfcType};
use std::cell::OnceCell;
use std::collections::HashMap;
use std::rc::Rc;

// One declaration owns alias membership, typed family identity and construction.
macro_rules! processor_families {
    ($schema:ident; $( $family:ident => [$($ifc_type:ident),+] => $constructor:expr; )+) => {
        /// Built-in construction semantics. A custom processor registration does
        /// not inherit these semantics merely by advertising the same IFC type.
        #[non_exhaustive]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
        #[serde(rename_all = "snake_case")]
        #[repr(usize)]
        pub enum ConstructionFamily { $( $family, )+ }
        const FAMILIES: &[ConstructionFamily] = &[$(ConstructionFamily::$family),+];
        pub(super) const TYPES: [&[IfcType]; FAMILIES.len()] = [
            $(&[$(IfcType::$ifc_type),+]),+
        ];
        pub(crate) fn builtin_family(ifc_type: &IfcType) -> Option<ConstructionFamily> {
            Some(match ifc_type {
                $($(IfcType::$ifc_type)|+ => ConstructionFamily::$family,)+
                _ => return None,
            })
        }
        fn create(index: usize, $schema: &IfcSchema) -> Rc<dyn GeometryProcessor> {
            match FAMILIES[index] { $(ConstructionFamily::$family => Rc::new($constructor),)+ }
        }
    };
}

processor_families! { schema;
    Extrusion => [IfcExtrudedAreaSolid] => ExtrudedAreaSolidProcessor::new(schema.clone());
    TaperedExtrusion => [IfcExtrudedAreaSolidTapered] => ExtrudedAreaSolidTaperedProcessor::new(schema.clone());
    TriangulatedFaceSet => [IfcTriangulatedFaceSet, IfcTriangulatedIrregularNetwork] => TriangulatedFaceSetProcessor::new();
    PolygonalFaceSet => [IfcPolygonalFaceSet] => PolygonalFaceSetProcessor::new();
    // WithVoids adds only `Voids` after the shared Outer (#7688 PROC-S6).
    FacetedBrep => [IfcFacetedBrep, IfcFacetedBrepWithVoids] => FacetedBrepProcessor::new();
    Boolean => [IfcBooleanResult, IfcBooleanClippingResult] => BooleanClippingProcessor::new();
    SweptDisk => [IfcSweptDiskSolid] => SweptDiskSolidProcessor::new(schema.clone());
    RevolvedAreaSolid => [IfcRevolvedAreaSolid] => RevolvedAreaSolidProcessor::new(schema.clone());
    SweptArea => [IfcSurfaceCurveSweptAreaSolid, IfcFixedReferenceSweptAreaSolid] => SurfaceCurveSweptAreaSolidProcessor::new(schema.clone());
    SectionedSolid => [IfcSectionedSolidHorizontal] => SectionedSolidHorizontalProcessor::new(schema.clone());
    AdvancedBrep => [IfcAdvancedBrep, IfcAdvancedBrepWithVoids] => AdvancedBrepProcessor::new();
    BSplineSurface => [IfcBSplineSurfaceWithKnots, IfcRationalBSplineSurfaceWithKnots] => BSplineSurfaceProcessor::new();
    ShellSurfaceModel => [IfcShellBasedSurfaceModel] => ShellBasedSurfaceModelProcessor::new();
    FaceSurfaceModel => [IfcFaceBasedSurfaceModel] => FaceBasedSurfaceModelProcessor::new();
    Block => [IfcBlock] => BlockProcessor::new();
    Sphere => [IfcSphere] => SphereProcessor::new();
    CsgSolid => [IfcCsgSolid] => CsgSolidProcessor::new();
    Alignment => [IfcAlignment] => IfcAlignmentProcessor::new();
    Edge => [IfcEdge, IfcEdgeCurve, IfcOrientedEdge] => IfcEdgeProcessor::new();
    FaceSurface => [IfcFaceSurface, IfcAdvancedFace] => IfcFaceSurfaceProcessor::new();
    // Documented and exported, but never registered before #7688 (PROC-S6).
    LinearExtrusionSurface => [IfcSurfaceOfLinearExtrusion] => SurfaceOfLinearExtrusionProcessor::new();
}

fn slot(ifc_type: IfcType) -> Option<usize> {
    builtin_family(&ifc_type).map(|family| family as usize)
}

/// How a registered processor entered the router; planning may only assume
/// built-in semantics for the first two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessorOrigin { Builtin, ConfiguredBuiltin, Custom }

struct RegisteredProcessor {
    processor: Rc<dyn GeometryProcessor>,
    origin: ProcessorOrigin,
}

/// One FRESH built-in processor for `ifc_type`, or `None` when no built-in
/// meshes that type.
///
/// This is the single "what can the engine mesh" table. The router's lazy
/// registry below caches one instance per slot; the boolean operand path
/// (`BooleanClippingProcessor::process_operand_checked`) builds a transient
/// one per operand instead, exactly as it always constructed its leaf
/// processors by hand. Before #4560 that path kept its OWN six-arm copy of
/// this table, so every built-in it forgot — `IfcPolygonalFaceSet` first of
/// all, the cutter Bonsai/IfcOpenShell emits for a wall clipped by a roof —
/// meshed empty as an operand and the host rendered un-cut.
pub(crate) fn builtin_processor(
    ifc_type: IfcType,
    schema: &IfcSchema,
) -> Option<Rc<dyn GeometryProcessor>> {
    slot(ifc_type).map(|index| create(index, schema))
}

pub(super) struct ProcessorRegistry {
    defaults: [OnceCell<Rc<dyn GeometryProcessor>>; TYPES.len()],
    overrides: HashMap<IfcType, RegisteredProcessor>,
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
            return Some(&processor.processor);
        }
        let index = slot(ifc_type.clone())?;
        Some(self.defaults[index].get_or_init(|| create(index, schema)))
    }

    pub(super) fn insert(&mut self, ifc_type: IfcType, processor: Rc<dyn GeometryProcessor>, origin: ProcessorOrigin) {
        self.overrides.insert(ifc_type.clone(), RegisteredProcessor { processor, origin });
        if let Some(index) = slot(ifc_type) {
            // Match eager map replacement: an instance loses its failure log
            // and allocation when its last supported type is overridden.
            if TYPES[index].iter().all(|t| self.overrides.contains_key(t)) {
                self.defaults[index].take();
            }
        }
    }

    pub(super) fn origin(&self, ifc_type: &IfcType) -> Option<ProcessorOrigin> {
        self.overrides.get(ifc_type).map(|entry| entry.origin)
            .or_else(|| builtin_family(ifc_type).map(|_| ProcessorOrigin::Builtin))
    }

    pub(super) fn values(&self) -> impl Iterator<Item = &Rc<dyn GeometryProcessor>> {
        // Draining must not initialize unused processors. Multi-type built-ins
        // share one cell and are drained once; custom aliases share an Rc as
        // before (subsequent visits drain an empty log).
        self.overrides.values().map(|entry| &entry.processor).chain(self.defaults.iter().filter_map(OnceCell::get))
    }
}
#[cfg(test)]
mod typed_family_tests {
    use super::*;
    use crate::GeometryRouter;

    #[test]
    fn family_aliases_match_the_processors_actual_dispatch_contract() {
        let schema = IfcSchema::new();
        let mut seen = std::collections::HashSet::new();
        for (index, types) in TYPES.iter().enumerate() {
            let processor = create(index, &schema);
            let supported = processor.supported_types();
            for ifc_type in *types {
                assert!(seen.insert(ifc_type.clone()), "an alias cannot belong to two families");
                assert_eq!(builtin_family(ifc_type), Some(FAMILIES[index]));
                assert!(supported.contains(ifc_type), "family advertises a type its processor cannot execute");
            }
            for ifc_type in supported {
                assert!(types.contains(&ifc_type), "processor type missing from typed family");
            }
        }
        assert_eq!(builtin_family(&IfcType::IfcWall), None);
    }

    #[test]
    fn metadata_queries_do_not_initialize_or_drain_processors() {
        let registry = ProcessorRegistry::new();
        assert_eq!(registry.origin(&IfcType::IfcBlock), Some(ProcessorOrigin::Builtin));
        assert_eq!(registry.origin(&IfcType::IfcWall), None);
        assert_eq!(registry.values().count(), 0, "metadata-only planning must preserve lazy construction");
        let schema = IfcSchema::new();
        registry.get(&IfcType::IfcBlock, &schema).unwrap();
        assert_eq!(registry.values().count(), 1);
        assert_eq!(registry.origin(&IfcType::IfcBlock), Some(ProcessorOrigin::Builtin));
        assert_eq!(registry.values().count(), 1);
    }

    #[test]
    fn configured_builtins_and_public_overrides_keep_distinct_origins() {
        let mut router = GeometryRouter::new();
        assert_eq!(router.processor_origin(&IfcType::IfcBooleanResult), Some(ProcessorOrigin::Builtin));
        router.register(Box::new(BlockProcessor::new()));
        // The same implementation registered publicly is a custom contract;
        // planning may not assume the caller's replacement has built-in semantics.
        assert_eq!(router.processor_origin(&IfcType::IfcBlock), Some(ProcessorOrigin::Custom));
        let source = "#1=IFCBLOCK($,2.,3.,4.);";
        let mut decoder = ifc_lite_core::EntityDecoder::new(source);
        let entity = decoder.decode_by_id(1).unwrap();
        let mesh = router.process_representation_item(&entity, &mut decoder).unwrap();
        assert!(!mesh.is_empty(), "origin tracking must preserve public dispatch");
        router.set_skip_small_cuts(true);
        assert_eq!(router.processor_origin(&IfcType::IfcBooleanResult), Some(ProcessorOrigin::ConfiguredBuiltin));
        assert_eq!(router.processor_origin(&IfcType::IfcBooleanClippingResult), Some(ProcessorOrigin::ConfiguredBuiltin));
        assert_eq!(router.processor_origin(&IfcType::IfcCsgSolid), Some(ProcessorOrigin::ConfiguredBuiltin));
        assert_eq!(router.processor_origin(&IfcType::IfcBlock), Some(ProcessorOrigin::Custom));
        router.register(Box::new(BooleanClippingProcessor::new()));
        assert_eq!(router.processor_origin(&IfcType::IfcBooleanResult), Some(ProcessorOrigin::Custom));
        router.set_skip_small_cuts(false);
        assert_eq!(router.processor_origin(&IfcType::IfcBooleanResult), Some(ProcessorOrigin::ConfiguredBuiltin));
    }
}
