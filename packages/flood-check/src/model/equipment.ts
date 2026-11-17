/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which technical equipment counts, per schema. Class names were checked
 * against the repo's schema data (`packages/data/src/ifc-schema/generated/
 * entities-ifc2x3.ts`, `-ifc4.ts`, `-ifc4x3.ts`):
 *
 * - IFC4 and IFC4X3 have specific occurrence classes ({@link EQUIPMENT_OCCURRENCES}).
 * - IFC2X3 has none of them except `IfcElectricDistributionPoint` and
 *   `IfcTransportElement`: a boiler is an `IfcEnergyConversionDevice` typed by
 *   an `IfcBoilerType`, a pump an `IfcFlowMovingDevice` typed by an
 *   `IfcPumpType`, and so on. Generic occurrences are therefore resolved
 *   through their type object ({@link EQUIPMENT_TYPES}) in every schema, since
 *   IFC4 exporters use that pattern too. `IfcCommunicationsAppliance` and its
 *   type exist only from IFC4 on; an IFC2X3 communications device cannot be
 *   recognised by class.
 */

/** Occurrence classes (UPPERCASE STEP names) and, where only some types qualify, their predefined types. */
export const EQUIPMENT_OCCURRENCES: ReadonlyArray<{ type: string; predefined?: readonly string[] }> = [
  { type: 'IFCELECTRICDISTRIBUTIONBOARD' }, // IFC4, IFC4X3
  { type: 'IFCELECTRICDISTRIBUTIONPOINT' }, // IFC2X3 name of the distribution board
  { type: 'IFCTRANSFORMER' },
  { type: 'IFCELECTRICGENERATOR' },
  { type: 'IFCELECTRICFLOWSTORAGEDEVICE' }, // batteries, UPS
  { type: 'IFCSWITCHINGDEVICE' },
  { type: 'IFCPROTECTIVEDEVICE' },
  { type: 'IFCCOMMUNICATIONSAPPLIANCE' },
  { type: 'IFCBOILER' },
  { type: 'IFCCHILLER' },
  { type: 'IFCUNITARYEQUIPMENT' }, // heat pumps, air handlers
  { type: 'IFCPUMP' },
  { type: 'IFCTANK' },
  { type: 'IFCTRANSPORTELEMENT', predefined: ['ELEVATOR', 'LIFTINGGEAR'] },
];

/** Generic occurrence classes that are equipment when their type object is one of {@link EQUIPMENT_TYPES}. */
export const GENERIC_OCCURRENCES: readonly string[] = [
  'IFCENERGYCONVERSIONDEVICE',
  'IFCFLOWMOVINGDEVICE',
  'IFCFLOWSTORAGEDEVICE',
  'IFCFLOWCONTROLLER',
  'IFCFLOWTERMINAL',
];

/** Type objects (all present in IFC2X3, IFC4 and IFC4X3 unless noted) that make a generic occurrence equipment. */
export const EQUIPMENT_TYPES: ReadonlySet<string> = new Set([
  'IFCTRANSFORMERTYPE',
  'IFCELECTRICGENERATORTYPE',
  'IFCELECTRICFLOWSTORAGEDEVICETYPE',
  'IFCSWITCHINGDEVICETYPE',
  'IFCPROTECTIVEDEVICETYPE',
  'IFCCOMMUNICATIONSAPPLIANCETYPE', // IFC4, IFC4X3
  'IFCELECTRICDISTRIBUTIONBOARDTYPE', // IFC4, IFC4X3
  'IFCBOILERTYPE',
  'IFCCHILLERTYPE',
  'IFCUNITARYEQUIPMENTTYPE',
  'IFCPUMPTYPE',
  'IFCTANKTYPE',
]);
