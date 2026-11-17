// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcTypeEnumFromString` (`packages/data/src/types.ts`): the UPPERCASE STEP
//! keyword to the `IfcTypeEnum` ordinal the Entities section's `typeEnum`
//! column stores. A keyword the TS map lacks is 9999 (`IfcTypeEnum.Unknown`, not 0); the row's
//! `rawTypeName` still names it.
//!
//! Transcribed from `TYPE_STRING_TO_ENUM`, sorted for binary search. A copy
//! can drift, so it is not trusted on its own: the cross-language gate
//! (`scripts/cache-native-conformance.mjs`) recomputes every row's ordinal with
//! the real `IfcTypeEnumFromString` and fails on any disagreement.

static TYPE_ORDINALS: &[(&str, u16)] = &[
    ("IFCALIGNMENT", 89),
    ("IFCANNOTATION", 55),
    ("IFCBEAM", 16),
    ("IFCBEAMSTANDARDCASE", 16),
    ("IFCBEAMTYPE", 305),
    ("IFCBRIDGE", 61),
    ("IFCBRIDGEPART", 62),
    ("IFCBUILDING", 3),
    ("IFCBUILDINGELEMENTPART", 33),
    ("IFCBUILDINGELEMENTPROXY", 27),
    ("IFCBUILDINGELEMENTPROXYTYPE", 316),
    ("IFCBUILDINGSTOREY", 4),
    ("IFCCABLESEGMENT", 51),
    ("IFCCHIMNEY", 31),
    ("IFCCIVILELEMENT", 57),
    ("IFCCOLUMN", 15),
    ("IFCCOLUMNSTANDARDCASE", 15),
    ("IFCCOLUMNTYPE", 304),
    ("IFCCOURSE", 70),
    ("IFCCOVERING", 20),
    ("IFCCOVERINGTYPE", 310),
    ("IFCCURTAINWALL", 21),
    ("IFCCURTAINWALLTYPE", 315),
    ("IFCDISCRETEACCESSORY", 38),
    ("IFCDISTRIBUTIONCONTROLELEMENT", 40),
    ("IFCDISTRIBUTIONELEMENT", 40),
    ("IFCDISTRIBUTIONFLOWELEMENT", 40),
    ("IFCDISTRIBUTIONSYSTEM", 320),
    ("IFCDOOR", 12),
    ("IFCDOORSTANDARDCASE", 12),
    ("IFCDOORTYPE", 301),
    ("IFCDUCTSEGMENT", 49),
    ("IFCEARTHWORKSCUT", 79),
    ("IFCEARTHWORKSELEMENT", 77),
    ("IFCEARTHWORKSFILL", 78),
    ("IFCELEMENTASSEMBLY", 34),
    ("IFCELEMENTQUANTITY", 210),
    ("IFCENERGYCONVERSIONDEVICE", 48),
    ("IFCFACILITY", 59),
    ("IFCFACILITYPART", 60),
    ("IFCFACILITYPARTCOMMON", 322),
    ("IFCFLOWCONTROLLER", 44),
    ("IFCFLOWFITTING", 43),
    ("IFCFLOWMOVINGDEVICE", 45),
    ("IFCFLOWSEGMENT", 42),
    ("IFCFLOWSTORAGEDEVICE", 46),
    ("IFCFLOWTERMINAL", 41),
    ("IFCFLOWTREATMENTDEVICE", 47),
    ("IFCFOOTING", 26),
    ("IFCFOOTINGTYPE", 309),
    ("IFCFURNISHINGELEMENT", 52),
    ("IFCFURNITURE", 53),
    ("IFCGEOGRAPHICELEMENT", 58),
    ("IFCGEOTECHNICALASSEMBLY", 84),
    ("IFCGEOTECHNICALSTRATUM", 83),
    ("IFCKERB", 72),
    ("IFCMARINEFACILITY", 67),
    ("IFCMARINEPART", 321),
    ("IFCMECHANICALFASTENER", 39),
    ("IFCMEMBER", 24),
    ("IFCMEMBERSTANDARDCASE", 24),
    ("IFCMEMBERTYPE", 307),
    ("IFCMOORINGDEVICE", 73),
    ("IFCNAVIGATIONELEMENT", 74),
    ("IFCOPENINGELEMENT", 30),
    ("IFCOPENINGSTANDARDCASE", 30),
    ("IFCPAVEMENT", 71),
    ("IFCPILE", 23),
    ("IFCPILETYPE", 306),
    ("IFCPIPESEGMENT", 50),
    ("IFCPLATE", 25),
    ("IFCPLATESTANDARDCASE", 25),
    ("IFCPLATETYPE", 308),
    ("IFCPOSITIONINGELEMENT", 88),
    ("IFCPROJECT", 1),
    ("IFCPROPERTYBOUNDEDVALUE", 203),
    ("IFCPROPERTYENUMERATEDVALUE", 202),
    ("IFCPROPERTYLISTVALUE", 204),
    ("IFCPROPERTYSET", 200),
    ("IFCPROPERTYSINGLEVALUE", 201),
    ("IFCPROXY", 54),
    ("IFCQUANTITYAREA", 212),
    ("IFCQUANTITYCOUNT", 214),
    ("IFCQUANTITYLENGTH", 211),
    ("IFCQUANTITYVOLUME", 213),
    ("IFCQUANTITYWEIGHT", 215),
    ("IFCRAILING", 22),
    ("IFCRAILINGTYPE", 311),
    ("IFCRAILWAY", 65),
    ("IFCRAILWAYPART", 66),
    ("IFCRAMP", 18),
    ("IFCRAMPFLIGHT", 29),
    ("IFCRAMPTYPE", 313),
    ("IFCREFERENT", 80),
    ("IFCREINFORCINGBAR", 35),
    ("IFCREINFORCINGMESH", 36),
    ("IFCRELAGGREGATES", 101),
    ("IFCRELASSOCIATESCLASSIFICATION", 105),
    ("IFCRELASSOCIATESMATERIAL", 104),
    ("IFCRELCONNECTSPATHELEMENTS", 108),
    ("IFCRELCONTAINEDINSPATIALSTRUCTURE", 100),
    ("IFCRELDEFINESBYPROPERTIES", 102),
    ("IFCRELDEFINESBYTYPE", 103),
    ("IFCRELFILLSELEMENT", 107),
    ("IFCRELSPACEBOUNDARY", 109),
    ("IFCRELVOIDSELEMENT", 106),
    ("IFCROAD", 63),
    ("IFCROADPART", 64),
    ("IFCROOF", 19),
    ("IFCROOFTYPE", 314),
    ("IFCSHADINGDEVICE", 32),
    ("IFCSIGN", 81),
    ("IFCSIGNAL", 82),
    ("IFCSITE", 2),
    ("IFCSLAB", 14),
    ("IFCSLABSTANDARDCASE", 14),
    ("IFCSLABTYPE", 303),
    ("IFCSOLIDSTRATUM", 85),
    ("IFCSPACE", 5),
    ("IFCSPATIALZONE", 317),
    ("IFCSTAIR", 17),
    ("IFCSTAIRFLIGHT", 28),
    ("IFCSTAIRTYPE", 312),
    ("IFCSYSTEM", 319),
    ("IFCTENDON", 37),
    ("IFCTRACKELEMENT", 75),
    ("IFCTRANSPORTELEMENT", 56),
    ("IFCVEHICLE", 76),
    ("IFCVOIDSTRATUM", 86),
    ("IFCWALL", 10),
    ("IFCWALLSTANDARDCASE", 11),
    ("IFCWALLTYPE", 300),
    ("IFCWATERSTRATUM", 87),
    ("IFCWINDOW", 13),
    ("IFCWINDOWSTANDARDCASE", 13),
    ("IFCWINDOWTYPE", 302),
    ("IFCZONE", 318),
];

/// `IfcTypeEnum.Unknown`. The fork prototype wrote 0, an ordinal no member
/// holds, which the reader's `IfcTypeEnumToString` resolves to nothing.
const UNKNOWN: u16 = 9999;

/// The ordinal for an UPPERCASE STEP keyword, or [`UNKNOWN`].
pub(crate) fn type_ordinal(upper: &str) -> u16 {
    TYPE_ORDINALS
        .binary_search_by(|(name, _)| (*name).cmp(upper))
        .map_or(UNKNOWN, |at| TYPE_ORDINALS[at].1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sorted_and_unique_for_binary_search() {
        assert!(TYPE_ORDINALS.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn known_keywords_resolve_and_unknown_is_zero() {
        assert_eq!(type_ordinal("IFCPROJECT"), 1);
        assert_eq!(type_ordinal("IFCWALL"), 10);
        assert_eq!(type_ordinal("IFCPUMP"), UNKNOWN, "most product classes have no enum member");
    }
}
