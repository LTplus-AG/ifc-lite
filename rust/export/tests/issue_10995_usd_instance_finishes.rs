// SPDX-License-Identifier: MPL-2.0

use ifc_lite_export::{export_usd, UsdOptions};

#[test]
fn usd_binds_finishes_per_mapped_occurrence_10995() {
    let styled = include_bytes!("fixtures/mapped_instance_finishes.ifc");
    for instancing in [true, false] {
        let opts = UsdOptions {
            instancing,
            ..UsdOptions::default()
        };
        let stage = export_usd(styled, &opts).unwrap();
        for (prim, roughness, metallic, occurrence) in [
            ("Proxy_1_38", "0.75", "1", true),
            ("Proxy_0_31", "0.25", "0", false),
            ("Proxy_2_45", "1", "0", true),
        ] {
            let (_, body) = stage.split_once(&format!("def Xform \"{prim}\"")).unwrap();
            let body = body.split("def Xform ").next().unwrap();
            assert_eq!(
                body.contains("prepend references = "),
                instancing && occurrence,
                "{prim}"
            );
            let (_, binding) = body
                .split_once("rel material:binding = </World/Looks/")
                .unwrap();
            let name = binding.split_once('>').unwrap().0;
            let (_, material) = stage
                .split_once(&format!("def Material \"{name}\""))
                .unwrap();
            let material = material.split("def Material ").next().unwrap();
            assert!(
                material
                    .lines()
                    .any(|line| line.trim() == format!("float inputs:roughness = {roughness}")),
                "{prim} should bind roughness {roughness}, got material {name}"
            );
            assert!(
                material
                    .lines()
                    .any(|line| line.trim() == format!("float inputs:metallic = {metallic}")),
                "{prim} should bind metallic {metallic}, got material {name}"
            );
        }
    }
}
