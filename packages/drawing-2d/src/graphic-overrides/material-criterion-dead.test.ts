/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ElementData.materials` (and the sibling `.layers`) used to be declared
 * and read by the rule engine's `material`/`layer` criteria, but every
 * production construction site of `ElementData` — all in apps/viewer
 * (`Drawing2DCanvas.tsx`, `useDrawingExport.ts`) — populates only
 * `expressId` and `ifcType`. No writer for `.materials`/`.layers` existed
 * anywhere in packages/ or apps/, so within this repository the two criteria
 * could never match (an external consumer of the exported `ElementData` could
 * populate either field, which is why their removal is breaking): an
 * override rule keyed on material or layer silently did nothing, with no
 * error and no unmatched-criterion warning. Removed rather than wired up —
 * see CriteriaType in ./types.ts for why.
 *
 * This test pins the removal at both the type and the runtime level, using
 * an `ElementData` built exactly the way every real call site builds one
 * (see `productionShapedElement`) so a reintroduction of either field would
 * be caught the same way the original bug would have been.
 */

import { describe, it, expect } from 'vitest';
import { createOverrideEngine } from './rule-engine.js';
import type { GraphicOverrideRule, ElementData, CriteriaType, OverrideCriterion } from './types.js';

/**
 * Mirrors, field for field, every `ElementData` literal actually built in
 * production (apps/viewer/src/components/viewer/Drawing2DCanvas.tsx and
 * apps/viewer/src/hooks/useDrawingExport.ts): only `expressId` and
 * `ifcType` are ever set. Neither `materials`, `layers`, nor `properties`
 * is populated at any of the eight construction sites.
 */
function productionShapedElement(expressId: number, ifcType: string): ElementData {
  return { expressId, ifcType };
}

describe('material/layer criteria were removed, not wired up', () => {
  it('CONTROL: an ifcType criterion — which production data DOES carry — still matches', () => {
    const rule: GraphicOverrideRule = {
      id: 'ifctype-rule',
      name: 'wall override',
      enabled: true,
      priority: 0,
      criteria: { type: 'ifcType', ifcTypes: ['IfcWall'] },
      style: { fillColor: '#FF0000' },
    };
    const engine = createOverrideEngine([rule]);
    const result = engine.applyOverrides(productionShapedElement(1, 'IfcWall'));
    expect(result.matchedRules).toHaveLength(1);
  });

  it('TYPE-LEVEL: "material" and "layer" are no longer valid CriteriaType values', () => {
    // @ts-expect-error — 'material' must not be assignable to CriteriaType.
    const badMaterial: CriteriaType = 'material';
    // @ts-expect-error — 'layer' must not be assignable to CriteriaType.
    const badLayer: CriteriaType = 'layer';
    expect([badMaterial, badLayer]).toBeDefined();
  });

  it('TYPE-LEVEL: ElementData no longer has a materials field', () => {
    const el: ElementData = {
      expressId: 1,
      ifcType: 'IfcWall',
      // @ts-expect-error — `materials` must not exist on ElementData.
      materials: ['Concrete'],
    };
    expect(el.expressId).toBe(1);
  });

  it('TYPE-LEVEL: ElementData no longer has a layers field', () => {
    const el: ElementData = {
      expressId: 1,
      ifcType: 'IfcWall',
      // @ts-expect-error — `layers` must not exist on ElementData.
      layers: ['A-WALL'],
    };
    expect(el.expressId).toBe(1);
  });

  it('RUNTIME (old persisted rules): a rule carrying a stale type: "material" from '
    + 'before this change is ignored safely, not thrown, and matches nothing', () => {
    // A rule loaded from old localStorage/JSON data can still carry the
    // removed criterion shape at runtime even though the type no longer
    // allows constructing one. Simulate that with an unknown-typed cast.
    const staleCriterion = { type: 'material', materialNames: ['Concrete'] } as unknown as OverrideCriterion;
    const rule: GraphicOverrideRule = {
      id: 'stale-material-rule',
      name: 'stale rule from before the fix',
      enabled: true,
      priority: 0,
      criteria: staleCriterion,
      style: { fillColor: '#888888' },
    };
    const engine = createOverrideEngine([rule]);
    const result = engine.applyOverrides(productionShapedElement(42, 'IfcWall'));
    expect(result.matchedRules).toHaveLength(0);
  });
});
