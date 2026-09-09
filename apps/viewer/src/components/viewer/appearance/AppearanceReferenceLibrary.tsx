/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Unlock, Trash2, Pencil, Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { downloadBlob } from '@/lib/export/download.js';

export interface AppearanceReferenceLibraryProps {
  onEdit?: (id: string) => void;
  disabled?: boolean;
}

/** Registered drawings live inside the Appearance workspace; they never select IFC entities. */
export function AppearanceReferenceLibrary({ onEdit, disabled = false }: AppearanceReferenceLibraryProps) {
  const references = useViewerStore(state => state.appearanceReferences);
  const selected = useViewerStore(state => state.selectedAppearanceReferenceId);
  const sources = useViewerStore(state => state.appearanceSources);
  const frame = useViewerStore(placementFrameKey);
  useViewerStore(state => state.referenceRevision); // exact-image relink changes availability without replacing the record
  const id = useId();
  const importPicker = useRef<HTMLInputElement>(null);
  const relinkPicker = useRef<HTMLInputElement>(null);
  const relinkTarget = useRef<string | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    if (disabled) { pending.current?.abort(); pending.current = undefined; setBusy(false); }
  }, [disabled]);
  const blocked = disabled || busy;
  function perform(action: () => void): void {
    if (blocked) return;
    setError(undefined); setNotice(undefined);
    try { action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function fileOperation(action: (signal: AbortSignal) => Promise<string>): Promise<void> {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const message = await action(controller.signal);
      if (!controller.signal.aborted && mounted.current) setNotice(message);
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (pending.current === controller && mounted.current) { pending.current = undefined; setBusy(false); }
    }
  }
  function importFile(file: File): void {
    const before = useViewerStore.getState().appearanceReferences;
    void fileOperation(async signal => {
      if (file.size > 2_000_000) throw new Error('Choose a drawing registration file no larger than 2 MB.');
      const text = await file.text();
      if (signal.aborted) throw new DOMException('Registration import cancelled.', 'AbortError');
      if (useViewerStore.getState().appearanceReferences !== before) throw new Error('Drawings changed while the file was opening. Import the registration again.');
      useViewerStore.getState().importAppearanceReferences(text);
      return 'Drawing registration restored. Relink any missing original images below.';
    });
  }
  function relinkFile(file: File): void {
    const target = relinkTarget.current; relinkTarget.current = undefined;
    if (!target) return;
    void fileOperation(async signal => {
      await useViewerStore.getState().relinkAppearanceReference(target, file, signal);
      return 'Original drawing image restored.';
    });
  }
  return <section className="space-y-2" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <div className="flex items-center justify-between gap-2">
      <h3 id={`${id}-heading`} className="text-xs font-medium">Registered drawings</h3>
      <div className="flex gap-1">
        <Button type="button" variant="ghost" size="icon-xs" disabled={blocked}
          aria-label="Import drawing registration" title="Import drawing registration" onClick={() => importPicker.current?.click()}><Upload aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon-xs" disabled={blocked || references.size === 0}
          aria-label="Export drawing registration" title="Export drawing registration" onClick={() => perform(() => {
            downloadBlob(new Blob([useViewerStore.getState().exportAppearanceReferences()], { type: 'application/json' }), 'drawing-registration.json');
            setNotice('Registration saved. Keep its original images with the file.');
          })}><Download aria-hidden="true" /></Button>
      </div>
    </div>
    {references.size === 0 && <p className="text-[11px] leading-relaxed text-muted-foreground">Registered drawings will appear here. You can also restore a saved registration.</p>}
    <ul className="space-y-2">
      {[...references.values()].map((reference, index) => {
        const name = sources.find(source => source.id === reference.sourceId)?.name ?? `Drawing ${index + 1}`;
        const missing = !appearanceAssets.get(reference.assetId);
        const wrongFrame = reference.frameKey !== frame;
        const editsDisabled = blocked || reference.locked;
        return <li key={reference.id} aria-label={name} className={`rounded-md border p-2 ${selected === reference.id ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <div className="flex items-center gap-1">
            <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Select ${name}`} aria-pressed={selected === reference.id} title={name} disabled={blocked}
              onClick={() => perform(() => useViewerStore.getState().selectAppearanceReference(reference.id))}>{name}</button>
            <Button type="button" variant="ghost" size="icon-xs" disabled={editsDisabled || wrongFrame}
              aria-label={`${reference.visible ? 'Hide' : 'Show'} ${name}`} title={reference.visible ? 'Hide drawing' : 'Show drawing'}
              onClick={() => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { visible: !reference.visible }))}>
              {reference.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" disabled={blocked || (wrongFrame && !reference.locked)}
              aria-label={`${reference.locked ? 'Unlock' : 'Lock'} ${name}`} title={reference.locked ? 'Unlock drawing' : 'Lock drawing'}
              onClick={() => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { locked: !reference.locked }))}>
              {reference.locked ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}
            </Button>
            {onEdit && <Button type="button" variant="ghost" size="icon-xs" disabled={editsDisabled || missing}
              aria-label={`Edit ${name}`} title="Edit registration" onClick={() => perform(() => {
                useViewerStore.getState().selectAppearanceReference(reference.id); onEdit(reference.id);
              })}><Pencil aria-hidden="true" /></Button>}
            <Button type="button" variant="ghost" size="icon-xs" disabled={editsDisabled}
              aria-label={`Remove ${name}`} title="Remove drawing" onClick={() => perform(() => useViewerStore.getState().removeAppearanceReference(reference.id))}><Trash2 aria-hidden="true" /></Button>
          </div>
          <ReferenceOpacity name={name} value={reference.opacity} disabled={editsDisabled || wrongFrame}
            onCommit={opacity => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { opacity }))} />
          {wrongFrame && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">This drawing uses another coordinate frame. Unlock and edit its registration before displaying it.</p>}
          {missing && <div className="mt-1 space-y-1">
            <p className="text-[11px] text-muted-foreground">Original image needed. Choose the exact image used by this registration.</p>
            <Button type="button" variant="outline" size="sm" className="h-7 text-[11px]" disabled={blocked}
              aria-label={`Relink image for ${name}`} onClick={() => { relinkTarget.current = reference.id; relinkPicker.current?.click(); }}>Relink original image</Button>
          </div>}
        </li>;
      })}
    </ul>
    <input ref={importPicker} className="sr-only" tabIndex={-1} type="file" accept="application/json,.json" aria-label="Drawing registration file" disabled={blocked}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file && !blocked) importFile(file); }} />
    <input ref={relinkPicker} className="sr-only" tabIndex={-1} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="Original drawing image" disabled={blocked}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file && !blocked) relinkFile(file); }} />
    {busy && <div className="flex items-center justify-between text-[11px] text-muted-foreground" role="status">
      <span>Opening file…</span><Button type="button" variant="ghost" size="sm" onClick={() => { pending.current?.abort(); pending.current = undefined; setBusy(false); }}>Cancel file operation</Button>
    </div>}
    {error && <p role="alert" className="text-[11px] leading-relaxed text-destructive">{error}</p>}
    {notice && <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{notice}</p>}
  </section>;
}


/** Commit one numeric edit on Enter/blur, instead of filling Undo on every keystroke. */
function ReferenceOpacity({ name, value, disabled, onCommit }: {
  name: string; value: number; disabled: boolean; onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(Math.round(value * 100)));
  const [invalid, setInvalid] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setText(String(Math.round(value * 100))); setInvalid(false); setDirty(false); }, [value]);
  function commit() {
    if (disabled || !dirty) return;
    const percentage = Number(text);
    if (!text.trim() || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) { setInvalid(true); return; }
    setInvalid(false); setDirty(false);
    if (percentage / 100 !== value) onCommit(percentage / 100);
  }
  return <div className="mt-1">
    <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="flex-1">Opacity</span>
      <input type="number" min="0" max="100" step="1" className="h-7 w-16 rounded border bg-background px-2 text-xs tabular-nums"
        aria-label={`Opacity for ${name}`} aria-invalid={invalid} value={text} disabled={disabled}
        onChange={event => { setText(event.currentTarget.value); setInvalid(false); setDirty(true); }} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} /><span>%</span>
    </label>
    {invalid && <p className="mt-1 text-[11px] text-destructive" role="alert">Enter an opacity between 0 and 100%.</p>}
  </div>;
}
