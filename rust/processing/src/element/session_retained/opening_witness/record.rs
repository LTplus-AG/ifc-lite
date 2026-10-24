// SPDX-License-Identifier: MPL-2.0
//! #7955 R3: mutations of real source records at each proof boundary.
use super::removal_sources;
pub(in super::super) fn tail(id: u32, suffix: &str) -> String {
    removal_sources().remove(0).lines().map(|line| {
        if line.starts_with(&format!("#{id}=")) {
            format!("{}{suffix}",line.strip_suffix(';').unwrap())
        } else { line.to_owned() }
    }).collect::<Vec<_>>().join("\n")
}
pub(in super::super) fn cases() -> Vec<(&'static str,String)> {
    let mut cases = Vec::new();
    for id in [40,41] {
        for suffix in ["(2.);","BOGUS();",");"," /*trivia*/ ((2.));"] {
            cases.push(("J2_RECORD_COMPLETE",tail(id,suffix)));
        }
    }
    cases
}
pub(in super::super) fn trivia() -> String {
    removal_sources().remove(0).lines().map(|line| {
        if line.starts_with('#') { format!("{} /*record ) ,*/ ;",line.strip_suffix(';').unwrap()) }
        else { line.to_owned() }
    }).collect::<Vec<_>>().join("\n")
}
