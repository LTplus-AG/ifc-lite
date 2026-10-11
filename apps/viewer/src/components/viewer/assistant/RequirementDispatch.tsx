/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native targets of reviewed source requirements (#7375). Shows each
 * requirement's explicit target, lets the reviewer exclude any, and on
 * request prepares the P07 drafts, which are then audited, dry-run, saved and
 * handed to their native editors by the unchanged P07 review cards. Nothing
 * is dispatched automatically.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { IFCVersion } from '@ifc-lite/ids';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import type { SemanticRequirementProposal } from '@/lib/semantic/assist/requirement-proposal';
import type { RequirementReview } from '@/lib/semantic/assist/requirement-review';
import { prepareNativeDrafts, qualifyRequirements, type NativeDrafts } from '@/lib/semantic/assist/requirement-dispatch';
import { loadSchemaMeasures, textRevision, type ClassifiedRequirement, type SchemaMeasures, type UnresolvedReason } from '@/lib/semantic/assist/requirement-targets';
import { useSemanticSourceTexts, type SourceText } from '@/lib/semantic/assist/source-texts';
import type { Passage } from '@/lib/semantic/assist/spans';
import { IdsDraftReview } from '../check-authoring/IdsDraftReview';
import { RulesDraftReview } from '../check-authoring/RulesDraftReview';
import { DocumentOutlineReview } from '../check-authoring/DocumentOutlineReview';

const UNRESOLVED: Record<Exclude<UnresolvedReason, 'native'>, TranslationKey> = {
  span: 'semanticAssist.unresolvedSpan', 'source-missing': 'semanticAssist.unresolvedSourceMissing',
  'source-changed': 'semanticAssist.unresolvedSourceChanged', scope: 'semanticAssist.unresolvedScope', unknown: 'semanticAssist.unresolvedUnknown', version: 'semanticAssist.unresolvedVersion',
  dimension: 'semanticAssist.unresolvedDimension', measure: 'semanticAssist.unresolvedMeasure', property: 'semanticAssist.unresolvedProperty',
  operator: 'semanticAssist.unresolvedOperator', value: 'semanticAssist.unresolvedValue', unit: 'semanticAssist.unresolvedUnit',
};
const TARGET: Record<'ids' | 'geometry' | 'manual', TranslationKey> = {
  ids: 'semanticAssist.targetIds', geometry: 'semanticAssist.targetGeometry', manual: 'semanticAssist.targetManual',
};
const REFUSED: Record<NativeDrafts['refused'][number]['target'], TranslationKey> = {
  ids: 'semanticAssist.refusedIds', geometry: 'semanticAssist.refusedGeometry', manual: 'semanticAssist.refusedManual',
};

const NONE_EXCLUDED: ReadonlySet<string> = new Set();

function TargetLabel({ row, excluded }: { row: ClassifiedRequirement; excluded: boolean }) {
  const { t } = useTranslation();
  if (row.target !== 'unresolved') return <span className="rounded bg-primary/10 px-1 py-0.5 font-medium">{t(TARGET[row.target])}</span>;
  return <span className="text-amber-700 dark:text-amber-400">
    {row.reason === 'native' ? t('semanticAssist.unresolvedNative', { detail: row.detail ?? '' }) : t(UNRESOLVED[row.reason ?? 'span'])}
    {/* An excluded requirement reaches no draft, the document included. */}
    {!excluded && <>{' '}{t('semanticAssist.unresolvedListed')}</>}</span>;
}

/**
 * The content of every source the drafts cite (included requirements, verified
 * or not, and the listed unsupported items): a draft is withdrawn once any of
 * them reads differently, however it read when the drafts were prepared.
 */
function citedSources(proposal: SemanticRequirementProposal, included: readonly ClassifiedRequirement[], sources: readonly SourceText[]): string {
  const ids = new Set([...included.map(row => row.requirement.span.source), ...proposal.unsupported.flatMap(item => item.span ? [item.span.source] : [])]);
  return [...ids].sort().map(id => {
    const source = sources.find(candidate => candidate.id === id);
    return `${id}:${source ? textRevision(source.text) : 'detached'}`;
  }).join('|');
}

/**
 * IDS versions of the loaded IFC models; IFC4 when none is loaded, none when only IFC5 models are (IDS has no IFC5 version).
 * `unchecked` counts the loaded models an IDS draft cannot target (IFC5, or no known version), so a mixed load says so.
 */
function loadedIfcVersions(models: ReadonlyMap<string, { schemaVersion?: string; ifcDataStore?: { schemaVersion?: string } | null }>):
  { versions: IFCVersion[]; unchecked: number } {
  if (models.size === 0) return { versions: ['IFC4'], unchecked: 0 };
  const versions = new Set<IFCVersion>();
  let unchecked = 0;
  for (const model of models.values()) {
    const schemaVersion = model.schemaVersion ?? model.ifcDataStore?.schemaVersion;
    if (schemaVersion === 'IFC2X3' || schemaVersion === 'IFC4') versions.add(schemaVersion);
    // A model record says IFC4X3; the IDS spelling is accepted too, so no IFC4X3 model is ever left untargeted.
    else if (schemaVersion === 'IFC4X3' || schemaVersion === 'IFC4X3_ADD2') versions.add('IFC4X3_ADD2');
    else unchecked += 1;
  }
  // Sorted, so the same set of versions in another load order is the same target.
  return { versions: [...versions].sort(), unchecked };
}

export function RequirementDispatch({ proposal, review, passages, loadSchema = loadSchemaMeasures }: {
  proposal: SemanticRequirementProposal; review: RequirementReview; passages: readonly Passage[];
  /** The schema's declared property and quantity types; injectable so a failure to read them can be shown. */
  loadSchema?: () => Promise<SchemaMeasures>;
}) {
  const { t } = useTranslation();
  const sources = useSemanticSourceTexts(s => s.sources);
  const [schema, setSchema] = useState<SchemaMeasures | null>(null);
  const [schemaFailure, setSchemaFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadSchema().then(measures => { if (live) setSchema(() => measures); },
      (failure: unknown) => { if (live) setSchemaFailure(failure instanceof Error ? failure.message : String(failure)); });
    return () => { live = false; };
  }, [loadSchema]);
  // The IFC versions an IDS draft would target decide which declared types the values are checked as.
  const models = useViewerStore(s => s.models);
  const loaded = useMemo(() => loadedIfcVersions(models), [models]);
  const ifcVersions = loaded.versions;
  const classified = useMemo(() => schema ? qualifyRequirements(review, passages, sources, schema, ifcVersions) : [], [review, passages, sources, schema, ifcVersions]);
  // Exclusions belong to the proposal they were made on: a replacement that reuses an id for another requirement starts included.
  const [exclusion, setExclusion] = useState<{ proposal: SemanticRequirementProposal; ids: ReadonlySet<string> }>(() => ({ proposal, ids: new Set() }));
  const excluded = exclusion.proposal === proposal ? exclusion.ids : NONE_EXCLUDED;
  const [prepared, setPrepared] = useState<{ drafts: NativeDrafts; cited: string; included: ClassifiedRequirement[]; proposal: SemanticRequirementProposal; versions: string } | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);
  // Re-checked on every render: a cited source changed or detached after preparing withdraws the unsaved drafts.
  // A different proposal in the same review withdraws them too: the drafts were built from the previous one.
  // So do models of other IFC versions: the drafts' types were chosen for the versions loaded when they were prepared.
  const stale = prepared !== null && (prepared.proposal !== proposal || prepared.versions !== ifcVersions.join()
    || citedSources(proposal, prepared.included, sources) !== prepared.cited);
  useEffect(() => {
    // Withdrawn drafts are gone for good: the reviewer prepares them again from the current classification.
    if (stale) { setPrepared(null); setWithdrawn(true); }
  }, [stale]);
  const prepare = () => {
    const included = classified.filter(row => !excluded.has(row.requirement.id));
    const drafts = prepareNativeDrafts(proposal, classified, excluded,
      { unsupported: review.unsupported, passages, sources, ifcVersions });
    setPrepared({ drafts, cited: citedSources(proposal, included, sources), included, proposal, versions: ifcVersions.join() });
    setWithdrawn(false);
  };
  const active = prepared !== null && !stale ? prepared : null;
  const included = classified.filter(row => !excluded.has(row.requirement.id)).length;
  // Without the schema no unit can be checked, so nothing is classified or offered for dispatch.
  if (schemaFailure) return <section aria-label={t('semanticAssist.dispatchTitle')} className="space-y-1.5 rounded border border-border p-1.5">
    <p className="font-medium">{t('semanticAssist.dispatchTitle')}</p>
    <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">{t('semanticAssist.schemaFailed', { detail: schemaFailure })}</p>
  </section>;
  if (!schema) return null;
  return <section aria-label={t('semanticAssist.dispatchTitle')} className="space-y-1.5 rounded border border-border p-1.5">
    <p className="font-medium">{t('semanticAssist.dispatchTitle')}</p>
    <p className="text-muted-foreground">{t('semanticAssist.dispatchHint')}</p>
    <ul className="space-y-1">{classified.map(row => {
      const id = row.requirement.id;
      return <li key={id} className="flex items-start gap-1.5">
        <input type="checkbox" id={`dispatch-${id}`} className="mt-0.5" checked={!excluded.has(id)} disabled={active !== null}
          aria-label={t('semanticAssist.include', { id })}
          onChange={event => {
            const checked = event.target.checked;
            setExclusion(previous => {
              const next = new Set(previous.proposal === proposal ? previous.ids : []);
              if (checked) next.delete(id); else next.add(id);
              return { proposal, ids: next };
            });
          }} />
        <label htmlFor={`dispatch-${id}`} className="break-words"><span className="font-mono font-semibold">{id}</span> <TargetLabel row={row} excluded={excluded.has(id)} /></label>
      </li>;
    })}</ul>
    {withdrawn && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('semanticAssist.draftsWithdrawn')}</p>}
    {!active && <Button size="sm" variant="outline" className="h-7" disabled={included === 0 && !proposal.unsupported.length}
      onClick={prepare}>{t('semanticAssist.prepareDrafts')}</Button>}
    {active && <>
      <p aria-live="polite" className="text-muted-foreground">{t('semanticAssist.draftsPrepared')}</p>
      {active.drafts.refused.map(({ target, detail }) => <p key={target} role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">
        {t(REFUSED[target], { detail })}</p>)}
      {/* A mixed load: the IDS draft checks the models of the versions it targets and says which it cannot. */}
      {active.drafts.ids && loaded.unchecked > 0 && <p role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
        {t('semanticAssist.idsSkipsModels', { count: loaded.unchecked })}</p>}
      {active.drafts.ids && <IdsDraftReview initial={active.drafts.ids} />}
      {active.drafts.rules && <RulesDraftReview initial={active.drafts.rules} />}
      {/* No validation report backs these drafts: the outline holds only text and not-checked items. */}
      {active.drafts.document && <DocumentOutlineReview initial={active.drafts.document} evidence={null} />}
    </>}
  </section>;
}
