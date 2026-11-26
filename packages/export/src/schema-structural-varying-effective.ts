/* SPDX-License-Identifier: MPL-2.0 */

import { StructuralCarriers } from './schema-converter-structural-carriers.js';
import { unusableAppliedLoad } from './schema-structural-varying-constant.js';
import { StructuralVarying, varyingTarget } from './schema-converter-structural-varying.js';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef } from './schema-converter-structural-source.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { skipStepTrivia } from './step-slot-grammar.js';

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
    const carried = new Set(cause ? ['CausedBy'] : []);
    const restored = (next <= 0xffffffff ? plan.rewrite(id, record.type, args, carried) : undefined) ?? plan.constant(record.type, args, carried);
    if (restored?.unusableAppliedLoad) throw unusableAppliedLoad(id, record.type);
    if (!restored?.body) continue;
    for (const warning of restored.losses) noteLoss(warning);
    lines[index] = '#' + id + '=' + restored.body + ';';
  }
  const added = [...plan.added(), ...carriers.added()];
  for (const line of added) lines.push(line);
  return added.length;
}
