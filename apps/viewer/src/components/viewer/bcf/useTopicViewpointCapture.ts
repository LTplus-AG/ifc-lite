/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF panel's "Add viewpoint" (3D) and "Capture 2D" actions on the open
 * topic (C-2): one capture at a time, so a double press cannot append two
 * viewpoints. A capture belongs to the topic it was pressed on, even if
 * another topic is open by the time it lands. Every failure is told to the
 * user: useAsyncRun does not rethrow, so an escaping throw would only reach
 * the console.
 */

import { useCallback } from 'react';
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { toast } from '@/components/ui/toast';
import { useAsyncRun } from '@/hooks/useAsyncRun';
import type { useBCF } from '@/hooks/useBCF';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

export interface TopicViewpointCapture {
  /** Capture the 3D view and append it to the open topic. */
  addViewpoint: () => Promise<void>;
  /** Run the 2D section capture under the same one-at-a-time lane. */
  addSectionViewpoint: (capture: () => Promise<void>) => void;
  capturing: boolean;
}

export function useTopicViewpointCapture(activeTopicId: string | null, createViewpointFromState: ReturnType<typeof useBCF>['createViewpointFromState']): TopicViewpointCapture {
  const { t } = useTranslation();
  const addViewpointToTopic = useViewerStore((s) => s.addViewpoint);
  const flight = useAsyncRun();
  const run = flight.start;
  const addViewpoint = useCallback(async () => {
    if (!activeTopicId) return;
    await run(async () => {
      // Create viewpoint from current camera, section plane, and selection state
      let viewpoint: BCFViewpoint | null = null;
      try {
        viewpoint = await createViewpointFromState({ includeSnapshot: true, includeSelection: true, includeHidden: true });
      } catch (err) {
        console.error('[BCFPanel] failed to capture viewpoint for topic', err);
      }
      if (!viewpoint) {
        toast.error(t('bcf.panel.captureViewpointFailed'));
        return;
      }
      try {
        addViewpointToTopic(activeTopicId, viewpoint);
      } catch (error) {
        console.error('[BCFPanel] Adding the viewpoint failed', error);
        toast.error(t('bcf.panel.addViewpointFailed', { message: error instanceof Error ? error.message : String(error) }));
      }
    });
  }, [run, activeTopicId, addViewpointToTopic, createViewpointFromState, t]);
  const addSectionViewpoint = useCallback((capture: () => Promise<void>) => { void run(capture); }, [run]);
  return { addViewpoint, addSectionViewpoint, capturing: flight.busy };
}
