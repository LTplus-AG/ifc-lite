// SPDX-License-Identifier: MPL-2.0
use super::*;
// #7955 M3-A: the exact VoidControl and public parts API remain byte-identical.
#[test]
fn issue_7955_m3_exact_void_control_matches_public_parts() {
    let text = include_str!("../../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
    let mut decoder = ifc_lite_core::EntityDecoder::new(text);
    let router = GeometryRouter::with_units(text, &mut decoder);
    let host = decoder.decode_by_id(30).unwrap();
    let ids = [50, 70, 100];
    let mut program = GeometryProgram::voided(&host, &ids);
    while let Some(request) = program.request().unwrap() {
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).ok().unwrap();
    }
    let actual = program.finish_parts().unwrap();
    let expected = router.process_element_with_voids_parts(&host, &mut decoder,
        &[(30, ids.to_vec())].into_iter().collect()).unwrap();
    assert!(!actual.is_empty());
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(&expected) {
        assert_eq!(a.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), b.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        assert_eq!(a.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), b.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.origin.map(f64::to_bits), b.origin.map(f64::to_bits));
    }
}
