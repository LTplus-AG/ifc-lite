/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * buildingSMART's IFC2X3 occurrence/type mapping table.
 *
 * IFC2X3 predates several IFC4 entity classes (`IfcAirTerminal`,
 * `IfcFilter`, `IfcValve`, …). An IFC2X3 model represents those concepts
 * with a generic occurrence class (`IfcFlowTerminal`, `IfcFlowController`,
 * …) related to a specific type object (`IfcAirTerminalType`,
 * `IfcFilterType`, …) via `IfcRelDefinesByType`. The IDS spec defines this
 * table so an entity facet can name the IFC4-only class and still match
 * the equivalent IFC2X3 (occurrence, type) pair:
 *
 * "The following table lists all special cases for checking IFC2X3
 * models[.] ... [F]or example, the definition of an IDS applicability
 * facet with entity `IfcFilter`, should result in the identification of
 * all `IfcFlowTreatmentDevice` that are associated with a type
 * `IfcFilterType`."
 *
 * Source (CC BY-ND 4.0, (c) buildingSMART International Ltd):
 * https://github.com/buildingSMART/IDS/blob/master/Documentation/ImplementersDocumentation/ifc2x3-occurrence-type-mapping-table.md
 *
 * Scoped to IFC2X3 only — callers must gate on schema version before
 * consulting this table. IFC4+ already has real classes for every alias
 * below, so applying the same fallback there would let a facet match an
 * entity typed by the *old* IFC2X3-style pairing when the model should
 * have used the dedicated class instead.
 */

/** One row of the table: an IDS-facet-visible alias mapped to its IFC2X3 (occurrence, type) pair. */
export interface Ifc2x3TypeMappingRow {
  /** The entity name an IDS facet may specify (e.g. `IFCAIRTERMINAL`). Uppercase. */
  alias: string;
  /** The actual IFC2X3 occurrence class (e.g. `IFCFLOWTERMINAL`). Uppercase. */
  occurrence: string;
  /** The IFC2X3 type class the occurrence must be related to (e.g. `IFCAIRTERMINALTYPE`). Uppercase. */
  typeEntity: string;
}

const ROWS: readonly Ifc2x3TypeMappingRow[] = [
  { alias: 'IFCFURNITURE', occurrence: 'IFCFURNISHINGELEMENT', typeEntity: 'IFCFURNITURETYPE' },
  { alias: 'IFCSYSTEMFURNITUREELEMENT', occurrence: 'IFCFURNISHINGELEMENT', typeEntity: 'IFCSYSTEMFURNITUREELEMENTTYPE' },
  { alias: 'IFCACTUATOR', occurrence: 'IFCDISTRIBUTIONCONTROLELEMENT', typeEntity: 'IFCACTUATORTYPE' },
  { alias: 'IFCALARM', occurrence: 'IFCDISTRIBUTIONCONTROLELEMENT', typeEntity: 'IFCALARMTYPE' },
  { alias: 'IFCCONTROLLER', occurrence: 'IFCDISTRIBUTIONCONTROLELEMENT', typeEntity: 'IFCCONTROLLERTYPE' },
  { alias: 'IFCFLOWINSTRUMENT', occurrence: 'IFCDISTRIBUTIONCONTROLELEMENT', typeEntity: 'IFCFLOWINSTRUMENTTYPE' },
  { alias: 'IFCSENSOR', occurrence: 'IFCDISTRIBUTIONCONTROLELEMENT', typeEntity: 'IFCSENSORTYPE' },
  { alias: 'IFCAIRTOAIRHEATRECOVERY', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCAIRTOAIRHEATRECOVERYTYPE' },
  { alias: 'IFCBOILER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCBOILERTYPE' },
  { alias: 'IFCCHILLER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCCHILLERTYPE' },
  { alias: 'IFCCOIL', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCCOILTYPE' },
  { alias: 'IFCCONDENSER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCCONDENSERTYPE' },
  { alias: 'IFCCOOLEDBEAM', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCCOOLEDBEAMTYPE' },
  { alias: 'IFCCOOLINGTOWER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCCOOLINGTOWERTYPE' },
  { alias: 'IFCELECTRICGENERATOR', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCELECTRICGENERATORTYPE' },
  { alias: 'IFCELECTRICMOTOR', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCELECTRICMOTORTYPE' },
  { alias: 'IFCEVAPORATIVECOOLER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCEVAPORATIVECOOLERTYPE' },
  { alias: 'IFCEVAPORATOR', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCEVAPORATORTYPE' },
  { alias: 'IFCHEATEXCHANGER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCHEATEXCHANGERTYPE' },
  { alias: 'IFCHUMIDIFIER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCHUMIDIFIERTYPE' },
  { alias: 'IFCMOTORCONNECTION', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCMOTORCONNECTIONTYPE' },
  { alias: 'IFCSPACEHEATER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCSPACEHEATERTYPE' },
  { alias: 'IFCTRANSFORMER', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCTRANSFORMERTYPE' },
  { alias: 'IFCTUBEBUNDLE', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCTUBEBUNDLETYPE' },
  { alias: 'IFCUNITARYEQUIPMENT', occurrence: 'IFCENERGYCONVERSIONDEVICE', typeEntity: 'IFCUNITARYEQUIPMENTTYPE' },
  { alias: 'IFCAIRTERMINALBOX', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCAIRTERMINALBOXTYPE' },
  { alias: 'IFCDAMPER', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCDAMPERTYPE' },
  { alias: 'IFCELECTRICTIMECONTROL', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCELECTRICTIMECONTROLTYPE' },
  { alias: 'IFCFLOWMETER', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCFLOWMETERTYPE' },
  { alias: 'IFCPROTECTIVEDEVICE', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCPROTECTIVEDEVICETYPE' },
  { alias: 'IFCSWITCHINGDEVICE', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCSWITCHINGDEVICETYPE' },
  { alias: 'IFCVALVE', occurrence: 'IFCFLOWCONTROLLER', typeEntity: 'IFCVALVETYPE' },
  { alias: 'IFCCABLECARRIERFITTING', occurrence: 'IFCFLOWFITTING', typeEntity: 'IFCCABLECARRIERFITTINGTYPE' },
  { alias: 'IFCDUCTFITTING', occurrence: 'IFCFLOWFITTING', typeEntity: 'IFCDUCTFITTINGTYPE' },
  { alias: 'IFCJUNCTIONBOX', occurrence: 'IFCFLOWFITTING', typeEntity: 'IFCJUNCTIONBOXTYPE' },
  { alias: 'IFCPIPEFITTING', occurrence: 'IFCFLOWFITTING', typeEntity: 'IFCPIPEFITTINGTYPE' },
  { alias: 'IFCCOMPRESSOR', occurrence: 'IFCFLOWMOVINGDEVICE', typeEntity: 'IFCCOMPRESSORTYPE' },
  { alias: 'IFCFAN', occurrence: 'IFCFLOWMOVINGDEVICE', typeEntity: 'IFCFANTYPE' },
  { alias: 'IFCPUMP', occurrence: 'IFCFLOWMOVINGDEVICE', typeEntity: 'IFCPUMPTYPE' },
  { alias: 'IFCCABLECARRIERSEGMENT', occurrence: 'IFCFLOWSEGMENT', typeEntity: 'IFCCABLECARRIERSEGMENTTYPE' },
  { alias: 'IFCCABLESEGMENT', occurrence: 'IFCFLOWSEGMENT', typeEntity: 'IFCCABLESEGMENTTYPE' },
  { alias: 'IFCDUCTSEGMENT', occurrence: 'IFCFLOWSEGMENT', typeEntity: 'IFCDUCTSEGMENTTYPE' },
  { alias: 'IFCPIPESEGMENT', occurrence: 'IFCFLOWSEGMENT', typeEntity: 'IFCPIPESEGMENTTYPE' },
  { alias: 'IFCELECTRICFLOWSTORAGEDEVICE', occurrence: 'IFCFLOWSTORAGEDEVICE', typeEntity: 'IFCELECTRICFLOWSTORAGEDEVICETYPE' },
  { alias: 'IFCTANK', occurrence: 'IFCFLOWSTORAGEDEVICE', typeEntity: 'IFCTANKTYPE' },
  { alias: 'IFCAIRTERMINAL', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCAIRTERMINALTYPE' },
  { alias: 'IFCELECTRICAPPLIANCE', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCELECTRICAPPLIANCETYPE' },
  { alias: 'IFCFIRESUPPRESSIONTERMINAL', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCFIRESUPPRESSIONTERMINALTYPE' },
  { alias: 'IFCLAMP', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCLAMPTYPE' },
  { alias: 'IFCLIGHTFIXTURE', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCLIGHTFIXTURETYPE' },
  { alias: 'IFCOUTLET', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCOUTLETTYPE' },
  { alias: 'IFCSANITARYTERMINAL', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCSANITARYTERMINALTYPE' },
  { alias: 'IFCSTACKTERMINAL', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCSTACKTERMINALTYPE' },
  { alias: 'IFCWASTETERMINAL', occurrence: 'IFCFLOWTERMINAL', typeEntity: 'IFCWASTETERMINALTYPE' },
  { alias: 'IFCDUCTSILENCER', occurrence: 'IFCFLOWTREATMENTDEVICE', typeEntity: 'IFCDUCTSILENCERTYPE' },
  { alias: 'IFCFILTER', occurrence: 'IFCFLOWTREATMENTDEVICE', typeEntity: 'IFCFILTERTYPE' },
  { alias: 'IFCVIBRATIONISOLATOR', occurrence: 'IFCEQUIPMENTELEMENT', typeEntity: 'IFCVIBRATIONISOLATORTYPE' },
];

/** Rows indexed by occurrence class, for the (entityType, typeEntityType) → alias direction. */
const BY_OCCURRENCE: ReadonlyMap<string, readonly Ifc2x3TypeMappingRow[]> = (() => {
  const map = new Map<string, Ifc2x3TypeMappingRow[]>();
  for (const row of ROWS) {
    const list = map.get(row.occurrence);
    if (list) list.push(row);
    else map.set(row.occurrence, [row]);
  }
  return map;
})();

/** Every alias name any row maps to — used for the applicability broadphase. */
export const IFC2X3_MAPPED_ALIASES: ReadonlySet<string> = new Set(ROWS.map((r) => r.alias));

/**
 * Rows whose occurrence class is `occurrenceType` (already uppercase),
 * or an empty array when nothing in the table maps to it.
 */
export function rowsForOccurrence(occurrenceType: string): readonly Ifc2x3TypeMappingRow[] {
  return BY_OCCURRENCE.get(occurrenceType) ?? [];
}

/** The row whose alias is `alias` (already uppercase), if any. */
export function rowForAlias(alias: string): Ifc2x3TypeMappingRow | undefined {
  return ROWS.find((r) => r.alias === alias);
}
