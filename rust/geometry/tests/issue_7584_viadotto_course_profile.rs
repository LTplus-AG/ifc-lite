// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7584: the Viadotto Acerno pavement courses sweep asymmetric profiles
//! (crown 1.5 m off centre) along an alignment offset 1.46 m from the
//! deck's. Mirroring the profile pushed every course ~2.9 m sideways, half
//! off the deck slab. The source and SHA-256 are pinned in
//! tests/models/manifest.json.

use std::collections::HashMap;

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

mod support;

const FIXTURE: &str = "../../tests/models/buildingsmart/Viadotto_Acerno.ifc";

/// Plan-view and vertical extents of one element: `[min, max]` per axis.
type Bounds = [[f64; 2]; 3];

#[test]
fn viadotto_acerno_courses_sit_on_their_deck_slab() {
    let source = match std::fs::read_to_string(FIXTURE) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            assert!(!support::require_fixtures(),
                "fixture missing and IFC_LITE_REQUIRE_FIXTURES=1 -- run `pnpm fixtures` to download");
            eprintln!("skipping #7584 regression: {FIXTURE} missing -- run `pnpm fixtures`");
            return;
        }
        Err(error) => panic!("failed to read {FIXTURE}: {error}"),
    };
    let ids: Vec<u32> = {
        let mut scanner = EntityScanner::new(&source);
        std::iter::from_fn(|| scanner.next_entity())
            .filter(|(_, name, _, _)| {
                name.eq_ignore_ascii_case("IFCCOURSE") || name.eq_ignore_ascii_case("IFCSLAB")
            })
            .map(|(id, _, _, _)| id)
            .collect()
    };

    let index = build_entity_index(&source);
    let mut decoder = EntityDecoder::with_index(&source, index);
    let router = GeometryRouter::new();
    let mut by_name: HashMap<String, Bounds> = HashMap::new();
    for id in ids {
        let element = decoder.decode_by_id(id).expect("decode element");
        let Some(name) = element.get_string(2).map(str::to_string) else { continue };
        if !(name.starts_with("RCSlab_Span") || name.starts_with("Binder_Span")
            || name.starts_with("Wearing_Span"))
        {
            continue;
        }
        let mesh = router.process_element(&element, &mut decoder)
            .unwrap_or_else(|error| panic!("{name} #{id}: {error}"));
        let mut bounds = [[f64::INFINITY, f64::NEG_INFINITY]; 3];
        for point in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let value = point[axis] as f64 + mesh.origin[axis];
                bounds[axis][0] = bounds[axis][0].min(value);
                bounds[axis][1] = bounds[axis][1].max(value);
            }
        }
        by_name.insert(name, bounds);
    }

    let mut checked = 0;
    for span in 1..=19 {
        let slab = by_name[&format!("RCSlab_Span{span:02}")];
        for layer in ["Binder", "Wearing"] {
            let course = by_name[&format!("{layer}_Span{span:02}")];
            // The 10.5 m carriageway lies within the 12 m deck in plan …
            for axis in 0..2 {
                assert!(course[axis][0] >= slab[axis][0] - 0.05
                    && course[axis][1] <= slab[axis][1] + 0.05,
                    "{layer}_Span{span:02} axis {axis} {:?} overhangs RCSlab {:?}",
                    course[axis], slab[axis]);
            }
            // … and on top of it, below 0.3 m above the slab's highest point.
            assert!(course[2][0] > slab[2][0] && course[2][1] < slab[2][1] + 0.3,
                "{layer}_Span{span:02} z {:?} not on RCSlab z {:?}", course[2], slab[2]);
            checked += 1;
        }
    }
    assert_eq!(checked, 38, "Viadotto source changed; inspect the fixture");
}
