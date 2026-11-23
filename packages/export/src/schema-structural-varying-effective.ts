/* SPDX-License-Identifier: MPL-2.0 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { StructuralCarriers } from './schema-converter-structural-carriers.js';
import { StructuralVarying, varyingTarget } from './schema-converter-structural-varying.js';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef, slotUnset } from './schema-converter-structural-source.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { skipStepTrivia } from './step-slot-grammar.js';

const LOSS = 'The retained varying structural action has no complete load configuration; its varying locations and subsequent loads were omitted (#11037).';
const MISSING_LOAD = 'The retained varying structural action has no usable AppliedLoad; the required IFC4 slot was left unset (#11037).';

export function finishEffectiveVarying(lines: string[], includeRelationships: boolean, noteLoss: (message: string) => void): number {
  // Most edited exports have no varying actions.
  if (!lines.some((line) => /IFCSTRUCTURAL(?:LINEAR|PLANAR)ACTIONVARYING/i.test(line))) return 0;
  const types = new Map<number, string>();
  const byId = new Map<number, string>();
  const byType = new Map<string, number[]>();
  const candidates = new Map<number, number>();
  let next = 1;
  lines.forEach((line, index) => {
    const head = stepRecordHead(line);
    const id = Number(/^#(\d+)/.exec(line.slice(skipStepTrivia(line, 0)))?.[1]);
    if (id >= next) next = id + 1;
    if (!head || !id) return;
    const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
    types.set(id, type);
    if (['IFCSHAPEASPECT', 'IFCRELASSIGNSTOPRODUCT', 'IFCSTRUCTURALPOINTREACTION'].includes(type)) {
      byId.set(id, line);
      const ids = byType.get(type);
      if (ids) ids.push(id);
      else byType.set(type, [id]);
    }
    if (varyingTarget(type)) candidates.set(id, index);
  });
  const source = {
    ids: (type: string) => byType.get(type) ?? [],
    slots: (id: number | null) => {
      const line = id === null ? undefined : byId.get(id);
      return line === undefined ? undefined : readStepSlots(line)?.slots;
    },
    type: (id: number | null) => id === null ? undefined : types.get(id),
  };
  const plan = new StructuralVarying();
  plan.fromEffective(types, source.ids('IFCSHAPEASPECT'), (id) => {
    const args = source.slots(id);
    const shape = args && slotRef(args[4]);
    const subshapes = args && listItems(args[0]);
    return shape && types.has(shape) && subshapes?.every((ref) => types.has(slotRef(ref) ?? 0)) ? args : undefined;
  });
  const carriers = new StructuralCarriers();
  if (includeRelationships) carriers.fromEmitted(source);
  carriers.ids = plan.ids = () => next++;
  for (const [id, index] of candidates) {
    const record = readStepSlots(lines[index]);
    if (!record) continue;
    const args = Array.from({ length: 14 }, (_, at) => record.slots[at] ?? '$');
    const present = (slot: string) => types.has(slotRef(slot) ?? 0);
    for (const slot of [1, 5, 6]) if (!present(args[slot])) args[slot] = '$';
    const cause = includeRelationships && next <= 0xffffffff ? carriers.noteCause(id, record.type, args, undefined) : null;
    if (cause) noteLoss(cause.message);
    const restored = next <= 0xffffffff ? plan.rewrite(id, record.type, args, new Set(cause ? ['CausedBy'] : [])) : undefined;
    if (restored?.body) {
      for (const warning of restored.losses) noteLoss(warning);
      lines[index] = '#' + id + '=' + restored.body + ';';
      continue;
    }
    const sourceLoad = types.get(slotRef(args[7]) ?? 0);
    const load = sourceLoad && getInheritanceChainAcrossSchemas(sourceLoad).includes('IfcStructuralLoad') ? args[7] : '$';
    const target = varyingTarget(record.type)!;
    lines[index] = '#' + id + '=' + target + '(' + [...args.slice(0, 7), load, args[8],
      args[9], args[11], '.CONST.'].join(',') + ');';
    noteLoss(LOSS);
    if (load === '$') noteLoss(MISSING_LOAD);
    if (!cause && !slotUnset(args[10])) noteLoss(record.type + '.CausedBy has no slot in IFC4; its value is omitted (#11037).');
  }
  const added = [...plan.added(), ...carriers.added()];
  for (const line of added) lines.push(line);
  return added.length;
}
