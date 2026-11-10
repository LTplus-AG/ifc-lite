// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

const SOURCE: &str = "\
#1=IFCCARTESIANPOINT((-0.,2.,3.));
#2=IFCCARTESIANPOINT((1.,0.,0.));
#3=IFCCARTESIANPOINT((0.,1.,0.));
#10=IFCPOLYLOOP((#1,#2,#1,#3));
#11=IFCPOLYLOOP((#3,#99,#2,#1));
#12=IFCPOLYLOOP((#1,#4294967296,#2,#3));
#13=IFCPOLYLOOP((#1,#2));
#14=IFCPOLYLOOP(());
#15=IFCPOLYLOOP($);
#20=IFCFACE((#10,#11,#10,#4294967296,#12));
#21=IFCFACE(());
#22=IFCFACE($);
#23=IFCFACE((#10,#11,#10,#12));
";

#[test]
fn issue_3988_polyloop_scratch_preserves_order_failures_and_point_cache() {
    let mut fill = EntityDecoder::new(SOURCE);
    let mut owned = EntityDecoder::new(SOURCE);
    let mut coords = Vec::with_capacity(32);
    let ptr = coords.as_ptr();
    for id in [10, 11, 10, 12, 13, 14, 15, 99, 10] {
        let expected = owned.get_polyloop_coords_cached(id);
        let result = fill.get_polyloop_coords_cached_into(id, &mut coords);
        assert_eq!(result.is_some(), id == 10);
        assert_eq!(result.is_some(), expected.is_some());
        assert_eq!(fill.point_cache_stats(), owned.point_cache_stats());
        assert_eq!(coords.as_ptr(), ptr, "scratch must be reused across loop decodes");
        if id == 10 {
            let bits = |points: &[(f64, f64, f64)]| -> Vec<[u64; 3]> {
                points.iter().map(|&(x, y, z)| [x.to_bits(), y.to_bits(), z.to_bits()]).collect()
            };
            assert_eq!(bits(&coords), bits(&[
                (-0.0, 2.0, 3.0), (1.0, 0.0, 0.0),
                (-0.0, 2.0, 3.0), (0.0, 1.0, 0.0),
            ]));
            assert_eq!(bits(&coords), bits(&expected.unwrap()));
        } else {
            assert!(coords.is_empty(), "failed loops must expose no stale/partial polygon");
        }
    }
}

#[test]
fn issue_3988_ref_scratch_retains_duplicates_and_refuses_oversized_refs() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut ids = Vec::with_capacity(32);
    let ptr = ids.as_ptr();
    for id in [23, 20, 21, 23, 22, 99, 23] {
        let result = decoder.get_entity_ref_list_fast_into(id, &mut ids);
        assert_eq!(result.is_some(), id == 23);
        assert_eq!(ids.as_ptr(), ptr);
        if id == 23 {
            assert_eq!(ids, [10, 11, 10, 12]);
            assert_eq!(decoder.get_entity_ref_list_fast(id), Some(ids.clone()));
        } else {
            assert!(ids.is_empty());
            assert_eq!(decoder.get_entity_ref_list_fast(id), None);
        }
    }
}

/// The byte proof behind skipping a face decode: every record it accepts
/// decodes, uncached, to an `IfcFace`; every variant it refuses still decodes
/// (or fails) exactly as before because the caller then decodes it.
#[test]
fn plain_face_proof_accepts_only_records_the_decode_reads_as_ifc_face() {
    let accepted = [
        "#1=IFCFACE((#10));",
        "#2=IFCFACE((#10,#11,#12));",
        "#3= IFCFACE((#10,#11));",
        "#4 =\tIFCFACE ( ( #10 , #11 ) ) ;",
        "#5=IFCFACE((#10,#11))\r\n;",
        "#6=IFCFACE((#4294967295));",
        "#7=IFCFACE((#0010));",
    ];
    let refused = [
        "#20=IFCFACE(());",
        "#21=IFCFACE($);",
        "#22=IFCFACE((#10),$);",
        "#23=IFCFACE((#10,));",
        "#24=IFCFACE((# 10));",
        "#25=IFCFACE((#4294967296));",
        "#26=IFCFACE((#10/* c */));",
        "#27=ifcface((#10));",
        "#28=IFCFACESURFACE((#10),#11,.T.);",
        "#29=IFCADVANCEDFACE((#10),#11,.T.);",
        "#30=IFCFACE((#10,#11.5));",
        "#31=IFCFACE((#10)));",
        "#32=IFCFACE((#10))",
        "#33=IFCFACE((#10a));",
        "#34=IFCFACE (#10);",
        "#35=IFCFACE_X((#10));",
    ];
    let source: String = accepted.iter().chain(&refused).map(|r| format!("{r}\n")).collect();
    for (record, expected) in accepted.iter().map(|r| (r, true)).chain(refused.iter().map(|r| (r, false))) {
        let id: u32 = record[1..].split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap();
        let mut decoder = EntityDecoder::new(&source);
        assert_eq!(decoder.is_plain_face(id), expected, "{record}");
        if expected {
            let face = decoder.decode_by_id(id).unwrap_or_else(|e| panic!("{record}: {e}"));
            assert_eq!(face.ifc_type, crate::IfcType::IfcFace, "{record}");
            // A decoded (memoized) id is the decode's to answer.
            assert!(!decoder.is_plain_face(id), "{record}");
        }
    }
}
