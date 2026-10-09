/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inspector for a specification (IDS-032): its text fields, IFC versions and
 * cardinality with what each means in IDS 1.0, plus structure actions
 * (add facet, duplicate, move, remove). Every change is an op through the gate.
 */

import { useId } from 'react';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import type { IDSSpecification, IFCVersion } from '@ifc-lite/ids';
import type { SpecCardinality, Uuid } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { duplicateSpecOps, moveSpecOp, removeSpecOp, setSpecCardinalityOp, setSpecTextOp, setSpecVersionsOp } from '@/lib/ids-studio/ops';
import { specCardinality } from '@/lib/ids-studio/spec-cardinality';
import { AddFacetMenu } from './AddFacetMenu';
import { CommitInput } from './CommitInput';
import { NodeDiagnostics } from './NodeDiagnostics';
import { useStudioDispatch } from './useStudio';

export const IFC_VERSIONS: readonly IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];
const CARDINALITIES: readonly SpecCardinality[] = ['required', 'optional', 'prohibited'];
const CARDINALITY: Record<SpecCardinality, { label: TranslationKey; explain: TranslationKey }> = {
  required: { label: 'idsStudio.cardinality.required', explain: 'idsStudio.spec.cardinality.requiredExplain' },
  optional: { label: 'idsStudio.cardinality.optional', explain: 'idsStudio.spec.cardinality.optionalExplain' },
  prohibited: { label: 'idsStudio.cardinality.prohibited', explain: 'idsStudio.spec.cardinality.prohibitedExplain' },
};

export function SpecificationEditor({ spec, specId, index, count }: { spec: IDSSpecification; specId: Uuid; index: number; count: number }) {
  const { t } = useTranslation();
  const dispatch = useStudioDispatch();
  const select = useViewerStore((s) => s.idsStudioSelect);
  const id = useId();
  const cardinality = specCardinality(spec);
  const toggleVersion = (version: IFCVersion, on: boolean) => {
    const next = on ? [...spec.ifcVersions, version] : spec.ifcVersions.filter((v) => v !== version);
    dispatch([setSpecVersionsOp(specId, IFC_VERSIONS.filter((v) => next.includes(v)))]);
  };
  const duplicate = () => {
    const { ops, specId: copy } = duplicateSpecOps(specId, t('idsStudio.spec.copySuffix'));
    if (dispatch(ops).ok) select(copy);
  };
  return <section aria-label={t('idsStudio.spec.heading')} className="space-y-2">
    <h3 className="text-xs font-semibold">{t('idsStudio.spec.heading')}</h3>
    <CommitInput label={t('idsStudio.spec.name')} value={spec.name} onCommit={(v) => dispatch([setSpecTextOp(specId, 'name', v)])} />
    <CommitInput label={t('idsStudio.spec.identifier')} hint={t('idsStudio.spec.identifierHint')} value={spec.identifier ?? ''}
      onCommit={(v) => dispatch([setSpecTextOp(specId, 'identifier', v)])} />
    <CommitInput label={t('idsStudio.spec.description')} multiline value={spec.description ?? ''} onCommit={(v) => dispatch([setSpecTextOp(specId, 'description', v)])} />
    <CommitInput label={t('idsStudio.spec.instructions')} multiline value={spec.instructions ?? ''} onCommit={(v) => dispatch([setSpecTextOp(specId, 'instructions', v)])} />
    <fieldset className="space-y-0.5">
      <legend className="text-2xs text-muted-foreground">{t('idsStudio.spec.versions')}</legend>
      <div className="flex flex-wrap gap-2">
        {IFC_VERSIONS.map((version) => <label key={version} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={spec.ifcVersions.includes(version)} onChange={(event) => toggleVersion(version, event.target.checked)} />
          {version}
        </label>)}
      </div>
    </fieldset>
    <fieldset className="space-y-1" aria-describedby={`${id}-card`}>
      <legend className="text-2xs text-muted-foreground">{t('idsStudio.spec.cardinality')}</legend>
      <div role="radiogroup" className="flex flex-wrap gap-2">
        {CARDINALITIES.map((value) => <label key={value} className="flex items-center gap-1 text-xs">
          <input type="radio" name={`${id}-cardinality`} checked={cardinality === value}
            onChange={() => dispatch([setSpecCardinalityOp(specId, value)])} />{t(CARDINALITY[value].label)}
        </label>)}
      </div>
      <p id={`${id}-card`} className="text-2xs text-muted-foreground">{t(CARDINALITY[cardinality].explain)}</p>
    </fieldset>
    <div className="flex flex-wrap gap-1">
      <AddFacetMenu specId={specId} section="applicability" />
      <AddFacetMenu specId={specId} section="requirements" />
    </div>
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" className="h-7" onClick={duplicate}><Copy className="mr-1 h-3 w-3" aria-hidden />{t('idsStudio.spec.duplicate')}</Button>
      <Button size="sm" variant="outline" className="h-7" disabled={index === 0} onClick={() => dispatch([moveSpecOp(specId, index - 1)])}
        aria-label={t('idsStudio.spec.moveUp')}><ArrowUp className="h-3 w-3" aria-hidden /></Button>
      <Button size="sm" variant="outline" className="h-7" disabled={index >= count - 1} onClick={() => dispatch([moveSpecOp(specId, index + 1)])}
        aria-label={t('idsStudio.spec.moveDown')}><ArrowDown className="h-3 w-3" aria-hidden /></Button>
      <Button size="sm" variant="outline" className="h-7 text-destructive" onClick={() => { if (dispatch([removeSpecOp(specId)]).ok) select(null); }}>
        <Trash2 className="mr-1 h-3 w-3" aria-hidden />{t('idsStudio.spec.remove')}
      </Button>
    </div>
    <NodeDiagnostics nodeId={specId} />
  </section>;
}
