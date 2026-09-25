// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The identifier a STEP writer declares in `FILE_SCHEMA` for a schema family.
//!
//! The Rust twin of `packages/data/src/file-schema-identifier.ts` (#5351).
//! ifc-lite names schemas by family (`IFC2X3`, `IFC4`, `IFC4X3`, `IFC5`); for
//! IFC4X3 the family name is NOT the right file identifier. The attribute
//! layouts written for IFC4X3 are IFC4X3_ADD2's (ISO 16739-1:2024), while
//! IfcOpenShell 0.8.x (and the buildingSMART Validation Service built on it)
//! resolves the bare `IFC4X3` token to a later development schema whose
//! layouts differ (`IfcTriangulatedIrregularNetwork` puts `Closed` before
//! `Normals`, `IfcMapConversion` has 10 attributes, not 8). Conformant output
//! then fails `ifcopenshell.validate` purely because of the token.
//!
//! Only a writer that CHOOSES the token calls this; a re-export that keeps the
//! source's own `FILE_SCHEMA` token (header fidelity) does not.

/// The `FILE_SCHEMA` identifier to write for a schema family label.
pub(crate) fn file_schema_identifier(schema: &str) -> &str {
    if schema == "IFC4X3" {
        "IFC4X3_ADD2"
    } else {
        schema
    }
}

#[cfg(test)]
mod tests {
    use super::file_schema_identifier;
    use crate::{export_merged_models, export_step, MergedModel, MergedOptions, StepOptions};

    fn model(token: &str) -> String {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n\
             FILE_NAME('m.ifc','2026-01-01T00:00:00',('A'),('O'),'App','System','');\n\
             FILE_SCHEMA(('{token}'));\nENDSEC;\nDATA;\n\
             #1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Wall',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
        )
    }

    fn schema_line(step: &str) -> &str {
        step.lines().find(|l| l.starts_with("FILE_SCHEMA(")).expect("a FILE_SCHEMA line")
    }

    fn step_to(source: &str, target: Option<&str>) -> String {
        let opts = StepOptions { schema: target.map(str::to_string), ..StepOptions::default() };
        export_step(model(source).as_bytes(), &opts).unwrap()
    }

    /// #5351: IFC4X3 output is declared as the ISO identifier; every other
    /// label, including an exact identifier a caller already chose, passes
    /// through unchanged.
    #[test]
    fn ifc4x3_family_is_declared_as_add2() {
        assert_eq!(file_schema_identifier("IFC4X3"), "IFC4X3_ADD2");
        for label in ["IFC2X3", "IFC4", "IFC5", "IFC4X3_ADD2", "IFC4X1"] {
            assert_eq!(file_schema_identifier(label), label);
        }
    }

    /// #5351, the TypeScript twin's rule (`file-schema-identifier.test.ts`):
    /// a conversion declares the target's file identifier; a re-export that
    /// does not convert keeps the source's own token, even a bare `IFC4X3`.
    #[test]
    fn step_export_declares_add2_only_when_it_chooses_the_token() {
        assert_eq!(schema_line(&step_to("IFC4", Some("IFC4X3"))), "FILE_SCHEMA(('IFC4X3_ADD2'));");
        assert_eq!(schema_line(&step_to("IFC4X3_ADD2", Some("IFC4"))), "FILE_SCHEMA(('IFC4'));");
        assert_eq!(schema_line(&step_to("IFC4X3_ADD2", Some("IFC4X3"))), "FILE_SCHEMA(('IFC4X3_ADD2'));");
        assert_eq!(schema_line(&step_to("IFC4X3", Some("IFC4X3"))), "FILE_SCHEMA(('IFC4X3'));");
        assert_eq!(schema_line(&step_to("IFC4X3", None)), "FILE_SCHEMA(('IFC4X3'));");
    }

    /// #5351: an explicit IFC4X3 merge target is declared as IFC4X3_ADD2; with
    /// no target the first model's own token is kept.
    #[test]
    fn merged_export_declares_add2_for_an_explicit_ifc4x3_target() {
        let a = model("IFC4");
        let b = model("IFC4X3");
        let models = [
            MergedModel { content: a.as_bytes(), id: "a".into(), included: None },
            MergedModel { content: b.as_bytes(), id: "b".into(), included: None },
        ];
        let explicit = MergedOptions { schema: Some("IFC4X3".into()), ..MergedOptions::default() };
        let (out, _) = export_merged_models(&models, &explicit);
        assert_eq!(schema_line(&out), "FILE_SCHEMA(('IFC4X3_ADD2'));");
        let (out, _) = export_merged_models(&models[1..], &MergedOptions::default());
        assert_eq!(schema_line(&out), "FILE_SCHEMA(('IFC4X3'));");
    }
}
