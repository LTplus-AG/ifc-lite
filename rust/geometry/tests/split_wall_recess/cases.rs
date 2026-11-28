// SPDX-License-Identifier: MPL-2.0
use super::super::{finish_wall_volume, split_wall, Recess};

/// A wall turned in plan, with a recess turned independently in its own placement.
fn wall_with_recess_turned_against(wall: f64, phi: f64, recess: Recess, length: f64) -> String {
    let (sin, cos) = phi.to_radians().sin_cos();
    let (axis, depth) = match recess {
        Recess::FromInterface => ("#15", format!("({:?},{cos:?},0.)", -sin)),
        Recess::ToInterfaceAtTop => ("#16", format!("({sin:?},{:?},0.)", -cos)),
    };
    let authored = format!("#111=IFCAXIS2PLACEMENT3D(#110,{axis},#17);");
    let content = split_wall::wall_with_finish([0.0; 2], wall, 2.274, recess, length);
    assert!(content.contains(&authored));
    content.replace(
        &authored,
        &format!(
            "#140=IFCDIRECTION({depth});#141=IFCDIRECTION(({cos:?},{sin:?},0.));\
             #111=IFCAXIS2PLACEMENT3D(#110,#140,#141);"
        ),
    )
}

fn turned_recess_removed_above(phi: f64, recess: Recess, floor: f64) -> f64 {
    let (sin, cos) = phi.to_radians().sin_cos();
    // y = y0 + u sin + sense v cos for u in [0, 1] along the face, v in
    // [0, 0.012] along the depth.
    let (y0, sense) = match recess {
        Recess::FromInterface => (0.2, 1.0),
        Recess::ToInterfaceAtTop => (0.212, -1.0),
    };
    const STEPS: usize = 20_000;
    (0..STEPS)
        .map(|step| {
            let u = (step as f64 + 0.5) / STEPS as f64;
            // The v at which y reaches each finish face.
            let a = (floor - y0 - u * sin) / (sense * cos);
            let b = (0.212 - y0 - u * sin) / (sense * cos);
            (a.max(b).min(0.012) - a.min(b).max(0.0)).max(0.0)
        })
        .sum::<f64>()
        / STEPS as f64
}

fn mixed_recess(relative: f64, length: f64) -> (String, f64) {
    let (sin, cos) = relative.to_radians().sin_cos();
    // A 1 m by 1 m box, 0.15 m deep, from 0.1 m outside the core's
    // outer face (y = 0) into it, turned `relative` about its corner.
    let second = format!(
        "#400=IFCCARTESIANPOINT((2.5,-0.1,2.));\
         #401=IFCDIRECTION(({:?},{:?},0.));#402=IFCDIRECTION(({cos:?},{sin:?},0.));\
         #403=IFCAXIS2PLACEMENT3D(#400,#401,#402);#404=IFCLOCALPLACEMENT(#33,#403);\
         #405=IFCEXTRUDEDAREASOLID(#122,#11,#14,0.15);\
         #406=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#405));\
         #407=IFCPRODUCTDEFINITIONSHAPE($,$,(#406));\
         #408=IFCOPENINGELEMENT('0FlushInterface0000007',$,'Recess',$,$,#404,#407,$,.RECESS.);\
         #409=IFCRELVOIDSELEMENT('0FlushInterface0000008',$,$,$,#100,#408);\
         #410=IFCCARTESIANPOINT((0.2,-0.1,2.));#411=IFCAXIS2PLACEMENT3D(#410,#15,#17);\
         #412=IFCLOCALPLACEMENT(#33,#411);\
         #413=IFCOPENINGELEMENT('0FlushInterface0000009',$,'Recess',$,$,#412,#407,$,.RECESS.);\
         #414=IFCRELVOIDSELEMENT('0FlushInterface0000010',$,$,$,#100,#413);\nENDSEC;",
        -sin, cos,
    );
    // The part of the turned box with y >= 0, over its 1 m height.
    let removed = 0.05 + 0.15 - (0.1 - 0.5 * sin) / cos;
    let content =
        split_wall::wall_with_finish([0.0; 2], 42.0, 2.274, Recess::FromInterface, length)
            .replacen("ENDSEC;\nEND-ISO", &format!("{second}\nEND-ISO"), 1);
    assert!(content.contains("#414="));
    (content, finish_wall_volume(length) - removed)
}

/// The 90-host wall/cutter sweep, the short-finish and small-angle straight
/// wall controls, and the three-opening wall-frame fixture from #11423.
pub(super) fn each(mut visit: impl FnMut(String, String, f64, f64, bool)) {
    for wall in [0.0, 0.5, 1.0, -0.5, 0.17] {
        for phi in [-0.3, -0.2, -0.1, -0.01, 0.0, 0.01, 0.1, 0.2, 0.3] {
            for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
                let content = wall_with_recess_turned_against(wall, phi, recess, 4.0);
                let expected = 4.0 * 3.0 * 0.212 - turned_recess_removed_above(phi, recess, 0.0);
                visit(
                    format!("wall/{wall}/{phi}/{recess:?}"),
                    content,
                    expected,
                    1.1,
                    phi == 0.0,
                );
            }
        }
    }
    for phi in [0.0005, 0.001, 0.002, 0.1, 0.5, 0.9] {
        for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
            for length in [1.0, 4.0] {
                let content = wall_with_recess_turned_against(0.0, phi, recess, length);
                let expected = if length == 4.0 {
                    4.0 * 3.0 * 0.212 - turned_recess_removed_above(phi, recess, 0.2)
                } else {
                    finish_wall_volume(length)
                };
                visit(
                    format!("straight/{phi}/{length}/{recess:?}"),
                    content,
                    expected,
                    1.1,
                    false,
                );
            }
        }
    }
    for phi in [0.0, 0.3, 0.5, -0.5, 0.9] {
        for length in [1.5, 4.0] {
            let (content, expected) = mixed_recess(phi, length);
            visit(
                format!("mixed/{phi}/{length}"),
                content,
                expected,
                0.2,
                phi == 0.0,
            );
        }
    }
}
