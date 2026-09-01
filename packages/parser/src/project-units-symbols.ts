/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Symbol tables + composition helpers for {@link ../project-units.ts}: the
 * SI prefix/unit-name tables (mirror `project_units/symbols.rs`), the
 * `IfcConversionBasedUnit`/currency symbol lookups, derived-unit symbol
 * composition, and the measure-value-type → unit-type table (mirror
 * `project_units/measure.rs`). Split out of `project-units.ts` to stay
 * under the module-size budget; no behavioral boundary is implied, this is
 * purely `project-units.ts`'s private lookup-table half.
 */

/** How a measure value type maps onto the file's declared units. */
export type MeasureUnit =
  | { kind: 'typed'; unitType: string; defaultSymbol: string }
  | { kind: 'monetary' }
  | { kind: 'dimensionless' };

// ============================================================================
// SI prefix + unit-name symbol tables (mirror project_units/symbols.rs)
// ============================================================================

const SI_PREFIX_MULTIPLIERS: Record<string, number> = {
  ATTO: 1e-18, FEMTO: 1e-15, PICO: 1e-12, NANO: 1e-9, MICRO: 1e-6, MILLI: 1e-3,
  CENTI: 1e-2, DECI: 1e-1, DECA: 1e1, HECTO: 1e2, KILO: 1e3, MEGA: 1e6,
  GIGA: 1e9, TERA: 1e12, PETA: 1e15, EXA: 1e18,
};

const SI_PREFIX_SYMBOLS: Record<string, string> = {
  EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k', HECTO: 'h',
  DECA: 'da', DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ', NANO: 'n',
  PICO: 'p', FEMTO: 'f', ATTO: 'a',
};

interface SiName {
  symbol: string;
  prefixPower: number;
  baseScale: number;
}

/** Resolve an `IfcSIUnitName` token to its symbol descriptor. */
function siUnitName(name: string): SiName | undefined {
  const n = name.replace(/\./g, '').trim().toUpperCase();
  const d = (symbol: string): SiName => ({ symbol, prefixPower: 1, baseScale: 1.0 });
  switch (n) {
    case 'METRE': return d('m');
    case 'SQUARE_METRE': return { symbol: 'm²', prefixPower: 2, baseScale: 1.0 };
    case 'CUBIC_METRE': return { symbol: 'm³', prefixPower: 3, baseScale: 1.0 };
    case 'GRAM': return { symbol: 'g', prefixPower: 1, baseScale: 1e-3 };
    case 'SECOND': return d('s');
    case 'AMPERE': return d('A');
    case 'KELVIN': return d('K');
    case 'MOLE': return d('mol');
    case 'CANDELA': return d('cd');
    case 'RADIAN': return d('rad');
    case 'STERADIAN': return d('sr');
    case 'HERTZ': return d('Hz');
    case 'NEWTON': return d('N');
    case 'PASCAL': return d('Pa');
    case 'JOULE': return d('J');
    case 'WATT': return d('W');
    case 'COULOMB': return d('C');
    case 'VOLT': return d('V');
    case 'FARAD': return d('F');
    case 'OHM': return d('Ω');
    case 'SIEMENS': return d('S');
    case 'WEBER': return d('Wb');
    case 'TESLA': return d('T');
    case 'HENRY': return d('H');
    case 'DEGREE_CELSIUS': return d('°C');
    case 'LUMEN': return d('lm');
    case 'LUX': return d('lx');
    case 'BECQUEREL': return d('Bq');
    case 'GRAY': return d('Gy');
    case 'SIEVERT': return d('Sv');
    default: return undefined;
  }
}

function prefixSymbol(prefix: string): string {
  return SI_PREFIX_SYMBOLS[prefix.replace(/\./g, '').trim().toUpperCase()] ?? '';
}

function prefixMultiplier(prefix: string): number {
  return SI_PREFIX_MULTIPLIERS[prefix.replace(/\./g, '').trim().toUpperCase()] ?? 1.0;
}

/** Symbol + SI scale for a prefixed `IfcSIUnit`. */
export function siUnitSymbolAndScale(name: string, prefix: string | null): { symbol: string; scale: number } | undefined {
  const base = siUnitName(name);
  if (!base) return undefined;
  const cleanPrefix = prefix ? prefix.replace(/\./g, '').trim() : '';
  const pSym = cleanPrefix ? prefixSymbol(cleanPrefix) : '';
  const pMult = cleanPrefix ? prefixMultiplier(cleanPrefix) : 1.0;
  return {
    symbol: `${pSym}${base.symbol}`,
    scale: base.baseScale * Math.pow(pMult, base.prefixPower),
  };
}

/** Friendly symbol for a common `IfcConversionBasedUnit` name. */
export function conversionUnitSymbol(name: string): string {
  const clean = name.replace(/'/g, '').trim();
  switch (clean.toUpperCase()) {
    case 'DEGREE': return '°';
    case 'GRAD': case 'GON': return 'gon';
    case 'MINUTE': return '′';
    case 'SECOND': return '″';
    case 'FOOT': case 'FEET': return 'ft';
    case 'INCH': return 'in';
    case 'YARD': return 'yd';
    case 'MILE': return 'mi';
    case 'LITRE': case 'LITER': return 'L';
    case 'ACRE': return 'acre';
    case 'POUND': case 'POUND-MASS': case 'LBM': return 'lb';
    case 'POUND-FORCE': case 'LBF': return 'lbf';
    case 'OUNCE': return 'oz';
    case 'TON-METRIC': case 'TONNE': return 't';
    case 'PSI': return 'psi';
    case 'BAR': return 'bar';
    case 'KIP': return 'kip';
    case 'MINUTE-TIME': case 'MIN': return 'min';
    case 'HOUR': return 'h';
    case 'DAY': return 'd';
    case 'BTU': return 'Btu';
    case '': return '';
    default: return clean;
  }
}

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

function superscript(mag: number): string {
  if (mag === 1) return '';
  return String(mag).split('').map(c => SUPERSCRIPT_DIGITS[c] ?? c).join('');
}

/** Compose a derived-unit symbol from `(symbol, exponent)` pairs. */
export function composeDerived(elements: Array<[string, number]>): string {
  const num: string[] = [];
  const den: string[] = [];
  for (const [sym, exp] of elements) {
    if (exp === 0 || sym.length === 0) continue;
    const piece = `${sym}${superscript(Math.abs(exp))}`;
    if (exp > 0) num.push(piece); else den.push(piece);
  }
  const midDot = '·';
  const numerator = num.length === 0 ? '1' : num.join(midDot);
  if (den.length === 0) return num.length === 0 ? '' : numerator;
  const denominator = den.join(midDot);
  return den.length > 1 ? `${numerator}/(${denominator})` : `${numerator}/${denominator}`;
}

export function currencySymbol(code: string): string {
  const c = code.replace(/['.]/g, '').trim();
  switch (c.toUpperCase()) {
    case 'EUR': return '€';
    case 'USD': return '$';
    case 'GBP': return '£';
    case 'JPY': case 'CNY': case 'RMB': return '¥';
    case '': return '';
    default: return c;
  }
}

// ============================================================================
// Measure → unit-type table (mirror project_units/measure.rs)
// ============================================================================

const MEASURE_TABLE: Record<string, MeasureUnit> = {
  // Length family
  LENGTHMEASURE: { kind: 'typed', unitType: 'LENGTHUNIT', defaultSymbol: 'm' },
  POSITIVELENGTHMEASURE: { kind: 'typed', unitType: 'LENGTHUNIT', defaultSymbol: 'm' },
  NONNEGATIVELENGTHMEASURE: { kind: 'typed', unitType: 'LENGTHUNIT', defaultSymbol: 'm' },
  AREAMEASURE: { kind: 'typed', unitType: 'AREAUNIT', defaultSymbol: 'm²' },
  VOLUMEMEASURE: { kind: 'typed', unitType: 'VOLUMEUNIT', defaultSymbol: 'm³' },
  MASSMEASURE: { kind: 'typed', unitType: 'MASSUNIT', defaultSymbol: 'kg' },
  TIMEMEASURE: { kind: 'typed', unitType: 'TIMEUNIT', defaultSymbol: 's' },
  PLANEANGLEMEASURE: { kind: 'typed', unitType: 'PLANEANGLEUNIT', defaultSymbol: 'rad' },
  POSITIVEPLANEANGLEMEASURE: { kind: 'typed', unitType: 'PLANEANGLEUNIT', defaultSymbol: 'rad' },
  SOLIDANGLEMEASURE: { kind: 'typed', unitType: 'SOLIDANGLEUNIT', defaultSymbol: 'sr' },
  THERMODYNAMICTEMPERATUREMEASURE: { kind: 'typed', unitType: 'THERMODYNAMICTEMPERATUREUNIT', defaultSymbol: 'K' },
  // Named SI (special-name) units
  ELECTRICCURRENTMEASURE: { kind: 'typed', unitType: 'ELECTRICCURRENTUNIT', defaultSymbol: 'A' },
  ELECTRICVOLTAGEMEASURE: { kind: 'typed', unitType: 'ELECTRICVOLTAGEUNIT', defaultSymbol: 'V' },
  ELECTRICRESISTANCEMEASURE: { kind: 'typed', unitType: 'ELECTRICRESISTANCEUNIT', defaultSymbol: 'Ω' },
  ELECTRICCAPACITANCEMEASURE: { kind: 'typed', unitType: 'ELECTRICCAPACITANCEUNIT', defaultSymbol: 'F' },
  ELECTRICCHARGEMEASURE: { kind: 'typed', unitType: 'ELECTRICCHARGEUNIT', defaultSymbol: 'C' },
  ELECTRICCONDUCTANCEMEASURE: { kind: 'typed', unitType: 'ELECTRICCONDUCTANCEUNIT', defaultSymbol: 'S' },
  POWERMEASURE: { kind: 'typed', unitType: 'POWERUNIT', defaultSymbol: 'W' },
  ENERGYMEASURE: { kind: 'typed', unitType: 'ENERGYUNIT', defaultSymbol: 'J' },
  FORCEMEASURE: { kind: 'typed', unitType: 'FORCEUNIT', defaultSymbol: 'N' },
  PRESSUREMEASURE: { kind: 'typed', unitType: 'PRESSUREUNIT', defaultSymbol: 'Pa' },
  FREQUENCYMEASURE: { kind: 'typed', unitType: 'FREQUENCYUNIT', defaultSymbol: 'Hz' },
  INDUCTANCEMEASURE: { kind: 'typed', unitType: 'INDUCTANCEUNIT', defaultSymbol: 'H' },
  ILLUMINANCEMEASURE: { kind: 'typed', unitType: 'ILLUMINANCEUNIT', defaultSymbol: 'lx' },
  LUMINOUSFLUXMEASURE: { kind: 'typed', unitType: 'LUMINOUSFLUXUNIT', defaultSymbol: 'lm' },
  LUMINOUSINTENSITYMEASURE: { kind: 'typed', unitType: 'LUMINOUSINTENSITYUNIT', defaultSymbol: 'cd' },
  MAGNETICFLUXMEASURE: { kind: 'typed', unitType: 'MAGNETICFLUXUNIT', defaultSymbol: 'Wb' },
  MAGNETICFLUXDENSITYMEASURE: { kind: 'typed', unitType: 'MAGNETICFLUXDENSITYUNIT', defaultSymbol: 'T' },
  AMOUNTOFSUBSTANCEMEASURE: { kind: 'typed', unitType: 'AMOUNTOFSUBSTANCEUNIT', defaultSymbol: 'mol' },
  ABSORBEDDOSEMEASURE: { kind: 'typed', unitType: 'ABSORBEDDOSEUNIT', defaultSymbol: 'Gy' },
  DOSEEQUIVALENTMEASURE: { kind: 'typed', unitType: 'DOSEEQUIVALENTUNIT', defaultSymbol: 'Sv' },
  RADIOACTIVITYMEASURE: { kind: 'typed', unitType: 'RADIOACTIVITYUNIT', defaultSymbol: 'Bq' },
  // Derived units
  VOLUMETRICFLOWRATEMEASURE: { kind: 'typed', unitType: 'VOLUMETRICFLOWRATEUNIT', defaultSymbol: 'm³/s' },
  MASSFLOWRATEMEASURE: { kind: 'typed', unitType: 'MASSFLOWRATEUNIT', defaultSymbol: 'kg/s' },
  MASSDENSITYMEASURE: { kind: 'typed', unitType: 'MASSDENSITYUNIT', defaultSymbol: 'kg/m³' },
  MASSPERLENGTHMEASURE: { kind: 'typed', unitType: 'MASSPERLENGTHUNIT', defaultSymbol: 'kg/m' },
  LINEARVELOCITYMEASURE: { kind: 'typed', unitType: 'LINEARVELOCITYUNIT', defaultSymbol: 'm/s' },
  ACCELERATIONMEASURE: { kind: 'typed', unitType: 'ACCELERATIONUNIT', defaultSymbol: 'm/s²' },
  ANGULARVELOCITYMEASURE: { kind: 'typed', unitType: 'ANGULARVELOCITYUNIT', defaultSymbol: 'rad/s' },
  ROTATIONALFREQUENCYMEASURE: { kind: 'typed', unitType: 'ROTATIONALFREQUENCYUNIT', defaultSymbol: '1/s' },
  TORQUEMEASURE: { kind: 'typed', unitType: 'TORQUEUNIT', defaultSymbol: 'N·m' },
  LINEARFORCEMEASURE: { kind: 'typed', unitType: 'LINEARFORCEUNIT', defaultSymbol: 'N/m' },
  PLANARFORCEMEASURE: { kind: 'typed', unitType: 'PLANARFORCEUNIT', defaultSymbol: 'N/m²' },
  LINEARSTIFFNESSMEASURE: { kind: 'typed', unitType: 'LINEARSTIFFNESSUNIT', defaultSymbol: 'N/m' },
  ROTATIONALSTIFFNESSMEASURE: { kind: 'typed', unitType: 'ROTATIONALSTIFFNESSUNIT', defaultSymbol: 'N·m/rad' },
  MODULUSOFELASTICITYMEASURE: { kind: 'typed', unitType: 'MODULUSOFELASTICITYUNIT', defaultSymbol: 'Pa' },
  SHEARMODULUSMEASURE: { kind: 'typed', unitType: 'SHEARMODULUSUNIT', defaultSymbol: 'Pa' },
  THERMALTRANSMITTANCEMEASURE: { kind: 'typed', unitType: 'THERMALTRANSMITTANCEUNIT', defaultSymbol: 'W/(m²·K)' },
  THERMALCONDUCTIVITYMEASURE: { kind: 'typed', unitType: 'THERMALCONDUCTANCEUNIT', defaultSymbol: 'W/(m·K)' },
  THERMALRESISTANCEMEASURE: { kind: 'typed', unitType: 'THERMALRESISTANCEUNIT', defaultSymbol: 'm²·K/W' },
  THERMALADMITTANCEMEASURE: { kind: 'typed', unitType: 'THERMALADMITTANCEUNIT', defaultSymbol: 'W/(m²·K)' },
  THERMALEXPANSIONCOEFFICIENTMEASURE: { kind: 'typed', unitType: 'THERMALEXPANSIONCOEFFICIENTUNIT', defaultSymbol: '1/K' },
  SPECIFICHEATCAPACITYMEASURE: { kind: 'typed', unitType: 'SPECIFICHEATCAPACITYUNIT', defaultSymbol: 'J/(kg·K)' },
  HEATFLUXDENSITYMEASURE: { kind: 'typed', unitType: 'HEATFLUXDENSITYUNIT', defaultSymbol: 'W/m²' },
  HEATINGVALUEMEASURE: { kind: 'typed', unitType: 'HEATINGVALUEUNIT', defaultSymbol: 'J/kg' },
  DYNAMICVISCOSITYMEASURE: { kind: 'typed', unitType: 'DYNAMICVISCOSITYUNIT', defaultSymbol: 'Pa·s' },
  KINEMATICVISCOSITYMEASURE: { kind: 'typed', unitType: 'KINEMATICVISCOSITYUNIT', defaultSymbol: 'm²/s' },
  MOMENTOFINERTIAMEASURE: { kind: 'typed', unitType: 'MOMENTOFINERTIAUNIT', defaultSymbol: 'm⁴' },
  SECTIONMODULUSMEASURE: { kind: 'typed', unitType: 'SECTIONMODULUSUNIT', defaultSymbol: 'm³' },
  SECTIONALAREAINTEGRALMEASURE: { kind: 'typed', unitType: 'SECTIONAREAINTEGRALUNIT', defaultSymbol: 'm⁵' },
  WARPINGCONSTANTMEASURE: { kind: 'typed', unitType: 'WARPINGCONSTANTUNIT', defaultSymbol: 'm⁶' },
  WARPINGMOMENTMEASURE: { kind: 'typed', unitType: 'WARPINGMOMENTUNIT', defaultSymbol: 'N·m²' },
  LINEARMOMENTMEASURE: { kind: 'typed', unitType: 'LINEARMOMENTUNIT', defaultSymbol: 'N·m/m' },
  AREADENSITYMEASURE: { kind: 'typed', unitType: 'AREADENSITYUNIT', defaultSymbol: 'kg/m²' },
  CURVATUREMEASURE: { kind: 'typed', unitType: 'CURVATUREUNIT', defaultSymbol: '1/m' },
  MOLECULARWEIGHTMEASURE: { kind: 'typed', unitType: 'MOLECULARWEIGHTUNIT', defaultSymbol: 'kg/mol' },
  IONCONCENTRATIONMEASURE: { kind: 'typed', unitType: 'IONCONCENTRATIONUNIT', defaultSymbol: 'kg/m³' },
  MOISTUREDIFFUSIVITYMEASURE: { kind: 'typed', unitType: 'MOISTUREDIFFUSIVITYUNIT', defaultSymbol: 'm²/s' },
  VAPORPERMEABILITYMEASURE: { kind: 'typed', unitType: 'VAPORPERMEABILITYUNIT', defaultSymbol: 'kg/(s·m·Pa)' },
  ISOTHERMALMOISTURECAPACITYMEASURE: { kind: 'typed', unitType: 'ISOTHERMALMOISTURECAPACITYUNIT', defaultSymbol: 'm³/kg' },
  TEMPERATUREGRADIENTMEASURE: { kind: 'typed', unitType: 'TEMPERATUREGRADIENTUNIT', defaultSymbol: 'K/m' },
  TEMPERATURERATEOFCHANGEMEASURE: { kind: 'typed', unitType: 'TEMPERATURERATEOFCHANGEUNIT', defaultSymbol: 'K/s' },
  SOUNDPOWERMEASURE: { kind: 'typed', unitType: 'SOUNDPOWERUNIT', defaultSymbol: 'W' },
  SOUNDPOWERLEVELMEASURE: { kind: 'typed', unitType: 'SOUNDPOWERLEVELUNIT', defaultSymbol: 'dB' },
  SOUNDPRESSUREMEASURE: { kind: 'typed', unitType: 'SOUNDPRESSUREUNIT', defaultSymbol: 'Pa' },
  SOUNDPRESSURELEVELMEASURE: { kind: 'typed', unitType: 'SOUNDPRESSURELEVELUNIT', defaultSymbol: 'dB' },
  MODULUSOFSUBGRADEREACTIONMEASURE: { kind: 'typed', unitType: 'MODULUSOFSUBGRADEREACTIONUNIT', defaultSymbol: 'N/m³' },
  MODULUSOFLINEARSUBGRADEREACTIONMEASURE: { kind: 'typed', unitType: 'MODULUSOFLINEARSUBGRADEREACTIONUNIT', defaultSymbol: 'N/m²' },
  MODULUSOFROTATIONALSUBGRADEREACTIONMEASURE: { kind: 'typed', unitType: 'MODULUSOFROTATIONALSUBGRADEREACTIONUNIT', defaultSymbol: 'N/rad' },
  ROTATIONALMASSMEASURE: { kind: 'typed', unitType: 'ROTATIONALMASSUNIT', defaultSymbol: 'kg·m²' },
  INTEGERCOUNTRATEMEASURE: { kind: 'typed', unitType: 'INTEGERCOUNTRATEUNIT', defaultSymbol: '1/s' },
  LUMINOUSINTENSITYDISTRIBUTIONMEASURE: { kind: 'typed', unitType: 'LUMINOUSINTENSITYDISTRIBUTIONUNIT', defaultSymbol: 'cd/lm' },
  // Monetary
  MONETARYMEASURE: { kind: 'monetary' },
  // Dimensionless / unit-less
  RATIOMEASURE: { kind: 'dimensionless' },
  NORMALISEDRATIOMEASURE: { kind: 'dimensionless' },
  POSITIVERATIOMEASURE: { kind: 'dimensionless' },
  COUNTMEASURE: { kind: 'dimensionless' },
  NUMERICMEASURE: { kind: 'dimensionless' },
  DESCRIPTIVEMEASURE: { kind: 'dimensionless' },
  CONTEXTDEPENDENTMEASURE: { kind: 'dimensionless' },
  PHMEASURE: { kind: 'dimensionless' },
  CURVEMEASURE: { kind: 'dimensionless' },
  COMPOUNDPLANEANGLEMEASURE: { kind: 'dimensionless' },
  DERIVEDMEASURE: { kind: 'dimensionless' },
  MEASURE: { kind: 'dimensionless' },
};

/** Resolve a measure value type name (case-insensitive, with or without the
 *  leading `IFC`) to its unit mapping. `undefined` for non-measure value types. */
export function measureUnit(measureType: string): MeasureUnit | undefined {
  const up = measureType.trim().toUpperCase();
  const key = up.startsWith('IFC') ? up.slice(3) : up;
  return MEASURE_TABLE[key];
}
