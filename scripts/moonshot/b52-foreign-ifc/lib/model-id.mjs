/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * De-identification for B5.2's foreign inputs.
 *
 * The two foreign models are real delivered client work. Nothing that could
 * identify the project, the firm or the filesystem they came from may reach
 * this repository: not the file name, not the STEP header, not an owner
 * history, not a path. Every script in this bet therefore takes the model
 * path as a RUNTIME argument, reads it in place, and writes only what this
 * module lets through:
 *
 *   - a stable id: the first 12 hex of sha256(file bytes), plus a
 *     human-readable alias ("model-a" / "model-b") supplied on the command
 *     line by the operator;
 *   - non-identifying descriptors: byte size, schema version, entity count,
 *     entity-type histogram, authoring-tool FAMILY (a coarse label the
 *     operator passes in, never the FILE_NAME / FILE_DESCRIPTION strings).
 *
 * Two different filters, because the two kinds of string carry different
 * risk:
 *
 * `safeMessage()` - for strings ifc-lite ITSELF composed (validation issue
 * messages). Those are template text plus counts plus IFC type names, so the
 * only job here is to guarantee that assumption rather than trust it: any
 * token that is not template vocabulary, a number, an IFC type name or an
 * express-id reference is redacted.
 *
 * `standardNameOrPlaceholder()` - for strings the FILE authored (quantity-set
 * and quantity names). A custom pset can be named after the firm, so nothing
 * authored is echoed: a name is emitted verbatim only when it is
 * buildingSMART-standard vocabulary, and otherwise collapses to
 * `<non-standard>`. That is also the better measurement - "how much of this
 * file's quantity vocabulary is standard" is the number the report wants.
 */

import { createHash } from 'node:crypto';

/** Stable, non-reversible id for a model: first 12 hex of sha256(bytes). */
export function modelId(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/**
 * Vocabulary that may appear in an ifc-lite validation message. Anything a
 * message can legitimately contain: the template words, IFC type tokens, an
 * express-id reference, and any number with separators/units.
 */
const MESSAGE_SAFE = /^(?:IFC[A-Z0-9]*|Ifc[A-Za-z0-9]*|#\d+|[\d.,/%()+-]+|[A-Za-z][a-z]*)$/;

/** Redact anything in an ifc-lite-composed message that is not template vocabulary. */
export function safeMessage(text) {
  if (typeof text !== 'string') return text;
  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s*$/.test(tok) || tok === '') return tok;
      // Punctuation that commonly wraps a word; test the bare core.
      const core = tok.replace(/^[^\w#]+/, '').replace(/[^\w%)\]]+$/, '');
      if (core === '' || MESSAGE_SAFE.test(core)) return tok;
      return '<redacted>';
    })
    .join('');
}

/**
 * buildingSMART-standard quantity-set names. Anything else is authored text
 * and never leaves the run.
 *
 * ENUMERATED, NOT PATTERNED. The previous form was `/^(?:Qto_[A-Za-z0-9]+|
 * BaseQuantities)$/`, which accepts ANY alphanumeric suffix after `Qto_`. A
 * file is free to author `Qto_<firm>Quantities`, and that name would have been
 * echoed verbatim as a histogram key in `kernel-<alias>.json` while this
 * module's header promised the opposite ("emitted verbatim only when it is
 * buildingSMART-standard vocabulary"). The prefix is not the guarantee; the
 * name is. Both review bots landed on this independently.
 *
 * A standard name missing from this list costs one `<non-standard>` count -
 * the safe direction. An authored name matching one exactly is a name a
 * thousand other files also carry, which is what makes it publishable.
 */
const STANDARD_QSET = new Set([
  'BaseQuantities',
  'Qto_AudioVisualApplianceBaseQuantities', 'Qto_BeamBaseQuantities',
  'Qto_BodyGeometryValidation', 'Qto_BoilerBaseQuantities',
  'Qto_BuildingBaseQuantities', 'Qto_BuildingStoreyBaseQuantities',
  'Qto_ChillerBaseQuantities', 'Qto_ChimneyBaseQuantities',
  'Qto_CoilBaseQuantities', 'Qto_ColumnBaseQuantities',
  'Qto_CommunicationsApplianceBaseQuantities', 'Qto_CondenserBaseQuantities',
  'Qto_ConstructionEquipmentResourceBaseQuantities',
  'Qto_ConstructionMaterialResourceBaseQuantities',
  'Qto_CoveringBaseQuantities', 'Qto_CurtainWallBaseQuantities',
  'Qto_DoorBaseQuantities', 'Qto_DuctFittingBaseQuantities',
  'Qto_DuctSegmentBaseQuantities', 'Qto_ElectricApplianceBaseQuantities',
  'Qto_ElectricDistributionBoardBaseQuantities',
  'Qto_ElectricFlowStorageDeviceBaseQuantities',
  'Qto_ElectricGeneratorBaseQuantities', 'Qto_ElectricMotorBaseQuantities',
  'Qto_EvaporativeCoolerBaseQuantities', 'Qto_EvaporatorBaseQuantities',
  'Qto_FanBaseQuantities', 'Qto_FootingBaseQuantities',
  'Qto_HeatExchangerBaseQuantities', 'Qto_HumidifierBaseQuantities',
  'Qto_LaborResourceBaseQuantities', 'Qto_LampBaseQuantities',
  'Qto_LightFixtureBaseQuantities', 'Qto_MemberBaseQuantities',
  'Qto_MotorConnectionBaseQuantities', 'Qto_OpeningElementBaseQuantities',
  'Qto_OutletBaseQuantities', 'Qto_PileBaseQuantities',
  'Qto_PipeFittingBaseQuantities', 'Qto_PipeSegmentBaseQuantities',
  'Qto_PlateBaseQuantities', 'Qto_ProjectionElementBaseQuantities',
  'Qto_ProtectiveDeviceBaseQuantities', 'Qto_PumpBaseQuantities',
  'Qto_RailingBaseQuantities', 'Qto_RampFlightBaseQuantities',
  'Qto_ReinforcingElementBaseQuantities', 'Qto_RoofBaseQuantities',
  'Qto_SanitaryTerminalBaseQuantities', 'Qto_SiteBaseQuantities',
  'Qto_SlabBaseQuantities', 'Qto_SpaceBaseQuantities',
  'Qto_SpatialZoneBaseQuantities', 'Qto_StairBaseQuantities',
  'Qto_StairFlightBaseQuantities', 'Qto_SwitchingDeviceBaseQuantities',
  'Qto_TankBaseQuantities', 'Qto_TransformerBaseQuantities',
  'Qto_TubeBundleBaseQuantities', 'Qto_UnitaryControlElementBaseQuantities',
  'Qto_UnitaryEquipmentBaseQuantities', 'Qto_ValveBaseQuantities',
  'Qto_VoidingFeatureBaseQuantities', 'Qto_WallBaseQuantities',
  'Qto_WindowBaseQuantities', 'Qto_WorkEquipmentBaseQuantities',
]);

/** buildingSMART-standard IfcPhysicalQuantity names used across Qto_*BaseQuantities. */
const STANDARD_QUANTITY = new Set([
  'Length', 'Width', 'Height', 'Depth', 'Thickness', 'Perimeter', 'Diameter', 'Span',
  'CrossSectionArea', 'OuterSurfaceArea', 'TotalSurfaceArea', 'GrossSurfaceArea', 'NetSurfaceArea',
  'GrossArea', 'NetArea', 'GrossSideArea', 'NetSideArea', 'GrossFootprintArea', 'NetFootprintArea',
  'GrossCeilingArea', 'NetCeilingArea', 'GrossWallArea', 'NetWallArea',
  'GrossFloorArea', 'NetFloorArea', 'GrossRoofArea', 'NetRoofArea',
  'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight',
  'Area', 'Volume', 'Weight', 'Count', 'Number', 'Shape',
]);

/**
 * The same closed vocabulary, exported so `build-scorecard.mjs`'s identifier
 * guard can hold `qsetLabelCounts` keys to it. The guard used to carry its own
 * copy of the `Qto_[A-Za-z0-9]+` pattern, so the two lines of defence shared
 * one hole: a leak that got past this filter also got past the guard.
 */
export const STANDARD_QSET_NAMES = STANDARD_QSET;

/**
 * Emit a file-authored name only when it is standard vocabulary.
 * Returns `<non-standard>` otherwise.
 */
export function standardNameOrPlaceholder(name, kind) {
  if (typeof name !== 'string') return '<non-standard>';
  if (kind === 'qset') return STANDARD_QSET.has(name) ? name : '<non-standard>';
  return STANDARD_QUANTITY.has(name) ? name : '<non-standard>';
}

/** Round to `d` decimals, returning a finite number or null. */
export function round(v, d = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
