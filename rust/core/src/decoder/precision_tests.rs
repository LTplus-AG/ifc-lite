// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::EntityDecoder;

#[test]
fn issue_6316_uses_declared_context_precision_range_without_inventing_default() {
    let content = b"ISO-10303-21;DATA;
#1=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-6,$,$);
#2=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#1,$,.MODEL_VIEW.,$);
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-5,$,$);
ENDSEC;END-ISO-10303-21;";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.geometric_context_precision_range().unwrap(), Some((1e-6, 1e-5)));
    assert_eq!(decoder.geometric_context_precision_range().unwrap(), Some((1e-6, 1e-5)));

    let mut absent = EntityDecoder::new(b"ISO-10303-21;DATA;#1=IFCWALL($,$,$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;");
    assert_eq!(absent.geometric_context_precision_range().unwrap(), None);
}

#[test]
fn issue_6316_invalid_declared_precision_does_not_become_zero() {
    let content = b"ISO-10303-21;DATA;
#1=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,-1.E-5,$,$);
ENDSEC;END-ISO-10303-21;";
    let mut decoder = EntityDecoder::new(content);
    for _ in 0..2 {
        let error = decoder.geometric_context_precision_range().unwrap_err();
        assert!(error.to_string().contains("context #1 has invalid Precision"));
    }
}
