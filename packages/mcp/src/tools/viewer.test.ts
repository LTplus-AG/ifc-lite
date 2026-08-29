/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for issue #3338: `resolveTargetRefs` in this file
 * used to turn a `global_id`/`global_ids` selector into `EntityRef[]` by
 * direct lookup only, with no `IfcRelAggregates` expansion. An
 * `IfcElementAssembly` (or any other decomposition container) carries no
 * mesh of its own — its parts do — and `packages/viewer`'s renderer
 * (`viewer-html.ts`) keys every override off rendered-mesh ids
 * (`entityMap`). So `viewer_isolate({ global_id: <assembly> })` isolated
 * against a set containing only the assembly's own id, which the renderer
 * never renders: every rendered entity failed the `idSet.has(eid)` check
 * and got dimmed to near-invisible — the whole model appeared to vanish.
 * `viewer_hide`/`viewer_show`/`viewer_colorize` had the quieter version of
 * the same bug: setting a color/visibility override for an id the renderer
 * never keys is a silent no-op.
 *
 * These tests exercise `viewer_isolate`/`viewer_hide`/`viewer_show`/
 * `viewer_colorize`/`viewer_fly_to` end to end (through the real tool
 * handlers, with a fake streaming adapter recording exactly which
 * `EntityRef[]` reached the backend) rather than unit-testing a helper in
 * isolation, so a regression in the wiring — not just the expansion logic
 * — fails these tests too.
 *
 * `viewer_fly_to` has the same failure mode as `viewer_hide`/`show`/
 * `colorize`: `packages/viewer`'s `viewer-html.ts` computes the camera
 * target bounding box only from `entityMap` (rendered-mesh ids), so an
 * unexpanded assembly id matches nothing and `getEntityBoundsForFilter`
 * returns `null` — the camera silently does not move.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EntityRef } from '@ifc-lite/sdk';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { viewerTools } from './viewer.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

function step(body: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
${body}
ENDSEC;
END-ISO-10303-21;
`;
}

// One geometry-less `IfcElementAssembly` (#100, the "roof assembly")
// aggregating two `IfcWall`s (#101, #102) via IfcRelAggregates, plus one
// standalone `IfcWall` (#103) that decomposes nothing — the no-op case.
const MODEL = step(`
#100= IFCELEMENTASSEMBLY('${guid('ASM')}',$,'Roof Assembly',$,$,#40,$,$,$,$);
#101= IFCWALL('${guid('WALL1')}',$,'Wall 1',$,$,#40,$,$,$);
#102= IFCWALL('${guid('WALL2')}',$,'Wall 2',$,$,#40,$,$,$);
#103= IFCWALL('${guid('WALL3')}',$,'Standalone Wall',$,$,#40,$,$,$);
#200= IFCRELAGGREGATES('${guid('REL')}',$,$,$,#100,(#101,#102));
`);

const ASM_GID = guid('ASM');
const WALL1_GID = guid('WALL1');
const WALL3_GID = guid('WALL3');

let tmp: string;
const ctx: ToolContext = {
  registry: new InMemoryModelRegistry(),
  scope: fullScope(),
  progress: NOOP_PROGRESS,
  log: SILENT_LOGGER,
  signal: new AbortController().signal,
  config: { ...DEFAULT_CONFIG },
  // A fake "always open" viewer manager — just enough for `requireViewer`
  // and each handler's `viewer.isOpen()` guard. The actual refs under test
  // are captured via `attachStreamingAdapters` below, not through this.
  viewer: { isOpen: () => true } as unknown as ToolContext['viewer'],
};

let isolateCalls: EntityRef[][];
let hideCalls: EntityRef[][];
let showCalls: EntityRef[][];
let colorizeCalls: EntityRef[][];
let flyToCalls: EntityRef[][];

async function load(): Promise<void> {
  const path = join(tmp, 'm.ifc');
  await writeFile(path, MODEL, 'utf-8');
  const model = await loadIfcModel(path, { modelId: 'm' });
  isolateCalls = [];
  hideCalls = [];
  showCalls = [];
  colorizeCalls = [];
  flyToCalls = [];
  model.backend.attachStreamingAdapters(
    {
      colorize(refs) { colorizeCalls.push(refs); },
      colorizeAll() {},
      resetColors() {},
      flyTo(refs) { flyToCalls.push(refs); },
      setSection() {},
      getSection() { return null; },
      setCamera() {},
      getCamera() { return { mode: 'perspective' as const }; },
    },
    {
      hide(refs) { hideCalls.push(refs); },
      show(refs) { showCalls.push(refs); },
      isolate(refs) { isolateCalls.push(refs); },
      reset() {},
    },
  );
  ctx.registry.add(model);
}

function tool(name: string) {
  const t = viewerTools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

function expressIdsOf(calls: EntityRef[][]): number[] {
  expect(calls.length).toBe(1);
  return [...calls[0]].map((r) => r.expressId).sort((a, b) => a - b);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mcp-viewer-test-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(() => {
  ctx.registry.remove('m');
});

describe('viewer_isolate — assembly expansion (#3338)', () => {
  it('isolating a geometry-less assembly reaches the backend with its geometry-bearing parts, not just the assembly id', async () => {
    await load();
    const result = await tool('viewer_isolate').handler({ global_id: ASM_GID }, ctx);
    expect(result.isError).toBeUndefined();
    expect(expressIdsOf(isolateCalls)).toEqual([100, 101, 102]);
  });

  it('isolating a plain wall (no IfcRelAggregates children) is a no-op — passes through unchanged', async () => {
    await load();
    await tool('viewer_isolate').handler({ global_id: WALL3_GID }, ctx);
    expect(expressIdsOf(isolateCalls)).toEqual([103]);
  });

  it('isolating both the assembly and one of its own children does not double-expand', async () => {
    await load();
    await tool('viewer_isolate').handler({ global_ids: [ASM_GID, WALL1_GID] }, ctx);
    expect(expressIdsOf(isolateCalls)).toEqual([100, 101, 102]);
  });
});

describe('viewer_hide / viewer_show — assembly expansion (#3338)', () => {
  it('hiding a geometry-less assembly reaches the backend with its parts', async () => {
    await load();
    await tool('viewer_hide').handler({ global_id: ASM_GID }, ctx);
    expect(expressIdsOf(hideCalls)).toEqual([100, 101, 102]);
  });

  it('showing a geometry-less assembly reaches the backend with its parts', async () => {
    await load();
    await tool('viewer_show').handler({ global_id: ASM_GID }, ctx);
    expect(expressIdsOf(showCalls)).toEqual([100, 101, 102]);
  });

  it('hiding a plain wall is a no-op', async () => {
    await load();
    await tool('viewer_hide').handler({ global_id: WALL3_GID }, ctx);
    expect(expressIdsOf(hideCalls)).toEqual([103]);
  });
});

describe('viewer_colorize — assembly expansion (#3338)', () => {
  it('colorizing a geometry-less assembly paints its parts too', async () => {
    await load();
    await tool('viewer_colorize').handler({ global_id: ASM_GID, color: 'red' }, ctx);
    expect(expressIdsOf(colorizeCalls)).toEqual([100, 101, 102]);
  });

  it('colorizing a plain wall is a no-op', async () => {
    await load();
    await tool('viewer_colorize').handler({ global_id: WALL3_GID, color: 'red' }, ctx);
    expect(expressIdsOf(colorizeCalls)).toEqual([103]);
  });
});

describe('viewer_fly_to — assembly expansion (#3338)', () => {
  it('flying to a geometry-less assembly reaches the backend with its geometry-bearing parts, not just the assembly id', async () => {
    await load();
    const result = await tool('viewer_fly_to').handler({ global_id: ASM_GID }, ctx);
    expect(result.isError).toBeUndefined();
    expect(expressIdsOf(flyToCalls)).toEqual([100, 101, 102]);
  });

  it('flying to a plain wall (no IfcRelAggregates children) is a no-op — passes through unchanged', async () => {
    await load();
    await tool('viewer_fly_to').handler({ global_id: WALL3_GID }, ctx);
    expect(expressIdsOf(flyToCalls)).toEqual([103]);
  });

  it('flying to both the assembly and one of its own children does not double-expand', async () => {
    await load();
    await tool('viewer_fly_to').handler({ global_ids: [ASM_GID, WALL1_GID] }, ctx);
    expect(expressIdsOf(flyToCalls)).toEqual([100, 101, 102]);
  });
});
