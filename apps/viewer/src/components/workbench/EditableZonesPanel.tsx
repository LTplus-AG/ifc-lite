/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { listBuiltInEditableZones } from '@ifc-lite/customization';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';

export function EditableZonesPanel() {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const setConfig = useViewerStore((s) => s.setWorkbenchPanelConfig);
  const zones = listBuiltInEditableZones();
  return (
    <div className="space-y-3">
      {zones.map((zone) => {
        const current = layout.panelConfigs[zone.panelId] ?? zone.defaults;
        return (
          <div key={zone.panelId} className="rounded border p-3">
            <div className="font-medium">{zone.label}</div>
            <p className="mt-1 text-sm text-muted-foreground">{zone.description}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-muted/30 p-2 text-xs">{JSON.stringify(current, null, 2)}</pre>
            <Button type="button" size="sm" className="mt-2" onClick={() => setConfig(zone.panelId, zone.defaults)}>
              Apply defaults
            </Button>
          </div>
        );
      })}
    </div>
  );
}
