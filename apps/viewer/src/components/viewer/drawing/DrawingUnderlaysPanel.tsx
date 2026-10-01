/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { captureDxfReferenceFrame } from '@/hooks/dxfReferencePlane';
import { DxfUnderlayPanel, type DxfUnderlayPanelProps } from '../DxfUnderlayPanel';
import { AppearanceReferenceLibrary } from '../appearance/AppearanceReferenceLibrary';
import type { AppearanceDraftSettings } from '@/lib/appearance/draft-types';

/** Open the existing source/calibration workspace before a file is chosen.
 * The engineering origin is frozen now, so moving the cut during PDF upload
 * cannot retarget the requested reference. */
export function openSectionReference(plane: SectionPlaneConfig | undefined, editReferenceId?: string): void {
  const state = useViewerStore.getState();
  let settings: Partial<AppearanceDraftSettings> | undefined;
  if (!editReferenceId && plane && !plane.customPlane) {
    const frame = captureDxfReferenceFrame(state, plane);
    const [offsetU, offsetV, offsetW] = frame.originIfc;
    settings = { kind: 'planar', plane: plane.axis === 'x' ? 'yz' : plane.axis === 'z' ? 'xz' : 'xy',
      offsetU, offsetV, offsetW, rotationDegrees: 0, repeatS: false, repeatT: false };
  }
  state.requestAppearanceReference({ settings, editReferenceId });
  state.openPanelInHome('appearance', 'programmatic');
}

export function DrawingUnderlaysPanel(props: DxfUnderlayPanelProps) {
  const { t } = useTranslation();
  return <div className="h-full overflow-y-auto bg-background">
    <div className="space-y-3 p-3">
      <Button variant="outline" size="sm" className="w-full" disabled={!props.sectionPlane || !!props.sectionPlane.customPlane}
        onClick={() => openSectionReference(props.sectionPlane)}>{t('drawingUnderlay.reference.importButton')}</Button>
      <p className="text-2xs text-muted-foreground">{t('drawingUnderlay.reference.importHint')}</p>
      <AppearanceReferenceLibrary plane={props.sectionPlane} onEdit={id => openSectionReference(props.sectionPlane, id)} />
    </div>
    <DxfUnderlayPanel {...props} />
  </div>;
}
