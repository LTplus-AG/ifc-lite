/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PDF view dialog's source bundle. Resident geometry reads it synchronously,
 * as before. Released CPU geometry (#10264) is read back first, asynchronously;
 * a failure leaves no source (nothing to export), never an empty drawing.
 */

import { useEffect, useMemo, useState } from 'react';
import { useViewerStore } from '@/store';
import { readViewPdfSource } from '@/lib/export/view-pdf/view-pdf-export-source';
import { geometryReleased, withReleasedExportGeometry } from '@/utils/instancedExport';

type ViewPdfSource = ReturnType<typeof readViewPdfSource>;

/** `triggers` are invalidation keys only; the values are read from the store. */
export function useViewPdfSource(open: boolean, triggers: readonly unknown[]): ViewPdfSource | null {
  const resident = useMemo(
    () => (open && !geometryReleased() ? readViewPdfSource(useViewerStore.getState()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidation triggers, values read from getState().
    [open, ...triggers],
  );
  const [released, setReleased] = useState<ViewPdfSource | null>(null);
  useEffect(() => {
    setReleased(null);
    if (!open || !geometryReleased()) return;
    let cancelled = false;
    withReleasedExportGeometry(() => readViewPdfSource(useViewerStore.getState())).then(
      (prepared) => { if (!cancelled) setReleased(prepared); },
      (error: unknown) => console.error('[PdfViewExport] released geometry could not be read back', error),
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same invalidation triggers as the resident source.
  }, [open, ...triggers]);
  return resident ?? released;
}
