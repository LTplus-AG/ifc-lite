/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDSCorrectionDialog — correct a failed IDS scalar-property requirement
 * for a chosen subset of failed entities (#3929).
 *
 * Writes through the SAME canonical path as the property panel and the
 * bulk editor: `store.setProperty` → `MutablePropertyView.setProperty`,
 * which is undo/redo-tracked, dirty-flags the model, and mirrors into a
 * collab session when one is active. After applying, it re-runs IDS
 * validation so the report reflects reality rather than an assumed
 * success — a correction that fails to apply is reported per-entity, not
 * swallowed.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { configureMutationView } from '@/utils/configureMutationView';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import {
  checkCorrectionEligibility,
  inferValueType,
  parseCorrectionValue,
  applyPropertyCorrection,
  CorrectionValueError,
  type CorrectionTarget,
  type CorrectionApplyResult,
} from '@/hooks/ids/idsCorrection';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IDSEntityResult, IDSSpecificationResult } from '@ifc-lite/ids';

/**
 * The set of requirements in a spec that are structurally correctable
 * (exact-name scalar property facet) and have at least one failing entity.
 * Keyed by requirement id so the dialog can offer a picker when a spec
 * carries more than one correctable requirement.
 */
export interface CorrectableRequirement {
  requirementId: string;
  description: string;
  target: CorrectionTarget;
  failedEntities: IDSEntityResult[];
  /** The facet's declared dataType constraint (e.g. "IFCLABEL"), if it names an exact value. */
  facetDataType?: string;
}

export function getCorrectableRequirements(specResult: IDSSpecificationResult): CorrectableRequirement[] {
  const byId = new Map<string, CorrectableRequirement>();
  const rejected = new Set<string>();

  for (const entity of specResult.entityResults) {
    for (const reqResult of entity.requirementResults) {
      if (reqResult.status !== 'fail') continue;
      const id = reqResult.requirement.id;
      if (rejected.has(id)) continue;

      const existing = byId.get(id);
      if (existing) {
        existing.failedEntities.push(entity);
        continue;
      }

      const eligibility = checkCorrectionEligibility(reqResult);
      if (!eligibility.eligible) {
        rejected.add(id);
        continue;
      }
      const facet = reqResult.requirement.facet;
      const facetDataType =
        facet.type === 'property' && facet.dataType?.type === 'simpleValue'
          ? facet.dataType.value
          : undefined;
      byId.set(id, {
        requirementId: id,
        description: reqResult.checkedDescription,
        target: { psetName: eligibility.psetName, propName: eligibility.propName },
        failedEntities: [entity],
        facetDataType,
      });
    }
  }

  return Array.from(byId.values());
}

interface IDSCorrectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  specResult: IDSSpecificationResult;
  modelId: string;
  /** Re-runs IDS validation for `modelId` after applying corrections. */
  onRevalidate: (modelId: string) => Promise<unknown>;
}

export function IDSCorrectionDialog({
  open,
  onOpenChange,
  specResult,
  modelId,
  onRevalidate,
}: IDSCorrectionDialogProps) {
  const models = useIfc().models;
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const registerMutationView = useViewerStore((s) => s.registerMutationView);
  const setStoreProperty = useViewerStore((s) => s.setProperty);

  const correctable = useMemo(() => getCorrectableRequirements(specResult), [specResult]);

  const [requirementId, setRequirementId] = useState<string | null>(correctable[0]?.requirementId ?? null);
  const activeRequirement = correctable.find((r) => r.requirementId === requirementId) ?? correctable[0] ?? null;

  const [selectedIds, setSelectedIds] = useState<Set<number> | null>(null);
  const [rawValue, setRawValue] = useState('');
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<CorrectionApplyResult[] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const failedEntities = activeRequirement?.failedEntities ?? [];
  const effectiveSelection = selectedIds ?? new Set(failedEntities.map((e) => e.expressId));

  const toggleEntity = useCallback((expressId: number) => {
    setSelectedIds((prev) => {
      const base = prev ?? new Set(failedEntities.map((e) => e.expressId));
      const next = new Set(base);
      if (next.has(expressId)) next.delete(expressId);
      else next.add(expressId);
      return next;
    });
  }, [failedEntities]);

  const dataStore = useMemo(() => {
    if (modelId === '__legacy__' || modelId === 'legacy') return legacyIfcDataStore ?? undefined;
    return models.get(modelId)?.ifcDataStore ?? undefined;
  }, [modelId, models, legacyIfcDataStore]);

  const resetForNewOpen = useCallback(() => {
    setSelectedIds(null);
    setRawValue('');
    setResults(null);
    setApplyError(null);
  }, []);

  const handleApply = useCallback(async () => {
    if (!activeRequirement || !dataStore) return;
    setApplyError(null);
    setResults(null);

    const ids = failedEntities
      .map((e) => e.expressId)
      .filter((id) => effectiveSelection.has(id));
    if (ids.length === 0) {
      setApplyError('Select at least one failed entity to correct.');
      return;
    }

    // Ensure a mutation view exists for this model — same lazy-init pattern
    // the Bulk Property Editor and PropertiesPanel use.
    let mutationView = getMutationView(modelId);
    if (!mutationView) {
      mutationView = new MutablePropertyView(dataStore.properties || null, modelId);
      configureMutationView(mutationView, dataStore);
      registerMutationView(modelId, mutationView);
    }

    setApplying(true);
    try {
      const accessor = createDataAccessor(dataStore, modelId, mutationView);
      const applied: CorrectionApplyResult[] = [];

      for (const expressId of ids) {
        const existing = accessor.getPropertyValue(
          expressId,
          activeRequirement.target.psetName,
          activeRequirement.target.propName,
        );
        const valueType = inferValueType(existing?.dataType, activeRequirement.facetDataType);

        let value: string | number | boolean;
        try {
          value = parseCorrectionValue(rawValue, valueType);
        } catch (err) {
          applied.push({
            expressId,
            applied: false,
            error: err instanceof CorrectionValueError ? err.message : 'Invalid value',
          });
          continue;
        }

        const result = applyPropertyCorrection(
          {
            setProperty: (entityId, pset, prop, v, vt) =>
              setStoreProperty(modelId, entityId, pset, prop, v, vt),
            getPropertyValue: (entityId, pset, prop) =>
              mutationView!.getPropertyValue(entityId, pset, prop),
          },
          expressId,
          activeRequirement.target,
          value,
          valueType,
        );
        applied.push(result);
      }

      setResults(applied);

      const succeeded = applied.some((r) => r.applied);
      if (succeeded) {
        // Rerun validation so the report reflects the corrected data —
        // never assume success just because no write threw.
        await onRevalidate(modelId);
      }
    } finally {
      setApplying(false);
    }
  }, [
    activeRequirement,
    dataStore,
    failedEntities,
    effectiveSelection,
    getMutationView,
    modelId,
    rawValue,
    registerMutationView,
    setStoreProperty,
    onRevalidate,
  ]);

  const appliedCount = results?.filter((r) => r.applied).length ?? 0;
  const failedCount = results ? results.length - appliedCount : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) resetForNewOpen();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Correct Property Requirement
          </DialogTitle>
          <DialogDescription>
            Set an explicit value for the failed entities you choose. This writes through the
            same edit path as the Properties panel and is undoable (Ctrl/Cmd+Z).
          </DialogDescription>
        </DialogHeader>

        {!activeRequirement || !dataStore ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Nothing to correct</AlertTitle>
            <AlertDescription>
              {!dataStore
                ? 'The validated model has no parsed data to edit.'
                : 'No requirement in this specification is a correctable scalar property requirement (exact property-set and property name).'}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
            {correctable.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Requirement</Label>
                <select
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
                  value={activeRequirement.requirementId}
                  onChange={(e) => {
                    setRequirementId(e.target.value);
                    setSelectedIds(null);
                    setResults(null);
                  }}
                >
                  {correctable.map((r) => (
                    <option key={r.requirementId} value={r.requirementId}>
                      {r.target.psetName}.{r.target.propName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="text-sm text-muted-foreground">
              Target: <span className="font-medium text-foreground">{activeRequirement.target.psetName}.{activeRequirement.target.propName}</span>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">New value</Label>
              <Input
                value={rawValue}
                onChange={(e) => setRawValue(e.target.value)}
                placeholder="e.g. F90"
              />
            </div>

            <div className="space-y-1 flex-1 min-h-0 flex flex-col">
              <Label className="text-xs text-muted-foreground">
                Failed entities ({effectiveSelection.size} of {failedEntities.length} selected)
              </Label>
              <ScrollArea className="border rounded-md flex-1 min-h-0 max-h-48">
                <div className="divide-y">
                  {failedEntities.map((entity) => {
                    const result = results?.find((r) => r.expressId === entity.expressId);
                    return (
                      <label
                        key={entity.expressId}
                        className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={effectiveSelection.has(entity.expressId)}
                          onChange={() => toggleEntity(entity.expressId)}
                        />
                        <span className="flex-1 truncate">
                          {entity.entityName || `#${entity.expressId}`}
                        </span>
                        {result && (
                          result.applied
                            ? <Check className="h-3.5 w-3.5 text-green-600 shrink-0" aria-label="Applied" />
                            : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label={result.error} />
                        )}
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>

            {applyError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{applyError}</AlertDescription>
              </Alert>
            )}

            {results && (
              <Alert variant={failedCount === 0 ? 'default' : 'destructive'}>
                {failedCount === 0 ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                <AlertTitle>{failedCount === 0 ? 'Correction applied' : 'Some corrections did not apply'}</AlertTitle>
                <AlertDescription>
                  {appliedCount} applied{failedCount > 0 && `, ${failedCount} failed`} — validation has been rerun.
                  {failedCount > 0 && (
                    <ul className="mt-1 list-disc list-inside">
                      {results.filter((r) => !r.applied).map((r) => (
                        <li key={r.expressId}>#{r.expressId}: {r.error}</li>
                      ))}
                    </ul>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            onClick={() => { void handleApply(); }}
            disabled={!activeRequirement || !dataStore || applying || rawValue.trim().length === 0 || effectiveSelection.size === 0}
          >
            {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wrench className="h-4 w-4 mr-2" />}
            Apply to {effectiveSelection.size} {effectiveSelection.size === 1 ? 'entity' : 'entities'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
