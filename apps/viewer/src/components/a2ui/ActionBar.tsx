/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ActionBar: viewer actions over a target set (a live query or bound refs)
 * plus suggested follow-up questions. Every button goes through the policy
 * gate; the click is the user gesture that lets Export CSV run.
 */

import type { ReactNode } from 'react';
import { Crosshair, Download, Eye, EyeOff, Focus, MessageSquare, MousePointerClick, Palette, RotateCcw } from 'lucide-react';
import { createComponentImplementation } from '@a2ui/react';
import { encodeRef, VIEWER_ACTIONS, type ViewerAction } from '@ifc-lite/a2ui';
import { ActionBarApi } from '@ifc-lite/a2ui/catalog';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { safeColor } from '@/lib/a2ui/functions';
import { weightStyle } from './basic-layout';
import { ResultNotes } from './notes';
import { useA2uiRuntime, useRunFunction, useTarget } from './runtime';

const ACTION_LABEL: Record<ViewerAction, TranslationKey> = {
  select: 'a2ui.action.select',
  isolate: 'a2ui.action.isolate',
  hide: 'a2ui.action.hide',
  show: 'a2ui.action.show',
  colorize: 'a2ui.action.colorize',
  flyTo: 'a2ui.action.flyTo',
  resetView: 'a2ui.action.resetView',
  exportCsv: 'a2ui.action.exportCsv',
};

const ACTION_ICON: Record<ViewerAction, ReactNode> = {
  select: <MousePointerClick className="h-3.5 w-3.5" aria-hidden />,
  isolate: <Focus className="h-3.5 w-3.5" aria-hidden />,
  hide: <EyeOff className="h-3.5 w-3.5" aria-hidden />,
  show: <Eye className="h-3.5 w-3.5" aria-hidden />,
  colorize: <Palette className="h-3.5 w-3.5" aria-hidden />,
  flyTo: <Crosshair className="h-3.5 w-3.5" aria-hidden />,
  resetView: <RotateCcw className="h-3.5 w-3.5" aria-hidden />,
  exportCsv: <Download className="h-3.5 w-3.5" aria-hidden />,
};

export const ActionBarImpl = createComponentImplementation(ActionBarApi, ({ props }) => {
  const { t } = useTranslation();
  const { onFollowUp } = useA2uiRuntime();
  const run = useRunFunction();
  const target = useTarget({ refs: props.refs, query: props.query });
  const refs = target.refs.map(encodeRef);
  const actions = (Array.isArray(props.actions) ? props.actions : []).filter((a): a is ViewerAction => (VIEWER_ACTIONS as readonly string[]).includes(a));
  const color = safeColor(props.color);
  const followUps = Array.isArray(props.followUps) ? props.followUps : [];

  return (
    <div style={weightStyle(props.weight)} className="flex flex-col gap-1.5">
      <ResultNotes unloadedModels={target.unloadedModels} problems={target.problems} shown={target.refs.length} total={target.cappedFrom} />
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              data-a2ui-action={action}
              disabled={action !== 'resetView' && refs.length === 0}
              onClick={() => run(action, action === 'colorize' ? { refs, color } : action === 'resetView' ? {} : { refs })}
              className="gap-1"
            >
              {action === 'colorize'
                ? <span aria-hidden className="h-3 w-3 rounded-sm border" style={{ backgroundColor: color }} />
                : ACTION_ICON[action]}
              {t(ACTION_LABEL[action])}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">{t('a2ui.action.count', { count: refs.length })}</span>
        </div>
      )}
      {followUps.length > 0 && onFollowUp && (
        <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">{t('a2ui.followUps')}</legend>
          {followUps.map((f, i) => (
            <Button key={i} size="sm" variant="secondary" className="h-auto gap-1 whitespace-normal py-1 text-left" onClick={() => onFollowUp(f.prompt, { prompt: f.prompt })}>
              <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {f.label}
            </Button>
          ))}
        </fieldset>
      )}
    </div>
  );
});
