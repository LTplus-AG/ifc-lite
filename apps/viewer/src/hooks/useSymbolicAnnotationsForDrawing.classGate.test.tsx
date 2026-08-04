/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end proof that `symbolicAnnotationsOverlayEnabled` (the fix for
 * issue #2121) actually suppresses REAL parsed annotation content when
 * driven through the real `useSymbolicAnnotationsForDrawing` hook — not just
 * that the predicate itself returns the right boolean in isolation (that's
 * `useSymbolicAnnotations.test.ts`).
 *
 * `Section2DPanel.tsx` (the file issue #2121 is about) cannot be rendered
 * under this repo's `tsx --test` runner: it imports `useIfc`, which imports
 * `src/utils/ifcConfig.ts`, which reads `import.meta.env` — `tsx` does not
 * populate that (Vite-only), so the import throws before any test body runs.
 * No existing test file in this repo imports `Section2DPanel` (verified:
 * `grep -rln "Section2DPanel" src --include="*.test.*"` is empty), so this is
 * a pre-existing gap, not something this change introduced.
 * `symbolicAnnotationsOverlayEnabled` was pulled out into
 * `useSymbolicAnnotations.ts` specifically so the gate `Section2DPanel` now
 * calls has a real, importable test surface; this file drives it through the
 * exact hook `Section2DPanel` calls, with the exact expression
 * `Section2DPanel` now uses at its call site.
 */

import '@/test/setup-dom.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import {
  useSymbolicAnnotationsForDrawing,
  symbolicAnnotationsOverlayEnabled,
  type DrawingAnnotationData,
} from './useSymbolicAnnotations.js';

// ─── WASM environment shim ─────────────────────────────────────────────────
//
// Mirrors `useDrawingGeneration.projection.test.tsx`'s `serveFileUrlsFromDisk`,
// captured and restored here (its original didn't restore). Verified
// empirically that this repo's `tsx --test --test-concurrency=1 $(find ...)`
// invocation runs every matched file in its own child process — a probe file
// placed after an unrestored version of this shim still saw a native `fetch`
// and a present `WebAssembly.instantiateStreaming` — so today this is not an
// active cross-file leak. Restoring anyway is cheap insurance against a
// future isolation-mode change.
let restoreFetch: (() => void) | null = null;
let restoreInstantiateStreaming: (() => void) | null = null;

function serveFileUrlsFromDiskAndCapture(): void {
  const upstream = globalThis.fetch;
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href =
      input instanceof URL ? input.href
      : typeof input === 'string' ? input
      : input.url;
    if (href.startsWith('file:')) {
      const bytes = await readFile(fileURLToPath(href));
      return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
    }
    return upstream(input, init);
  };
  globalThis.fetch = patched;
  restoreFetch = () => { globalThis.fetch = upstream; };

  const hadInstantiateStreaming = 'instantiateStreaming' in WebAssembly;
  const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
  Reflect.deleteProperty(WebAssembly, 'instantiateStreaming');
  restoreInstantiateStreaming = () => {
    if (hadInstantiateStreaming) {
      WebAssembly.instantiateStreaming = originalInstantiateStreaming;
    }
  };
}

before(() => { serveFileUrlsFromDiskAndCapture(); });
after(() => {
  restoreFetch?.();
  restoreInstantiateStreaming?.();
});

// ─── Fixture: a real IfcAnnotation text literal ────────────────────────────
//
// Structure mirrors `rust/processing/tests/issue_843_symbolic_parity.rs`'s
// `RICH_IFC` text-literal block (proven to parse through the same
// `extract_symbolic_data` the WASM binding calls). Everything sits at the
// world origin (Z=0 throughout the placement chain), so the primitive has no
// resolvable storey and lands in the parser's "loose" bucket, surfaced via
// `fallbackY` — same as a file with no spatial hierarchy at all.
const ANNOTATION_TEXT = 'REDGATE_ANNOTATION_MARK';
const ANNOTATION_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('annot.ifc','2026-08-04T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#40=IFCLOCALPLACEMENT($,#5);
#200=IFCCARTESIANPOINT((1.,1.,0.));
#201=IFCAXIS2PLACEMENT3D(#200,$,$);
#202=IFCPLANAREXTENT(0.5,0.4);
#203=IFCTEXTLITERALWITHEXTENT('${ANNOTATION_TEXT}',#201,.RIGHT.,#202,'center');
#204=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#203));
#205=IFCPRODUCTDEFINITIONSHAPE($,$,(#204));
#206=IFCANNOTATION('AnnoText00000000000001',$,'Label',$,$,#40,#205);
ENDSEC;
END-ISO-10303-21;
`;

/** A real, fully-typed `IfcDataStore` — built by the actual columnar parser
 *  the app loads files through, not a hand-shaped stand-in. Avoids casting
 *  a partial object to `IfcDataStore` (banned in this repo, including in
 *  test fixtures — a cast there hides signature drift). */
async function parseAnnotationStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ANNOTATION_IFC);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new IfcParser().parseColumnar(buffer);
}

// ─── Harness ────────────────────────────────────────────────────────────────

/** Renders the real hook with `enabled` computed by the same expression
 *  `Section2DPanel.tsx` now uses at its `useSymbolicAnnotationsForDrawing`
 *  call site: `symbolicAnnotationsOverlayEnabled(showIfcAnnotations, status,
 *  typeVisibility.ifcAnnotations)`. `status='ready'` and `showIfcAnnotations
 *  = true` are held fixed (both already covered elsewhere); the variable
 *  under test is the class-visibility toggle. */
async function runHarness(ifcAnnotationsClassVisible: boolean): Promise<{
  waitFor: (predicate: (data: DrawingAnnotationData) => boolean, timeoutMs?: number) => Promise<DrawingAnnotationData>;
  cleanup: () => Promise<void>;
}> {
  let latest: DrawingAnnotationData = { lines: [], texts: [], fills: [] };

  function Harness(): null {
    const data = useSymbolicAnnotationsForDrawing({
      enabled: symbolicAnnotationsOverlayEnabled(true, 'ready', ifcAnnotationsClassVisible),
      axis: 'down',
      sectionPosWorld: 0,
      viewDepth: 1.2,
      flipped: false,
      fallbackY: 0,
    });
    latest = data;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  async function waitFor(
    predicate: (data: DrawingAnnotationData) => boolean,
    timeoutMs = 4000,
  ): Promise<DrawingAnnotationData> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(latest)) return latest;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    }
    return latest;
  }

  return {
    waitFor,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe('useSymbolicAnnotationsForDrawing driven by symbolicAnnotationsOverlayEnabled (issue #2121)', () => {
  it('positive control: real annotation content IS produced when the class is visible', async () => {
    useViewerStore.setState({ ifcDataStore: await parseAnnotationStore() });
    const { waitFor, cleanup } = await runHarness(true);
    try {
      const data = await waitFor((d) => d.texts.some((t) => t.content === ANNOTATION_TEXT));
      assert.ok(
        data.texts.some((t) => t.content === ANNOTATION_TEXT),
        `expected the parsed annotation text to appear; got texts=${JSON.stringify(data.texts.map((t) => t.content))} ` +
        `(if this fails, the negative case below is vacuous, not a real gate)`,
      );
    } finally {
      await cleanup();
    }
  });

  it('with the IfcAnnotation class toggle OFF, the symbolic annotation is not produced', async () => {
    useViewerStore.setState({ ifcDataStore: await parseAnnotationStore() });
    const { waitFor, cleanup } = await runHarness(false);
    try {
      // There is nothing to "become true" here — wait out the same window the
      // positive control uses so a parse that would have landed had time to.
      const data = await waitFor(() => false, 1000).catch(() => ({ lines: [], texts: [], fills: [] }));
      assert.equal(
        data.texts.length + data.lines.length + data.fills.length,
        0,
        `IfcAnnotation class toggle is OFF: expected no symbolic annotation data, got texts=${JSON.stringify(data.texts.map((t) => t.content))}`,
      );
    } finally {
      await cleanup();
    }
  });
});
