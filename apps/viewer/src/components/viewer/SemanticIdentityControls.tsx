/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { GUID_PATTERN, LIMITS, assertIri, createResourceLinkStrategy, type ProfileDefinition, type ResourceIdentityLink } from '@ifc-lite/semantic';
import { useTranslation } from '@/i18n';
import type { IdentityFields } from '@/lib/semantic/resolver-context';
export interface SemanticIdentityControlsProps {
  strategy: string; onStrategy: (strategy: string) => void;
  links: ResourceIdentityLink[]; onLinks: (links: ResourceIdentityLink[]) => void;
  profile: ProfileDefinition; onError: (message: string) => void;
  identityFields?: IdentityFields; onIdentityFields?: (fields: IdentityFields) => void;
}
export function parseResourceLinks(serialized: string): ResourceIdentityLink[] {
  if (new TextEncoder().encode(serialized).length > LIMITS.bytes) throw new Error('Resource links exceed byte limit');
  const raw: unknown = JSON.parse(serialized);
  if (!Array.isArray(raw) || raw.length > LIMITS.rows) throw new Error('Expected a bounded resource link array');
  const links = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('resourceId' in item) || typeof item.resourceId !== 'string'
      || !('modelRevision' in item) || typeof item.modelRevision !== 'string' || !('GlobalId' in item) || typeof item.GlobalId !== 'string') throw new Error('Links require resourceId, modelRevision and GlobalId');
    assertIri(item.resourceId); assertIri(item.modelRevision);
    if (!new RegExp(GUID_PATTERN).test(item.GlobalId)) throw new Error('Invalid IFC GlobalId');
    return { resourceId: item.resourceId, modelRevision: item.modelRevision, GlobalId: item.GlobalId };
  });
  createResourceLinkStrategy(links);
  return links;
}
const control = 'w-full rounded border border-border bg-background p-2 text-sm';
export function SemanticIdentityControls({ strategy, onStrategy, links, onLinks, profile, onError,
  identityFields = { GlobalId: 'GlobalId', modelRevision: 'modelRevision' }, onIdentityFields }: SemanticIdentityControlsProps) {
  const { t } = useTranslation(); const [draft, setDraft] = useState(JSON.stringify(links, null, 2));
  useEffect(() => setDraft(JSON.stringify(links, null, 2)), [links]);
  const guidFields = Object.keys(profile.fields).filter(key => profile.fields[key].kind === 'string');
  const revisionFields = Object.keys(profile.fields).filter(key => ['iri', 'string'].includes(profile.fields[key].kind));
  function apply() { try { onLinks(parseResourceLinks(draft)); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } }
  return <details className="rounded border border-border p-2"><summary>{t('semantic.identityControls')}</summary>
    <select className={control} aria-label={t('semantic.identityControls')} value={strategy} onChange={event => onStrategy(event.target.value)}>
      <option value="ifc-global-id">{t('semantic.identityDirect')}</option><option value="resource-links">{t('semantic.identityLinks')}</option><option value="profile-fields">{t('semantic.identityProfile')}</option>
    </select>
    {strategy === 'resource-links' && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('semantic.identityLinkHint')}</p>
      <textarea aria-label={t('semantic.identityLinkJson')} className={control} rows={7} value={draft} onChange={event => setDraft(event.target.value)} />
      <button className="rounded border p-2 text-sm" onClick={apply}>{t('semantic.identityApplyLinks')}</button>
    </div>}
    {strategy === 'profile-fields' && <div className="space-y-2">
      <label className="block text-xs">{t('semantic.identityGuidField')}<select className={control} value={identityFields.GlobalId} onChange={event => onIdentityFields?.({ ...identityFields, GlobalId: event.target.value })}>
        {guidFields.map(key => <option key={key} value={key}>{key}</option>)}
      </select></label>
      <label className="block text-xs">{t('semantic.identityRevisionField')}<select className={control} value={identityFields.modelRevision ?? ''} onChange={event => onIdentityFields?.({ ...identityFields, modelRevision: event.target.value || undefined })}>
        <option value="">{t('semantic.identityNoRevision')}</option>{revisionFields.map(key => <option key={key} value={key}>{key}</option>)}
      </select></label>
    </div>}
  </details>;
}
