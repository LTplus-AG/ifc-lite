// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7791 item 4: the resolver half of the `PlacementRelTo` chain contract that
//! the TypeScript walker (`packages/data/src/placement-chain.ts`) also
//! satisfies. Both read `fixtures/placement_chain_vectors.json`: an acyclic
//! chain composes the sum of its offsets, a cycle is refused.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;
use serde_json::Value;

fn step_for(links: &serde_json::Map<String, Value>) -> String {
    let mut out = String::new();
    for (id, link) in links {
        let id: u32 = id.parse().unwrap();
        let off = link["offset"].as_array().unwrap();
        let (point, axis) = (id + 1000, id + 2000);
        out += &format!(
            "#{point}=IFCCARTESIANPOINT(({:?},{:?},{:?}));\n#{axis}=IFCAXIS2PLACEMENT3D(#{point},$,$);\n",
            off[0].as_f64().unwrap(),
            off[1].as_f64().unwrap(),
            off[2].as_f64().unwrap()
        );
        let parent = match link["parent"].as_u64() {
            Some(p) => format!("#{p}"),
            None => "$".to_string(),
        };
        out += &format!("#{id}=IFCLOCALPLACEMENT({parent},#{axis});\n");
    }
    out
}

#[test]
fn resolver_matches_the_shared_chain_vectors() {
    let raw = include_str!("fixtures/placement_chain_vectors.json");
    let doc: Value = serde_json::from_str(raw).unwrap();
    for vector in doc["vectors"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        let start = vector["start"].as_u64().unwrap();
        let src = format!(
            "{}#9000=IFCWALL('0000000000000000000000',$,$,$,$,#{start},$,$,$);\n",
            step_for(vector["links"].as_object().unwrap())
        );
        let mut decoder = EntityDecoder::new(&src);
        let router = GeometryRouter::new();
        let product = decoder.decode_by_id(9000).unwrap();
        let resolved = router.resolve_scaled_placement_strict(&product, &mut decoder);
        let expect = &vector["expect"];
        match expect["kind"].as_str().unwrap() {
            "ok" => {
                let m = resolved.unwrap_or_else(|e| panic!("{name}: {e}"));
                let origin = expect["origin"].as_array().unwrap();
                for (axis, want) in origin.iter().enumerate() {
                    let got = m[12 + axis];
                    assert!(
                        (got - want.as_f64().unwrap()).abs() < 1e-9,
                        "{name}: origin[{axis}] = {got}, want {want}"
                    );
                }
            }
            "cycle" => assert!(resolved.is_err(), "{name}: a cycle must be refused, got {resolved:?}"),
            other => panic!("{name}: unknown kind {other}"),
        }
    }
}
