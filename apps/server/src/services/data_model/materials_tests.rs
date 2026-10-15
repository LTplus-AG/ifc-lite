// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! SERVER-5 (#7673): `resolve_material` followed `IfcMaterial*SetUsage`
//! attribute 0 by recursing into whatever it named, with no type check and no
//! bound. A usage that names itself recursed until the stack overflowed, and a
//! stack overflow is `SIGABRT`, not a panic: `CatchPanicLayer` and the
//! `server-release` unwind profile cannot contain it, so every in-flight
//! request on the server died with it.

use crate::services::data_model::{extract_data_model, DataModel, MaterialAssociation};

fn materials_of(dm: &DataModel, element_id: u32) -> Vec<&MaterialAssociation> {
    dm.materials.iter().filter(|m| m.element_id == element_id).collect()
}

/// Number of usages in the acyclic `usage -> usage -> ... -> set` chain. A
/// visited set alone does not bound this shape while the walk recurses: every
/// id is new, so the chain overflows the stack anyway (AGENTS.md, "Bounding
/// walks over file-supplied references"). Only an iterative walk survives it.
const CHAIN_LEN: u32 = 20_000;

/// The hostile file: each wall's `RelatingMaterial` is a usage whose
/// `ForLayerSet` / `ForProfileSet` does not name a set.
///
/// - #10 is the reproduction from the finding: a layer-set usage naming itself.
/// - #11 is the same for a profile-set usage.
/// - #12 -> #13 -> #12 is a mutual cycle across the two usage kinds.
/// - #1000.. is a long acyclic usage chain ending in a real set. Malformed
///   (`ForLayerSet` should name a set), but the pre-fix walk and the TS twin
///   both follow it, so it must keep resolving.
/// - #40 is a well-formed usage -> set, the control that the walk still
///   resolves real input in the same file.
fn hostile_usage_ifc() -> String {
    let mut data = String::from(
        "#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#3=IFCWALL('Wall00000000000000003',$,'W3',$,$,$,$,$,$);
#4=IFCBEAM('Beam00000000000000004',$,'B4',$,$,$,$,$,$);
#5=IFCWALL('Wall00000000000000005',$,'W5',$,$,$,$,$,$);
#6=IFCWALL('Wall00000000000000006',$,'W6',$,$,$,$,$,$);
#7=IFCWALL('Wall00000000000000007',$,'W7',$,$,$,$,$,$);
#10=IFCMATERIALLAYERSETUSAGE(#10,.AXIS2.,.POSITIVE.,0.,$);
#11=IFCMATERIALPROFILESETUSAGE(#11,$,$);
#12=IFCMATERIALLAYERSETUSAGE(#13,.AXIS2.,.POSITIVE.,0.,$);
#13=IFCMATERIALPROFILESETUSAGE(#12,$,$);
#20=IFCRELASSOCIATESMATERIAL('Mat0000000000000000020',$,$,$,(#3),#10);
#21=IFCRELASSOCIATESMATERIAL('Mat0000000000000000021',$,$,$,(#4),#11);
#22=IFCRELASSOCIATESMATERIAL('Mat0000000000000000022',$,$,$,(#5),#12);
#23=IFCRELASSOCIATESMATERIAL('Mat0000000000000000023',$,$,$,(#6),#1000);
#40=IFCMATERIALLAYERSETUSAGE(#41,.AXIS2.,.POSITIVE.,0.,$);
#41=IFCMATERIALLAYERSET((#42),'GoodSet',$);
#42=IFCMATERIALLAYER(#43,200.,.F.,'Core',$,$,$);
#43=IFCMATERIAL('Concrete',$,$);
#44=IFCRELASSOCIATESMATERIAL('Mat0000000000000000044',$,$,$,(#7),#40);
",
    );
    for i in 0..CHAIN_LEN {
        let id = 1000 + i;
        let next = if i + 1 == CHAIN_LEN { 41 } else { id + 1 };
        data.push_str(&format!("#{id}=IFCMATERIALLAYERSETUSAGE(#{next},.AXIS2.,.POSITIVE.,0.,$);\n"));
    }
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// SERVER-5 (#7673). The walk runs on rayon workers inside
/// `extract_data_model`, and an unbounded one dies by stack overflow, which
/// would take the test runner down with it. So the reproduction runs in a
/// child copy of this test binary and the parent asserts the child exited
/// cleanly rather than by signal (same pattern as the #3973 spatial-cycle
/// tests in `tests.rs`).
#[test]
fn self_and_mutually_referencing_material_usages_do_not_abort_server_5() {
    const REPRO_ENV_VAR: &str = "IFC_LITE_SERVER_5_MATERIAL_USAGE_REPRO";

    if std::env::var(REPRO_ENV_VAR).is_ok() {
        let content = hostile_usage_ifc();
        let dm = extract_data_model(&content);
        for element in [3, 4, 5] {
            assert!(
                materials_of(&dm, element).is_empty(),
                "element #{element}: a usage that does not name a set resolves to no material"
            );
        }
        // Element #6 is the long acyclic chain and #7 the well-formed control:
        // both still resolve the set, as they did before the fix and as the
        // TS twin does.
        for element in [6, 7] {
            let rows = materials_of(&dm, element);
            assert_eq!(rows.len(), 1, "element #{element}: the usage resolves its set");
            assert_eq!(rows[0].material_name, "Concrete");
            assert_eq!(rows[0].set_name.as_deref(), Some("GoodSet"));
        }
        eprintln!("SERVER-5 repro resolved {} material rows without aborting", dm.materials.len());
        std::process::exit(0);
    }

    let exe = std::env::current_exe().expect("current test exe");
    // libtest's `--exact` names are not crate-qualified (see `tests.rs`).
    let test_name =
        "services::data_model::materials::tests::self_and_mutually_referencing_material_usages_do_not_abort_server_5";
    let mut child = std::process::Command::new(exe)
        .args([test_name, "--exact", "--nocapture"])
        .env(REPRO_ENV_VAR, "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("failed to spawn child test process");
    // The bound has two failure modes: recursion overflows the stack, and an
    // iterative walk whose visited set stopped firing spins forever. Kill a
    // child that runs far past the ~1 s this takes, so the second shape fails
    // here instead of hanging CI.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while child.try_wait().expect("poll child").is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let output = child.wait_with_output().expect("collect child output");

    assert!(
        output.status.success(),
        "a self- or mutually-referencing IfcMaterial*SetUsage must neither abort the process \
         nor hang; child exit status = {:?}\n--- child stdout ---\n{}\n--- child stderr ---\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The usage arms had no positive coverage in this crate: every existing
/// material fixture associates the set directly. Pins that a layer-set usage
/// and a profile-set usage each resolve their set's members, with the usage
/// recorded as the association's definition.
#[test]
fn layer_and_profile_set_usages_resolve_their_sets() {
    const USAGE_IFC: &str = "ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#3=IFCWALL('Wall00000000000000003',$,'W3',$,$,$,$,$,$);
#4=IFCBEAM('Beam00000000000000004',$,'B4',$,$,$,$,$,$);
#10=IFCMATERIAL('Concrete',$,'Mineral');
#11=IFCMATERIAL('Insulation',$,$);
#12=IFCMATERIALLAYER(#10,0.2,.F.,'Core',$,$,$);
#13=IFCMATERIALLAYER(#11,0.05,.T.,'Insul',$,$,$);
#14=IFCMATERIALLAYERSET((#12,#13),'WallSet',$);
#15=IFCMATERIALLAYERSETUSAGE(#14,.AXIS2.,.POSITIVE.,0.,$);
#16=IFCRELASSOCIATESMATERIAL('Mat0000000000000000016',$,$,$,(#3),#15);
#20=IFCMATERIAL('Timber',$,'Wood');
#21=IFCMATERIALPROFILE('Flange',$,#20,$,$,$);
#22=IFCMATERIALPROFILESET('BeamSet',$,(#21),$);
#23=IFCMATERIALPROFILESETUSAGE(#22,$,$);
#24=IFCRELASSOCIATESMATERIAL('Mat0000000000000000024',$,$,$,(#4),#23);
ENDSEC;
END-ISO-10303-21;
";
    let dm = extract_data_model(USAGE_IFC);

    let wall = materials_of(&dm, 3);
    assert_eq!(wall.len(), 2);
    assert!(wall.iter().all(|m| m.kind == "IfcMaterialLayerSet" && m.definition_id == 15));
    assert_eq!(wall[0].material_name, "Concrete");
    assert_eq!(wall[1].material_name, "Insulation");
    assert_eq!(wall[0].set_name.as_deref(), Some("WallSet"));
    assert_eq!(wall[1].is_ventilated, Some(true));

    let beam = materials_of(&dm, 4);
    assert_eq!(beam.len(), 1);
    assert_eq!(beam[0].kind, "IfcMaterialProfileSet");
    assert_eq!(beam[0].definition_id, 23);
    assert_eq!(beam[0].material_name, "Timber");
    assert_eq!(beam[0].set_name.as_deref(), Some("BeamSet"));
}
