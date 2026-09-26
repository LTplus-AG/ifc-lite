/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { trackExportCompleted } from '@/lib/analytics';
import { AppearanceAnnotationFields } from './AppearanceAnnotationFields';
import { referenceFrameStatus } from '@/lib/appearance/reference-runtime/frame.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, Lock, Unlock, Trash2, Pencil, Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { downloadBlob } from '@/lib/export/download.js';
import { useTranslation, type TranslationKey } from '@/i18n';

export interface AppearanceReferenceLibraryProps {
  onEdit?: (id: string) => void;
  disabled?: boolean;
}

type LibraryError = { key: TranslationKey } | { text: string } | null;

class LocalizedReferenceError extends Error {
  constructor(readonly key: TranslationKey) {
    super(key);
  }
}

/** Registered drawings live inside the Appearance workspace; they never select IFC entities. */
export function AppearanceReferenceLibrary({ onEdit, disabled = false }: AppearanceReferenceLibraryProps) {
  const { t } = useTranslation();
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
  const [error, setError] = useState<LibraryError>(null);
  const [noticeKey, setNoticeKey] = useState<TranslationKey>();
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
    setError(null); setNoticeKey(undefined);
    try { action(); }
    catch (failure) { setError({ text: failure instanceof Error ? failure.message : String(failure) }); }
  }
  async function fileOperation(action: (signal: AbortSignal) => Promise<TranslationKey>): Promise<void> {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setNoticeKey(undefined);
    try {
      const notice = await action(controller.signal);
      if (!controller.signal.aborted && mounted.current) setNoticeKey(notice);
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) {
        setError(failure instanceof LocalizedReferenceError
          ? { key: failure.key }
          : { text: failure instanceof Error ? failure.message : String(failure) });
      }
    } finally {
      if (pending.current === controller && mounted.current) { pending.current = undefined; setBusy(false); }
    }
  }
  function importFile(file: File): void {
    const before = useViewerStore.getState().appearanceReferences;
    void fileOperation(async signal => {
      if (file.size > 2_000_000) throw new LocalizedReferenceError('appearance.referenceLibrary.tooLarge');
      const text = await file.text();
      if (signal.aborted) throw new LocalizedReferenceError('appearance.referenceLibrary.importCancelled');
      if (useViewerStore.getState().appearanceReferences !== before) throw new LocalizedReferenceError('appearance.referenceLibrary.changedWhileOpening');
      useViewerStore.getState().importAppearanceReferences(text);
      return 'appearance.referenceLibrary.importedNotice';
    });
  }
  function relinkFile(file: File): void {
    const target = relinkTarget.current; relinkTarget.current = undefined;
    if (!target) return;
    void fileOperation(async signal => {
      await useViewerStore.getState().relinkAppearanceReference(target, file, signal);
      return 'appearance.referenceLibrary.relinkedNotice';
    });
  }
  return <section className="space-y-2" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <div className="flex items-center justify-between gap-2">
      <h3 id={`${id}-heading`} className="text-xs font-medium">{t('appearance.referenceLibrary.heading')}</h3>
      <div className="flex gap-1">
        <IconButton
          label={t('appearance.referenceLibrary.importTooltip')}
          type="button"
          size="icon-xs"
          disabled={blocked}
          onClick={() => importPicker.current?.click()}
        ><Upload aria-hidden="true" /></IconButton>
        <IconButton
          label={t('appearance.referenceLibrary.exportTooltip')}
          type="button"
          size="icon-xs"
          disabled={blocked || references.size === 0}
          onClick={() => perform(() => {
            downloadBlob(new Blob([useViewerStore.getState().exportAppearanceReferences()], { type: 'application/json' }), 'drawing-registration.json');
            trackExportCompleted({ format: 'json', surface: 'appearance_panel' });
            setNoticeKey('appearance.referenceLibrary.exportedNotice');
          })}
        ><Download aria-hidden="true" /></IconButton>
      </div>
    </div>
    {references.size === 0 && <p className="text-2xs leading-relaxed text-muted-foreground">{t('appearance.referenceLibrary.emptyState')}</p>}
    <ul className="space-y-2">
      {[...references.values()].map((reference, index) => {
        const name = sources.find(source => source.id === reference.sourceId)?.name ?? t('appearance.referenceLibrary.defaultDrawingName', { n: index + 1 });
        const missing = !appearanceAssets.get(reference.assetId);
        const wrongFrame = reference.frameKey !== frame && referenceFrameStatus(reference, useViewerStore.getState()) === 'frame-mismatch';
        const editsDisabled = blocked || reference.locked;
        return <li key={reference.id} aria-label={name} className={`rounded-md border p-2 ${selected === reference.id ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <div className="flex items-center gap-1">
            <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t('appearance.referenceLibrary.selectAriaLabel', { name })} aria-pressed={selected === reference.id} title={name} disabled={blocked}
              onClick={() => perform(() => useViewerStore.getState().selectAppearanceReference(reference.id))}>{name}</button>
            <IconButton
              label={reference.visible ? t('appearance.referenceLibrary.hideAriaLabel', { name }) : t('appearance.referenceLibrary.showAriaLabel', { name })}
              tooltip={reference.visible ? t('appearance.referenceLibrary.hideDrawing') : t('appearance.referenceLibrary.showDrawing')}
              type="button"
              size="icon-xs"
              disabled={editsDisabled || wrongFrame}
              onClick={() => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { visible: !reference.visible }))}
            >
              {reference.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            </IconButton>
            <IconButton
              label={reference.locked ? t('appearance.referenceLibrary.unlockAriaLabel', { name }) : t('appearance.referenceLibrary.lockAriaLabel', { name })}
              tooltip={reference.locked ? t('appearance.referenceLibrary.unlockDrawing') : t('appearance.referenceLibrary.lockDrawing')}
              type="button"
              size="icon-xs"
              disabled={blocked || (wrongFrame && !reference.locked)}
              onClick={() => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { locked: !reference.locked }))}
            >
              {reference.locked ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}
            </IconButton>
            {onEdit && <IconButton
   label={t('appearance.referenceLibrary.editAriaLabel', { name })}
   tooltip={t('appearance.referenceLibrary.editTooltip')}
   type="button"
   size="icon-xs"
   disabled={editsDisabled || missing}
   onClick={() => perform(() => {
                useViewerStore.getState().selectAppearanceReference(reference.id); onEdit(reference.id);
              })}
 ><Pencil aria-hidden="true" /></IconButton>}
            <IconButton
              label={t('appearance.referenceLibrary.removeAriaLabel', { name })}
              tooltip={t('appearance.referenceLibrary.removeTooltip')}
              type="button"
              size="icon-xs"
              disabled={editsDisabled}
              onClick={() => perform(() => useViewerStore.getState().removeAppearanceReference(reference.id))}
            ><Trash2 aria-hidden="true" /></IconButton>
          </div>
          <ReferenceOpacity name={name} value={reference.opacity} disabled={editsDisabled || wrongFrame}
            onCommit={opacity => perform(() => useViewerStore.getState().updateAppearanceReference(reference.id, { opacity }))} />
          <AppearanceAnnotationFields referenceId={reference.id} name={name} disabled={editsDisabled || missing || wrongFrame} />
          {wrongFrame && <p className="mt-1 text-2xs text-amber-700 dark:text-amber-400">{t('appearance.referenceLibrary.wrongFrameNotice')}</p>}
          {missing && <div className="mt-1 space-y-1">
            <p className="text-2xs text-muted-foreground">{t('appearance.referenceLibrary.missingImageNotice')}</p>
            <Button type="button" variant="outline" size="sm" className="h-7 text-2xs" disabled={blocked}
              aria-label={t('appearance.referenceLibrary.relinkAriaLabel', { name })} onClick={() => { relinkTarget.current = reference.id; relinkPicker.current?.click(); }}>{t('appearance.referenceLibrary.relinkButton')}</Button>
          </div>}
        </li>;
      })}
    </ul>
    <input ref={importPicker} className="sr-only" tabIndex={-1} type="file" accept="application/json,.json" aria-label={t('appearance.referenceLibrary.importFileAriaLabel')} disabled={blocked}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file && !blocked) importFile(file); }} />
    <input ref={relinkPicker} className="sr-only" tabIndex={-1} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label={t('appearance.referenceLibrary.relinkFileAriaLabel')} disabled={blocked}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file && !blocked) relinkFile(file); }} />
    {busy && <div className="flex items-center justify-between text-2xs text-muted-foreground" aria-live="polite" aria-atomic="true">
      <span>{t('appearance.referenceLibrary.openingFile')}</span><Button type="button" variant="ghost" size="sm" onClick={() => { pending.current?.abort(); pending.current = undefined; setBusy(false); }}>{t('appearance.referenceLibrary.cancelFileOperation')}</Button>
    </div>}
    {error && <p role="alert" className="text-2xs leading-relaxed text-destructive">{'key' in error ? t(error.key) : error.text}</p>}
    {noticeKey && <output className="block text-2xs leading-relaxed text-muted-foreground">{t(noticeKey)}</output>}
  </section>;
}


/** Commit one numeric edit on Enter/blur, instead of filling Undo on every keystroke. */
function ReferenceOpacity({ name, value, disabled, onCommit }: {
  name: string; value: number; disabled: boolean; onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
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
    <label className="flex items-center gap-2 text-2xs text-muted-foreground">
      <span className="flex-1">{t('appearance.referenceLibrary.opacityLabel')}</span>
      <input type="number" min="0" max="100" step="1" className="h-7 w-16 rounded border bg-background px-2 text-xs tabular-nums"
        aria-label={t('appearance.referenceLibrary.opacityAriaLabel', { name })} aria-invalid={invalid} value={text} disabled={disabled}
        onChange={event => { setText(event.currentTarget.value); setInvalid(false); setDirty(true); }} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} /><span>%</span>
    </label>
    {invalid && <p className="mt-1 text-2xs text-destructive" role="alert">{t('appearance.referenceLibrary.opacityInvalid')}</p>}
  </div>;
}
