/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { beamTopAttachment } from '@/lib/commands/modeling/wall-top';
import { fixtureStep, MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { installScriptedMesher, settleRemesh } from '@/test/scripted-mesher';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { loadStoreyAdapter } from '@/sdk/adapters/store-adapter-storey';
import { noticeText } from '@/lib/storeys/storey-text';
import { registerLocale, setLocale, resolve } from '@/i18n/registry';
import { storeyManagerDe } from '@/i18n/locales/de/storey-manager';
import { toGlobalIdFromModels } from '@/store/globalId';

let mesher: ReturnType<typeof installScriptedMesher> | undefined;
afterEach(() => { mesher?.restore(); mesher = undefined; });
async function seed() {
  await loadStoreyAdapter();
  await seedModelingSession({ step: fixtureStep({}).replace('#51=IFCLOCALPLACEMENT($,#42);',
    '#51=IFCLOCALPLACEMENT($,#52);\n#52=IFCAXIS2PLACEMENT3D(#53,$,$);\n#53=IFCCARTESIANPOINT((0.,0.,3.));') });
  useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
}
it('#9352 a non-finite beam top does not attach', async () => {
  await seed();
  assert.ok(beamTopAttachment(useViewerStore.getState(), MODEL_ID, STOREY, 3));
  assert.equal(beamTopAttachment(useViewerStore.getState(), MODEL_ID, STOREY, NaN), null);
});
it('#9352 a grid column fallback uses its refitted top, including Undo and Redo', async () => {
  await seed();
  mesher = installScriptedMesher(() => []);
  const api = createStoreAdapter(useViewerStore);
  const grid = api.addGrid!(MODEL_ID, STOREY, rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }));
  const state = useViewerStore.getState(), record = state.mutationViews.get(MODEL_ID)!.getNewEntity(grid.expressId)!;
  const first = (value: unknown) => Number(String((value as unknown[])[0]).replace('#', ''));
  const made = api.addColumnOnGrid!(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: .4, Depth: .4, Height: 2.5,
    TopConstraint: { kind: 'storeyAbove' } }, { GridId: grid.expressId, IntersectingAxes: [first(record.attributes[7]), first(record.attributes[8])] });
  await settleRemesh();
  const globalId = toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, made.expressId);
  const meshes = () => useViewerStore.getState().models.get(MODEL_ID)!.geometryResult!.meshes.filter(m => m.expressId === globalId);
  const span = () => { const ys = meshes().flatMap(m => Array.from(m.positions).filter((_, i) => i % 3 === 1)); return Math.max(...ys) - Math.min(...ys); };
  assert.ok(Math.abs(span() - 3) < 1e-6, 'the rendered top reaches the 3 m storey');
  useViewerStore.getState().undo(MODEL_ID);
  await settleRemesh();
  assert.equal(meshes().length, 0);
  useViewerStore.getState().redo(MODEL_ID);
  await settleRemesh();
  assert.ok(Math.abs(span() - 3) < 1e-6);
});


it('#9352 non-wall attachment notices use translated kind-specific wording', () => {
  registerLocale('de', storeyManagerDe);
  setLocale('de');
  try {
    for (const [elementType, word] of [['IfcColumn', 'Stütze'], ['IfcBeam', 'Träger'], ['IfcMember', 'Stab'], ['IfcCurtainWall', 'Vorhangfassade']] as const) {
      for (const code of ['attachedNotResized', 'wallAttachmentUnresolved']) {
        const notice = { code, message: 'untranslated core notice', elementIds: [1], elementType };
        const rendered = noticeText(resolve, notice);
        assert.ok(rendered.includes(word), rendered);
        assert.ok(!rendered.includes('Wand'), rendered);
      }
    }
  } finally { setLocale('en'); }
});
