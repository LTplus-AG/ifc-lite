// SPDX-License-Identifier: MPL-2.0
//! Requested occurrence attribution remains distinct from trusted cached entities.
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;
use std::sync::Arc;

#[test]
fn requested_opening_id_survives_compatibility_cache_alias_with_real_cut_geometry() {
    let source = "#10=IFCBLOCK($,2.,3.,4.);
#1=IFCWALL('host',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#21=IFCOPENINGELEMENT('actual-opening',$,$,$,$,$,#2,$);";
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(source);
    let actual = Arc::new(decoder.decode_by_id(21).unwrap());
    // The public raw-cache API intentionally supports trusted compatibility
    // inputs; this alias does not acquire authenticated source-factory authority.
    let cache: FxHashMap<_, _> = [(20, actual)].into_iter().collect();
    decoder.inject_shared_cache(&cache);
    let host = decoder.decode_by_id(1).unwrap();
    let original = router.process_element(&host, &mut decoder).unwrap();
    assert!((crate::mesh_check::signed_volume(&original).abs() - 24.).abs() < 1e-6);

    let voids = [(1, vec![20, 20])].into_iter().collect();
    let result = router.process_element_with_voids(&host, &mut decoder, &voids).unwrap();
    assert!(result.is_empty(), "the actual containing opening consumes the host");
    assert!(router.host_consumed_by_void(1));
    let diagnostics = router.take_host_opening_diagnostics();
    let openings = &diagnostics[&1].openings;
    assert_eq!(openings.iter().map(|entry| entry.opening_id).collect::<Vec<_>>(), [20, 20]);
    assert!(openings.iter().all(|entry| entry.vertex_count > 0));
    assert_eq!(decoder.decode_by_id(20).unwrap().id, 21,
        "diagnostic attribution must not rewrite the actual cached source entity");
}
