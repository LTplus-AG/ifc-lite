/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio slice lives in the root store, so it must not pull the
 * `@ifc-lite/ids-authoring` runtime into the viewer's eager bundle: the
 * runtime arrives via `loadIdsStudioRuntime` (dynamic import), which the lazy
 * Studio panel awaits before it mounts. Before that, the synchronous actions
 * refuse explicitly; they never silently no-op or turn async.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { setFieldOp } from '@/lib/ids-studio/ops';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { IDS_STUDIO_RUNTIME_NOT_LOADED } from './idsStudioSlice';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** `[specifier, typeOnly]` for each static import/export-from statement in `source`. */
function staticImports(source: string): Array<[string, boolean]> {
  return [...source.matchAll(/^(import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?'([^']+)';/gm)]
    .map((m) => [m[3], Boolean(m[2])]);
}

afterEach(async () => {
  useViewerStore.getState().idsStudioClose();
  await loadIdsStudioRuntime();
});

describe('idsStudioSlice lazy authoring runtime', () => {
  it('imports the authoring runtime as types only, so the root store stays free of it', () => {
    const slice = readFileSync(join(HERE, 'idsStudioSlice.ts'), 'utf8');
    const lazyOnly = /^(@ifc-lite\/ids-authoring|@\/lib\/ids-studio\/.*)$/;
    const valueImports = staticImports(slice).filter(([spec, typeOnly]) => lazyOnly.test(spec) && !typeOnly);
    assert.deepEqual(valueImports, [], 'the slice must not value-import the authoring runtime');
  });

  it('reaches the runtime module only through a dynamic import', () => {
    for (const file of ['lib/ids-studio/runtime-loader.ts', 'lib/panels/renderPanelBody.tsx']) {
      const source = readFileSync(join(SRC, file), 'utf8');
      const runtime = staticImports(source).filter(([spec, typeOnly]) => /ids-studio\/runtime$|^\.\/runtime$/.test(spec) && !typeOnly);
      assert.deepEqual(runtime, [], `${file} must not statically import the runtime`);
    }
    assert.match(readFileSync(join(SRC, 'lib/ids-studio/runtime-loader.ts'), 'utf8'), /import\('\.\/runtime'\)/);
  });

  it('refuses explicitly before the runtime is installed, then works once it is loaded', async () => {
    const { doc, state, propertyId, contexts } = await wallFixture();
    useViewerStore.getState().idsStudioSetContexts(contexts);
    useViewerStore.setState({ idsStudioRuntime: null, idsStudioState: null });

    assert.throws(() => useViewerStore.getState().idsStudioOpen(doc), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });
    assert.equal(useViewerStore.getState().idsStudioState, null, 'a refused open leaves no document');

    // A document present without the runtime (not reachable through the UI): edits refuse as data.
    useViewerStore.setState({ idsStudioState: state });
    const outcome = useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.value', { kind: 'equals', value: 'EI60' })]);
    assert.equal(outcome.ok, false);
    assert.equal(useViewerStore.getState().idsStudioRejection?.issues[0].code, 'GATE-OP-001');
    assert.equal(useViewerStore.getState().idsStudioState, state, 'a refused edit changes nothing');
    assert.throws(() => useViewerStore.getState().idsStudioUndo(), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });
    assert.throws(() => useViewerStore.getState().idsStudioRedo(), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });

    await loadIdsStudioRuntime();
    useViewerStore.getState().idsStudioOpen(doc);
    assert.equal(useViewerStore.getState().idsStudioState?.doc, doc);
    assert.equal(useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.value', { kind: 'equals', value: 'EI60' })]).ok, true);
  });
});
