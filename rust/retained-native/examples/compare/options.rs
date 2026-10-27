// SPDX-License-Identifier: MPL-2.0
use std::{collections::BTreeSet, path::PathBuf};
pub struct Options {
    pub worker: PathBuf,
    pub out: PathBuf,
    pub models: Vec<PathBuf>,
    pub gate: bool,
    pub bless: bool,
}
pub fn options() -> Result<Options, Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (mut worker, mut out, mut manifest) = (None, None, None);
    let (mut committed, mut gate, mut bless) = (false, false, false);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--worker" => worker = Some(PathBuf::from(args.next().ok_or("--worker needs a path")?)),
            "--out" => out = Some(PathBuf::from(args.next().ok_or("--out needs a path")?)),
            "--manifest" => {
                manifest = Some(PathBuf::from(args.next().ok_or("--manifest needs a path")?))
            }
            "--committed" => committed = true,
            "--gate" => gate = true,
            "--bless" => bless = true,
            _ => return Err(format!("unknown argument {arg}").into()),
        }
    }
    if committed == manifest.is_some() {
        return Err("choose exactly one of --committed or --manifest".into());
    }
    if bless && std::env::var_os("CI").is_some() {
        return Err("--bless is forbidden in CI".into());
    }
    if bless && !committed {
        return Err("only committed coverage may be blessed".into());
    }
    let models: BTreeSet<PathBuf> = if let Some(path) = manifest {
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        let parent = path.parent().ok_or("manifest has no parent")?;
        json["files"]
            .as_array()
            .ok_or("manifest files missing")?
            .iter()
            .filter_map(|f| f["path"].as_str())
            .filter(|p| p.to_ascii_lowercase().ends_with(".ifc"))
            .map(|p| parent.join(p))
            .collect()
    } else {
        committed_models().into_iter().map(PathBuf::from).collect()
    };
    Ok(Options {
        worker: worker.ok_or("--worker required")?,
        out: out.ok_or("--out required")?,
        models: models.into_iter().collect(),
        gate,
        bless,
    })
}
fn committed_models() -> Vec<&'static str> {
    vec![
        "tests/fixtures/synthetic-retained/f-c-extrusion.ifc",
        "tests/fixtures/synthetic-retained/f-c-brep.ifc",
        "tests/fixtures/synthetic-retained/f-a-curved.ifc",
        "tests/fixtures/synthetic-retained/f-b-mapped.ifc",
        "tests/fixtures/cli-retained/layered-wall.ifc",
        "rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        "rust/geometry/tests/fixtures/mapped_instances_multi_item.ifc",
        "rust/geometry/tests/fixtures/mapped_instances_site_rotated.ifc",
        "rust/geometry/tests/fixtures/swept_disk_trimmed_line.ifc",
        "rust/geometry/tests/fixtures/issue_1985_scaled_kinds.ifc",
        "rust/geometry/tests/fixtures/issue_098_wall_W.ifc",
        "rust/geometry/tests/fixtures/bath_csg_solid.ifc",
    ]
}
