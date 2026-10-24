// SPDX-License-Identifier: MPL-2.0
//! Conservative accounting for the new proof's owned source-record copies.
//! This is an audited allocation bound, not an opaque SDK/RSS bound.
use super::{AnalyticBoundarySource, SourceValue};

pub(super) fn copy(source: Option<&AnalyticBoundarySource>, multiplier: u64) -> Result<(), String> {
    let Some(source) = source else { return Ok(()) };
    let mut work = 1_000_000usize;
    let mut bytes = 256u64;
    for record in source.records.values() {
        bytes += 256 + record.ifc_type_name.len() as u64;
        for (name,value) in &record.attributes {
            bytes += 256 + name.len() as u64 + size(value,0,&mut work)?;
        }
    }
    let bytes = bytes.checked_mul(multiplier).ok_or("region source copy overflow")?;
    crate::resource::charge(crate::resource::Cost { copy_bytes: bytes, live_bytes: bytes,
        work: (1_000_000-work) as u64, ..Default::default() }).map_err(|e| e.to_string())?.retain();
    Ok(())
}
fn size(value: &SourceValue, depth: usize, work: &mut usize) -> Result<u64,String> {
    *work = work.checked_sub(1).ok_or("region source copy work budget exceeded")?;
    if depth > 32 { return Err("region source copy depth exceeded".into()); }
    let mut bytes = std::mem::size_of::<SourceValue>() as u64;
    match value {
        SourceValue::String(s) | SourceValue::Binary(s) | SourceValue::Enum(s) => bytes += s.len() as u64,
        SourceValue::List(values) => {
            for value in values { bytes += size(value,depth+1,work)?; }
        }
        SourceValue::Typed { name,value } => bytes += name.len() as u64 + size(value,depth+1,work)?,
        _ => (),
    }
    Ok(bytes)
}
