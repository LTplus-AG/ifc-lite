/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merge section of the Layers panel (#1717 V3, 08-review.md §8.3): pick a
 * published candidate and a target ref, preview the three-way plan, work
 * the conflict queue (ours/theirs per conflict; subtree deletes carry
 * their descendants as ONE decision), and execute once the queue is
 * empty. Local refs merge in-process; registry refs merge on the server
 * where policies and approvals are enforced.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import type { MergeConflict, ResolutionInput, Waiver } from '@ifc-lite/merge';
import { getBrowserLayerStore, DEFAULT_LOCAL_REF } from '@/lib/layers/browser-store';
import { LayerRegistryClient } from '@/lib/layers/registry-client';
import {
  candidateLabel,
  editedWithRemovals,
  executeMergeInto,
  previewMergeInto,
  refStackFiles,
  requiredCheckStatus,
  type MergeTarget,
  type RequiredCheckStatus,
  type ViewerMergeResult,
} from '@/lib/layers/merge';
import { pathTail } from '@/lib/layers/stack';
import { CheckCircle2, XCircle } from 'lucide-react';

type Choice = 'ours' | 'theirs' | 'edited';

function conflictKey(c: MergeConflict): string {
  return c.componentKey === undefined ? c.path : `${c.path}::${c.componentKey}`;
}

/** Edit-in-place applies as a set-component: only componentKey-scoped,
 *  non-relation conflicts can take one (mirrors `applyResolutions`). */
function isEditable(c: MergeConflict): boolean {
  return (
    c.componentKey !== undefined &&
    !c.componentKey.startsWith('child:') &&
    !c.componentKey.startsWith('inherit:')
  );
}

/** Parsed replacement attributes for an edited conflict, or undefined
 *  while the JSON is not (yet) a plain object. */
function parseEditedAttributes(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function valueSummary(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return 'removed';
  const json = JSON.stringify(attrs);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

function ConflictRow({
  conflict,
  choice,
  onChoose,
  editedText,
  onEditText,
}: {
  conflict: MergeConflict;
  choice: Choice | undefined;
  onChoose: (choice: Choice) => void;
  editedText: string;
  onEditText: (text: string) => void;
}) {
  const isDelete = conflict.kind === 'modify-vs-delete' || conflict.kind === 'delete-vs-modify';
  const options: Choice[] = isEditable(conflict) ? ['ours', 'theirs', 'edited'] : ['ours', 'theirs'];
  const editedValid = choice !== 'edited' || parseEditedAttributes(editedText) !== undefined;
  return (
    <div className="rounded border bg-card/40 px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[11px] font-medium" title={conflict.path}>
          {pathTail(conflict.path)}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {conflict.componentKey ?? conflict.kind}
        </span>
        <span className="ml-auto inline-flex overflow-hidden rounded border">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChoose(option)}
              className={`px-1.5 py-px text-[10px] font-medium transition-colors ${
                choice === option ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
            >
              {option === 'edited' ? 'edit' : option}
            </button>
          ))}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 pt-0.5 text-[10px] text-muted-foreground">
        <span className="truncate" title={valueSummary(conflict.ours?.attributes as Record<string, unknown>)}>
          ours: {valueSummary(conflict.ours?.attributes as Record<string, unknown>)}
        </span>
        <span className="truncate" title={valueSummary(conflict.theirs?.attributes as Record<string, unknown>)}>
          theirs: {valueSummary(conflict.theirs?.attributes as Record<string, unknown>)}
        </span>
      </div>
      {choice === 'edited' && (
        <div className="flex flex-col gap-0.5 pt-0.5">
          <textarea
            value={editedText}
            onChange={(e) => onEditText(e.target.value)}
            rows={2}
            spellCheck={false}
            aria-label={`Replacement attributes for ${conflict.path}`}
            className={`w-full resize-y rounded border bg-background px-1.5 py-1 font-mono text-[10px] ${
              editedValid ? '' : 'border-red-500'
            }`}
          />
          {!editedValid && (
            <span className="text-[10px] text-red-500">Replacement must be a JSON object of attributes.</span>
          )}
        </div>
      )}
      {isDelete && conflict.subtree && conflict.subtree.length > 0 && (
        <p className="pt-0.5 text-[10px] text-amber-600 dark:text-amber-300">
          Delete decision carries {conflict.subtree.length} touched descendant
          {conflict.subtree.length === 1 ? '' : 's'}: {conflict.subtree.map(pathTail).join(', ')}
        </p>
      )}
    </div>
  );
}

export function LayerMergeSection() {
  const { loadFederatedIfcx } = useIfc();
  const layerStack = useViewerStore((s) => s.layerStack);
  // Authenticated deployments guard /api/v1 with the same bearer token as
  // the websocket; an unbound client would 401 on every registry call.
  const collabToken = useViewerStore((s) => s.collabSelfToken);

  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);
  const [localRefs, setLocalRefs] = useState<string[]>([]);
  const [registryRefs, setRegistryRefs] = useState<string[]>([]);
  const [candidateId, setCandidateId] = useState<string>('');
  const [targetKey, setTargetKey] = useState<string>(`local:${DEFAULT_LOCAL_REF}`);
  const [result, setResult] = useState<ViewerMergeResult | null>(null);
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [editedTexts, setEditedTexts] = useState<Map<string, string>>(new Map());
  const [requiredChecks, setRequiredChecks] = useState<RequiredCheckStatus[]>([]);
  const [waiverReasons, setWaiverReasons] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  const registryClient = useMemo(() => LayerRegistryClient.fromCollabConfig(collabToken ?? undefined), [collabToken]);

  const refresh = useCallback(async () => {
    const store = await getBrowserLayerStore();
    const refs = Object.keys(store.listRefs());
    setLocalRefs(refs.length > 0 ? refs : [DEFAULT_LOCAL_REF]);
    setCandidates(store.listLayers().map((id) => ({ id, label: candidateLabel(store, id) })));
    if (registryClient) {
      try {
        const remote = await registryClient.listRefs();
        setRegistryRefs(Object.keys(remote.refs));
      } catch {
        setRegistryRefs([]);
      }
    }
  }, [registryClient]);

  useEffect(() => {
    void refresh();
  }, [refresh, layerStack]);

  // A previewed plan is only valid for the (candidate, target) it was
  // computed for — a stale conflicts+choices pair against a new pair
  // would silently auto-resolve conflicts the user never reviewed.
  useEffect(() => {
    setResult(null);
    setChoices(new Map());
    setEditedTexts(new Map());
    setRequiredChecks([]);
    setWaiverReasons(new Map());
  }, [candidateId, targetKey]);

  const target = useMemo<MergeTarget | null>(() => {
    // Ref names may themselves contain ':' — slice on the FIRST separator
    // only, never split (a ref like 'release:2026' must stay intact).
    const sep = targetKey.indexOf(':');
    if (sep < 0) return null;
    const kind = targetKey.slice(0, sep);
    const refName = targetKey.slice(sep + 1);
    if (refName.length === 0) return null;
    if (kind === 'local') return { kind: 'local', refName };
    if (kind === 'registry' && registryClient) return { kind: 'registry', refName, client: registryClient };
    return null;
  }, [targetKey, registryClient]);

  const preview = useCallback(async () => {
    if (!target || !candidateId) return;
    setBusy(true);
    setChoices(new Map());
    setEditedTexts(new Map());
    try {
      const store = await getBrowserLayerStore();
      setResult(await previewMergeInto(target, store, candidateId));
      setRequiredChecks(await requiredCheckStatus(target, store, candidateId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, candidateId]);

  const execute = useCallback(async () => {
    if (!target || !candidateId || !result) return;
    setBusy(true);
    try {
      const store = await getBrowserLayerStore();
      const resolutions: ResolutionInput[] = result.conflicts.map((conflict) => {
        const choice = choices.get(conflictKey(conflict)) as Choice;
        return {
          path: conflict.path,
          ...(conflict.componentKey !== undefined ? { componentKey: conflict.componentKey } : {}),
          choice,
          ...(choice === 'edited'
            ? {
                attributes: editedWithRemovals(
                  conflict,
                  parseEditedAttributes(editedTexts.get(conflictKey(conflict)) ?? '') ?? {},
                ),
              }
            : {}),
        };
      });
      const resolver =
        (typeof window !== 'undefined' && window.localStorage.getItem('ifc-lite:layer-author')) || 'viewer-user';
      // A waiver without a reason is not a waiver (08-review.md §8.4: waiving
      // requires a reason, recorded in the merge manifest).
      const waivers: Waiver[] = [...waiverReasons.entries()]
        .filter(([, reason]) => reason.trim().length > 0)
        .map(([spec, reason]) => ({ spec, reason: reason.trim() }));
      const outcome = await executeMergeInto(target, store, candidateId, resolutions, resolver, waivers);
      setResult(outcome);
      if (outcome.status === 'merged' || outcome.status === 'fast-forward') {
        toast.success(
          outcome.status === 'merged'
            ? `Merged into '${target.refName}' (${outcome.mergeLayerId?.slice(0, 15)}…).`
            : `Fast-forwarded '${target.refName}'.`,
        );
        await refresh();
      } else if (outcome.status === 'policy-failure') {
        toast.error(`Policy: ${outcome.reason}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, candidateId, result, choices, editedTexts, waiverReasons, refresh]);

  const loadMergedRef = useCallback(async () => {
    if (!target || target.kind !== 'local') return;
    setBusy(true);
    try {
      const store = await getBrowserLayerStore();
      const files = refStackFiles(store, target.refName).map(
        (file, i) => new File([JSON.stringify(file)], `${target.refName}-${i}.ifcx`, { type: 'application/json' }),
      );
      await loadFederatedIfcx(files);
      toast.success(`Loaded ref '${target.refName}' (${files.length} layers).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, loadFederatedIfcx]);

  if (candidates.length === 0) return null;

  // Every conflict needs a decision, and an edit-in-place needs valid
  // replacement attributes before the merge can execute.
  const allResolved =
    result !== null &&
    result.conflicts.every((c) => {
      const choice = choices.get(conflictKey(c));
      if (choice === undefined) return false;
      if (choice !== 'edited') return true;
      return parseEditedAttributes(editedTexts.get(conflictKey(c)) ?? '') !== undefined;
    });

  const choose = (conflict: MergeConflict, choice: Choice) => {
    const key = conflictKey(conflict);
    setChoices((prev) => new Map(prev).set(key, choice));
    if (choice === 'edited') {
      // Seed the editor with the current winner so edits start from a
      // real value instead of an empty object.
      setEditedTexts((prev) => {
        if (prev.has(key)) return prev;
        const seed = (conflict.ours?.attributes ?? conflict.theirs?.attributes ?? {}) as Record<string, unknown>;
        return new Map(prev).set(key, JSON.stringify(seed));
      });
    }
  };

  const chooseAll = (choice: 'ours' | 'theirs', filter?: (c: MergeConflict) => boolean) => {
    if (!result) return;
    setChoices((prev) => {
      const next = new Map(prev);
      for (const conflict of result.conflicts) {
        if (filter && !filter(conflict)) continue;
        next.set(conflictKey(conflict), choice);
      }
      return next;
    });
  };

  // Bulk selectors (08-review.md §8.3, "theirs for all Pset_X"): offer a
  // per-componentKey group action when several conflicts share a key.
  const bulkGroups =
    result === null
      ? []
      : [...result.conflicts.reduce((acc, c) => {
          if (c.componentKey === undefined) return acc;
          acc.set(c.componentKey, (acc.get(c.componentKey) ?? 0) + 1);
          return acc;
        }, new Map<string, number>())].filter(([, count]) => count > 1);
  // Spec 08-review.md §8.3: merge enables on empty queue + green checks;
  // a failing required check needs a waiver reason (§8.4) to proceed.
  const checksSatisfied = requiredChecks.every(
    (check) => check.passing || (waiverReasons.get(check.spec) ?? '').trim().length > 0,
  );
  const mergeDone = result?.status === 'merged' || result?.status === 'fast-forward';

  return (
    <div className="rounded-md border border-dashed bg-card/30 p-2">
      <div className="flex items-center gap-1.5 pb-1.5 text-[11px] font-medium">
        <GitMerge className="size-3" aria-hidden />
        <span>Merge</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1"
          onClick={() => void refresh()}
          aria-label="Refresh refs and candidates"
        >
          <RefreshCw className="size-3" aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Select value={candidateId} onValueChange={setCandidateId}>
          <SelectTrigger className="h-7 text-xs" aria-label="Candidate layer">
            <SelectValue placeholder="Candidate layer" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Select value={targetKey} onValueChange={setTargetKey}>
            <SelectTrigger className="h-7 flex-1 text-xs" aria-label="Target ref">
              <SelectValue placeholder="Target ref" />
            </SelectTrigger>
            <SelectContent>
              {localRefs.map((name) => (
                <SelectItem key={`local:${name}`} value={`local:${name}`} className="text-xs">
                  {name} (local)
                </SelectItem>
              ))}
              {registryRefs.map((name) => (
                <SelectItem key={`registry:${name}`} value={`registry:${name}`} className="text-xs">
                  {name} (registry)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={busy || !candidateId || !target}
            onClick={() => void preview()}
          >
            Preview
          </Button>
        </div>

        {result && (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] text-muted-foreground">
              {result.status === 'preview' &&
                `${result.stats?.autoMerged ?? 0} auto-merged, ${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'}.`}
              {result.status === 'conflicts' && `${result.conflicts.length} unresolved conflict${result.conflicts.length === 1 ? '' : 's'}.`}
              {result.status === 'fast-forward' && 'Fast-forwarded.'}
              {result.status === 'merged' && `Merged as ${result.mergeLayerId?.slice(0, 15)}…`}
              {result.status === 'policy-failure' && `Blocked by ref policy: ${result.reason}`}
              {result.status === 'unrelated-base' && `Unrelated base: ${result.reason}`}
            </p>
            {requiredChecks.length > 0 && !mergeDone && (
              <div className="flex flex-col gap-0.5 rounded border bg-card/40 px-1.5 py-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Required checks
                </span>
                {requiredChecks.map((check) => (
                  <div key={check.spec} className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1 text-[11px]">
                      {check.passing ? (
                        <CheckCircle2 className="size-3 shrink-0 text-emerald-500" aria-label="pass" />
                      ) : (
                        <XCircle className="size-3 shrink-0 text-red-500" aria-label="fail" />
                      )}
                      <span className="truncate">{check.spec}</span>
                    </span>
                    {!check.passing && (
                      <input
                        type="text"
                        value={waiverReasons.get(check.spec) ?? ''}
                        onChange={(e) =>
                          setWaiverReasons((prev) => new Map(prev).set(check.spec, e.target.value))
                        }
                        placeholder="Waive with a reason (recorded in the merge manifest)"
                        aria-label={`Waiver reason for ${check.spec}`}
                        className="h-6 rounded border bg-background px-1.5 text-[11px] placeholder:text-muted-foreground/60"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {!mergeDone && result.conflicts.length > 1 && (
              <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                <span>Bulk:</span>
                <button type="button" onClick={() => chooseAll('ours')} className="rounded border px-1.5 py-px hover:bg-muted/60">
                  all ours
                </button>
                <button type="button" onClick={() => chooseAll('theirs')} className="rounded border px-1.5 py-px hover:bg-muted/60">
                  all theirs
                </button>
                {bulkGroups.map(([key, count]) => (
                  <span key={key} className="inline-flex items-center gap-0.5">
                    <span className="truncate font-mono" title={key}>{key.split(':').pop()}</span>
                    <span>×{count}:</span>
                    <button
                      type="button"
                      onClick={() => chooseAll('ours', (c) => c.componentKey === key)}
                      className="rounded border px-1 py-px hover:bg-muted/60"
                    >
                      ours
                    </button>
                    <button
                      type="button"
                      onClick={() => chooseAll('theirs', (c) => c.componentKey === key)}
                      className="rounded border px-1 py-px hover:bg-muted/60"
                    >
                      theirs
                    </button>
                  </span>
                ))}
              </div>
            )}
            {result.conflicts.map((conflict) => (
              <ConflictRow
                key={conflictKey(conflict)}
                conflict={conflict}
                choice={choices.get(conflictKey(conflict))}
                onChoose={(choice) => choose(conflict, choice)}
                editedText={editedTexts.get(conflictKey(conflict)) ?? ''}
                onEditText={(text) =>
                  setEditedTexts((prev) => new Map(prev).set(conflictKey(conflict), text))
                }
              />
            ))}
            {!mergeDone && (result.status === 'preview' || result.status === 'conflicts') && (
              <Button
                size="sm"
                className="h-7 gap-1 self-end px-2 text-[11px]"
                disabled={busy || !allResolved || !checksSatisfied}
                onClick={() => void execute()}
              >
                <GitMerge className="size-3" aria-hidden />
                {result.conflicts.length > 0 ? 'Merge with resolutions' : 'Merge'}
              </Button>
            )}
            {mergeDone && target?.kind === 'local' && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 self-end px-2 text-[11px]"
                disabled={busy}
                onClick={() => void loadMergedRef()}
              >
                Load merged ref
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
