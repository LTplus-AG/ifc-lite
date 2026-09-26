/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked `placement` side panel (#5505): Local and Georeference tabs
 * replace the floating `RepositionPanel` (`absolute top-32 right-4 z-40
 * w-80`) and the floating `CesiumPlacementEditor` card. Docks in the right
 * pane like every other side panel (`renderPanelBody`, registry id
 * `placement`) — no drag, no floating mount, no self-owned open/collapse
 * state. The gizmos (`PlacementGizmo`, `CesiumPlacementGizmo`) stay scene
 * overlays; this panel only carries the form.
 */
import { useEffect, useState } from 'react';
import { Move3d, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { usePlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { LocalTab } from './LocalTab';
import { GeoreferenceTab } from './GeoreferenceTab';

interface PlacementPanelProps {
  onClose?: () => void;
}

export function PlacementPanel({ onClose }: PlacementPanelProps) {
  const { t } = useTranslation();
  const repositionOpen = useViewerStore((s) => s.repositionOpen);
  const cesiumPlacementEditMode = useViewerStore((s) => s.cesiumPlacementEditMode);
  const georefContext = usePlacementGeorefContext();
  const [tab, setTab] = useState<'local' | 'georeference'>(
    () => (cesiumPlacementEditMode && !repositionOpen ? 'georeference' : 'local'),
  );
  // Follow whichever workflow just started (the ribbon/toolbar "Reposition"
  // or "Move georef" toggles): the panel should show the session it just
  // opened, not whatever tab a previous visit left selected.
  useEffect(() => { if (repositionOpen) setTab('local'); }, [repositionOpen]);
  useEffect(() => { if (cesiumPlacementEditMode) setTab('georeference'); }, [cesiumPlacementEditMode]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Move3d className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">{t('placementPanel.title')}</span>
        {onClose && (
          <IconButton variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} label={t('placementPanel.headerCloseTitle')}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as 'local' | 'georeference')} className="flex flex-1 flex-col overflow-hidden">
        <div className="px-2 pt-2">
          <TabsList className="w-full">
            <TabsTrigger value="local" className="flex-1">{t('placementPanel.tabs.local')}</TabsTrigger>
            <TabsTrigger value="georeference" className="flex-1">{t('placementPanel.tabs.georeference')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="local" className="flex-1 overflow-y-auto p-2 mt-0">
          <LocalTab />
        </TabsContent>
        <TabsContent value="georeference" className="flex-1 overflow-y-auto p-2 mt-0">
          {georefContext ? <GeoreferenceTab {...georefContext} /> : (
            <div className="flex flex-col gap-1 text-xs">
              <p className="uppercase tracking-wider text-muted-foreground">{t('placementPanel.georeference.emptyTitle')}</p>
              <p className="leading-snug text-muted-foreground">{t('placementPanel.georeference.emptyHint')}</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
