// SPDX-License-Identifier: MPL-2.0
use super::{export_merged_with_stats, MergedOptions};

/// Merge whole models into a STEP file, returning `InvalidData` with the
/// record diagnostic if conversion is refused.
pub fn try_export_merged(models: &[&[u8]], opts: &MergedOptions) -> std::io::Result<String> {
    let (out, stats) = export_merged_with_stats(models, opts);
    if out.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, stats.warnings.join("\n")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallible_merge_returns_wr22_with_the_record_id_11117() {
        let source = b"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#5=IFCPROPERTYBOUNDEDVALUE('Dates',$,IFCDATE('2026-12-01'),$,$,$);
ENDSEC;
END-ISO-10303-21;
";
        let opts = MergedOptions { schema: Some("IFC2X3".into()), ..Default::default() };
        let error = try_export_merged(&[source], &opts).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        let diagnostic = error.to_string();
        assert!(diagnostic.contains("#5") && diagnostic.contains("IfcPropertyBoundedValue") && diagnostic.contains("WR22"), "{diagnostic}");
    }
}
