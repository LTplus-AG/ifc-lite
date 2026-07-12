/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-click demo layer stack (#1717 exposure): the bundled buildingSMART
 * hello-wall IFC5 sample as the base, plus two authored overlays built
 * here — an agent-published fire-safety pass (with check evidence and a
 * scope claim) and a human review bump that overrides it. Composed, the
 * stack demonstrates strata, provenance badges, contribution diffs,
 * ghosting, LWW override, and a ready-made merge divergence with ZERO
 * files or setup from the user.
 *
 * Fixed `created` stamps keep every layer id deterministic, so re-loading
 * the demo never mints new content addresses.
 */

import type { IfcxFile, IfcxNode, ProvenanceBase } from '@ifc-lite/ifcx';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';

/** hello-wall entity paths (IFC5 UUID-style; path IS the identity). */
const WALL = '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b';
const WINDOW_A = '25503984-6605-43a1-8597-eae657ff5bea';
const WINDOW_B = '2c2d549f-f9fe-4e22-8590-562fda81a690';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const COMBUSTIBLE = 'bsi::ifc::v5a::Pset_FireSafety::Combustible';

const SAMPLE_PATH = '/samples/hello-wall.ifcx';

/** Load-a-layer-stack request; the listener lives next to the load-file
 *  one in MainToolbar and routes to `loadFederatedIfcx`. */
export const EVENT_LOAD_LAYER_STACK = 'ifc-lite:load-layer-stack';

function publishable(
  nodes: IfcxNode[],
  intent: string,
  author: { kind: 'human' | 'agent'; principal: string; tool?: string },
  base: ProvenanceBase,
  created: string,
  extras: Partial<Parameters<typeof createProvenanceManifest>[0]> = {},
): IfcxFile {
  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: author.principal,
      timestamp: created,
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
  const manifest = createProvenanceManifest({ author, intent, base, created, ...extras });
  const withManifest = setProvenance(bare, manifest);
  return { ...withManifest, header: { ...withManifest.header, id: computeLayerId(withManifest) } };
}

/** The three demo files, strongest last (the federation loader treats the
 *  first file as weakest). Exposed for tests. */
export async function buildDemoLayerFiles(): Promise<File[]> {
  const res = await fetch(SAMPLE_PATH);
  if (!res.ok) throw new Error(`demo stack fetch failed: ${res.status} ${SAMPLE_PATH}`);
  const baseText = await res.text();
  const base = JSON.parse(baseText) as IfcxFile;
  const baseId = base.header.id;

  const agentPass = publishable(
    [
      { path: WALL, attributes: { [FIRE]: 'REI90', [COMBUSTIBLE]: false } },
      { path: WINDOW_A, attributes: { [FIRE]: 'EI30' } },
      { path: WINDOW_B, attributes: { [FIRE]: 'EI30' } },
    ],
    'Classify fire ratings (agent pass)',
    { kind: 'agent', principal: 'fire-safety-agent', tool: '@ifc-lite/mcp' },
    { kind: 'stack', id: computeStackHash([baseId]) },
    '2026-07-01T09:00:00.000Z',
    {
      scope_claim: ['model.mutate:Pset_FireSafety*'],
      checks: [{ tool: '@ifc-lite/ids', spec: 'fire-safety.ids', result: 'pass' }],
    },
  );

  const humanReview = publishable(
    [{ path: WALL, attributes: { [FIRE]: 'REI120' } }],
    'Review: corridor wall needs REI120',
    { kind: 'human', principal: 'louis' },
    { kind: 'stack', id: computeStackHash([baseId, agentPass.header.id]) },
    '2026-07-02T14:30:00.000Z',
  );

  const toFile = (doc: IfcxFile | string, name: string) =>
    new File([typeof doc === 'string' ? doc : JSON.stringify(doc)], name, { type: 'application/json' });
  return [
    toFile(baseText, 'hello-wall.ifcx'),
    toFile(agentPass, 'agent-fire-safety.ifcx'),
    toFile(humanReview, 'human-review.ifcx'),
  ];
}

/** Build the demo files and hand them to the federation loader via the
 *  window event bus (usable from panels AND the tour's demoFulfil, where
 *  no hook context exists). */
export async function loadDemoLayerStack(): Promise<void> {
  const files = await buildDemoLayerFiles();
  window.dispatchEvent(new CustomEvent(EVENT_LOAD_LAYER_STACK, { detail: files }));
}
