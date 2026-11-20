/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PDF view dialog's source bundle. Resident geometry reads it synchronously,
 * as before. Released CPU geometry (#10264) is read back first, asynchronously;
 * a failure leaves no source (nothing to export), never an empty drawing.
 *
 * Both paths re-run on the released-geometry revision, which moves when CPU
 * geometry is released (a resident source cached before then must not be
 * exported from emptied arrays) and when a backing becomes available (an
 * open dialog that could not read back retries on its own, without reopening).
 */

import { useEffect, useMemo, useState } from 'react';
import { useViewerStore } from '@/store';
import { readViewPdfSource } from '@/lib/export/view-pdf/view-pdf-export-source';
import { useReleasedGeometryRevision } from '@/lib/geometry-backing/use-released-geometry-revision';
import { geometryReleased, withReleasedExportGeometry } from '@/utils/instancedExport';

type ViewPdfSource = ReturnType<typeof readViewPdfSource>;
/** `loading`: reading released geometry back; `unavailable`: its backing cannot answer yet. */
export type ViewPdfSourceStatus = 'none' | 'ready' | 'loading' | 'unavailable';

/** `triggers` are invalidation keys only; the values are read from the store. */
export function useViewPdfSource(open: boolean, triggers: readonly unknown[]): { source: ViewPdfSource | null; status: ViewPdfSourceStatus } {
  const revision = useReleasedGeometryRevision();
  const resident = useMemo(
    () => (open && !geometryReleased() ? readViewPdfSource(useViewerStore.getState()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidation triggers, values read from getState().
    [open, revision, ...triggers],
  );
  // A token per request, minted during render: a source read for an older request (a previous
  // visibility, backing or view revision) is never returned, not even for the render before its
  // effect runs. Until the current request's source arrives the dialog sees `loading`.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- same invalidation triggers as the resident source.
  const request = useMemo(() => ({}), [open, revision, ...triggers]);
  const [released, setReleased] = useState<{ request: object | null; source: ViewPdfSource | null; status: ViewPdfSourceStatus }>(
    { request: null, source: null, status: 'none' });
  useEffect(() => {
    if (!open || !geometryReleased()) { setReleased({ request, source: null, status: 'none' }); return; }
    setReleased({ request, source: null, status: 'loading' });
    let cancelled = false;
    withReleasedExportGeometry((context) => readViewPdfSource(useViewerStore.getState(), context)).then(
      (prepared) => { if (!cancelled) setReleased({ request, source: prepared, status: 'ready' }); },
      (error: unknown) => {
        console.error('[PdfViewExport] released geometry could not be read back', error);
        if (!cancelled) setReleased({ request, source: null, status: 'unavailable' });
      },
    );
    return () => { cancelled = true; };
  }, [request]);
  if (resident) return { source: resident, status: 'ready' };
  if (!open) return { source: null, status: 'none' };
  return released.request === request ? { source: released.source, status: released.status } : { source: null, status: 'loading' };
}
