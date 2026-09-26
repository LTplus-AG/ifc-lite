// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5327: the buildingSMART Viadotto Acerno IFC4x3 bridge has 638
//! sectioned solids whose cross-section positions are linear placements.
//! The source and SHA-256 are pinned in tests/models/manifest.json.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;

mod support;

const FIXTURE: &str = "../../tests/models/buildingsmart/Viadotto_Acerno.ifc";

#[test]
fn viadotto_acerno_sectioned_solids_follow_deck_grade() {
    let source = match std::fs::read_to_string(FIXTURE) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            assert!(!support::require_fixtures(),
                "fixture missing and IFC_LITE_REQUIRE_FIXTURES=1 -- run `pnpm fixtures` to download");
            eprintln!("skipping #5327 regression: {FIXTURE} missing -- run `pnpm fixtures`");
            return;
        }
        Err(error) => panic!("failed to read {FIXTURE}: {error}"),
    };
    let ids: Vec<u32> = {
        let mut scanner = EntityScanner::new(&source);
        std::iter::from_fn(|| scanner.next_entity())
            .filter(|(_, name, _, _)| name.eq_ignore_ascii_case("IFCSECTIONEDSOLIDHORIZONTAL"))
            .map(|(id, _, _, _)| id)
            .collect()
    };
    assert_eq!(ids.len(), 638, "Viadotto source changed; inspect the fixture and oracle");

    let index = build_entity_index(&source);
    let mut decoder = EntityDecoder::with_index(&source, index);
    let router = GeometryRouter::new();
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for id in ids {
        let entity = decoder.decode_by_id(id).expect("decode sectioned solid");
        let mesh = router.process_representation_item(&entity, &mut decoder)
            .unwrap_or_else(|error| panic!("sectioned solid #{id}: {error}"));
        assert!(!mesh.positions.is_empty(), "sectioned solid #{id} produced no geometry");
        for point in mesh.positions.chunks_exact(3) {
            min_z = min_z.min(point[2]);
            max_z = max_z.max(point[2]);
        }
    }
    // Deck spans roughly 50–55 m above origin. Wide bounds allow valid
    // mesh refinement while detecting the former z≈0 placement failure.
    assert!(min_z > 45.0 && min_z < 52.0, "unexpected deck min z {min_z}");
    assert!(max_z > 55.0 && max_z < 60.0, "unexpected deck max z {max_z}");
}
