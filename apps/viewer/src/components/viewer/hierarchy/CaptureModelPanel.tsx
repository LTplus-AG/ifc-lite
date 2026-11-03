/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy when the only model is a Gaussian capture (#8566). A capture
 * has no spatial tree, so its one row carries the model controls that the
 * multi-model header rows provide: inspect, hide/show, fit and remove.
 */

import type { MouseEvent } from 'react';
import { Eye, EyeOff, Maximize2, Sparkles, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { frameModels } from '@/lib/model-placement/scene';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export interface CaptureModelPanelProps {
  model: FederatedModel;
  title: string;
  onRemove: (modelId: string, event: MouseEvent) => void;
  /** `data-*` attributes for the panel root, e.g. the welcome tour anchor. */
  rootProps?: Record<`data-${string}`, string>;
}

const ACTION = 'p-1 shrink-0 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 dark:hover:text-zinc-100 dark:hover:bg-zinc-800';

export function CaptureModelPanel({ model, title, onRemove, rootProps }: CaptureModelPanelProps) {
  const { t, locale } = useTranslation();
  const setSelectedModelId = useViewerStore((s) => s.setSelectedModelId);
  const setModelVisibility = useViewerStore((s) => s.setModelVisibility);
  const count = model.gaussianSplat?.count ?? 0;
  const visibility = t(model.visible ? 'gaussianCapture.row.hide' : 'gaussianCapture.row.show');
  return (
    <div {...rootProps} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">{title}</h2>
      </div>
      <ul className="p-2">
        <li data-testid="capture-model-row" className={cn('flex items-center gap-2 border border-zinc-200 dark:border-zinc-800 px-2 py-1.5', !model.visible && 'opacity-60')}>
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setSelectedModelId(model.id)}
            aria-label={t('gaussianCapture.row.inspect')} title={t('gaussianCapture.row.inspect')}>
            <span className="block truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{model.name}</span>
            <span className="block text-2xs text-zinc-500">{t('gaussianCapture.row.summary', { count, formatted: formatLocaleNumber(locale, count) })}</span>
          </button>
          <button type="button" className={ACTION} aria-label={visibility} title={visibility} aria-pressed={!model.visible}
            onClick={() => setModelVisibility(model.id, !model.visible)}>
            {model.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
          <button type="button" className={ACTION} aria-label={t('gaussianCapture.row.fit')} title={t('gaussianCapture.row.fit')}
            onClick={() => { try { frameModels([model.id]); } catch { /* bounds not resident yet */ } }}>
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={ACTION} aria-label={t('gaussianCapture.row.remove')} title={t('gaussianCapture.row.remove')}
            onClick={(event) => onRemove(model.id, event)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      </ul>
    </div>
  );
}
