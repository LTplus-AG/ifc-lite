/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { selectCreatedAppearanceObject } from './select-created-object';
import { useEffect, useRef, useState } from 'react';
import { useIfcAuthoringTarget } from './useIfcAuthoringTarget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { createAnnotationFromReference } from '@/lib/appearance/create-annotation';
import { appearanceSelectClass } from './AppearanceSourceFields';
import { PdfAnnotationFields } from './PdfAnnotationFields';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';

type AnnotationMessage = { key: TranslationKey } | { text: string } | null;

/** Explicit IFC creation, next to the independent drawing it captures. */
export function AppearanceAnnotationFields({ referenceId, name, disabled }: {
  referenceId: string; name: string; disabled: boolean;
}) {
  const { t } = useTranslation();
  const { modelId, containerId, eligible, containers, setChosenModel, setChosenContainer } = useIfcAuthoringTarget();
  const room = useViewerStore(state => state.collabRoomId);
  const [Name, setName] = useState(name);
  const [expanded, setExpanded] = useState(false);
  const [representation, setRepresentation] = useState<'image' | 'fills'>('image');
  const pdf = useViewerStore(state => state.appearanceReferences.get(referenceId)?.pdf);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<AnnotationMessage>(null);
  const [error, setError] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  useEffect(() => {
    if (disabled) operation.current?.abort();
  }, [disabled]);
  async function save() {
    if (disabled || room || operation.current || containerId === undefined || !modelId) return;
    const renderer = getGlobalRenderer();
    if (!renderer) { setError(true); setMessage({ key: 'appearance.annotationFields.rendererNotReady' }); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage({ key: 'appearance.annotationFields.creating' });
    try {
      const result = await createAnnotationFromReference(modelId, containerId, referenceId, renderer, { Name, signal: controller.signal });
      if (controller.signal.aborted) return;
      selectCreatedAppearanceObject(modelId, result);
      setMessage({ key: 'appearance.annotationFields.created' });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(true); setMessage({ text: failure instanceof Error ? failure.message : String(failure) });
      }
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    }
  }
  return <details className="mt-2 border-t pt-2" onToggle={event => { setExpanded(event.currentTarget.open); if (!event.currentTarget.open) operation.current?.abort(); }}>
    <summary className="cursor-pointer text-2xs font-medium">{t('appearance.annotationFields.summary')}</summary>
    <div className="mt-2 space-y-2" aria-busy={busy}>
      <p className="text-2xs text-muted-foreground">{t('appearance.annotationFields.description')}</p>
      <fieldset disabled={disabled || busy || !!room} className="space-y-2">
        <label className="block text-2xs">{t('appearance.annotationFields.representationLabel')}<select aria-label={t('appearance.annotationFields.representationAriaLabel')} className={appearanceSelectClass} value={representation}
          onChange={event => setRepresentation(event.target.value === 'fills' ? 'fills' : 'image')}>
          <option value="image">{t('appearance.annotationFields.representationImage')}</option><option value="fills" disabled={!pdf}>{t('appearance.annotationFields.representationPdfVectors')}</option>
        </select></label>
        <label className="block text-2xs">{t('appearance.annotationFields.modelLabel')}<select aria-label={t('appearance.annotationFields.modelAriaLabel')} className={appearanceSelectClass} value={modelId}
          onChange={event => { setChosenModel(event.target.value); setChosenContainer(undefined); setMessage(null); }}>
          {!eligible.length && <option value="">{t('appearance.annotationFields.noEligibleModel')}</option>}
          {eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="block text-2xs">{t('appearance.annotationFields.containerLabel')}<select aria-label={t('appearance.annotationFields.containerAriaLabel')} className={appearanceSelectClass} value={containerId ?? ''}
          onChange={event => setChosenContainer(Number(event.target.value))}>
          {!containers.length && <option value="">{t('appearance.annotationFields.noContainer')}</option>}
          {containers.map(node => <option key={node.expressId} value={node.expressId}>{node.name || t('appearance.annotationFields.containerFallbackName', { expressId: node.expressId })}</option>)}
        </select></label>
        <label className="block text-2xs">{t('appearance.annotationFields.nameLabel')}<Input aria-label={t('appearance.annotationFields.nameAriaLabel')} value={Name} onChange={event => setName(event.target.value)} className="h-8 text-xs" /></label>
        {representation === 'image' && <Button type="button" variant="outline" size="sm" disabled={!modelId || containerId === undefined || !Name.trim()} onClick={() => { void save(); }}>{t('appearance.annotationFields.createAnnotation')}</Button>}
      </fieldset>
      {expanded && representation === 'fills' && <PdfAnnotationFields referenceId={referenceId} modelId={modelId} containerId={containerId} Name={Name} disabled={disabled || busy || !!room} />}
      {room && <p className="text-2xs text-muted-foreground">{t('appearance.annotationFields.leaveRoomNotice')}</p>}
      {busy && <Button type="button" variant="ghost" size="sm" onClick={() => { operation.current?.abort(); setMessage({ key: 'appearance.annotationFields.cancelled' }); }}>{t('appearance.annotationFields.cancelCreation')}</Button>}
      {message && <p role={error ? 'alert' : 'status'} className={`text-2xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{'key' in message ? t(message.key) : message.text}</p>}
    </div>
  </details>;
}
