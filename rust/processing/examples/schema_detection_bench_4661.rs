// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ad hoc perf probe for #4661: measures the cost of the case-insensitive
//! `detect_schema_version` (via `ifc_lite_core::parser::find_keyword`,
//! anchored on the rarest letter in "IFC4") against the previous
//! case-sensitive `memchr::memmem::find` search, and against a naive
//! I-anchored case-insensitive search, on a synthetic file shaped like a
//! real IFC corpus member: dense with `I`-heavy GUIDs and IFC keywords, no
//! `IFC4`/`IFC4X3` literal anywhere, so every strategy must scan to the end.
//! Not wired into CI; run with:
//!   cargo run -p ifc-lite-processing --release --example schema_detection_bench_4661

use std::time::Instant;

fn build_synthetic_ifc(target_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(target_len + 4096);
    out.extend_from_slice(b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n");
    let mut id = 1u64;
    // IFC GUIDs are base64-like and I-dense; walls/GUIDs dominate real files.
    let guid_alphabet: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
    while out.len() < target_len {
        let g0 = guid_alphabet[(id as usize * 7) % guid_alphabet.len()];
        let g1 = guid_alphabet[(id as usize * 13) % guid_alphabet.len()];
        out.extend_from_slice(
            format!(
                "#{id}=IFCWALLSTANDARDCASE('{g0}IIIIIIIIIIIIIIIIIII{g1}',#2,'Wall',$,$,#100,#101,'Tag',$);\n"
            )
            .as_bytes(),
        );
        id += 1;
    }
    out.extend_from_slice(b"ENDSEC;\nEND-ISO-10303-21;\n");
    out
}

/// The pre-#4661 case-sensitive search this replaces.
fn case_sensitive_memmem(content: &[u8]) -> Option<usize> {
    memchr::memmem::find(content, b"IFC4")
}

/// A naive case-insensitive search anchored on the FIRST letter of the
/// needle ('I'), the choice #4498 measured as the worst one available for
/// an IFC-keyword needle.
fn naive_i_anchored(content: &[u8]) -> Option<usize> {
    let mut from = 0usize;
    loop {
        let rel = memchr::memchr2(b'I', b'i', content.get(from..)?)?;
        let hit = from + rel;
        from = hit + 1;
        let end = hit + 4;
        if end <= content.len() && content[hit..end].eq_ignore_ascii_case(b"IFC4") {
            return Some(hit);
        }
    }
}

fn time_it<F: Fn(&[u8]) -> Option<usize>>(name: &str, content: &[u8], f: F, iters: u32) {
    // Warm up.
    for _ in 0..3 {
        std::hint::black_box(f(std::hint::black_box(content)));
    }
    let start = Instant::now();
    for _ in 0..iters {
        std::hint::black_box(f(std::hint::black_box(content)));
    }
    let elapsed = start.elapsed();
    println!(
        "{name:32} {:>10.3} ms/iter  ({:>4} iters, total {:.1} ms)",
        elapsed.as_secs_f64() * 1000.0 / iters as f64,
        iters,
        elapsed.as_secs_f64() * 1000.0
    );
}

fn main() {
    for &size_mb in &[20usize, 60, 120] {
        let content = build_synthetic_ifc(size_mb * 1024 * 1024);
        println!("\n--- synthetic file: {} MB, {} bytes ---", size_mb, content.len());
        let iters = if size_mb <= 20 { 30 } else { 10 };
        time_it("case-sensitive memmem (old)", &content, case_sensitive_memmem, iters);
        time_it("naive I-anchored (worst case)", &content, naive_i_anchored, iters);
        time_it(
            "find_keyword, F-anchored (new)",
            &content,
            |c| ifc_lite_core::parser::find_keyword(c, b"IFC4"),
            iters,
        );
    }
}
