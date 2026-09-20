/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GLBExportDialog.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.glb.*`). Same oracle shape as the
 * rest of the sweep: a pseudo-locale marks every asserted key, the dialog is
 * opened with no models loaded (so no export ever actually runs — the wasm
 * geometry engine isn't available in this Node test environment), the
 * locale is switched live, and every marked string visible in English must
 * reappear marked.
 *
 * The expected key/English-text pairs below are inlined rather than read
 * from the catalogue module at runtime (#4918 revert-oracle): the catalogue
 * is a brand-new file this slice adds, so reverting just the production
 * hunks deletes it outright — an import of it here would throw, and a
 * guarded try/catch around that import (skipping the suite when the module
 * is absent) would make the oracle see zero collected tests on revert
 * instead of a real failure. Inlining the expected strings means a
 * reverted `GLBExportDialog.tsx` (back to hardcoded text, no `t()` calls)
 * still renders the same English copy, but switching locale no longer marks
 * it — the assertion fails for real.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { GLBExportDialog } from './GLBExportDialog.js';

const STRINGS: Record<string, string> = {
  'geometryExport.glb.triggerButton': 'Export GLB',
  'geometryExport.glb.dialogTitle': 'Export GLB File',
  'geometryExport.glb.dialogDescription':
    'Export model geometry as binary glTF, including its current workspace placement',
  'geometryExport.glb.colorSourceLabel': 'Colour Source',
  // colorSourceRendering is the default-selected value, surfaced through
  // Select's trigger; colorSourceShading lives only inside the closed
  // Radix Select's portal-rendered content and isn't in the DOM until
  // the trigger is opened, so it is intentionally not asserted here.
  'geometryExport.glb.colorSourceRendering': 'Rendering (apparent colour)',
  'geometryExport.glb.colorSourceRenderingHint':
    'Uses IfcSurfaceStyleRendering.DiffuseColour when authored, otherwise SurfaceColour. Matches most IFC viewers.',
  'geometryExport.glb.outputLabel': 'Output',
  'geometryExport.glb.outputFormat': 'glTF Binary',
  'geometryExport.glb.fileExtension': '.glb',
  'geometryExport.glb.visibleOnlyLabel': 'Export Visible Only',
  'geometryExport.glb.visibleOnlyHint': 'Skip entities currently hidden or outside the isolation set',
  'geometryExport.glb.includeMetadataLabel': 'Include Metadata',
  'geometryExport.glb.includeMetadataHint': 'Embed expressId / modelIndex on each node and totals on the asset',
  'geometryExport.glb.litLabel': 'Lit Materials',
  'geometryExport.glb.litHint': 'Shade from normals in other viewers. Off = flat apparent colour (unlit)',
  'geometryExport.glb.cancelButton': 'Cancel',
  'geometryExport.glb.exportButton': 'Export',
};

const PSEUDO: Catalogue = Object.fromEntries(
  Object.entries(STRINGS).map(([key, text]) => [key, `⟦${key}|${text}⟧`]),
);
const PSEUDO_LOCALE = 'glb-export-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function openDialog(): void {
  render(<GLBExportDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(STRINGS['geometryExport.glb.triggerButton']),
  );
  assert.ok(trigger, 'export trigger button not found');
  click(trigger!);
}

const RESET = {
  models: new Map(),
  geometryResult: null,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('GLBExportDialog localization (#4918)', () => {
  it('static dialog chrome: title, description, field labels, hints, and footer', () => {
    openDialog();
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();

    for (const [key, text] of Object.entries(STRINGS)) {
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }
  });
});
