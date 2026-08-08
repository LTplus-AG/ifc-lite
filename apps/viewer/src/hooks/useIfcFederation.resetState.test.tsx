/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `loadFederatedIfcxFromBuffers` took a `{ resetState?: boolean }` option
 * that was NEVER READ (grep confirms exactly two hits in the source file:
 * the declaration and one call site). The function unconditionally calls
 * `resetViewerState()` / `setGeometryResult(null)` / `clearAllModels()`
 * regardless of what the caller passed. `addIfcxOverlays` called it with
 * `{ resetState: false }`, which reads as "preserve selection/hidden/
 * isolated state while adding an overlay" but that intent was silently
 * discarded.
 *
 * Investigation (recorded here, not just in the PR description, so the
 * "why" survives): expressIds in the composed IFCX entity table are
 * SYNTHETIC and auto-incrementing over iteration order of the composed
 * node map (`packages/ifcx/src/entity-extractor.ts`). That iteration order
 * is seeded by `LayerStack.getAllPaths()`, which walks layers STRONGEST
 * FIRST and inserts each layer's own path order first-come-first-served
 * into an insertion-ordered Set (`packages/ifcx/src/layer-stack.ts`).
 * Adding an overlay makes it the new strongest layer, so the overlay's own
 * path order gets spliced to the FRONT of that Set - ahead of paths that
 * previously sorted earlier. That reshuffles which entity gets which
 * expressId, even for a PURE property overlay that adds zero new paths.
 *
 * This was verified empirically against real fixtures
 * (tests/models/ifc5/Hello_Wall_hello-wall.ifcx + ...-add-fire-rating-60.ifcx):
 * of 9 entities shared between "base alone" and "base + fire-rating overlay",
 * 5 of 9 got a DIFFERENT expressId after recomposition, despite the overlay
 * changing no geometry and adding no entities. Since federated models use
 * `idOffset: 0` for every layer (globalId === expressId), a selection/
 * hidden/isolated set captured before the overlay would silently point at
 * DIFFERENT entities after it — exactly the "3D highlighting" corruption
 * the in-code comment warns about. So the reset is CORRECT and the dead
 * option is a lie: honouring `resetState: false` would reintroduce that
 * bug. Conclusion: delete the option, keep the reset, document overlay-add
 * as intentionally destructive to viewer state at the call site.
 *
 * These tests pin:
 *  1. `resetState` is no longer part of the public signature (grep-level,
 *     so a returning offer to "just wire it up" fails loudly).
 *  2. BOUNDING CONTROL - a first federated load resets state (unchanged
 *     behaviour, must never regress).
 *  3. The behaviour this fix is choosing: adding an overlay to an already-
 *     loaded federation ALSO resets state (selection/hidden/isolated all
 *     clear), because ids are not stable across recomposition.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcFederation } from './useIfcFederation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASE_PATH = resolve(REPO_ROOT, 'tests/models/ifc5/Hello_Wall_hello-wall.ifcx');
const OVERLAY_PATH = resolve(REPO_ROOT, 'tests/models/ifc5/Hello_Wall_hello-wall-add-fire-rating-60.ifcx');
// Per AGENTS.md fixtures are fetched on demand; skip cleanly on a fresh
// checkout rather than crashing the suite.
const FIXTURES_AVAILABLE = existsSync(BASE_PATH) && existsSync(OVERLAY_PATH);

function toFile(path: string, name: string): File {
  const bytes = readFileSync(path);
  return new File([bytes], name, { type: 'application/json' });
}

// ─── Signature-level pin: the misleading option must not exist ──────────

describe('loadFederatedIfcxFromBuffers - dead resetState option', () => {
  it('is not referenced anywhere in the hook source (declaration + call site both gone)', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'useIfcFederation.ts'),
      'utf8',
    );
    const hits = src.match(/resetState/g) ?? [];
    assert.deepStrictEqual(
      hits,
      [],
      'resetState must not appear in useIfcFederation.ts - it was a dead option ' +
      '(declared, never read) that misrepresented addIfcxOverlays as state-preserving',
    );
  });
});

// ─── Behavioural harness ──────────────────────────────────────────────────

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
const loadFile = async (): Promise<void> => {
  throw new Error('loadFile should not be invoked by these federated-IFCX paths');
};

function Probe(): null {
  hookApi = useIfcFederation(loadFile);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

function seedDirtyViewerState(): void {
  useViewerStore.getState().resetViewerState();
  useViewerStore.setState({
    selectedEntityIds: new Set([1, 2, 3]),
    hiddenEntities: new Set([4, 5]),
    isolatedEntities: new Set([1]),
  });
}

function isDirty(): boolean {
  const s = useViewerStore.getState();
  return s.selectedEntityIds.size > 0 || s.hiddenEntities.size > 0 || s.isolatedEntities !== null;
}

beforeEach(async () => {
  hookApi = null;
  await mount();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe(
  'useIfcFederation - viewer state around federated IFCX loads',
  { skip: !FIXTURES_AVAILABLE && 'tests/models/ifc5 fixtures missing - run `pnpm fixtures`' },
  () => {
    // BOUNDING CONTROL: unchanged behaviour. A first federated load must
    // still fully reset viewer state - this must hold before AND after
    // the fix, or "never reset" would pass the overlay test below while
    // silently breaking normal loads.
    it('BOUNDING CONTROL: a first federated load resets selection/hidden/isolated state', async () => {
      seedDirtyViewerState();
      assert.equal(isDirty(), true, 'precondition: dirty state must be seeded');

      await act(async () => {
        await hookApi!.loadFederatedIfcx([toFile(BASE_PATH, 'base.ifcx')]);
      });

      assert.equal(isDirty(), false, 'first federated load must reset selection/hidden/isolated state');
    });

    // The decided behaviour: adding an overlay to an already-federated
    // model is intentionally destructive to viewer state too, because
    // expressIds are not stable across recomposition (see file banner).
    it('adding an IFCX overlay to an existing federation ALSO resets state (ids are not stable across recomposition)', async () => {
      await act(async () => {
        await hookApi!.loadFederatedIfcx([toFile(BASE_PATH, 'base.ifcx')]);
      });
      assert.equal(useViewerStore.getState().error, null, 'base load must succeed');

      seedDirtyViewerState();
      assert.equal(isDirty(), true, 'precondition: dirty state must be seeded after base load');

      await act(async () => {
        await hookApi!.addIfcxOverlays([toFile(OVERLAY_PATH, 'fire-rating.ifcx')]);
      });

      assert.equal(useViewerStore.getState().error, null, 'overlay add must succeed');
      assert.equal(
        isDirty(),
        false,
        'overlay-add must reset selection/hidden/isolated state - stale ids from before ' +
        'the recomposition can point at a DIFFERENT entity afterwards',
      );
    });
  },
);
