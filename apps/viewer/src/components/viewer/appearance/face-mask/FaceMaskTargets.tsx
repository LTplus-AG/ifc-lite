/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AppearanceMeshPreview, type RegionGesture } from '../AppearanceMeshPreview.js';
import { UNSELECTED_FACE_COLOR, type FaceMaskControls, type FaceMaskTarget } from './useFaceMasks.js';
import { registerViewportFacePicker } from './viewport-face-picker.js';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

/** One converted object's selection state as a chip, plus the way into its editor.
 * Vocabulary shared with the editor: **Select faces** opens it, **Pick faces**
 * is its selection mode, **All faces** clears a selection wherever it appears. */
function FaceMaskRow({ target, editing, disabled, onEdit, onClear }: { target: FaceMaskTarget; editing: boolean; disabled: boolean; onEdit(): void; onClear(): void }) {
  const { t, locale } = useTranslation();
  const selected = target.selected?.length ?? 0;
  return <li className="flex flex-wrap items-center gap-2">
    <span className="whitespace-nowrap"><span className="text-muted-foreground">{t('appearance.faceMask.ifcObject')}</span> <span className="font-medium">#{target.productId}</span></span>
    <output className="rounded-full border px-2 py-0.5 text-2xs text-muted-foreground">
      {selected
        ? t('appearance.faceMask.someSelected', { count: formatLocaleNumber(locale, selected), total: formatLocaleNumber(locale, target.triangleCount) })
        : t('appearance.faceMask.allSelectedSummary', { total: formatLocaleNumber(locale, target.triangleCount) })}
    </output>
    {selected > 0 && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClear}>{t('appearance.faceMask.allFaces')}</Button>}
    <Button type="button" size="sm" variant={editing ? 'secondary' : 'outline'} aria-pressed={editing} disabled={disabled} onClick={onEdit}>{editing ? t('appearance.faceMask.done') : t('appearance.faceMask.selectFaces')}</Button>
  </li>;
}

/** The evaluated surface of one object with click/marquee face selection. The
 * selection is a set of source triangle ordinals; every change re-plans. */
export function FaceMaskEditor({ target, disabled, onChange }: { target: FaceMaskTarget; disabled: boolean; onChange(triangles: Iterable<number> | null): void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const selected = useMemo(() => [...(target.selected ?? [])], [target.selected]);
  const latest = useRef({ selected, onChange, disabled });
  latest.current = { selected, onChange, disabled };
  const activeTool = useViewerStore(state => state.activeTool);
  const setActiveTool = useViewerStore(state => state.setActiveTool);
  useEffect(() => registerViewportFacePicker({ globalId: target.globalId, modelIndex: target.modelIndex,
    geometryItemIds: target.geometryItemIds, triangleCount: target.triangleCount, canPick: () => !latest.current.disabled, onToggle: triangle => {
      const next = new Set(latest.current.selected);
      if (next.has(triangle)) next.delete(triangle); else next.add(triangle);
      latest.current.onChange(next);
    } }), [target.globalId, target.modelIndex, target.geometryItemIds, target.triangleCount]);
  useEffect(() => () => {
    if (useViewerStore.getState().activeTool === 'appearance-face') useViewerStore.getState().setActiveTool('select');
  }, []);
  const faceSelection = useMemo(() => ({ unselectedColor: UNSELECTED_FACE_COLOR }), []);
  const region = (ids: number[], gesture: RegionGesture) => {
    const next = new Set(selected);
    if (gesture.kind === 'click') for (const id of ids) { if (next.has(id)) next.delete(id); else next.add(id); }
    else for (const id of ids) { if (gesture.subtract) next.delete(id); else next.add(id); }
    onChange(next);
  };
  return <div className="space-y-1 rounded-md border p-2" aria-label={t('appearance.faceMask.editorAriaLabel', { label: target.label })} aria-busy={!ready}>
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant={activeTool === 'appearance-face' ? 'secondary' : 'outline'}
        aria-pressed={activeTool === 'appearance-face'} disabled={disabled && activeTool !== 'appearance-face'}
        onClick={() => setActiveTool(activeTool === 'appearance-face' ? 'select' : 'appearance-face')}>
        {activeTool === 'appearance-face' ? t('appearance.faceMask.pickingInModel') : t('appearance.faceMask.pickInModel')}
      </Button>
      {activeTool === 'appearance-face' && <output className="text-2xs text-muted-foreground">{t('appearance.faceMask.pickingStatus')}</output>}
    </div>
    <AppearanceMeshPreview mesh={target.mesh} triangles={selected} disabled={disabled} faceSelection={faceSelection} canvasLabel={t('appearance.faceMask.previewCanvasLabel', { label: target.label })}
      onRegion={region} onReady={setReady} onError={message => { setReady(false); setError(message); }} />
    {error && <p className="text-2xs text-destructive" role="alert">{error}</p>}
    <p className="text-2xs text-muted-foreground">{t('appearance.faceMask.editorNote')}</p>
  </div>;
}

/** Face selections of the converted objects, with the stale-selection diagnostics beside them. */
export function FaceMaskTargets({ controls, disabled }: { controls: FaceMaskControls; disabled: boolean }) {
  const { t } = useTranslation();
  const editing = controls.targets.find(target => target.productId === controls.editing);
  return <div className="space-y-2" aria-label={t('appearance.faceMask.selectionsAriaLabel')}>
    <ul className="space-y-1 text-2xs">
      {controls.targets.map(target => <FaceMaskRow key={target.productId} target={target} disabled={disabled} editing={target.productId === controls.editing}
        onEdit={() => controls.onEdit(target.productId === controls.editing ? null : target.productId)} onClear={() => controls.onChange(target.productId, null)} />)}
    </ul>
    {editing && <FaceMaskEditor key={editing.productId} target={editing} disabled={disabled} onChange={triangles => controls.onChange(editing.productId, triangles)} />}
    {controls.diagnostics.length > 0 && <ul className="space-y-1 text-2xs text-destructive" role="alert" aria-label={t('appearance.faceMask.diagnosticsAriaLabel')}>
      {controls.diagnostics.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}
    </ul>}
  </div>;
}
