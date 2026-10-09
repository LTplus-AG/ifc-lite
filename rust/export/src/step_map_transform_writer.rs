// SPDX-License-Identifier: MPL-2.0
//! Precise STEP patch serialization; unchanged entity slots keep source bytes.

use std::collections::BTreeMap;
use nalgebra::Matrix4;
use super::{MapConversionEntityPatch, Record};
use crate::step_text::{apply_attr_mutations_counted, attribute_of};

pub(super) struct Writer { next: u32, entities: Vec<MapConversionEntityPatch>, origin: Option<(u32, u32)> }

impl Writer {
    pub(super) fn new(records: &[Record<'_>]) -> Result<Self, String> {
        let max = records.iter().map(|record| record.id).max().unwrap_or(0);
        Ok(Self { next: max.checked_add(1).ok_or("express ID space exhausted")?, entities: Vec::new(), origin: None })
    }

    fn entity(&mut self, kind: &str, arguments: String) -> Result<u32, String> {
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or("express ID space exhausted")?;
        self.entities.push(MapConversionEntityPatch { express_id: id, line: format!("#{id}={kind}({arguments});") });
        Ok(id)
    }

    pub(super) fn frame(&mut self, matrix: &Matrix4<f64>) -> Result<u32, String> {
        let point = self.entity("IFCCARTESIANPOINT", triple(matrix[(0, 3)], matrix[(1, 3)], matrix[(2, 3)])?)?;
        let axis = self.entity("IFCDIRECTION", triple(matrix[(0, 2)], matrix[(1, 2)], matrix[(2, 2)])?)?;
        let reference = self.entity("IFCDIRECTION", triple(matrix[(0, 0)], matrix[(1, 0)], matrix[(2, 0)])?)?;
        self.entity("IFCAXIS2PLACEMENT3D", format!("#{point},#{axis},#{reference}"))
    }

    pub(super) fn placement(&mut self, matrix: &Matrix4<f64>) -> Result<u32, String> {
        let frame = self.frame(matrix)?;
        self.entity("IFCLOCALPLACEMENT", format!("$,#{frame}"))
    }

    pub(super) fn mapped_representation(&mut self, source: &Record<'_>, _context: u32, scale: f64) -> Result<u32, String> {
        let (point, frame) = match self.origin {
            Some(origin) => origin,
            None => {
                let point = self.entity("IFCCARTESIANPOINT", "(0.,0.,0.)".into())?;
                let frame = self.entity("IFCAXIS2PLACEMENT3D", format!("#{point},$,$"))?;
                self.origin = Some((point, frame));
                (point, frame)
            }
        };
        let operator = self.entity("IFCCARTESIANTRANSFORMATIONOPERATOR3D", format!("$,$,#{point},{},$", real(scale)?))?;
        let map = self.entity("IFCREPRESENTATIONMAP", format!("#{frame},#{}", source.id))?;
        let item = self.entity("IFCMAPPEDITEM", format!("#{map},#{operator}"))?;
        let context = attribute_of(source.line, 0).ok_or("invalid representation ContextOfItems")?;
        let identifier = attribute_of(source.line, 1).ok_or("invalid representation identifier")?;
        self.entity("IFCSHAPEREPRESENTATION", format!("{context},{identifier},'MappedRepresentation',(#{item})"))
    }

    pub(super) fn direction_2d(&mut self, x: f64, y: f64) -> Result<u32, String> {
        self.entity("IFCDIRECTION", format!("({},{})", real(x)?, real(y)?))
    }

    pub(super) fn finish(self) -> Vec<MapConversionEntityPatch> { self.entities }
}

pub(super) fn replace(record: &Record<'_>, edits: &[(usize, String)]) -> Result<MapConversionEntityPatch, String> {
    let mut refused = 0;
    let changes: BTreeMap<_, _> = edits.iter().cloned().collect();
    let line = apply_attr_mutations_counted(record.line, &changes, &mut refused);
    if refused > 0 { return Err(format!("entity #{} cannot be patched exactly", record.id)); }
    Ok(MapConversionEntityPatch { express_id: record.id, line })
}

/// Replace a whole record under its original ID, e.g. to change its entity type.
pub(super) fn retype(record: &Record<'_>, kind: &str, arguments: String) -> MapConversionEntityPatch {
    MapConversionEntityPatch { express_id: record.id, line: format!("#{}={kind}({arguments});", record.id) }
}

pub(super) fn real(value: f64) -> Result<String, String> {
    if !value.is_finite() { return Err("non-finite STEP REAL".into()); }
    let text = value.to_string();
    let (mantissa, exponent) = text.split_once(['e', 'E']).map_or((text.as_str(), None), |(a, b)| (a, Some(b)));
    let decimal = if mantissa.contains('.') { mantissa.to_string() } else { format!("{mantissa}.") };
    Ok(exponent.map_or_else(|| decimal.clone(), |exponent| format!("{decimal}E{exponent}")))
}

fn triple(x: f64, y: f64, z: f64) -> Result<String, String> { Ok(format!("({},{},{})", real(x)?, real(y)?, real(z)?)) }
pub(super) fn refs(ids: &[u32]) -> String { format!("({})", ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(",")) }
