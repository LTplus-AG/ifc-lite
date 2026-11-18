/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity references in the structural reviews (#10605): each element id is a
 * button that selects and frames that element, through the one selection
 * path the properties panel uses (`selectOnlyEntity`), so it resolves the
 * federated id at any model count.
 */
import { Fragment, type ReactNode } from 'react';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { Button } from '@/components/ui/button';
import { TEXT_LINK_CLASS } from '@/components/ui/text-link';
import type { TranslationKey } from '@/i18n/en';
import type { TranslationParameters } from '@/i18n/types';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { selectOnlyEntity } from '../properties/useSelectAssembly';

/** `#id Name (IfcClass)`, read from the model and its edits; just `#id` when the entity has neither. */
function useEntityLabel(modelId: string, expressId: number): string {
  return useViewerStore((s) => {
    const dataStore = s.models.get(modelId)?.ifcDataStore;
    const record = dataStore ? effectiveMetadataRecord(dataStore, expressId, s.mutationViews.get(modelId)) : null;
    const name = record?.attributes[2];
    return [`#${expressId}`, typeof name === 'string' && name ? name : null, record?.type ? `(${record.type})` : null].filter(Boolean).join(' ');
  });
}

/** One element of `modelId`, as a button that selects and frames it. */
export function ElementLink({ modelId, expressId }: { modelId: string; expressId: number }) {
  const { t } = useTranslation();
  const label = useEntityLabel(modelId, expressId);
  return <Button type="button" variant="link" size="sm" className={`inline h-auto whitespace-normal p-0 text-left font-normal ${TEXT_LINK_CLASS}`}
    title={t('structuralDerive.selectElement')} onClick={() => selectOnlyEntity({ modelId, expressId })}>{label}</Button>;
}

/** Several elements of `modelId`, comma-separated links. */
export function ElementLinks({ modelId, ids }: { modelId: string; ids: readonly number[] }) {
  return <>{ids.map((id, index) => <Fragment key={id}>{index > 0 && ', '}<ElementLink modelId={modelId} expressId={id} /></Fragment>)}</>;
}

const MARK = '\u0001';

/**
 * A translated row whose `links` placeholders render as nodes. Each placeholder
 * stays in the catalogue string, so translations keep their word order; a `#`
 * written before one is dropped, since the link names the id itself.
 */
export function linkedText(t: (key: TranslationKey, params?: TranslationParameters) => string, key: TranslationKey,
  params: TranslationParameters, links: Record<string, ReactNode>): ReactNode {
  const marks = Object.fromEntries(Object.keys(links).map((name) => [name, `${MARK}${name}${MARK}`]));
  const text = t(key, { ...params, ...marks }).replaceAll(`#${MARK}`, MARK);
  return text.split(MARK).map((part, index) => index % 2 === 1 && Object.hasOwn(links, part)
    ? <Fragment key={index}>{links[part]}</Fragment> : part);
}

/**
 * Switch to the analytical view and select the analysis model, its members
 * highlighted and framed: the group itself owns no geometry.
 */
export function showAnalyticalModel(modelId: string, analysisModelId: number, memberIds: readonly number[]): void {
  useViewerStore.getState().setStructuralViewMode('analytical');
  selectOnlyEntity({ modelId, expressId: analysisModelId }, memberIds);
}

export function ShowAnalyticalModelButton({ modelId, analysisModelId, memberIds }: { modelId: string; analysisModelId: number; memberIds: readonly number[] }) {
  const { t } = useTranslation();
  return <Button size="sm" variant="outline" onClick={() => showAnalyticalModel(modelId, analysisModelId, memberIds)}>{t('structuralDerive.showAnalytical')}</Button>;
}
