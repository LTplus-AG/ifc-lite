// SPDX-License-Identifier: MPL-2.0
//! Native canonical execution must fit an ordinary worker stack. The integrated
//! continuation regression overflowed even a one-block product: each source
//! reply embedded all inactive controller layouts through GeometryProgram.
use super::{GeometryProgram, ProgramReply, ReadyOperation};
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;

#[test]
fn common_protocol_stack_values_have_a_bounded_inline_footprint() {
    // These values cross several nested protocol calls per operation. A 4 KiB
    // ceiling prevents their 34 KiB inactive-controller layout from returning;
    // the behavioural witnesses below also exercise the actual call frames.
    for (name, bytes) in [
        ("program", std::mem::size_of::<GeometryProgram>()),
        ("reply", std::mem::size_of::<ProgramReply>()),
        ("ready", std::mem::size_of::<ReadyOperation>()),
    ] {
        assert!(bytes <= 4096, "{name} occupies {bytes} inline bytes");
    }
}

fn run_product(mapping_depth: u32) {
    // Pin the ordinary worker stack rather than inheriting RUST_MIN_STACK or
    // routing this regression to the dedicated large-stack geometry pool.
    std::thread::Builder::new().stack_size(2 * 1024 * 1024).spawn(move || {
        let mut source = String::from(
            "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
             #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\n\
             #10=IFCBLOCK(#2,1.,2.,3.);\n");
        let mut item = 10;
        for level in 0..mapping_depth {
            let representation = 20 + level * 3;
            let map = representation + 1;
            let mapped = representation + 2;
            source.push_str(&format!(
                "#{representation}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{item}));\n\
                 #{map}=IFCREPRESENTATIONMAP(#2,#{representation});\n\
                 #{mapped}=IFCMAPPEDITEM(#{map},#3);\n"));
            item = mapped;
        }
        source.push_str(&format!(
            "#1000=IFCSHAPEREPRESENTATION($,'Body','CSG',(#{item}));\n\
             #1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));\n\
             #1002=IFCWALL('stack-product',$,$,$,$,$,#1001,$,$);"));
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1002).unwrap();
        let mesh = GeometryRouter::new().process_element(&element, &mut decoder).unwrap();
        assert_eq!(mesh.indices.len() / 3, 12, "the reached block must survive every mapping");
        let (min, max) = mesh.bounds();
        assert_eq!([min.x, min.y, min.z], [0., 0., 0.]);
        assert_eq!([max.x, max.y, max.z], [1., 2., 3.]);
    }).unwrap().join().unwrap();
}

#[test]
fn canonical_one_block_product_fits_an_ordinary_worker_stack() {
    run_product(0);
}

#[test]
fn canonical_deep_valid_mapping_product_preserves_geometry_on_an_ordinary_stack() {
    run_product(24);
}
