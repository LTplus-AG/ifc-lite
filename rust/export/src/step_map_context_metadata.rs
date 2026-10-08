// SPDX-License-Identifier: MPL-2.0
//! TrueNorth belongs to the engineering frame, including its implicit +Y default.
//! Clone metadata directions when baking map rotation; shared input IDs stay intact.
use super::{writer, MapConversionNormalizationPlan, Record};
use ifc_lite_core::{EntityDecoder, IfcType};
use nalgebra::Matrix4;
use std::collections::{HashMap, HashSet};

pub(super) fn transform_north(
    records: &[Record<'_>],
    ids: &HashMap<u32, usize>,
    contexts: &HashSet<u32>,
    affine: &Matrix4<f64>,
    decoder: &mut EntityDecoder,
    output: &mut writer::Writer,
    plan: &mut MapConversionNormalizationPlan,
) -> Result<(), String> {
    let mut contexts: Vec<_> = contexts.iter().copied().collect();
    contexts.sort_unstable();
    for id in contexts {
        let context = decoder
            .decode_by_id(id)
            .map_err(|error| error.to_string())?;
        let direction = match context.get(5).filter(|attr| !attr.is_null()) {
            None => [0., 1.],
            Some(attr) => {
                let reference = attr.as_entity_ref().ok_or("TrueNorth is not a reference")?;
                let node = decoder
                    .decode_by_id(reference)
                    .map_err(|error| error.to_string())?;
                if node.ifc_type != IfcType::IfcDirection {
                    return Err("TrueNorth is not an IfcDirection".into());
                }
                let values = node
                    .get_list(0)
                    .filter(|values| values.len() == 2)
                    .ok_or("TrueNorth requires exactly two direction ratios")?;
                let x = values[0]
                    .as_float()
                    .filter(|x| x.is_finite())
                    .ok_or("TrueNorth ratio must be finite")?;
                let y = values[1]
                    .as_float()
                    .filter(|y| y.is_finite())
                    .ok_or("TrueNorth ratio must be finite")?;
                let length = x.hypot(y);
                if !length.is_finite() || length == 0. {
                    return Err("TrueNorth direction is zero or unbounded".into());
                }
                [x / length, y / length]
            }
        };
        let x = affine[(0, 0)] * direction[0] + affine[(0, 1)] * direction[1];
        let y = affine[(1, 0)] * direction[0] + affine[(1, 1)] * direction[1];
        let length = x.hypot(y);
        if !length.is_finite() || length == 0. {
            return Err("transformed TrueNorth is zero or unbounded".into());
        }
        let direction = output.direction_2d(x / length, y / length)?;
        let record = &records[*ids.get(&id).ok_or("context record is absent")?];
        plan.replacements
            .push(writer::replace(record, &[(5, format!("#{direction}"))])?);
    }
    Ok(())
}
