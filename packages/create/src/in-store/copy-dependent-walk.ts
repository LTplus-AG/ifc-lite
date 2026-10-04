/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CopyContext } from './copy-product.js';

/** Separate from the public 10k root/transform budget. A normal Bonsai wall
 * carries two openings and two fillings: 10k roots remains exactly admissible. */
export const COPY_PRODUCT_WORK_LIMIT = 50_000;
const MAX_DEPENDENT_REFERENCES = COPY_PRODUCT_WORK_LIMIT * 4;

type ProductStep = { kind: 'opening' | 'filling' | 'part'; sourceId: number; parentId: number; ownerHistory: string | null };
type AssemblyStep = { kind: 'assembly'; sourceId: number; parts: number[]; ownerHistory: string | null };
type Step = ProductStep | AssemblyStep;
type Task = { kind: 'enter'; id: number } | { kind: 'part'; id: number; parentId: number; collected: number[] } | AssemblyStep;

/** Iterative depth-first traversal matches the existing product preorder and
 * relation postorder. Assemblies dedupe parts globally; hosted links retain
 * their existing per-host cardinality. Neither deep acyclic graphs nor cycles
 * consume the JavaScript call stack. */
export function* copyDependentSteps(ctx: CopyContext, rootId: number): Generator<Step> {
  const visited = new Set([rootId]);
  const tasks: Task[] = [{ kind: 'enter', id: rootId }];
  let references = 0;
  const boundedReference = () => {
    if (++references > MAX_DEPENDENT_REFERENCES) throw new Error(`Copy dependent graph exceeds ${MAX_DEPENDENT_REFERENCES} references`);
  };
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === 'assembly') { yield task; continue; }
    if (task.kind === 'part') {
      if (visited.has(task.id)) continue;
      visited.add(task.id); task.collected.push(task.id);
      yield { kind: 'part', sourceId: task.id, parentId: task.parentId, ownerHistory: null };
      tasks.push({ kind: 'enter', id: task.id });
      continue;
    }
    for (const opening of ctx.voids.get(task.id) ?? []) {
      boundedReference();
      yield { kind: 'opening', sourceId: opening.id, parentId: task.id, ownerHistory: opening.ownerHistory };
      for (const filling of ctx.fills.get(opening.id) ?? []) {
        boundedReference();
        yield { kind: 'filling', sourceId: filling.id, parentId: opening.id, ownerHistory: filling.ownerHistory };
      }
    }
    const links = ctx.parts.get(task.id) ?? [];
    for (let i = links.length - 1; i >= 0; i--) {
      boundedReference();
      const link = links[i], collected: number[] = [];
      tasks.push({ kind: 'assembly', sourceId: task.id, parts: collected, ownerHistory: link.ownerHistory });
      for (let p = link.parts.length - 1; p >= 0; p--) {
        boundedReference();
        tasks.push({ kind: 'part', id: link.parts[p], parentId: task.id, collected });
      }
    }
  }
}

/** Actual writes, including openings that preview intentionally omits. Stops
 * before writes when fan-out would exceed the separately bounded work budget. */
export function copiedProductWork(ctx: CopyContext, rootId: number): number {
  let count = 1;
  for (const step of copyDependentSteps(ctx, rootId)) if (step.kind !== 'assembly' && ++count > COPY_PRODUCT_WORK_LIMIT)
    throw new Error(`Copy carried products exceed ${COPY_PRODUCT_WORK_LIMIT} product writes`);
  return count;
}
