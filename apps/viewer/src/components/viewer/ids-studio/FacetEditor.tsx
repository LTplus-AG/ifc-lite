/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inspector for an applicability facet or a requirement (IDS-033): the facet
 * read as a sentence, its fields, and for a requirement its optionality with
 * the IDS 1.0 meaning of each choice and its instructions.
 */

import { useId } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { RequirementOptionality } from '@ifc-lite/ids';
import { describeFacet, type Section, type StudioDocument, type Uuid } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { moveFacetOp, removeFacetOp, setOptionalityOp, setRequirementTextOp } from '@/lib/ids-studio/ops';
import { applicabilityEntities } from '@/lib/ids-studio/spec-entities';
import { FACET_LABEL } from './AddFacetMenu';
import { CommitInput } from './CommitInput';
import { FacetFields } from './FacetFields';
import { NodeDiagnostics } from './NodeDiagnostics';
import { useStudioDispatch } from './useStudio';

const OPTIONALITY: Record<RequirementOptionality, { label: TranslationKey; explain: TranslationKey }> = {
  required: { label: 'idsStudio.cardinality.required', explain: 'idsStudio.facet.optionality.requiredExplain' },
  optional: { label: 'idsStudio.cardinality.optional', explain: 'idsStudio.facet.optionality.optionalExplain' },
  prohibited: { label: 'idsStudio.cardinality.prohibited', explain: 'idsStudio.facet.optionality.prohibitedExplain' },
};

export function FacetEditor({ doc, specIndex, section, facetIndex, facetId }: {
  doc: StudioDocument; specIndex: number; section: Section; facetIndex: number; facetId: Uuid;
}) {
  const { t } = useTranslation();
  const id = useId();
  const dispatch = useStudioDispatch();
  const gate = useViewerStore((s) => s.idsStudioContexts?.gate ?? null);
  const locale = useViewerStore((s) => s.idsLocale);
  const select = useViewerStore((s) => s.idsStudioSelect);
  const spec = doc.ids.specifications[specIndex];
  const requirement = section === 'requirements' ? spec.requirements[facetIndex] : undefined;
  const facet = requirement ? requirement.facet : spec.applicability.facets[facetIndex];
  const count = section === 'requirements' ? spec.requirements.length : spec.applicability.facets.length;
  const sentence = describeFacet(facet, section, requirement?.optionality, locale);
  const choices: RequirementOptionality[] = facet.type === 'entity' ? ['required'] : facet.type === 'partOf' ? ['required', 'prohibited'] : ['required', 'optional', 'prohibited'];
  return <section aria-label={t(FACET_LABEL[facet.type])} className="space-y-2">
    <div className="space-y-0.5">
      <h3 className="text-xs font-semibold">{t(section === 'requirements' ? 'idsStudio.facet.requirementHeading' : 'idsStudio.facet.applicabilityHeading', { type: t(FACET_LABEL[facet.type]) })}</h3>
      <p className="rounded bg-muted/50 px-2 py-1 text-xs italic break-words">{sentence}</p>
    </div>
    {gate
      ? <FacetFields facet={facet} facetId={facetId} gate={gate} versions={spec.ifcVersions} entities={applicabilityEntities(spec)} dispatch={(ops) => { dispatch(ops); }} />
      : <p className="text-2xs text-muted-foreground">{t('idsStudio.loadingSchema')}</p>}
    {requirement && <fieldset className="space-y-1" aria-describedby={`${id}-opt`}>
      <legend className="text-2xs text-muted-foreground">{t('idsStudio.facet.optionality')}</legend>
      <div role="radiogroup" className="flex flex-wrap gap-2">
        {choices.map((value) => <label key={value} className="flex items-center gap-1 text-xs">
          <input type="radio" name={`${id}-optionality`} checked={requirement.optionality === value}
            onChange={() => dispatch([setOptionalityOp(facetId, value)])} />{t(OPTIONALITY[value].label)}
        </label>)}
      </div>
      <p id={`${id}-opt`} className="text-2xs text-muted-foreground">{t(OPTIONALITY[requirement.optionality].explain)}</p>
    </fieldset>}
    {requirement && <CommitInput label={t('idsStudio.facet.instructions')} multiline value={requirement.instructions ?? ''}
      onCommit={(v) => dispatch([setRequirementTextOp(facetId, 'instructions', v)])} />}
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" className="h-7" disabled={facetIndex === 0} aria-label={t('idsStudio.facet.moveUp')}
        onClick={() => dispatch([moveFacetOp(facetId, facetIndex - 1)])}><ArrowUp className="h-3 w-3" aria-hidden /></Button>
      <Button size="sm" variant="outline" className="h-7" disabled={facetIndex >= count - 1} aria-label={t('idsStudio.facet.moveDown')}
        onClick={() => dispatch([moveFacetOp(facetId, facetIndex + 1)])}><ArrowDown className="h-3 w-3" aria-hidden /></Button>
      <Button size="sm" variant="outline" className="h-7 text-destructive"
        onClick={() => { if (dispatch([removeFacetOp(facetId)]).ok) select(doc.nodes.specs[specIndex].id); }}>
        <Trash2 className="mr-1 h-3 w-3" aria-hidden />{t('idsStudio.facet.remove')}
      </Button>
    </div>
    <NodeDiagnostics nodeId={facetId} />
  </section>;
}
