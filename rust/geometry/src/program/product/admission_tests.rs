// SPDX-License-Identifier: MPL-2.0
//! #7781: admission is shared by merged/styled and synchronous/stepped paths.
use super::*;
#[path = "../../../tests/support/profile_walk_model.rs"]
mod model;

fn triangles(output: ProductOutput) -> usize {
    match output {
        ProductOutput::Parts(parts) => parts.iter().map(Mesh::triangle_count).sum(),
        ProductOutput::Styled(parts) => parts.sub_meshes.iter().map(|p| p.mesh.triangle_count()).sum(),
    }
}

fn run(content: &str, allowance: u32, styled: bool, stepped: bool, warm: bool) -> (usize, u64) {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::new();
    let wall = decoder.decode_by_id(100).unwrap();
    if warm { router.process_element(&wall, &mut decoder).unwrap(); }
    let mut control = if styled {
        ProductControl::styled(&wall, false, None, SourceHygiene::Watertight)
    } else {
        ProductControl::merged(&wall, SourceHygiene::Watertight)
    };
    control.allowance = allowance;
    if stepped {
        while control.stage().unwrap().is_some() {
            let reply = control.execute(&router, &mut decoder).unwrap();
            control.accept(reply, &router);
        }
    } else {
        control.run(&router, &mut decoder).unwrap();
    }
    (triangles(control.take_result().unwrap().unwrap()), router.take_unsupported_items().values().sum())
}

#[test]
fn issue_7781_cached_product_roots_pay_the_same_logical_cost() {
    let content = model::chain(1);
    for styled in [false, true] {
        for stepped in [false, true] {
            for warm in [false, true] {
                assert_eq!(run(&content, 1, styled, stepped, warm), (0, 1));
                assert_eq!(run(&content, 2, styled, stepped, warm), (12, 0));
            }
        }
    }
}

#[test]
fn issue_7781_completed_root_survives_atomic_later_root_refusal() {
    let content = model::wall("#160", &format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#140,#1000,#240));\n{}",
        model::TARGET, model::mapped(1000, "#240")));
    for styled in [false, true] {
        for stepped in [false, true] {
            for warm in [false, true] {
                // The full root list costs three; entering the mapped root
                // needs a fourth item debit. Only the first solid survives.
                assert_eq!(run(&content, 3, styled, stepped, warm), (12, 1));
                assert_eq!(run(&content, 4, styled, stepped, warm), (36, 0));
            }
        }
    }
}
