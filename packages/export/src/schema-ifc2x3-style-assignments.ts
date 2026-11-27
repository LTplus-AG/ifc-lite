/* SPDX-License-Identifier: MPL-2.0 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef } from './schema-converter-structural-source.js';
import type { Rec, Records } from './schema-ifc2x3-records.js';
import { readStepSlots } from './step-argument-parser.js';

const ASSIGNMENT = 'IFCPRESENTATIONSTYLEASSIGNMENT';

/** IFC2X3 StyledItem.Styles holds assignments, which in turn hold the styles. */
export function wrapDirectStyles(records: Records, rec: Rec, id: number): [string, string] | null {
  const record = readStepSlots(rec.text);
  const members = record?.slots.length === 3 ? listItems(record.slots[1]) : null;
  if (!record || !members?.length) return null;
  const styles: string[] = [];
  const assignments: string[] = [];
  for (const member of members) {
    const type = records.get(slotRef(member))?.type;
    if (type === ASSIGNMENT) assignments.push(member);
    else if (type && getInheritanceChainAcrossSchemas(type).includes('IfcPresentationStyle')) styles.push(member);
    else return null;
  }
  if (!styles.length) return null;
  assignments.push('#' + id);
  const [item, , name] = record.slots;
  return [
    record.prefix + item + ',(' + assignments.join(',') + '),' + name + record.suffix,
    '#' + id + '=' + ASSIGNMENT + '((' + styles.join(',') + '));',
  ];
}
