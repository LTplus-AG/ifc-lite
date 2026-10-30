// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::IfcAPI;
use ifc_lite_core::EntityDecoder;
use std::sync::{Arc, Barrier};

// #7782 C4-11b: a shared content slot must publish one decoded plan, including
// when independent batch decoders race on first use. This asserts the ownership
// contract and real mapped/type discovery, rather than a setter round trip.
#[test]
fn c4_11b_concurrent_batches_share_one_discovered_type_plan() {
    let source = include_str!("../../../processing/tests/fixtures/c4_bare_type_map_7782.ifc");
    let source = source.replace("ENDSEC;\nEND-ISO", "#60=IFCMAPPEDITEM(#44,#45);\n#61=IFCRELDEFINESBYTYPE('rel',$,$,$,(#1),#43);\nENDSEC;\nEND-ISO");
    let source = source.as_bytes();
    let api = IfcAPI::new();
    let barrier = Barrier::new(8);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    let mut decoder = EntityDecoder::new(source);
                    barrier.wait();
                    api.get_or_build_type_geometry_plan(source, &mut decoder)
                })
            })
            .collect();
        let plans: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(plans[0].referenced_representation_maps.contains(&44));
        assert!(plans[0].instantiated_type_ids.contains(&43));
        for plan in &plans[1..] {
            assert!(
                Arc::ptr_eq(&plans[0], plan),
                "all batches must share the published plan"
            );
        }
        api.clear_pre_pass_cache();
        let mut decoder = EntityDecoder::new(source);
        let next = api.get_or_build_type_geometry_plan(source, &mut decoder);
        assert!(!Arc::ptr_eq(&plans[0], &next), "a new load must rebuild");
        assert_eq!(plans[0].jobs(), next.jobs());
    });
}
