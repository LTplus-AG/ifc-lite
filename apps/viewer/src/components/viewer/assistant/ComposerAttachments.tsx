/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit, per-message grounding for the Assistant composer: the current
 * selection and an optional viewport screenshot. Selecting elements or moving
 * the camera attaches nothing; only these controls do, and an attachment is
 * sent with the next message and then cleared. For a model without image
 * input the screenshot control explains on click why it cannot attach, and the
 * request refuses an image for such a model rather than dropping it silently.
 */

import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Camera, MousePointerClick, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { getModelById } from '@/lib/llm/models';
import { captureSelectionGrounding, selectionGroundingText, type SelectionGrounding } from '@/lib/actions/selection-grounding';
import type { AssistantAttachments } from '@/lib/assistant/request';
import { captureViewportScreenshot } from './viewport-screenshot';

export interface ComposerAttachmentValue {
  selection: SelectionGrounding | null;
  screenshot: string | null;
}

export const NO_ATTACHMENTS: ComposerAttachmentValue = { selection: null, screenshot: null };

/** What a send carries for `value`: nothing unless the user attached it. */
export function attachmentsForSend(value: ComposerAttachmentValue): AssistantAttachments {
  return {
    ...(value.selection ? { selection: selectionGroundingText(value.selection) } : {}),
    ...(value.screenshot ? { screenshot: value.screenshot } : {}),
  };
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { t } = useTranslation();
  return <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 py-0.5 pl-2 pr-0.5 text-2xs">
    {label}
    <IconButton label={t('sceneActions.removeAttachment', { name: label })} className="h-5 w-5" onClick={onRemove}><X className="h-3 w-3" /></IconButton>
  </span>;
}

export function ComposerAttachments({ model, value, onChange, disabled, sent }: {
  model: string;
  /** Messages sent so far: a capture still running when a message is sent belongs to no message and is dropped. */
  sent: number;
  value: ComposerAttachmentValue;
  /** A state setter: the screenshot lands after an await, so it updates the current value, not the one it started from. */
  onChange: Dispatch<SetStateAction<ComposerAttachmentValue>>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const selected = useViewerStore(s => s.selectedEntityIds.size || (s.selectedEntityId !== null ? 1 : 0));
  const images = getModelById(model)?.supportsImages === true;
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState<'unsupported' | 'failed' | null>(null);
  const sentRef = useRef(sent);
  sentRef.current = sent;
  const attachView = async () => {
    // Explained on click rather than by a disabled control, so keyboard users learn why too.
    if (!images) { setProblem('unsupported'); return; }
    setCapturing(true);
    setProblem(null);
    const startedAt = sentRef.current;
    let shot: string | null = null;
    // A lost GPU device rejects the frame wait: report a failed capture rather than leave the control capturing.
    try { shot = await captureViewportScreenshot(); }
    catch (error) { console.warn('[Assistant] viewport capture failed', error); }
    finally { setCapturing(false); }
    if (sentRef.current !== startedAt) return;
    if (shot) onChange(current => ({ ...current, screenshot: shot }));
    else setProblem('failed');
  };
  const attached = value.selection !== null || value.screenshot !== null;
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-1">
      {!value.selection && <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-2xs" disabled={disabled || selected === 0}
        title={selected === 0 ? t('sceneActions.attachSelectionEmpty') : undefined}
        onClick={() => onChange({ ...value, selection: captureSelectionGrounding(useViewerStore.getState()) })}>
        <MousePointerClick className="h-3 w-3 mr-1" aria-hidden="true" />
        {selected ? t('sceneActions.attachSelectionCount', { count: selected }) : t('sceneActions.attachSelection')}
      </Button>}
      {!value.screenshot && <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-2xs" disabled={disabled || capturing}
        onClick={() => void attachView()}>
        <Camera className="h-3 w-3 mr-1" aria-hidden="true" />{capturing ? t('sceneActions.viewCapturing') : t('sceneActions.attachView')}
      </Button>}
      {value.selection && <Chip label={t('sceneActions.selectionAttached', { count: value.selection.elements.length })}
        onRemove={() => onChange({ ...value, selection: null })} />}
      {value.screenshot && <Chip label={t('sceneActions.viewAttached')} onRemove={() => onChange({ ...value, screenshot: null })} />}
    </div>
    {problem && <p role="alert" className="text-2xs text-destructive">
      {t(problem === 'unsupported' ? 'sceneActions.attachViewUnsupported' : 'sceneActions.viewFailed')}</p>}
    {attached && <p className="text-2xs text-muted-foreground">{t('sceneActions.attachmentsNote')}</p>}
  </div>;
}
