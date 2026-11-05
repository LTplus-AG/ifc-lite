/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Document display component for IFC document references.
 */

import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, FileText } from 'lucide-react';
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
import { PersistentCollapsible } from './PersistentCollapsible';
import { associationDisclosureId } from './associationDisclosureId';
import { INSPECTOR_SECTION, INSPECTOR_TRIGGER, INSPECTOR_TITLE, INSPECTOR_COUNT, INSPECTOR_CHEVRON, InspectorRow } from './inspector-ui';

export function DocumentCard({ document, sectionId }: { document: DocumentInfo; sectionId?: string }) {
  const { t } = useTranslation();
  const displayName = document.name || document.identification || t('properties.document.heading');
  const isUrl = document.location?.startsWith('http://') || document.location?.startsWith('https://');

  return (
    <PersistentCollapsible id={sectionId ?? associationDisclosureId('document', document, [document], 0)} className={INSPECTOR_SECTION}>
      <CollapsibleTrigger className={INSPECTOR_TRIGGER}>
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={INSPECTOR_TITLE}>
          {displayName}
        </span>
        {document.revision && (
          <span className={INSPECTOR_COUNT}>
            {document.revision}
          </span>
        )}
        <ChevronDown className={INSPECTOR_CHEVRON} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-1">
          {document.unresolved && <output className="block px-3 py-1.5 text-xs text-status-warn">{t('properties.document.unresolved')}</output>}
          {document.identification && (
            <InspectorRow label={EXPRESS_IDENTIFICATION_ATTRIBUTE} value={String(document.identification)} />
          )}
          {document.name && (
            <InspectorRow label={EXPRESS_NAME_ATTRIBUTE} value={String(document.name)} />
          )}
          {document.description && (
            <InspectorRow label={EXPRESS_DESCRIPTION_ATTRIBUTE} value={String(document.description)} />
          )}
          {document.location && (
            <div className="inspector-kv group/copyrow min-h-7 gap-x-2 pl-3 pr-1 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{EXPRESS_LOCATION_ATTRIBUTE}</span>
              {isUrl ? (
                <a
                  href={document.location}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 truncate text-primary underline"
                  title={document.location}
                >
                  {document.location}
                </a>
              ) : (
                <span className="min-w-0 truncate" title={document.location}>{document.location}</span>
              )}
              <span className="w-6" aria-hidden="true" />
            </div>
          )}
          {document.purpose && (
            <InspectorRow label={EXPRESS_PURPOSE_ATTRIBUTE} value={String(document.purpose)} />
          )}
          {document.intendedUse && (
            <InspectorRow label={EXPRESS_INTENDED_USE_ATTRIBUTE} value={String(document.intendedUse)} />
          )}
          {document.revision && (
            <InspectorRow label={EXPRESS_REVISION_ATTRIBUTE} value={String(document.revision)} />
          )}
        </div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}
