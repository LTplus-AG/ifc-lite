// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-FFI-12 (#7694): the alignment sampler takes raw STEP bytes like every
//! processing entry point. A Latin-1 byte inside a string (legal ISO-8859-1
//! STEP text) must not change the sampled axes versus the ASCII twin.

use ifc_lite_geometry::{sample_alignment_axes, AlignmentAxis};

fn model(name: &[u8]) -> Vec<u8> {
    let mut out = b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10.,0.,1.));
#12=IFCPOLYLINE((#10,#11));#20=IFCALIGNMENT('a',$,'"
        .to_vec();
    out.extend_from_slice(name);
    out.extend_from_slice(b"',$,$,$,$,#12);ENDSEC;END-ISO-10303-21;");
    out
}

#[test]
fn issue_7694_alignment_sampling_accepts_latin1_bytes() {
    let ascii = model(b"Strasse");
    let latin1 = model(b"Stra\xdfe");
    assert!(std::str::from_utf8(&latin1).is_err());

    let a = sample_alignment_axes(&ascii, Default::default()).unwrap();
    let l = sample_alignment_axes(&latin1, Default::default()).unwrap();
    assert!(a.diagnostics.is_empty() && l.diagnostics.is_empty());
    assert_eq!(l.axes.len(), 1);
    let json = |r: &ifc_lite_geometry::AlignmentSamplingReport| serde_json::to_string(&r.axes[0].samples).unwrap();
    assert_eq!(json(&l), json(&a));

    let axis = AlignmentAxis::from_content(&latin1, 20).unwrap();
    assert!(axis.length_m() > 0.0);
    // `&str` callers keep compiling through the same generic entry point.
    let text = String::from_utf8(ascii).unwrap();
    assert_eq!(sample_alignment_axes(&text, Default::default()).unwrap().axes.len(), 1);
}

/// CORE-16 (F4 M-geom): `get_string` is already decoded, and the axis decoded
/// it a second time. A name whose DECODED text spells an escape (`\\` is one
/// backslash in STEP) was read as that escape: `C:\X2\00E9\X0\` came back as
/// `C:é`.
#[test]
fn core_16_alignment_names_are_decoded_once() {
    let content = br#"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10.,0.,1.));
#12=IFCPOLYLINE((#10,#11));#20=IFCALIGNMENT('g\\X2\\0041\\X0\\',$,'C:\\X2\\00E9\\X0\\ \X2\00FC\X0\ber',$,$,$,$,#12);ENDSEC;END-ISO-10303-21;"#;
    let axis = AlignmentAxis::from_content(&content[..], 20).unwrap();
    // The decoder reads the name once: `\\` is one backslash, and what
    // follows it is plain text. The genuine escape (`\X2\00FC\X0\`) decodes to
    // u-umlaut.
    assert_eq!(axis.GlobalId.as_deref(), Some(r"g\X2\0041\X0\"));
    assert_eq!(axis.Name.as_deref(), Some("C:\\X2\\00E9\\X0\\ \u{fc}ber"));
}
