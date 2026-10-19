// SPDX-License-Identifier: MPL-2.0
//! Selected root lowering and historical fresh operand dispatch are distinct roles.
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use crate::processors::BlockProcessor;
use crate::program::OwnedConstructor;
use crate::kernel::mesh_volume::mesh_volume;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc};

struct SelectedBlock(Rc<Cell<usize>>);
impl GeometryProcessor for SelectedBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn lower_owned(&self, _: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, rtc: Option<(f64, f64, f64)>) -> Option<Result<OwnedConstructor>> {
        if rtc.is_some() { return None; }
        self.0.set(self.0.get() + 1);
        Some(decoder.decode_by_id(90).map_err(crate::Error::from).and_then(|replacement| {
            BlockProcessor::new().lower_owned(&replacement, decoder, quality, None).unwrap()
        }))
    }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder,
        _: &IfcSchema, _: TessellationQuality) -> Result<Mesh> {
        panic!("selected root must use its actual owned-lowering hook")
    }
}

#[test]
fn actual_selected_root_hook_is_used_but_boolean_and_csg_operands_use_fresh_builtins() {
    let source = "#1=IFCWALL('w',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#10=IFCBLOCK($,2.,2.,2.);#90=IFCBLOCK($,3.,3.,3.);
#20=IFCBOOLEANRESULT(.UNION.,#10,#10);#30=IFCCSGSOLID(#20);";
    for root in [10, 20, 30] {
        let calls = Rc::new(Cell::new(0));
        let mut router = GeometryRouter::new();
        router.register(Box::new(SelectedBlock(calls.clone())));
        let source = source.replace("'CSG',(#10)", &format!("'CSG',(#{root})"));
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1).unwrap();
        let meshes = router.process_element_parts(&element, &mut decoder).unwrap();
        let volume: f64 = meshes.iter().map(|mesh| mesh_volume(mesh).abs()).sum();
        assert!((volume - if root == 10 { 27. } else { 8. }).abs() < 1e-6);
        assert_eq!(calls.get(), usize::from(root == 10));
    }
}

#[test]
fn configured_boolean_and_csg_roots_keep_their_selected_small_cut_policy() {
    let dimension = 0.01_f64;
    let source = format!("#1=IFCWALL('w',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#20));
#10=IFCBLOCK($,2.,2.,2.);#11=IFCBLOCK(#13,{dimension:e},{dimension:e},{dimension:e});
#12=IFCCARTESIANPOINT((0.5,0.5,0.5));#13=IFCAXIS2PLACEMENT3D(#12,$,$);
#20=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#11);#30=IFCCSGSOLID(#20);");
    for root in [20, 30] {
        for skip in [false, true] {
            let source = source.replace("'CSG',(#20)", &format!("'CSG',(#{root})"));
            let mut decoder = EntityDecoder::new(&source);
            let element = decoder.decode_by_id(1).unwrap();
            let mut router = GeometryRouter::new();
            router.set_skip_small_cuts(skip);
            let meshes = router.process_element_parts(&element, &mut decoder).unwrap();
            let actual: f64 = meshes.iter().map(|mesh| mesh_volume(mesh).abs()).sum();
            // The exact kernel evaluates snapped operands, not the authored
            // decimal width. Keep this independent of the returned mesh.
            let grid = crate::kernel::mesh_bridge::SNAP_GRID;
            let snapped_dimension = (dimension / grid).round() * grid;
            let expected = if skip { 8. } else { 8. - snapped_dimension.powi(3) };
            assert!((actual - expected).abs() < dimension.powi(3) * 1e-3,
                "root #{root}, skip={skip}: volume {actual}, expected {expected}");
            assert!(router.take_csg_failures().is_empty());
        }
    }
}
