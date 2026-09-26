/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ChevronDown } from 'lucide-react';
import type { ClassificationInfo, DocumentInfo, MaterialInfo } from '@ifc-lite/parser';
import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { matchesPropertySearch } from './propertySearch';
import { PropertySearchHighlight } from './PropertySearchHighlight';
import { PersistentCollapsible } from './PersistentCollapsible';
import { formatThickness, TYPE_LABEL_KEYS } from './MaterialCard';
import {
  EXPRESS_CATEGORY_ATTRIBUTE, EXPRESS_DESCRIPTION_ATTRIBUTE, EXPRESS_IDENTIFICATION_ATTRIBUTE,
  EXPRESS_INTENDED_USE_ATTRIBUTE, EXPRESS_IS_VENTILATED_ATTRIBUTE, EXPRESS_LOCATION_ATTRIBUTE,
  EXPRESS_NAME_ATTRIBUTE, EXPRESS_PURPOSE_ATTRIBUTE, EXPRESS_REVISION_ATTRIBUTE,
} from './express-labels';

type Translate = ReturnType<typeof useTranslation>['t'];
type SearchRow = { label: string; value: string; href?: string };
export type AssociationSearchCard = { id: string; title: string; rows: SearchRow[] };

function row(label: string, value: string | number | boolean | undefined, href?: string): SearchRow[] {
  return value === undefined || value === '' ? [] : [{ label, value: String(value), href }];
}

function matchedCard(id: string, title: string, rows: SearchRow[], query: string): AssociationSearchCard | null {
  const headingMatches = matchesPropertySearch(title, query);
  const matches = headingMatches ? rows : rows.filter(({ label, value }) => matchesPropertySearch(label, query) || matchesPropertySearch(value, query));
  return headingMatches || matches.length > 0 ? { id, title, rows: matches } : null;
}

function classificationCard(info: ClassificationInfo, query: string, t: Translate): AssociationSearchCard | null {
  if (info.unresolved) return null;
  const displayName = info.identification || info.name || t('properties.classification.unknown');
  const systemName = info.system || t('properties.classification.heading');
  const rows = [
    ...row(EXPRESS_IDENTIFICATION_ATTRIBUTE, info.identification),
    ...row(EXPRESS_NAME_ATTRIBUTE, info.name),
    ...row(t('properties.field.system'), info.system),
    ...row(EXPRESS_LOCATION_ATTRIBUTE, info.location),
    ...row(t('properties.field.path'), info.path?.join(' > ')),
    ...row(EXPRESS_DESCRIPTION_ATTRIBUTE, info.description),
  ];
  return matchedCard(`classification:${info.system}:${displayName}`, `${systemName} · ${displayName}`, rows, query);
}

function documentCard(info: DocumentInfo, query: string, t: Translate): AssociationSearchCard | null {
  const title = info.name || info.identification || t('properties.document.heading');
  const locationHref = info.location?.startsWith('https://') || info.location?.startsWith('http://') ? info.location : undefined;
  const rows = [
    ...row(EXPRESS_IDENTIFICATION_ATTRIBUTE, info.identification),
    ...row(EXPRESS_NAME_ATTRIBUTE, info.name),
    ...row(EXPRESS_DESCRIPTION_ATTRIBUTE, info.description),
    ...row(EXPRESS_LOCATION_ATTRIBUTE, info.location, locationHref),
    ...row(EXPRESS_PURPOSE_ATTRIBUTE, info.purpose),
    ...row(EXPRESS_INTENDED_USE_ATTRIBUTE, info.intendedUse),
    ...row(EXPRESS_REVISION_ATTRIBUTE, info.revision),
  ];
  return matchedCard(`document:${info.identification ?? title}`, info.revision ? `${title} · ${info.revision}` : title, rows, query);
}

function materialCard(info: MaterialInfo, query: string, t: Translate, locale: string): AssociationSearchCard | null {
  if (info.unresolved) return null;
  const typeLabel = t(TYPE_LABEL_KEYS[info.type]);
  const title = info.name || typeLabel;
  const rows: SearchRow[] = [];
  if (info.type === 'Material') rows.push(...row(EXPRESS_NAME_ATTRIBUTE, info.name), ...row(EXPRESS_DESCRIPTION_ATTRIBUTE, info.description));
  if (info.type !== 'Material') rows.push(...row(t('properties.material.setName'), info.name));
  info.layers?.forEach((layer, i) => {
    const heading = t('properties.material.layerN', { n: i + 1 });
    if (layer.thickness !== undefined) rows.push(...row(heading, formatThickness(layer.thickness, locale)));
    rows.push(...row(t('properties.material.materialLabel'), layer.materialName));
    rows.push(...row(EXPRESS_NAME_ATTRIBUTE, layer.name), ...row(EXPRESS_CATEGORY_ATTRIBUTE, layer.category));
    if (layer.isVentilated) rows.push(...row(EXPRESS_IS_VENTILATED_ATTRIBUTE, t('properties.material.yes')));
  });
  info.profiles?.forEach((profile) => {
    rows.push(...row(t('properties.material.materialLabel'), profile.materialName));
    rows.push(...row(EXPRESS_NAME_ATTRIBUTE, profile.name), ...row(EXPRESS_CATEGORY_ATTRIBUTE, profile.category));
  });
  info.constituents?.forEach((constituent, i) => {
    rows.push(...row(EXPRESS_NAME_ATTRIBUTE, constituent.name || t('properties.material.constituentN', { n: i + 1 })));
    if (constituent.fraction !== undefined) rows.push(...row(t('properties.material.constituentN', { n: i + 1 }), `${formatLocaleNumber(locale, constituent.fraction * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`));
    rows.push(...row(t('properties.material.materialLabel'), constituent.materialName));
    rows.push(...row(EXPRESS_CATEGORY_ATTRIBUTE, constituent.category));
  });
  info.materials?.forEach((material, i) => rows.push(...row(t('properties.material.materialN', { n: i + 1 }), material.name)));
  return matchedCard(`material:${info.type}:${info.name ?? ''}`, info.name ? `${title} · ${typeLabel}` : title, rows, query);
}

/** Search the visible IFC attributes of associated classification, material and document entities (#5899). */
export function findAssociationAttributes({ classifications, materials, documents, query, t, locale }: {
  classifications: readonly ClassificationInfo[];
  materials: readonly MaterialInfo[];
  documents: readonly DocumentInfo[];
  query: string;
  t: Translate;
  locale: string;
}) {
  if (!query) return { classifications: [], materials: [], documents: [] };
  return {
    classifications: classifications.flatMap((info) => classificationCard(info, query, t) ?? []),
    materials: materials.flatMap((info) => materialCard(info, query, t, locale) ?? []),
    documents: documents.flatMap((info) => documentCard(info, query, t) ?? []),
  };
}

export function AssociationAttributeSearchCard({ card, query }: { card: AssociationSearchCard; query: string }) {
  return <PersistentCollapsible id={card.id} forceOpen className="border-2 border-border bg-muted/20 w-full max-w-full overflow-hidden">
    <CollapsibleTrigger className="group/disclosure flex items-center gap-2 w-full p-2.5 text-left text-xs hover:bg-muted/50">
      <span className="font-bold truncate flex-1 min-w-0"><PropertySearchHighlight text={card.title} query={query} /></span>
      <ChevronDown className="size-3 shrink-0 transition-transform group-data-[state=closed]/disclosure:-rotate-90" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="divide-y border-t">
        {card.rows.map((item, index) => <div key={`${item.label}-${index}`} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
          <span className="text-muted-foreground font-medium"><PropertySearchHighlight text={item.label} query={query} /></span>
          {item.href ? <a href={item.href} target="_blank" rel="noopener noreferrer" className="font-mono underline break-all"><PropertySearchHighlight text={item.value} query={query} /></a>
            : <span className="font-mono select-all break-words"><PropertySearchHighlight text={item.value} query={query} /></span>}
        </div>)}
      </div>
    </CollapsibleContent>
  </PersistentCollapsible>;
}
