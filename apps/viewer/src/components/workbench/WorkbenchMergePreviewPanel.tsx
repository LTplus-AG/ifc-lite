/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createDefaultWorkbenchLayout, mergeWorkbenchLayouts, type WorkbenchLayoutState, type WorkbenchZoneId } from '@ifc-lite/extensions';
import { useViewerStore } from '@/store';
import { ZONE_LABEL } from './panelRegistry';

export function WorkbenchMergePreviewPanel() {
  const ours = useViewerStore((s) => s.workbenchLayout);
  const base = createDefaultWorkbenchLayout();
  const theirs = createDefaultWorkbenchLayout();
  theirs.zones.bottom = ['builtin:panel:ids', ...theirs.zones.bottom.filter((id) => id !== 'builtin:panel:ids')];
  theirs.zones.right = theirs.zones.right.filter((id) => id !== 'builtin:panel:ids');
  const result = mergeWorkbenchLayouts(base, theirs, ours);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <LayoutColumn title="Mine" layout={ours} />
        <LayoutColumn title="Incoming example" layout={theirs} />
        <LayoutColumn title="Merged preview" layout={result.merged} />
      </div>
      <div className="rounded border p-3">
        <div className="font-medium">Conflicts</div>
        {result.conflicts.length === 0 ? (
          <div className="mt-1 text-sm text-muted-foreground">No conflicts in this preview.</div>
        ) : result.conflicts.map((conflict) => (
          <div key={`${conflict.kind}:${conflict.key}`} className="mt-2 rounded bg-muted/30 p-2 text-xs">
            {conflict.kind}: {conflict.key}
          </div>
        ))}
      </div>
    </div>
  );
}

function LayoutColumn({ title, layout }: { title: string; layout: WorkbenchLayoutState }) {
  return (
    <div className="rounded border p-3">
      <div className="font-medium">{title}</div>
      {(['left', 'right', 'bottom'] as WorkbenchZoneId[]).map((zone) => (
        <div key={zone} className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{ZONE_LABEL[zone]}</div>
          <div className="mt-1 space-y-1">
            {layout.zones[zone].map((panelId) => (
              <div key={panelId} className="rounded bg-muted/40 px-2 py-1 text-xs truncate">{panelId}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
