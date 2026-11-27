/* SPDX-License-Identifier: MPL-2.0 */

import type { IfcSchemaVersion } from './schema-converter.js';

const styleTypes = new Map([
  ['IFCDOORSTYLE', 'IFCDOORTYPE'],
  ['IFCWINDOWSTYLE', 'IFCWINDOWTYPE'],
]);

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

export function upgradeNamedType(source: string, from: IfcSchemaVersion, to: IfcSchemaVersion): string | undefined {
  if (to === 'IFC4X3' && (from === 'IFC2X3' || from === 'IFC4')) {
    return renamed.get(source) ?? styleTypes.get(source);
  }
  return from === 'IFC2X3' && to === 'IFC4' ? styleTypes.get(source) : undefined;
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
