/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Document display component for IFC document references.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FileText } from 'lucide-react';
import type { DocumentInfo } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import {
  EXPRESS_DESCRIPTION_ATTRIBUTE,
  EXPRESS_IDENTIFICATION_ATTRIBUTE,
  EXPRESS_INTENDED_USE_ATTRIBUTE,
  EXPRESS_LOCATION_ATTRIBUTE,
  EXPRESS_NAME_ATTRIBUTE,
  EXPRESS_PURPOSE_ATTRIBUTE,
  EXPRESS_REVISION_ATTRIBUTE,
} from './express-labels';

export function DocumentCard({ document }: { document: DocumentInfo }) {
  const { t } = useTranslation();
  const displayName = document.name || document.identification || t('properties.document.heading');
  const isUrl = document.location?.startsWith('http://') || document.location?.startsWith('https://');

  return (
    <Collapsible defaultOpen className="border-2 border-sky-200 dark:border-sky-800 bg-sky-50/20 dark:bg-sky-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-sky-50 dark:hover:bg-sky-900/30 text-left transition-colors overflow-hidden">
        <FileText className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
        <span className="font-bold text-xs text-sky-700 dark:text-sky-400 truncate flex-1 min-w-0">
          {displayName}
        </span>
        {document.revision && (
          <span className="text-2xs font-mono bg-sky-100 dark:bg-sky-900/50 px-1.5 py-0.5 border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 shrink-0">
            {document.revision}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-sky-200 dark:border-sky-800 divide-y divide-sky-100 dark:divide-sky-900/30">
          {document.identification && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_IDENTIFICATION_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.identification}</span>
            </div>
          )}
          {document.name && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_NAME_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.name}</span>
            </div>
          )}
          {document.description && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_DESCRIPTION_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.description}</span>
            </div>
          )}
          {document.location && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_LOCATION_ATTRIBUTE}</span>
              {isUrl ? (
                <a
                  href={document.location}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sky-600 dark:text-sky-400 underline hover:text-sky-800 dark:hover:text-sky-300 break-all"
                >
                  {document.location}
                </a>
              ) : (
                <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.location}</span>
              )}
            </div>
          )}
          {document.purpose && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_PURPOSE_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.purpose}</span>
            </div>
          )}
          {document.intendedUse && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_INTENDED_USE_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.intendedUse}</span>
            </div>
          )}
          {document.revision && (
            <div className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-sky-50/50 dark:hover:bg-sky-900/20">
              <span className="text-zinc-500 dark:text-zinc-400 font-medium">{EXPRESS_REVISION_ATTRIBUTE}</span>
              <span className="font-mono text-sky-700 dark:text-sky-400 select-all break-words">{document.revision}</span>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
