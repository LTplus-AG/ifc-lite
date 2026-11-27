/* SPDX-License-Identifier: MPL-2.0 */

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
  ['IFCDOORSTYLE', 'IFCDOORTYPE'],
  ['IFCELECTRICDISTRIBUTIONPOINT', 'IFCDISTRIBUTIONBOARD'],
  ['IFCWINDOWSTYLE', 'IFCWINDOWTYPE'],
  ['IFCPROXY', 'IFCBUILDINGELEMENTPROXY'],
]);

export function upgradeIfc4x3Type(source: string): string | undefined {
  return renamed.get(source);
}

export function needsIfc4x3SlotMap(source: string): boolean {
  return source === 'IFCDOORSTYLE' || source === 'IFCWINDOWSTYLE' || source === 'IFCPROXY';
}

function sourceName(type: string, target: string): string {
  return type === 'IFCWINDOWSTYLE' && target === 'PartitioningType' ? 'OperationType' : target;
}

export function remapIfc4x3Slots(type: string, source: readonly string[], target: readonly string[], args: readonly string[]): string {
  // The source operation and proxy type differ from the target PredefinedType.
  return target.map((name) => name === 'PredefinedType'
    ? '.NOTDEFINED.'
    : args[source.indexOf(sourceName(type, name))] ?? '$').join(',');
}

export function droppedIfc4x3SlotNames(type: string, source: readonly string[], target: readonly string[]): string[] {
  const used = new Set(target.map((name) => sourceName(type, name)));
  return source.filter((name) => !used.has(name));
}
