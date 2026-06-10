/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Roadmap L2 closure: seeded partition fuzz over REAL models — random op
 * partitions over a real layer stack must never lose ops. The synthetic
 * fuzz in three-way.test.ts proves the algebra on hand-built nodes; this
 * suite proves it against real IFCX documents (multi-opinion nodes, deep
 * children maps, real psets) where path/component collisions actually
 * occur. Fixtures are fetched on demand (AGENTS.md §9): the suite skips
 * cleanly when the bytes are not on disk.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { planThreeWayMerge } from './three-way.js';
import { opsToNodes } from './merge-layer.js';
import { extractStackState } from './component-state.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MODELS = [
  'tests/models/ifc5/Hello_Wall_hello-wall.ifcx',
  'tests/models/ifc5/Geotech_WekaHills_GeologyModel.ifcx',
].map((rel) => ({ rel, path: resolve(REPO_ROOT, rel) }));

const MARKER = 'bsi::ifc::v5a::Pset_FuzzCheck::Marker';
const MARKER_COMPONENT = 'pset:Pset_FuzzCheck';

/** Deterministic LCG so failures reproduce (same as three-way.test.ts). */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function loadModel(path: string): IfcxFile {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as IfcxFile;
  return {
    header: parsed.header,
    imports: Array.isArray(parsed.imports) ? parsed.imports : [],
    schemas: parsed.schemas ?? {},
    data: parsed.data,
  };
}

function delta(nodes: IfcxNode[], id: string): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'fuzz',
      timestamp: '2026-06-10T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
}

for (const model of MODELS) {
  const available = existsSync(model.path);

  describe(`real-model partition fuzz: ${model.rel}`, {
    skip: !available && `${model.rel} missing — run \`pnpm fixtures\``,
  }, () => {
    const base = available ? loadModel(model.path) : delta([], 'unreachable');
    const baseState = extractStackState([base]);
    // Live entities only; deletes are restricted to childless entities so
    // child-path shadowing never masks the assertion target itself.
    const paths = [...baseState.entries()]
      .filter(([, entity]) => !entity.deleted)
      .map(([path]) => path)
      .sort();
    const leaves = new Set(
      [...baseState.entries()]
        .filter(([, entity]) => !entity.deleted && entity.children.size === 0)
        .map(([path]) => path)
    );

    it('disjoint random partitions auto-merge without losing a single op', () => {
      for (const seed of [3, 11, 58]) {
        const rand = lcg(seed);
        const oursNodes: IfcxNode[] = [];
        const theirsNodes: IfcxNode[] = [];
        const expectations = new Map<string, { side: 'ours' | 'theirs'; kind: 'edit' | 'delete' }>();

        for (const path of paths) {
          const roll = rand();
          if (roll < 0.25) {
            oursNodes.push({ path, attributes: { [MARKER]: `OURS-${seed}` } });
            expectations.set(path, { side: 'ours', kind: 'edit' });
          } else if (roll < 0.5) {
            theirsNodes.push({ path, attributes: { [MARKER]: `THEIRS-${seed}` } });
            expectations.set(path, { side: 'theirs', kind: 'edit' });
          } else if (roll < 0.55 && leaves.has(path)) {
            theirsNodes.push({ path, attributes: { [IFCLITE_ATTR.DELETED]: true } });
            expectations.set(path, { side: 'theirs', kind: 'delete' });
          }
        }

        const ours = [base, delta(oursNodes, `ours-${seed}`)];
        const plan = planThreeWayMerge({
          ancestor: [base],
          ours,
          theirs: [base, delta(theirsNodes, `theirs-${seed}`)],
        });
        expect(plan.conflicts).toEqual([]);

        // Not one theirs op may vanish: every theirs-touched path must
        // surface in autoOps (ours edits are already in the ours stack).
        const autoPaths = new Set(plan.autoOps.map((op) => op.path));
        for (const [path, expectation] of expectations) {
          if (expectation.side === 'theirs') expect(autoPaths.has(path)).toBe(true);
        }

        const merged = extractStackState([...ours, delta(opsToNodes(plan.autoOps), 'merge')]);
        for (const [path, expectation] of expectations) {
          const entity = merged.get(path);
          if (expectation.kind === 'delete') {
            expect(entity === undefined || entity.deleted).toBe(true);
            continue;
          }
          expect(entity).toBeDefined();
          expect(entity?.components.get(MARKER_COMPONENT)?.[MARKER]).toBe(
            expectation.side === 'ours' ? `OURS-${seed}` : `THEIRS-${seed}`
          );
        }
      }
    });

    it('overlapping partitions surface every contested op as a conflict, never dropping it', () => {
      for (const seed of [5, 23]) {
        const rand = lcg(seed);
        const contested: string[] = [];
        const theirsOnly: string[] = [];
        for (const path of paths) {
          const roll = rand();
          if (roll < 0.2) contested.push(path);
          else if (roll < 0.4) theirsOnly.push(path);
        }
        // Degenerate seeds (tiny models) must not silently pass.
        expect(contested.length + theirsOnly.length).toBeGreaterThan(0);

        const oursNodes = contested.map((path): IfcxNode => ({ path, attributes: { [MARKER]: 'OURS' } }));
        const theirsNodes = [...contested, ...theirsOnly].map(
          (path): IfcxNode => ({ path, attributes: { [MARKER]: 'THEIRS' } })
        );

        const plan = planThreeWayMerge({
          ancestor: [base],
          ours: [base, delta(oursNodes, `ours-${seed}`)],
          theirs: [base, delta(theirsNodes, `theirs-${seed}`)],
        });

        // Accounting: contested paths conflict on the marker component,
        // theirs-only paths auto-merge — and their union covers every op.
        const conflictPaths = new Set(
          plan.conflicts.filter((c) => c.componentKey === MARKER_COMPONENT).map((c) => c.path)
        );
        const autoPaths = new Set(plan.autoOps.map((op) => op.path));
        for (const path of contested) expect(conflictPaths.has(path)).toBe(true);
        for (const path of theirsOnly) expect(autoPaths.has(path)).toBe(true);
      }
    });
  });
}
