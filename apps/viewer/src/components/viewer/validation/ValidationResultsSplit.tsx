/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { GripHorizontal } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useTranslation } from '@/i18n';

/** #6690: summary content may grow, but always leaves room for results.
 * Both panes scroll independently; percentage bounds also fit short hosts.
 * The shared pane primitive supplies pointer and keyboard resizing. */
export function ValidationResultsSplit({ summary, children }: {
  summary: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Group orientation="vertical" className="flex-1 min-h-0 min-w-0" data-validation-results-split>
      <Panel defaultSize="45%" minSize="15%" maxSize="75%">
        <div className="h-full min-h-0 overflow-auto" data-validation-summary-pane>
          {summary}
        </div>
      </Panel>
      <Separator
        aria-label={t('validationPanel.results.resizeSummary')}
        className="group flex h-2.5 shrink-0 cursor-row-resize items-center justify-center border-y border-border/60 bg-muted/30 transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <GripHorizontal aria-hidden="true" className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary/70" />
      </Separator>
      <Panel minSize="25%">
        <div className="h-full min-h-0 flex flex-col overflow-hidden" data-validation-results-pane>
          {children}
        </div>
      </Panel>
    </Group>
  );
}
