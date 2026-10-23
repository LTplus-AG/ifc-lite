// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::collections::HashMap;
use crate::projections::is_ecmascript_whitespace;
pub const DEFAULT_CLASS_FAMILIES: &[&[&str]] = &[
    &["IfcWall", "IfcWallStandardCase", "IfcWallElementedCase", "IfcBuildingElementPart"],
    &["IfcSlab", "IfcSlabStandardCase", "IfcSlabElementedCase"],
    &["IfcBeam", "IfcBeamStandardCase"], &["IfcColumn", "IfcColumnStandardCase"],
    &["IfcMember", "IfcMemberStandardCase"], &["IfcPlate", "IfcPlateStandardCase"],
    &["IfcDoor", "IfcDoorStandardCase"], &["IfcWindow", "IfcWindowStandardCase"],
    &["IfcOpeningElement", "IfcOpeningStandardCase"],
    &["IfcFurniture", "IfcFurnishingElement", "IfcSystemFurnitureElement"],
];
pub fn normalize_class(value: &str) -> String {
    value.trim_matches(is_ecmascript_whitespace).to_uppercase()
}
pub struct ClassFamilies(HashMap<String, String>);
impl ClassFamilies {
    pub fn new(rows: Option<&[Vec<String>]>) -> Self {
        let defaults;
        let rows = match rows {
            Some(rows) => rows,
            None => {
                defaults = DEFAULT_CLASS_FAMILIES.iter().map(|row| row.iter().map(|s| (*s).to_owned()).collect()).collect::<Vec<_>>();
                &defaults
            }
        };
        let mut map = HashMap::new();
        for row in rows {
            let members: Vec<_> = row.iter().map(|name| normalize_class(name)).filter(|name| !name.is_empty()).collect();
            if let Some(canonical) = members.first() {
                for member in &members { map.entry(member.clone()).or_insert_with(|| canonical.clone()); }
            }
        }
        Self(map)
    }
    pub fn family_of(&self, name: &str) -> String {
        let key = normalize_class(name);
        self.0.get(&key).cloned().unwrap_or(key)
    }
}
