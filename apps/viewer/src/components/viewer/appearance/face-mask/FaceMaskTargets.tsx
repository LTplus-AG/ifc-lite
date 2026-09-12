/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AppearanceMeshPreview, type RegionGesture } from '../AppearanceMeshPreview.js';
import { UNSELECTED_FACE_COLOR, type FaceMaskControls, type FaceMaskTarget } from './useFaceMasks.js';

/** One converted object's selection state as a chip, plus the way into its editor.
 * Vocabulary shared with the editor: **Select faces** opens it, **Pick faces**
 * is its selection mode, **All faces** clears a selection wherever it appears. */
function FaceMaskRow({ target, editing, disabled, onEdit, onClear }: { target: FaceMaskTarget; editing: boolean; disabled: boolean; onEdit(): void; onClear(): void }) {
  const selected = target.selected?.length ?? 0;
  return <li className="flex flex-wrap items-center gap-2">
    <span className="whitespace-nowrap"><span className="text-muted-foreground">IFC object</span> <span className="font-medium">#{target.productId}</span></span>
    <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground" role="status">
      {selected ? `${selected.toLocaleString()} of ${target.triangleCount.toLocaleString()} faces selected` : `all ${target.triangleCount.toLocaleString()} faces`}
    </span>
    {selected > 0 && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClear}>All faces</Button>}
    <Button type="button" size="sm" variant={editing ? 'secondary' : 'outline'} aria-pressed={editing} disabled={disabled} onClick={onEdit}>{editing ? 'Done' : 'Select faces'}</Button>
  </li>;
}

/** The evaluated surface of one object with click/marquee face selection. The
 * selection is a set of source triangle ordinals; every change re-plans. */
export function FaceMaskEditor({ target, disabled, onChange }: { target: FaceMaskTarget; disabled: boolean; onChange(triangles: Iterable<number> | null): void }) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const selected = useMemo(() => [...(target.selected ?? [])], [target.selected]);
  const faceSelection = useMemo(() => ({ unselectedColor: UNSELECTED_FACE_COLOR }), []);
  const region = (ids: number[], gesture: RegionGesture) => {
    const next = new Set(selected);
    if (gesture.kind === 'click') for (const id of ids) { if (next.has(id)) next.delete(id); else next.add(id); }
    else for (const id of ids) { if (gesture.subtract) next.delete(id); else next.add(id); }
    onChange(next);
  };
  return <div className="space-y-1 rounded-md border p-2" aria-label={`Face selection for ${target.label}`} aria-busy={!ready}>
    <AppearanceMeshPreview mesh={target.mesh} triangles={selected} disabled={disabled} faceSelection={faceSelection} canvasLabel={`Face selection preview for ${target.label}`}
      onRegion={region} onReady={setReady} onError={message => { setReady(false); setError(message); }} />
    {error && <p className="text-[11px] text-destructive" role="alert">{error}</p>}
    <p className="text-[11px] text-muted-foreground">Selected faces receive the image; the rest of the surface keeps its current style. The selection binds to this exact evaluated surface.</p>
  </div>;
}

/** Face selections of the converted objects, with the stale-selection diagnostics beside them. */
export function FaceMaskTargets({ controls, disabled }: { controls: FaceMaskControls; disabled: boolean }) {
  const editing = controls.targets.find(target => target.productId === controls.editing);
  return <div className="space-y-2" aria-label="Face selections">
    <ul className="space-y-1 text-[11px]">
      {controls.targets.map(target => <FaceMaskRow key={target.productId} target={target} disabled={disabled} editing={target.productId === controls.editing}
        onEdit={() => controls.onEdit(target.productId === controls.editing ? null : target.productId)} onClear={() => controls.onChange(target.productId, null)} />)}
    </ul>
    {editing && <FaceMaskEditor key={editing.productId} target={editing} disabled={disabled} onChange={triangles => controls.onChange(editing.productId, triangles)} />}
    {controls.diagnostics.length > 0 && <ul className="space-y-1 text-[11px] text-destructive" role="alert" aria-label="Face selection diagnostics">
      {controls.diagnostics.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}
    </ul>}
  </div>;
}
