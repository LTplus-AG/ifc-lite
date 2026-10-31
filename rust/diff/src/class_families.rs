// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::JsString;
use std::collections::HashMap;
pub const DEFAULT_CLASS_FAMILIES: &[&[&str]] = &[
    &["IfcWall", "IfcWallStandardCase", "IfcWallElementedCase", "IfcBuildingElementPart"],
    &["IfcSlab", "IfcSlabStandardCase", "IfcSlabElementedCase"],
    &["IfcBeam", "IfcBeamStandardCase"], &["IfcColumn", "IfcColumnStandardCase"],
    &["IfcMember", "IfcMemberStandardCase"], &["IfcPlate", "IfcPlateStandardCase"],
    &["IfcDoor", "IfcDoorStandardCase"], &["IfcWindow", "IfcWindowStandardCase"],
    &["IfcOpeningElement", "IfcOpeningStandardCase"],
    &["IfcFurniture", "IfcFurnishingElement", "IfcSystemFurnitureElement"],
];
pub fn normalize_class(value: &JsString) -> JsString {
    value.normalized_class()
}
type FamilyMap = HashMap<JsString, JsString, crate::JsHash>;
pub struct ClassFamilies(std::borrow::Cow<'static, FamilyMap>);
impl ClassFamilies {
    pub fn new(rows: Option<&[Vec<JsString>]>) -> Self {
        match rows {
            Some(rows) => Self(std::borrow::Cow::Owned(family_map(rows))),
            // #8351: every comparison used to rebuild and renormalize the
            // defaults twice. They are ASCII, so host Unicode overrides never
            // apply to them and one process-wide map is exact.
            None => {
                static DEFAULTS: std::sync::OnceLock<FamilyMap> = std::sync::OnceLock::new();
                Self(std::borrow::Cow::Borrowed(DEFAULTS.get_or_init(|| {
                    let rows: Vec<Vec<JsString>> = DEFAULT_CLASS_FAMILIES.iter()
                        .map(|row| row.iter().map(|s| (*s).into()).collect()).collect();
                    family_map(&rows)
                })))
            }
        }
    }
    pub fn family_of(&self, name: &JsString) -> JsString {
        let key = normalize_class(name);
        self.0.get(&key).cloned().unwrap_or(key)
    }
}
fn family_map(rows: &[Vec<JsString>]) -> FamilyMap {
    let mut map = FamilyMap::default();
    for row in rows {
        let members: Vec<_> = row.iter().map(normalize_class).filter(|name| !name.is_empty()).collect();
        if let Some(canonical) = members.first() {
            for member in &members { map.entry(member.clone()).or_insert_with(|| canonical.clone()); }
        }
    }
    map
}
