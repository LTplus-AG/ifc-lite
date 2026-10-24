// SPDX-License-Identifier: MPL-2.0
//! #7955 R2-GRAMMAR: real source vector suffixes, not source-text assertions.
use super::removal_sources;
pub(in super::super) fn cases() -> Vec<(&'static str, String)> {
    let source = removal_sources().remove(0);
    vec![
        ("J2_VECTOR_DIRECTION", source.replace("#40= IFCDIRECTION((1.,0.));", "#40=IFCDIRECTION((1.,0.)BOGUS);")),
        ("J2_VECTOR_POINT", source.replace("#41= IFCCARTESIANPOINT((2.,0.1));", "#41=IFCCARTESIANPOINT((2.,0.1)BOGUS);")),
        ("J2_VECTOR_COMMENT_SUFFIX", source.replace("#40= IFCDIRECTION((1.,0.));", "#40=IFCDIRECTION((1.,0.) /*trivia*/ BOGUS);")),
    ]
}
pub(in super::super) fn trivia() -> String {
    removal_sources().remove(0)
        .replace("#40= IFCDIRECTION((1.,0.));", "#40=IFCDIRECTION(/*before*/ (1.,0.) /*after ) , */ );")
        .replace("#41= IFCCARTESIANPOINT((2.,0.1));", "#41=IFCCARTESIANPOINT( (2.,0.1) /*point*/ );")
}
