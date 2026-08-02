// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical mapping from an IFC *measure* value type (e.g.
//! `IfcVolumetricFlowRateMeasure`) to the IFC *unit* type it is expressed in
//! (`VOLUMETRICFLOWRATEUNIT`) plus the IFC-canonical SI display symbol used when
//! the file does not declare that unit.
//!
//! This association is defined by the IFC specification convention
//! (`IfcXxxMeasure` <-> `XxxUnit`) and is **not** derivable from the EXPRESS
//! schema files, so it is authored here as the single source of truth. The
//! TypeScript viewer mirrors this table and both are pinned to the shared
//! parity vectors in `rust/core/tests/fixtures/unit_symbol_vectors.json`.

/// How a measure maps onto the file's declared units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeasureUnit {
    /// A named or derived unit-type token (matches `IfcUnitEnum` /
    /// `IfcDerivedUnitEnum`), with the IFC-canonical SI symbol shown when the
    /// file declares no unit for that type.
    Typed {
        /// Unit-type token, e.g. `"VOLUMETRICFLOWRATEUNIT"`, `"LENGTHUNIT"`.
        unit_type: &'static str,
        /// SI default symbol, e.g. `"m\u{00B3}/s"`, `"mm"` never appears here
        /// (prefixes are file-declared); base SI only.
        default_symbol: &'static str,
    },
    /// The value is a monetary amount; the symbol comes from `IfcMonetaryUnit`.
    Monetary,
    /// Dimensionless / unit-less (ratios, counts, descriptive, ...). No symbol.
    Dimensionless,
}

/// Resolve a measure value type name (case-insensitive, with or without the
/// leading `IFC`) to its unit mapping. Returns `None` for value types that are
/// not measures (labels, identifiers, booleans, ...).
pub fn measure_unit(measure_type: &str) -> Option<MeasureUnit> {
    // Normalise: uppercase, strip a leading "IFC" so callers can pass either
    // "IFCAREAMEASURE" or "AreaMeasure".
    let up = measure_type.trim().to_ascii_uppercase();
    let key = up.strip_prefix("IFC").unwrap_or(&up);
    Some(match key {
        // ---- Length family (all share LENGTHUNIT) -------------------------
        "LENGTHMEASURE" | "POSITIVELENGTHMEASURE" | "NONNEGATIVELENGTHMEASURE" => {
            MeasureUnit::Typed { unit_type: "LENGTHUNIT", default_symbol: "m" }
        }
        "AREAMEASURE" => MeasureUnit::Typed { unit_type: "AREAUNIT", default_symbol: "m\u{00B2}" },
        "VOLUMEMEASURE" => {
            MeasureUnit::Typed { unit_type: "VOLUMEUNIT", default_symbol: "m\u{00B3}" }
        }
        "MASSMEASURE" => MeasureUnit::Typed { unit_type: "MASSUNIT", default_symbol: "kg" },
        "TIMEMEASURE" => MeasureUnit::Typed { unit_type: "TIMEUNIT", default_symbol: "s" },
        "PLANEANGLEMEASURE" | "POSITIVEPLANEANGLEMEASURE" => {
            MeasureUnit::Typed { unit_type: "PLANEANGLEUNIT", default_symbol: "rad" }
        }
        "SOLIDANGLEMEASURE" => {
            MeasureUnit::Typed { unit_type: "SOLIDANGLEUNIT", default_symbol: "sr" }
        }
        "THERMODYNAMICTEMPERATUREMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMODYNAMICTEMPERATUREUNIT",
            default_symbol: "K",
        },

        // ---- Named SI derived-with-special-name units ---------------------
        "ELECTRICCURRENTMEASURE" => {
            MeasureUnit::Typed { unit_type: "ELECTRICCURRENTUNIT", default_symbol: "A" }
        }
        "ELECTRICVOLTAGEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ELECTRICVOLTAGEUNIT", default_symbol: "V" }
        }
        "ELECTRICRESISTANCEMEASURE" => MeasureUnit::Typed {
            unit_type: "ELECTRICRESISTANCEUNIT",
            default_symbol: "\u{03A9}",
        },
        "ELECTRICCAPACITANCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ELECTRICCAPACITANCEUNIT", default_symbol: "F" }
        }
        "ELECTRICCHARGEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ELECTRICCHARGEUNIT", default_symbol: "C" }
        }
        "ELECTRICCONDUCTANCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ELECTRICCONDUCTANCEUNIT", default_symbol: "S" }
        }
        "POWERMEASURE" => MeasureUnit::Typed { unit_type: "POWERUNIT", default_symbol: "W" },
        "ENERGYMEASURE" => MeasureUnit::Typed { unit_type: "ENERGYUNIT", default_symbol: "J" },
        "FORCEMEASURE" => MeasureUnit::Typed { unit_type: "FORCEUNIT", default_symbol: "N" },
        "PRESSUREMEASURE" => {
            MeasureUnit::Typed { unit_type: "PRESSUREUNIT", default_symbol: "Pa" }
        }
        "FREQUENCYMEASURE" => {
            MeasureUnit::Typed { unit_type: "FREQUENCYUNIT", default_symbol: "Hz" }
        }
        "INDUCTANCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "INDUCTANCEUNIT", default_symbol: "H" }
        }
        "ILLUMINANCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ILLUMINANCEUNIT", default_symbol: "lx" }
        }
        "LUMINOUSFLUXMEASURE" => {
            MeasureUnit::Typed { unit_type: "LUMINOUSFLUXUNIT", default_symbol: "lm" }
        }
        "LUMINOUSINTENSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "LUMINOUSINTENSITYUNIT", default_symbol: "cd" }
        }
        "MAGNETICFLUXMEASURE" => {
            MeasureUnit::Typed { unit_type: "MAGNETICFLUXUNIT", default_symbol: "Wb" }
        }
        "MAGNETICFLUXDENSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "MAGNETICFLUXDENSITYUNIT", default_symbol: "T" }
        }
        "AMOUNTOFSUBSTANCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "AMOUNTOFSUBSTANCEUNIT", default_symbol: "mol" }
        }
        "ABSORBEDDOSEMEASURE" => {
            MeasureUnit::Typed { unit_type: "ABSORBEDDOSEUNIT", default_symbol: "Gy" }
        }
        "DOSEEQUIVALENTMEASURE" => {
            MeasureUnit::Typed { unit_type: "DOSEEQUIVALENTUNIT", default_symbol: "Sv" }
        }
        "RADIOACTIVITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "RADIOACTIVITYUNIT", default_symbol: "Bq" }
        }

        // ---- Derived units (IfcDerivedUnitEnum) ---------------------------
        "VOLUMETRICFLOWRATEMEASURE" => MeasureUnit::Typed {
            unit_type: "VOLUMETRICFLOWRATEUNIT",
            default_symbol: "m\u{00B3}/s",
        },
        "MASSFLOWRATEMEASURE" => {
            MeasureUnit::Typed { unit_type: "MASSFLOWRATEUNIT", default_symbol: "kg/s" }
        }
        "MASSDENSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "MASSDENSITYUNIT", default_symbol: "kg/m\u{00B3}" }
        }
        "MASSPERLENGTHMEASURE" => {
            MeasureUnit::Typed { unit_type: "MASSPERLENGTHUNIT", default_symbol: "kg/m" }
        }
        "LINEARVELOCITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "LINEARVELOCITYUNIT", default_symbol: "m/s" }
        }
        "ACCELERATIONMEASURE" => {
            MeasureUnit::Typed { unit_type: "ACCELERATIONUNIT", default_symbol: "m/s\u{00B2}" }
        }
        "ANGULARVELOCITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "ANGULARVELOCITYUNIT", default_symbol: "rad/s" }
        }
        "ROTATIONALFREQUENCYMEASURE" => {
            MeasureUnit::Typed { unit_type: "ROTATIONALFREQUENCYUNIT", default_symbol: "1/s" }
        }
        "TORQUEMEASURE" => {
            MeasureUnit::Typed { unit_type: "TORQUEUNIT", default_symbol: "N\u{00B7}m" }
        }
        "LINEARFORCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "LINEARFORCEUNIT", default_symbol: "N/m" }
        }
        "PLANARFORCEMEASURE" => {
            MeasureUnit::Typed { unit_type: "PLANARFORCEUNIT", default_symbol: "N/m\u{00B2}" }
        }
        "LINEARSTIFFNESSMEASURE" => {
            MeasureUnit::Typed { unit_type: "LINEARSTIFFNESSUNIT", default_symbol: "N/m" }
        }
        "ROTATIONALSTIFFNESSMEASURE" => MeasureUnit::Typed {
            unit_type: "ROTATIONALSTIFFNESSUNIT",
            default_symbol: "N\u{00B7}m/rad",
        },
        "MODULUSOFELASTICITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "MODULUSOFELASTICITYUNIT", default_symbol: "Pa" }
        }
        "SHEARMODULUSMEASURE" => {
            MeasureUnit::Typed { unit_type: "SHEARMODULUSUNIT", default_symbol: "Pa" }
        }
        "THERMALTRANSMITTANCEMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMALTRANSMITTANCEUNIT",
            default_symbol: "W/(m\u{00B2}\u{00B7}K)",
        },
        "THERMALCONDUCTIVITYMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMALCONDUCTANCEUNIT",
            default_symbol: "W/(m\u{00B7}K)",
        },
        "THERMALRESISTANCEMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMALRESISTANCEUNIT",
            default_symbol: "m\u{00B2}\u{00B7}K/W",
        },
        "THERMALADMITTANCEMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMALADMITTANCEUNIT",
            default_symbol: "W/(m\u{00B2}\u{00B7}K)",
        },
        "THERMALEXPANSIONCOEFFICIENTMEASURE" => MeasureUnit::Typed {
            unit_type: "THERMALEXPANSIONCOEFFICIENTUNIT",
            default_symbol: "1/K",
        },
        "SPECIFICHEATCAPACITYMEASURE" => MeasureUnit::Typed {
            unit_type: "SPECIFICHEATCAPACITYUNIT",
            default_symbol: "J/(kg\u{00B7}K)",
        },
        "HEATFLUXDENSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "HEATFLUXDENSITYUNIT", default_symbol: "W/m\u{00B2}" }
        }
        "HEATINGVALUEMEASURE" => {
            MeasureUnit::Typed { unit_type: "HEATINGVALUEUNIT", default_symbol: "J/kg" }
        }
        "DYNAMICVISCOSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "DYNAMICVISCOSITYUNIT", default_symbol: "Pa\u{00B7}s" }
        }
        "KINEMATICVISCOSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "KINEMATICVISCOSITYUNIT", default_symbol: "m\u{00B2}/s" }
        }
        "MOMENTOFINERTIAMEASURE" => {
            MeasureUnit::Typed { unit_type: "MOMENTOFINERTIAUNIT", default_symbol: "m\u{2074}" }
        }
        "SECTIONMODULUSMEASURE" => {
            MeasureUnit::Typed { unit_type: "SECTIONMODULUSUNIT", default_symbol: "m\u{00B3}" }
        }
        "SECTIONALAREAINTEGRALMEASURE" => {
            MeasureUnit::Typed { unit_type: "SECTIONAREAINTEGRALUNIT", default_symbol: "m\u{2075}" }
        }
        "WARPINGCONSTANTMEASURE" => {
            MeasureUnit::Typed { unit_type: "WARPINGCONSTANTUNIT", default_symbol: "m\u{2076}" }
        }
        "WARPINGMOMENTMEASURE" => MeasureUnit::Typed {
            unit_type: "WARPINGMOMENTUNIT",
            default_symbol: "N\u{00B7}m\u{00B2}",
        },
        "LINEARMOMENTMEASURE" => {
            MeasureUnit::Typed { unit_type: "LINEARMOMENTUNIT", default_symbol: "N\u{00B7}m/m" }
        }
        "AREADENSITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "AREADENSITYUNIT", default_symbol: "kg/m\u{00B2}" }
        }
        "CURVATUREMEASURE" => {
            MeasureUnit::Typed { unit_type: "CURVATUREUNIT", default_symbol: "1/m" }
        }
        "MOLECULARWEIGHTMEASURE" => {
            MeasureUnit::Typed { unit_type: "MOLECULARWEIGHTUNIT", default_symbol: "kg/mol" }
        }
        "IONCONCENTRATIONMEASURE" => {
            MeasureUnit::Typed { unit_type: "IONCONCENTRATIONUNIT", default_symbol: "kg/m\u{00B3}" }
        }
        "MOISTUREDIFFUSIVITYMEASURE" => {
            MeasureUnit::Typed { unit_type: "MOISTUREDIFFUSIVITYUNIT", default_symbol: "m\u{00B2}/s" }
        }
        "VAPORPERMEABILITYMEASURE" => MeasureUnit::Typed {
            unit_type: "VAPORPERMEABILITYUNIT",
            default_symbol: "kg/(s\u{00B7}m\u{00B7}Pa)",
        },
        "ISOTHERMALMOISTURECAPACITYMEASURE" => MeasureUnit::Typed {
            unit_type: "ISOTHERMALMOISTURECAPACITYUNIT",
            default_symbol: "m\u{00B3}/kg",
        },
        "TEMPERATUREGRADIENTMEASURE" => {
            MeasureUnit::Typed { unit_type: "TEMPERATUREGRADIENTUNIT", default_symbol: "K/m" }
        }
        "TEMPERATURERATEOFCHANGEMEASURE" => MeasureUnit::Typed {
            unit_type: "TEMPERATURERATEOFCHANGEUNIT",
            default_symbol: "K/s",
        },
        "SOUNDPOWERMEASURE" => {
            MeasureUnit::Typed { unit_type: "SOUNDPOWERUNIT", default_symbol: "W" }
        }
        "SOUNDPOWERLEVELMEASURE" => {
            MeasureUnit::Typed { unit_type: "SOUNDPOWERLEVELUNIT", default_symbol: "dB" }
        }
        "SOUNDPRESSUREMEASURE" => {
            MeasureUnit::Typed { unit_type: "SOUNDPRESSUREUNIT", default_symbol: "Pa" }
        }
        "SOUNDPRESSURELEVELMEASURE" => {
            MeasureUnit::Typed { unit_type: "SOUNDPRESSURELEVELUNIT", default_symbol: "dB" }
        }
        "MODULUSOFSUBGRADEREACTIONMEASURE" => MeasureUnit::Typed {
            unit_type: "MODULUSOFSUBGRADEREACTIONUNIT",
            default_symbol: "N/m\u{00B3}",
        },
        "MODULUSOFLINEARSUBGRADEREACTIONMEASURE" => MeasureUnit::Typed {
            unit_type: "MODULUSOFLINEARSUBGRADEREACTIONUNIT",
            default_symbol: "N/m\u{00B2}",
        },
        "MODULUSOFROTATIONALSUBGRADEREACTIONMEASURE" => MeasureUnit::Typed {
            unit_type: "MODULUSOFROTATIONALSUBGRADEREACTIONUNIT",
            default_symbol: "N/rad",
        },
        "ROTATIONALMASSMEASURE" => {
            MeasureUnit::Typed { unit_type: "ROTATIONALMASSUNIT", default_symbol: "kg\u{00B7}m\u{00B2}" }
        }
        "INTEGERCOUNTRATEMEASURE" => {
            MeasureUnit::Typed { unit_type: "INTEGERCOUNTRATEUNIT", default_symbol: "1/s" }
        }
        "LUMINOUSINTENSITYDISTRIBUTIONMEASURE" => MeasureUnit::Typed {
            unit_type: "LUMINOUSINTENSITYDISTRIBUTIONUNIT",
            default_symbol: "cd/lm",
        },

        // ---- Monetary -----------------------------------------------------
        "MONETARYMEASURE" => MeasureUnit::Monetary,

        // ---- Dimensionless / unit-less ------------------------------------
        "RATIOMEASURE" | "NORMALISEDRATIOMEASURE" | "POSITIVERATIOMEASURE" | "COUNTMEASURE"
        | "NUMERICMEASURE" | "DESCRIPTIVEMEASURE" | "CONTEXTDEPENDENTMEASURE" | "PHMEASURE"
        | "CURVEMEASURE" | "COMPOUNDPLANEANGLEMEASURE" | "DERIVEDMEASURE" | "MEASURE" => {
            MeasureUnit::Dimensionless
        }

        // Not a measure value type (label, identifier, boolean, ...).
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_1573_flow_rate_maps_to_derived_unit() {
        assert_eq!(
            measure_unit("IFCVOLUMETRICFLOWRATEMEASURE"),
            Some(MeasureUnit::Typed {
                unit_type: "VOLUMETRICFLOWRATEUNIT",
                default_symbol: "m\u{00B3}/s",
            })
        );
    }

    #[test]
    fn accepts_prefixed_or_bare_names_case_insensitively() {
        let a = measure_unit("IfcAreaMeasure");
        let b = measure_unit("AREAMEASURE");
        assert_eq!(a, b);
        assert_eq!(
            a,
            Some(MeasureUnit::Typed { unit_type: "AREAUNIT", default_symbol: "m\u{00B2}" })
        );
    }

    #[test]
    fn length_family_shares_length_unit() {
        for m in ["IFCLENGTHMEASURE", "IFCPOSITIVELENGTHMEASURE", "IFCNONNEGATIVELENGTHMEASURE"] {
            assert_eq!(
                measure_unit(m),
                Some(MeasureUnit::Typed { unit_type: "LENGTHUNIT", default_symbol: "m" })
            );
        }
    }

    #[test]
    fn ratios_and_counts_are_dimensionless() {
        for m in ["IFCRATIOMEASURE", "IFCCOUNTMEASURE", "IFCNORMALISEDRATIOMEASURE"] {
            assert_eq!(measure_unit(m), Some(MeasureUnit::Dimensionless));
        }
    }

    #[test]
    fn non_measures_return_none() {
        assert_eq!(measure_unit("IFCLABEL"), None);
        assert_eq!(measure_unit("IFCBOOLEAN"), None);
        assert_eq!(measure_unit("IFCIDENTIFIER"), None);
    }

    #[test]
    fn monetary_is_flagged() {
        assert_eq!(measure_unit("IFCMONETARYMEASURE"), Some(MeasureUnit::Monetary));
    }
}
