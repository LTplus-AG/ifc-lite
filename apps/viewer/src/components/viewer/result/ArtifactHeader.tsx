/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The working-artifact header (U02, #6925; charter "Shared artifact
 * editing"): the artifact's name, the source scope it was made from, its
 * revision and save state, its native actions, the assistant entry and its
 * latest activity. The editable object is the artifact itself; "Discuss"
 * opens the assistant on it, it never moves the artifact into a chat.
 *
 * The assistant entry is a slot: the panel passes its own `AssistantAction`
 * (which renders nothing where the panel is no assistant source), so a header
 * never offers a conversation that cannot open.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { StatusChip, type ResultStatus } from './StatusChip';

interface ArtifactHeaderProps {
  name: string;
  /** Where the artifact's content comes from ("12 specifications · IDS 1.0", "Clash run, 3 models"). */
  sourceScope?: string;
  description?: string;
  /** Revision or version as a complete message ("Version 1.0", "Revision 3"). */
  revision?: string;
  state?: ResultStatus;
  /** Native actions (save, export, apply). */
  actions?: ReactNode;
  /** The assistant entry (the panel's `AssistantAction`). */
  assistant?: ReactNode;
  /** Latest activity on this artifact, as a complete message ("Saved 10:42"). */
  activity?: string;
  className?: string;
}

export function ArtifactHeader({
  name, sourceScope, description, revision, state, actions, assistant, activity, className,
}: ArtifactHeaderProps) {
  const { t } = useTranslation();
  return (
    <header aria-label={t('artifactHeader.region', { name })} className={cn('space-y-1', className)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm break-words">{name}</h3>
          {sourceScope && <p className="text-xs text-muted-foreground">{sourceScope}</p>}
        </div>
        {state && <StatusChip status={state} className="mt-0.5" />}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {(revision || activity || actions || assistant) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          {revision && <span>{revision}</span>}
          {activity && <span>{activity}</span>}
          <div className="ml-auto flex items-center gap-1">
            {actions}
            {assistant}
          </div>
        </div>
      )}
    </header>
  );
}
