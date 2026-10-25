// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Columnar transport for precomputed fingerprints. JsString dictionaries and
//! numeric buffers cross once; opaque JS references remain in the caller.
use crate::JsString;
use std::collections::HashMap;
use crate::model::{EntityAabb, EntityFingerprint};
pub const ABSENT_STRING: u32 = u32::MAX;
/// Five string indices per row: key, IFC class, data hash, geometry hash,
/// container. Only geometry/container may use ABSENT_STRING.
#[derive(Debug, Default)]
pub struct FingerprintColumns {
    pub strings: Vec<JsString>,
    pub fields: Vec<u32>,
    /// Bit 0: aabb present, bit 1: volume present, bit 2: components present.
    pub flags: Vec<u8>,
    /// Six values per row, min xyz then max xyz, even for absent boxes.
    pub boxes: Vec<f64>,
    pub volumes: Vec<f64>,
    /// Row count + 1 offsets into component_pairs, measured in pairs.
    pub component_offsets: Vec<u32>,
    pub component_pairs: Vec<u32>,
}
pub fn decode_columns(columns: FingerprintColumns) -> Result<Vec<EntityFingerprint<usize>>, String> {
    let count = columns.flags.len();
    if count.checked_mul(5) != Some(columns.fields.len()) || count.checked_mul(6) != Some(columns.boxes.len()) || columns.volumes.len() != count {
        return Err("fingerprint column lengths disagree".into());
    }
    if columns.component_offsets.len() != count + 1 || !columns.component_pairs.len().is_multiple_of(2) {
        return Err("component column lengths disagree".into());
    }
    let offsets = &columns.component_offsets;
    if offsets.first() != Some(&0) || offsets.last().copied().map(|n|n as usize) != Some(columns.component_pairs.len()/2)
        || offsets.windows(2).any(|w|w[0]>w[1]) {
        return Err("component offsets are not a complete monotonic partition".into());
    }
    let string = |index: u32| columns.strings.get(index as usize).cloned().ok_or_else(||"fingerprint string index out of range".to_owned());
    let optional = |index: u32| if index == ABSENT_STRING { Ok(None) } else { string(index).map(Some) };
    let mut result = Vec::with_capacity(count);
    for row in 0..count {
        let fields = &columns.fields[row*5..row*5+5];
        let flags = columns.flags[row];
        if flags & !7 != 0 { return Err("unknown fingerprint presence flags".into()); }
        let component_start = offsets[row] as usize * 2;
        let component_end = offsets[row+1] as usize * 2;
        if flags & 4 == 0 && component_start != component_end { return Err("absent components carry values".into()); }
        let components = if flags & 4 != 0 {
            let mut map = HashMap::new();
            for pair in columns.component_pairs[component_start..component_end].chunks_exact(2) {
                map.insert(string(pair[0])?,string(pair[1])?);
            }
            Some(map)
        } else { None };
        result.push(EntityFingerprint { key:string(fields[0])?,ifc_type:string(fields[1])?,data_hash:string(fields[2])?,
            geometry_hash:optional(fields[3])?,container:optional(fields[4])?,
            aabb:if flags & 1 != 0 {Some(EntityAabb {min:std::array::from_fn(|i|columns.boxes[row*6+i]),max:std::array::from_fn(|i|columns.boxes[row*6+3+i])})} else {None},
            volume:if flags & 2 != 0 {Some(columns.volumes[row])} else {None},components,reference:row });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn columns() -> FingerprintColumns {
        FingerprintColumns {strings:vec!["key".into(),"IfcWall".into(),"data".into()],fields:vec![0,1,2,ABSENT_STRING,ABSENT_STRING],
            flags:vec![0],boxes:vec![0.0;6],volumes:vec![0.0],component_offsets:vec![0,0],component_pairs:vec![]}
    }
    #[test]
    fn issue_8042_columns_preserve_absence_empty_and_nonfinite() {
        let absent = decode_columns(columns()).unwrap();
        assert!(absent[0].components.is_none()); assert!(absent[0].aabb.is_none()); assert!(absent[0].volume.is_none());
        let mut input=columns(); input.flags[0]=7; input.boxes[0]=f64::NAN; input.volumes[0]=f64::INFINITY;
        let present=decode_columns(input).unwrap();
        assert_eq!(present[0].components,Some(HashMap::new()));
        assert!(present[0].aabb.as_ref().unwrap().min[0].is_nan());
        assert_eq!(present[0].volume,Some(f64::INFINITY));
        assert_eq!(present[0].reference,0);
    }
    #[test]
    fn issue_8042_malformed_columns_refuse_without_partial_results() {
        let mut input=columns(); input.fields[0]=10; assert!(decode_columns(input).is_err());
        let mut input=columns(); input.component_offsets=vec![0,1]; assert!(decode_columns(input).is_err());
        let mut input=columns(); input.flags[0]=8; assert!(decode_columns(input).is_err());
        let mut input=columns(); input.boxes.pop(); assert!(decode_columns(input).is_err());
        assert!(decode_columns(FingerprintColumns {component_offsets:vec![0],..Default::default()}).unwrap().is_empty());
    }
}
