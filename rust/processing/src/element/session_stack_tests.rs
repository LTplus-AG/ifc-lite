// SPDX-License-Identifier: MPL-2.0
//! Canonical product execution must fit an ordinary worker stack. The session
//! now wraps every product, so a one-block product and a 24-deep valid mapping
//! chain run through both drivers on a pinned 2 MiB thread.
use super::session_tests::Context;
use super::*;

fn source(mapping_depth: u32) -> String {
    let mut source = String::from(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\n\
         #10=IFCBLOCK(#2,1.,2.,3.);\n",
    );
    let mut item = 10;
    for level in 0..mapping_depth {
        let representation = 20 + level * 3;
        let map = representation + 1;
        let mapped = representation + 2;
        source.push_str(&format!(
            "#{representation}=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#{item}));\n\
             #{map}=IFCREPRESENTATIONMAP(#2,#{representation});\n\
             #{mapped}=IFCMAPPEDITEM(#{map},#3);\n"
        ));
        item = mapped;
    }
    source.push_str(&format!(
        "#1000=IFCSHAPEREPRESENTATION($,'Body','CSG',(#{item}));\n\
         #1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));\n\
         #1002=IFCWALL('stack-product',$,$,$,$,$,#1001,$,$);"
    ));
    source
}

fn assert_block(produced: &ProducedElementMeshes) {
    let triangles: usize = produced.meshes.iter().map(|mesh| mesh.indices.len() / 3).sum();
    assert_eq!(triangles, 12, "the reached block must survive every mapping");
    let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
    for mesh in &produced.meshes {
        for point in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let world = point[axis] + mesh.origin[axis] as f32;
                min[axis] = min[axis].min(world);
                max[axis] = max[axis].max(world);
            }
        }
    }
    for axis in 0..3 {
        assert!(min[axis].abs() < 1e-5, "min {min:?}");
        assert!((max[axis] - [1., 2., 3.][axis]).abs() < 1e-5, "max {max:?}");
    }
}

fn run_product(mapping_depth: u32) {
    // Pin the ordinary worker stack rather than inheriting RUST_MIN_STACK or
    // routing this regression to the dedicated large-stack geometry pool.
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let source = source(mapping_depth);
            let mut decoder = EntityDecoder::new(&source);
            decoder.seed_unit_scales(1., 1.);
            let router = GeometryRouter::new();
            let entity = decoder.decode_by_id(1002).unwrap();
            let job = ElementMeshJob {
                id: entity.id,
                ifc_type: entity.ifc_type.clone(),
                entity: &entity,
                kind: ElementJobKind::Product,
                element_color: None,
                metadata: None,
            };
            let borrowed = produce_element_meshes(&job, &Context::default().borrowed(), &MeshProductionOptions::default(), &mut decoder, &router);
            assert_block(&borrowed);
            let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
            let owned = produce_element_meshes_owned(&job, &context, &MeshProductionOptions::default(), &mut decoder, &router).unwrap();
            assert_block(&owned);
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn canonical_one_block_product_fits_an_ordinary_worker_stack() {
    run_product(0);
}

#[test]
fn canonical_deep_valid_mapping_product_preserves_geometry_on_an_ordinary_stack() {
    run_product(24);
}
