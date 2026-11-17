/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification display component for IFC element classifications.
 */

import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, Tag } from 'lucide-react';
import type { ClassificationInfo } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import {
  EXPRESS_DESCRIPTION_ATTRIBUTE,
  EXPRESS_IDENTIFICATION_ATTRIBUTE,
  EXPRESS_LOCATION_ATTRIBUTE,
  EXPRESS_NAME_ATTRIBUTE,
} from './express-labels';
import { PersistentCollapsible } from './PersistentCollapsible';
import { associationDisclosureId } from './associationDisclosureId';
import { INSPECTOR_SECTION, INSPECTOR_TRIGGER, INSPECTOR_TITLE, INSPECTOR_COUNT, INSPECTOR_CHEVRON, InspectorRow } from './inspector-ui';

export function ClassificationCard({ classification, sectionId }: { classification: ClassificationInfo; sectionId?: string }) {
  const { t } = useTranslation();
  // Matches the "unavailable on this data source" treatment in
  // ModelMetadataPanel: a server-parsed store (#3948) can prove the entity
  // is classified via the relationship graph without being able to read
  // any of the classification's own attributes. Without this branch the
  // card fell through to the general case below and rendered a
  // content-free "Classification / Unknown" card.
  if (classification.unresolved) {
    return (
      <div className="flex h-8 w-full items-center gap-1.5 border-b border-border px-3">
        <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground">
          {t('properties.classification.unresolved')}
        </span>
      </div>
    );
  }

  const displayName = classification.identification || classification.name || t('properties.classification.unknown');
  const systemName = classification.system;

  return (
    <PersistentCollapsible id={sectionId ?? associationDisclosureId('classification', classification, [classification], 0)} className={INSPECTOR_SECTION}>
      <CollapsibleTrigger className={INSPECTOR_TRIGGER}>
        <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className={INSPECTOR_TITLE}>
          {systemName || t('properties.classification.heading')}
        </span>
        <span className={INSPECTOR_COUNT}>
          {displayName}
        </span>
        <ChevronDown className={INSPECTOR_CHEVRON} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-1">
          {classification.identification && (
            <InspectorRow label={EXPRESS_IDENTIFICATION_ATTRIBUTE} value={String(classification.identification)} />
          )}
          {classification.name && (
            <InspectorRow label={EXPRESS_NAME_ATTRIBUTE} value={String(classification.name)} />
          )}
          {classification.system && (
            <InspectorRow label={t('properties.field.system')} value={String(classification.system)} />
          )}
          {classification.location && (
            <InspectorRow label={EXPRESS_LOCATION_ATTRIBUTE} value={String(classification.location)} />
          )}
          {classification.path && classification.path.length > 0 && (
            <InspectorRow label={t('properties.field.path')} value={String(classification.path.join(' > '))} />
          )}
          {classification.description && (
            <InspectorRow label={EXPRESS_DESCRIPTION_ATTRIBUTE} value={String(classification.description)} />
          )}
        </div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}
