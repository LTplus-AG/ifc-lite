// SPDX-License-Identifier: MPL-2.0
//! ProductProgram phase invariants: source admission precedes child execution,
//! while conditional descendants observe earlier mutable-decoder callbacks.
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use crate::processors::BlockProcessor;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc, sync::Arc};

pub(super) const BLOCK: &str = "#10=IFCBLOCK($,2.,3.,4.);";

pub(super) struct ObservedBlock { pub calls: Rc<Cell<usize>>, pub repair: bool }
impl GeometryProcessor for ObservedBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if self.repair {
            let repaired = decoder.decode_by_id(10)?;
            decoder.inject_shared_cache(&[(999, Arc::new(repaired))].into_iter().collect());
        }
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}

fn run(source: &str, styled: bool, repair: bool) -> (Result<usize>, usize) {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(ObservedBlock { calls: calls.clone(), repair }));
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1).unwrap();
    let result = if styled {
        router.process_element_with_submeshes(&element, &mut decoder)
            .map(|out| out.sub_meshes.iter().map(|sub| sub.mesh.indices.len() / 3).sum())
    } else {
        router.process_element_parts(&element, &mut decoder)
            .map(|parts| parts.iter().map(|part| part.indices.len() / 3).sum())
    };
    (result, calls.get())
}

#[test]
fn product_program_bulk_lists_fail_before_the_first_child_in_both_consumers() {
    for styled in [false, true] {
        for (reps, items) in [("#3,#999", "#10"), ("#3", "#10,#999")] {
            let source = format!("{BLOCK}#1=IFCWALL('w',$,$,$,$,$,#2,$);
                #2=IFCPRODUCTDEFINITIONSHAPE($,$,({reps}));
                #3=IFCSHAPEREPRESENTATION($,'Body','CSG',({items}));");
            let (result, calls) = run(&source, styled, true);
            assert!(result.is_err(), "malformed later reference must fail the whole list");
            assert_eq!(calls, 0, "an earlier child must not repair a later bulk-list reference");
        }
    }
}

#[test]
fn product_program_admits_later_representation_items_after_callback_repairs() {
    let source = format!("{BLOCK}#1=IFCWALL('w',$,$,$,$,$,#2,$);
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#4));
        #3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
        #4=IFCSHAPEREPRESENTATION($,'Body','CSG',(#999));");
    for styled in [false, true] {
        let (result, calls) = run(&source, styled, true);
        assert_eq!(result.unwrap(), 24, "both real block occurrences survive");
        assert_eq!(calls, 2, "later item admission sees the live decoder after the callback");
    }
}

#[test]
fn product_program_skips_axis_and_duplicate_mapped_descendants_without_source_reads() {
    let source = format!("{BLOCK}#1=IFCWALL('w',$,$,$,$,$,#2,$);
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#4,#5,#3));
        #3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#10));
        #4=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#998));
        #5=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#999));");
    for styled in [false, true] {
        let (result, calls) = run(&source, styled, false);
        assert_eq!(result.unwrap(), 24);
        assert_eq!(calls, 2, "repeated direct items are occurrences, not a global visited set");
    }
}

#[test]
fn product_program_absent_shape_skips_invalid_placement() {
    for styled in [false, true] {
        let (result, calls) = run("#1=IFCWALL('w',$,$,$,$,#999,$,$);", styled, false);
        assert_eq!(result.unwrap(), 0);
        assert_eq!(calls, 0);
    }
}

#[test]
fn selected_builtin_constructor_owns_parameters_after_source_disposal() {
    let plan = {
        let source = BLOCK.to_owned();
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(10).unwrap();
        BlockProcessor::new().lower_owned(&entity, &mut decoder, TessellationQuality::Medium, None)
            .expect("selected builtin admits an owned payload").unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert_eq!(mesh.indices.len(), 36);
    for axis in 0..3 {
        let max = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f32::NEG_INFINITY, f32::max);
        let min = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f32::INFINITY, f32::min);
        assert_eq!((min, max), (0., [2., 3., 4.][axis]));
    }
}
