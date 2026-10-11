/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Corpus revisions for diff / merge property tests: a document built from
 * corpus specifications, and random edits applied to it with the reducer
 * (so the edited document keeps node ids and KNOWS what changed).
 */

import type { IDSDocument } from '@ifc-lite/ids';
import { fromIdsDocument } from '../src/document/from-ids.js';
import type { StudioDocument } from '../src/document/types.js';
import type { StudioOp } from '../src/ops/types.js';
import { apply } from '../src/reducer/apply.js';
import { counterIds, loadCorpus } from './corpus.js';
import { randomOp, type Rng } from './op-gen.js';

/** A document of `count` corpus specifications chosen by `seq`. */
export function corpusDocument(seq: number, count = 5, idPrefix = 0x700): StudioDocument {
  const corpus = loadCorpus();
  const merged: IDSDocument = {
    info: { title: `rev ${seq}` },
    specifications: Array.from({ length: count }, (_, k) => corpus[(seq * 7 + k * 53) % corpus.length].ids.specifications).flat(),
  };
  return fromIdsDocument(merged, { newId: counterIds(idPrefix + seq) });
}

/** Apply up to `n` random valid ops; returns the edited document and the ops. */
export function mutate(
  rng: Rng,
  doc: StudioDocument,
  n: number,
  newId: () => string,
  accept: (op: StudioOp, doc: StudioDocument) => boolean = () => true,
): { doc: StudioDocument; ops: StudioOp[] } {
  let next = doc;
  const ops: StudioOp[] = [];
  for (let tries = 0; ops.length < n && tries < n * 10; tries++) {
    const op = randomOp(rng, next, newId);
    if (!op || !accept(op, next)) continue;
    next = apply(next, [op]).doc;
    ops.push(op);
  }
  return { doc: next, ops };
}

/** Everything a patch must reproduce: content, node ids, custom declarations. */
export function shape(doc: StudioDocument): unknown {
  const sortBy = <T>(list: readonly T[], key: (x: T) => string) => [...list].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return {
    ids: doc.ids,
    nodes: doc.nodes,
    psets: sortBy(doc.meta.custom.psets, (d) => d.name),
    udts: sortBy(doc.meta.custom.userDefinedTypes, (d) => `${d.entity}/${d.value}`),
  };
}
