/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected product's persistent face table (#7955 M11-F, spec §12 Q6):
 * one row per source face key `#item[>#opening]:role`, never a kernel face
 * index. Retained path only; triangle-level picking waits for the renderer.
 */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { RetainedFaceRow } from '@/store/retainedGeometry';

export function RetainedFaceTable({ modelId, faces }: { modelId: string; faces?: Record<number, RetainedFaceRow[]> }) {
  const { t } = useTranslation();
  const selected = useViewerStore((state) => state.selectedEntity);
  const rows = selected?.modelId === modelId ? faces?.[selected.expressId] : undefined;
  if (!faces) return null;
  if (!selected || !rows) return <p className="text-sm text-muted-foreground" data-retained-faces="">{t('retainedGeometry.faces.hint')}</p>;
  return (
    <div className="space-y-1" data-retained-faces={selected.expressId}>
      <p className="text-sm">{t('retainedGeometry.faces.title', { id: String(selected.expressId), count: String(rows.length) })}</p>
      <div className="max-h-48 overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium">{t('retainedGeometry.faces.column.key')}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t('retainedGeometry.faces.column.triangles')}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t('retainedGeometry.faces.column.area')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-retained-face={row.key} className="border-t">
                <td className="px-2 py-1 font-mono">{row.key}</td>
                <td className="px-2 py-1 text-right tabular-nums">{row.triangles}</td>
                <td className="px-2 py-1 text-right tabular-nums">{row.areaM2.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
