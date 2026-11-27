/* SPDX-License-Identifier: MPL-2.0 */

import type { IfcSchemaVersion } from './schema-converter.js';

const styleTypes = new Map([
  ['IFCDOORSTYLE', 'IFCDOORTYPE'],
  ['IFCWINDOWSTYLE', 'IFCWINDOWTYPE'],
]);

export function upgradeStyleType(source: string): string | undefined {
  return styleTypes.get(source);
}

// IFC4X3 dropped the old case entities. Their supertypes have the same slots.
// Replacements with a changed layout use a name-based map.
const renamed = new Map([
  ['IFCBEAMSTANDARDCASE', 'IFCBEAM'],
  ['IFCBUILDINGELEMENT', 'IFCBUILTELEMENT'],
  ['IFCBUILDINGELEMENTTYPE', 'IFCBUILTELEMENTTYPE'],
  ['IFCCOLUMNSTANDARDCASE', 'IFCCOLUMN'],
  ['IFCDOORSTANDARDCASE', 'IFCDOOR'],
  ['IFCMEMBERSTANDARDCASE', 'IFCMEMBER'],
  ['IFCOPENINGSTANDARDCASE', 'IFCOPENINGELEMENT'],
  ['IFCPLATESTANDARDCASE', 'IFCPLATE'],
  ['IFCSLABELEMENTEDCASE', 'IFCSLAB'],
  ['IFCSLABSTANDARDCASE', 'IFCSLAB'],
  ['IFCWALLELEMENTEDCASE', 'IFCWALL'],
  ['IFCWINDOWSTANDARDCASE', 'IFCWINDOW'],
  ['IFCELECTRICDISTRIBUTIONPOINT', 'IFCDISTRIBUTIONBOARD'],
  ['IFCPROXY', 'IFCBUILDINGELEMENTPROXY'],
]);

export function upgradeIfc4x3Type(source: string): string | undefined {
  return renamed.get(source) ?? upgradeStyleType(source);
}

export function needsUpgradeSlotMap(source: string, from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
  if (to === 'IFC4X3') return styleTypes.has(source) || source === 'IFCPROXY';
  return from === 'IFC2X3' && to === 'IFC4' && styleTypes.has(source);
}

function sourceName(type: string, target: string): string {
  return type === 'IFCWINDOWSTYLE' && target === 'PartitioningType' ? 'OperationType' : target;
}

export function remapUpgradeSlots(type: string, source: readonly string[], target: readonly string[], args: readonly string[]): string {
  // The source operation and proxy type differ from the target PredefinedType.
  return target.map((name) => name === 'PredefinedType'
    ? '.NOTDEFINED.'
    : args[source.indexOf(sourceName(type, name))] ?? '$').join(',');
}

export function droppedUpgradeSlotNames(type: string, source: readonly string[], target: readonly string[]): string[] {
  const used = new Set(target.map((name) => sourceName(type, name)));
  return source.filter((name) => !used.has(name));
}
