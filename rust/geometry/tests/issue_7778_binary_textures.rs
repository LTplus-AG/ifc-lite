// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F4-1 (#7778, CORE-32, PROC-AL-14, D18): a texture binary that does not
//! decode exactly is refused and counted, instead of being read as a prefix.
//! The old reader skipped any unused-bits indicator and stopped at the first
//! non-hex byte, so `"1FF0000"` (not byte-aligned) became pixel bytes.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{binary_textures_refused, build_texture_index};

fn model(pixel: &str) -> String {
    format!(
        "ISO-10303-21;\nDATA;\n\
         #1=IFCPIXELTEXTURE(.T.,.T.,'MODULATE',$,$,1,1,3,({pixel}));\n\
         #2=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));\n\
         #5=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#4,#2,((1,2,3)));\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn indexed(pixel: &str) -> bool {
    let content = model(pixel);
    let mut decoder = EntityDecoder::new(&content);
    build_texture_index(content.as_bytes(), &mut decoder).contains_key(&4)
}

/// One test: the refusal counter is process-wide, so two tests in this
/// binary would see each other's refusals.
#[test]
fn only_a_binary_that_decodes_exactly_builds_a_texture() {
    let before = binary_textures_refused();
    assert!(indexed("\"0FF0000\""));
    assert!(indexed("\"0ff0000\""), "hex is case-insensitive");
    assert_eq!(binary_textures_refused(), before, "aligned binaries are not refused");

    // Not byte-aligned (indicator), or an odd digit count.
    for bad in ["\"1FF0000\"", "\"3FF0000\"", "\"0FF000\""] {
        let before = binary_textures_refused();
        assert!(!indexed(bad), "{bad} must not build a texture");
        assert_eq!(binary_textures_refused(), before + 1, "{bad} must be counted once");
    }
    // A non-hex byte is no binary token at all: the record fails to tokenize.
    assert!(!indexed("\"0FF00G0\""));
}
