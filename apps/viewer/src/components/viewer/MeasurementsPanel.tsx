/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurements side panel (#5502, charter #5478 item 20): the LIST / POINT /
 * QTY readouts that used to expand out of the floating Measure card over the
 * model. Docks in the right pane like every other side panel (registry id
 * `measurements`, `renderPanelBody`), so it can float, pop out to a second
 * screen and scroll on its own — a list of thirty measurements no longer
 * covers the thing it measures. Flag-free like Environment / Point clouds
 * (#1869 precedent): driven purely by `sidebarActivePanel`.
 *
 * The Measure tool's bar (`MeasureToolbar`) opens it; it stays useful after
 * the tool is closed because finished measurements outlive the gesture.
 */

import { useState } from 'react';
import { Boxes, Crosshair, List, Ruler, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/en';
import { MeasurementList } from './tools/MeasurementList';
import { MeasurePointReadout } from './tools/MeasurePointReadout';
import { MeasureQuantities } from './tools/MeasureQuantities';

type PanelTab = 'list' | 'point' | 'quantities';

const TABS: ReadonlyArray<{ id: PanelTab; labelKey: TranslationKey; titleKey: TranslationKey; icon: typeof List }> = [
  { id: 'list', labelKey: 'measure.section.list.label', titleKey: 'measure.section.list.title', icon: List },
  { id: 'point', labelKey: 'measure.section.point.label', titleKey: 'measure.section.point.title', icon: Crosshair },
  { id: 'quantities', labelKey: 'measure.section.quantities.label', titleKey: 'measure.section.quantities.title', icon: Boxes },
];

export function MeasurementsPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PanelTab>('list');
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const count = useViewerStore(
    (s) =>
      s.measurements.length +
      s.polylineMeasurements.length +
      s.angleMeasurements.length +
      s.radiusMeasurements.length,
  );

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as PanelTab)} className="flex h-full flex-col">
      {/* House header — icon, title, close, the same shape as every other
          docked side panel (Environment, Point clouds, Cost). */}
      <div className="flex items-center gap-2 border-b p-3">
        <Ruler className="h-4 w-4 text-overlay-accent" />
        <span className="flex-1 text-sm font-medium">{t('measure.panel.title')}</span>
        {count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
        {count > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={async () => {
              if (await confirmDialog({ description: t('measure.clearAllConfirm'), destructive: true })) clearMeasurements();
            }}
            title={t('measure.clearAll')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} title={t('measure.panel.close')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <TabsList className="flex h-auto justify-start gap-1 rounded-none border-b bg-transparent px-3 py-1.5" aria-label={t('measure.panel.title')}>
        {TABS.map(({ id, labelKey, titleKey, icon: Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            title={t(titleKey)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
          >
            <Icon className="h-3 w-3" />
            {t(labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="list" className="mt-0 min-h-0 flex-1 overflow-y-auto"><MeasurementList /></TabsContent>
      <TabsContent value="point" className="mt-0 min-h-0 flex-1 overflow-y-auto"><MeasurePointReadout /></TabsContent>
      <TabsContent value="quantities" className="mt-0 min-h-0 flex-1 overflow-y-auto"><MeasureQuantities /></TabsContent>
    </Tabs>
  );
}
