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
fn issue_3988_ref_scratch_retains_duplicates_and_drops_oversized_refs() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut ids = Vec::with_capacity(32);
    let ptr = ids.as_ptr();
    for id in [20, 21, 20, 22, 99, 20] {
        let result = decoder.get_entity_ref_list_fast_into(id, &mut ids);
        assert_eq!(result.is_some(), id == 20);
        assert_eq!(ids.as_ptr(), ptr);
        if id == 20 {
            assert_eq!(ids, [10, 11, 10, 12]);
            assert_eq!(decoder.get_entity_ref_list_fast(id), Some(ids.clone()));
        } else {
            assert!(ids.is_empty());
            assert_eq!(decoder.get_entity_ref_list_fast(id), None);
        }
    }
}
