// SPDX-License-Identifier: MPL-2.0
//! inspect typed authored sources through the shared bounded source walk.
//! cargo run -p ifc-lite-processing --example authored_geometry -- model.ifc
//! This emits source plans and unresolved requirements, never final net geometry.

use ifc_lite_processing::authored_geometry::plan_authored_geometry;
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("pass an IFC file path")?;
    let content = std::fs::read(path)?;
    let plan = plan_authored_geometry(&content, None);
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &plan)?;
    output.write_all(b"\n")?;
    Ok(())
}
