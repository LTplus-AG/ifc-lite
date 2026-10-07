/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layout presets inside the Customize sidebar popover (#6926): preview what a
 * preset changes, apply it explicitly, and restore the layout you had before.
 * Previewing reads only; nothing moves until Apply.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Eye, LayoutTemplate, RotateCcw } from 'lucide-react';
import { useTranslation, type TranslationKey, type UseTranslationResult } from '@/i18n';
import { resolveLiveMessage, type LiveTranslationMessage } from '@/i18n/live-message';
import { LAYOUT_PRESETS, type LayoutPresetChange, type LayoutPresetDef } from '@/lib/panels/layout-presets';
import { isWorkspacePanelId, panelTitleKey } from '@/lib/panels/registry';
import { applyLayoutPreset, previewLayoutPreset, restoreLayoutBeforePreset, useLayoutPreset } from '@/store/layoutPreset';

const RESERVED_LABEL: Record<string, TranslationKey> = { review: 'layoutPresets.reserved.review' };
const ASSISTANT_CHANGE = {
  split: 'layoutPresets.change.assistantSplit',
  dock: 'layoutPresets.change.assistantDock',
  floating: 'layoutPresets.change.assistantFloating',
} as const;

function names(t: UseTranslationResult['t'], locale: string, ids: readonly string[]): string {
  const labels = ids.map((id) => isWorkspacePanelId(id) ? t(panelTitleKey(id)) : RESERVED_LABEL[id] ? t(RESERVED_LABEL[id]) : id);
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(labels);
  } catch (error) {
    console.debug('[layout-preset] list format unavailable for locale', locale, error);
    return labels.join(', ');
  }
}

function describe(t: UseTranslationResult['t'], locale: string, change: LayoutPresetChange): string {
  switch (change.kind) {
    case 'railFirst': return t('layoutPresets.change.railFirst', { panels: names(t, locale, change.ids) });
    case 'railShown': return t('layoutPresets.change.railShown', { panels: names(t, locale, change.ids) });
    case 'expand': return t('layoutPresets.change.expand');
    case 'dock': return change.secondary
      ? t('layoutPresets.change.dockSplit', { primary: t(panelTitleKey(change.primary)), secondary: t(panelTitleKey(change.secondary)) })
      : t('layoutPresets.change.dock', { primary: t(panelTitleKey(change.primary)) });
    case 'keepDetached': return t('layoutPresets.change.keepDetached', { panels: names(t, locale, change.ids) });
    case 'assistant': return t(ASSISTANT_CHANGE[change.placement]);
    case 'reserved': return t('layoutPresets.change.reserved', { panels: names(t, locale, change.ids) });
  }
}

function PresetRow({ preset, onAnnounce }: { preset: LayoutPresetDef; onAnnounce: (message: LiveTranslationMessage) => void }) {
  const { t, locale } = useTranslation();
  const active = useLayoutPreset((s) => s.record?.active === preset.id);
  const [previewing, setPreviewing] = useState(false);
  const previewId = useId();
  const title = t(preset.titleKey);
  // Recomputed on every render while open, so the preview tracks the live layout.
  const plan = previewing ? previewLayoutPreset(preset.id) : null;
  return (
    <div className="mx-1 rounded-md px-2 py-1.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <LayoutTemplate className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate text-xs font-medium">{title}</span>
        {active && <span className="shrink-0 rounded border border-primary/40 px-1.5 text-2xs text-primary">{t('layoutPresets.active')}</span>}
      </div>
      <p className="text-2xs text-muted-foreground">{t(preset.descriptionKey)}</p>
      <div className="flex flex-wrap gap-1">
        <button type="button" aria-expanded={previewing} aria-controls={previewId} aria-label={t('layoutPresets.previewLabel', { preset: title })}
          onClick={() => setPreviewing((open) => !open)}
          className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Eye className="h-3.5 w-3.5" aria-hidden />{t('layoutPresets.preview')}
        </button>
        <button type="button" data-layout-preset-apply="" aria-label={t('layoutPresets.applyLabel', { preset: title })}
          onClick={() => { applyLayoutPreset(preset.id); setPreviewing(false); onAnnounce({ key: 'layoutPresets.applied', params: { preset: title } }); }}
          className="inline-flex h-7 items-center rounded bg-primary px-2 text-xs text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {t('layoutPresets.apply')}
        </button>
      </div>
      {plan && (
        <div id={previewId} className="rounded border border-border/60 bg-muted/30 p-2 text-2xs space-y-1">
          {plan.changes.length === 0 ? <p>{t('layoutPresets.noChanges')}</p> : <>
            <p className="font-medium">{t('layoutPresets.changesHeading')}</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {plan.changes.map((change) => <li key={change.kind}>{describe(t, locale, change)}</li>)}
            </ul>
          </>}
          <p className="text-muted-foreground">{t('layoutPresets.unchanged')}</p>
        </div>
      )}
    </div>
  );
}

export function LayoutPresetSection() {
  const { t } = useTranslation();
  const hasRecord = useLayoutPreset((s) => s.record !== null);
  const [announcement, setAnnouncement] = useState<LiveTranslationMessage | null>(null);
  const ref = useRef<HTMLElement>(null);
  const hadRecord = useRef(hasRecord);
  // Restore removes its own button; keep keyboard focus in the section instead of losing it.
  useEffect(() => {
    const restored = hadRecord.current && !hasRecord;
    hadRecord.current = hasRecord;
    const active = document.activeElement;
    if (restored && (!active || active === document.body || !active.isConnected)) {
      ref.current?.querySelector<HTMLElement>('[data-layout-preset-apply]')?.focus();
    }
  }, [hasRecord]);
  return (
    <section ref={ref} aria-label={t('layoutPresets.heading')} className="border-b border-border py-1">
      <h3 className="px-3 pt-1 pb-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('layoutPresets.heading')}</h3>
      {LAYOUT_PRESETS.map((preset) => <PresetRow key={preset.id} preset={preset} onAnnounce={setAnnouncement} />)}
      {hasRecord && (
        <div className="mx-1 px-2 pb-1.5">
          <button type="button" aria-describedby="layout-preset-restore-hint"
            onClick={() => { restoreLayoutBeforePreset(); setAnnouncement({ key: 'layoutPresets.restored' }); }}
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />{t('layoutPresets.restore')}
          </button>
          <p id="layout-preset-restore-hint" className="sr-only">{t('layoutPresets.restoreHint')}</p>
        </div>
      )}
      <output aria-live="polite" className="sr-only">{resolveLiveMessage(t, announcement)}</output>
    </section>
  );
}
