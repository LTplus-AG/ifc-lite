/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set view (#7545): look straight at the active plane, at the part that stays.
 * Pressing it again returns to the camera the user had, which is what makes it
 * safe to press: a toggle with a memory, not a one-way trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanEye } from 'lucide-react';
import { useViewerStore } from '@/store';
import type { CameraViewpoint } from '@/store/types';
import { useTranslation } from '@/i18n';
import { customPlaneViewpoint } from '@/lib/section/section-set-view';
import { HudToggle } from '../../viewport-ui/hud/HudToggle';
import { presetViewForAxis } from './sectionConstants';

const TRANSITION_MS = 400;

export function SectionSetViewButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const planeId = useViewerStore((s) => s.sectionPlane.id);
  const hasPlane = useViewerStore((s) => !s.sectionPlane.box);
  const [engaged, setEngaged] = useState(false);
  const before = useRef<CameraViewpoint | null>(null);

  // The remembered camera belongs to the plane it was taken for.
  useEffect(() => {
    before.current = null;
    setEngaged(false);
  }, [planeId]);

  const press = useCallback(() => {
    const { cameraCallbacks: cb, sectionPlane: plane } = useViewerStore.getState();
    if (engaged) {
      if (before.current) cb.applyViewpoint?.(before.current, true, TRANSITION_MS);
      before.current = null;
      setEngaged(false);
      return;
    }
    const current = cb.getViewpoint?.() ?? null;
    if (plane.custom && current && cb.applyViewpoint) {
      before.current = current;
      cb.applyViewpoint(customPlaneViewpoint({ flipped: plane.flipped, custom: plane.custom }, current), true, TRANSITION_MS);
      setEngaged(true);
    } else if (!plane.custom && cb.setPresetView) {
      before.current = current;
      cb.setPresetView(presetViewForAxis(plane.axis, plane.flipped));
      setEngaged(true);
    }
  }, [engaged]);

  if (!hasPlane) return null;
  return (
    <HudToggle
      pressed={engaged}
      onPressedChange={press}
      aria-label={t('sectionPlanes.setView.label')}
      title={t(engaged ? 'sectionPlanes.setView.back' : 'sectionPlanes.setView.title')}
      icon={<ScanEye aria-hidden className="h-3.5 w-3.5" />}
    >
      {compact ? null : t('sectionPlanes.setView.label')}
    </HudToggle>
  );
}
