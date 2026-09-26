/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finished measurements as lasting scene state (#5893, part of #5611
 * deliverable 3).
 *
 * Before this, the measurement SVG only mounted inside `MeasureOverlay`
 * (`tools/MeasurePanel.tsx`), itself mounted only while
 * `activeTool === 'measure'` (`ToolOverlays.tsx` reading `TOOL_HUD`) — so a
 * finished measurement vanished the instant you switched to any other tool.
 *
 * This component is mounted unconditionally from the scene layer
 * (`ViewportContainer`'s `SceneOverlayRoot`, alongside `AnnotationLayer` /
 * `BCFOverlay` / `CollabPresenceLayer`), not from the tool. It draws the
 * FINISHED measurements only (`measurements`, `polylineMeasurements`) —
 * never the in-progress gesture (pending point, active drag, snap
 * indicator, live polyline), which stays `MeasureOverlay`'s job and only
 * exists while the Measure tool itself is open. It renders nothing while
 * the Measure tool is active (that overlay already draws the finished
 * measurements too, so this avoids a double render) or while
 * `sceneState.measurements.visible` is off (the HUD chip's hide toggle,
 * `MeasurementsVisibilityChip`).
 *
 * The camera-driven screen-coordinate reprojection these measurements need
 * on every frame is `useAnimationLoop`'s job, gated on
 * `sceneState.measurements.visible` there too (not on `activeTool`) — see
 * its "5. Measurement screen coords" step.
 */

import type { ReactNode } from 'react';
import { useViewerStore } from '@/store';
import { MeasurementOverlays } from '../tools/MeasurementVisuals';

export function MeasurementSceneLayer(): ReactNode {
  const activeTool = useViewerStore((s) => s.activeTool);
  const visible = useViewerStore((s) => s.sceneState.measurements.visible);
  const measurements = useViewerStore((s) => s.measurements);
  const polylineMeasurements = useViewerStore((s) => s.polylineMeasurements);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);

  if (activeTool === 'measure' || !visible) return null;
  if (measurements.length === 0 && polylineMeasurements.length === 0) return null;

  return (
    <MeasurementOverlays
      measurements={measurements}
      pending={null}
      activeMeasurement={null}
      snapTarget={null}
      snapVisualization={null}
      projectToScreen={projectToScreen}
      unitDisplayOverrides={unitDisplayOverrides}
      polylineMeasurements={polylineMeasurements}
    />
  );
}
