/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ReassignClassDialog` and `ReassignBadge`, extracted out of
 * `PropertyEditor.tsx` (#5812) so that file does not grow past its size
 * while `ReassignClassDialog`'s fields gain real labels: `Field` wraps both
 * the predefined-type `Select` (labelled via `FieldContext`, see
 * `ui/select.tsx`) and `ComboInput` (a plain `<input>` under the hood, so
 * `Field` labels it the same way it does `Input`/`Textarea`, by cloning
 * `id`/`aria-*` directly onto it).
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Check, Replace, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ComboInput } from '@/components/ui/combo-input';
import { cn } from '@/lib/utils';
import {
  resolveReassignSchema,
  getReassignTargets,
  getPredefinedTypes,
  isKnownReassignTarget,
  COMMON_REASSIGN_TARGETS,
} from '@/lib/ifc-class-reassign';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

// The structural "Reassign class" action is elevated as a distinct accent
// affordance — it transforms the element rather than adding data to it.
const RECLASS_TOOL_CLS =
  'h-7 min-w-0 gap-1.5 rounded-md px-2.5 text-2xs font-semibold text-sky-700 ring-1 ring-inset ring-sky-300/70 bg-sky-500/10 shadow-none transition-colors hover:bg-sky-500/20 hover:text-sky-800 dark:text-sky-300 dark:ring-sky-700/60 dark:bg-sky-500/10 dark:hover:text-sky-200';

interface ReassignClassDialogProps {
  modelId: string;
  entityId: number;
  /** The element's current IFC class, e.g. "IfcBuildingElementProxy". */
  entityType: string;
  schemaVersion?: string;
}

/**
 * Reassign an entity's IFC class in place ("retype"): expressId is
 * unchanged, so geometry/placement/representation and every IfcRel*
 * reference carry over; the new class materializes on STEP export. Mirrors
 * IfcOpenShell's `reassign_class`. Best for building-element subtypes
 * (Proxy ↔ Column/Beam/Member/Plate/Wall) sharing the IfcElement layout.
 */
export function ReassignClassDialog({ modelId, entityId, entityType, schemaVersion }: ReassignClassDialogProps) {
  const { t } = useTranslation();
  const setEntityType = useViewerStore((s) => s.setEntityType);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [predefinedType, setPredefinedType] = useState('');

  const schema = useMemo(() => resolveReassignSchema(schemaVersion), [schemaVersion]);
  const targets = useMemo(() => getReassignTargets(schema), [schema]);
  const predefinedOptions = useMemo(
    () => (target.trim() ? getPredefinedTypes(schema, target.trim()) : []),
    [schema, target],
  );
  const quickTargets = useMemo(
    () => COMMON_REASSIGN_TARGETS.filter((t) => t.toUpperCase() !== entityType.toUpperCase()),
    [entityType],
  );

  const trimmedTarget = target.trim();
  const targetChanged = trimmedTarget.length > 0 && trimmedTarget.toUpperCase() !== entityType.toUpperCase();
  const knownTarget = trimmedTarget.length > 0 && isKnownReassignTarget(schema, trimmedTarget);
  const validKeyword = /^[Ii][Ff][Cc][A-Za-z][A-Za-z0-9_]*$/.test(trimmedTarget);
  // Allow apply when the class changes, or when only setting a predefined type
  // on the same class (the retype API carries that too).
  const canApply = validKeyword && (targetChanged || (trimmedTarget.length > 0 && predefinedType.length > 0));

  const reset = useCallback(() => { setTarget(''); setPredefinedType(''); }, []);

  // Drop a predefined type that the newly-chosen class doesn't define.
  useEffect(() => {
    if (predefinedType && !predefinedOptions.includes(predefinedType)) setPredefinedType('');
  }, [predefinedOptions, predefinedType]);

  const handleApply = useCallback(() => {
    if (!canApply) return;
    let normalizedModelId = modelId;
    if (modelId === 'legacy') normalizedModelId = '__legacy__';
    setEntityType(normalizedModelId, entityId, trimmedTarget, predefinedType || null);
    bumpMutationVersion();
    reset();
    setOpen(false);
  }, [canApply, modelId, entityId, trimmedTarget, predefinedType, setEntityType, bumpMutationVersion, reset]);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title={t('propertyEditor.reassign.trigger')} className={RECLASS_TOOL_CLS}>
          <Replace className="h-3.5 w-3.5 shrink-0" />
          <span>{t('propertyEditor.reassign.action')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Replace className="h-4 w-4" />
            {t('propertyEditor.reassign.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.reassign.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* current → target */}
          <div className="flex items-center gap-2 rounded-md border border-sky-200/70 bg-sky-50/40 px-3 py-2.5 dark:border-sky-900/60 dark:bg-sky-950/20">
            <code className="flex-1 truncate font-mono text-2xs text-zinc-500 dark:text-zinc-400" title={entityType}>{entityType}</code>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-sky-400" />
            <code
              className={cn(
                'flex-1 truncate text-right font-mono text-2xs font-medium',
                targetChanged ? 'text-sky-600 dark:text-sky-300' : 'text-zinc-400 dark:text-zinc-600',
              )}
              title={trimmedTarget || undefined}
            >
              {trimmedTarget || '—'}
            </code>
          </div>

          {/* quick picks */}
          {quickTargets.length > 0 && (
            <div className="space-y-1.5">
              <span className="block text-2xs font-medium uppercase tracking-wide text-zinc-400">{t('propertyEditor.reassign.common')}</span>
              <div className="flex flex-wrap gap-1.5">
                {quickTargets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTarget(t)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-2xs transition-colors',
                      trimmedTarget === t
                        ? 'border-sky-400 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        : 'border-zinc-200 text-zinc-600 hover:border-sky-300 hover:bg-sky-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-sky-950/30',
                    )}
                  >
                    {t.replace(/^Ifc/, '')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* searchable full list */}
          <Field
            label={t('propertyEditor.reassign.targetClass')}
            hint={trimmedTarget.length > 0 && !knownTarget ? t('propertyEditor.reassign.nonStandard', { schema }) : undefined}
          >
            <ComboInput value={target} onChange={setTarget} options={targets} placeholder={t('propertyEditor.reassign.searchPlaceholder')} />
          </Field>

          {/* predefined type */}
          {predefinedOptions.length > 0 && (
            <Field label={t('propertyEditor.reassign.predefinedType')}>
              <Select value={predefinedType || '__none__'} onValueChange={(v) => setPredefinedType(v === '__none__' ? '' : v)}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder={t('propertyEditor.reassign.none')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('propertyEditor.reassign.none')}</SelectItem>
                  {predefinedOptions.map((p) => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <p className="text-2xs leading-relaxed text-zinc-400 dark:text-zinc-500">
            {t('propertyEditor.reassign.help')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { reset(); setOpen(false); }}>{t('propertyEditor.shared.cancel')}</Button>
          <Button size="sm" onClick={handleApply} disabled={!canApply}>
            <Check className="mr-1 h-3.5 w-3.5" /> {t('propertyEditor.reassign.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline chip surfacing a pending reassignment for the selected element. Reads
 * the overlay (re-rendering on `mutationVersion`) so a retype is visible in the
 * panel immediately, before the model is re-exported / reloaded.
 */
export function ReassignBadge({ modelId, entityId, entityType }: { modelId: string; entityId: number; entityType: string }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const pending = useMemo(() => {
    let mid = modelId;
    if (mid === 'legacy') mid = '__legacy__';
    const view = mutationViews.get(mid);
    const m = view?.getEntityTypeMutation?.(entityId) ?? null;
    if (!m) return null;
    // A no-op (same class, no predefined type) isn't worth surfacing.
    if (m.newType.toUpperCase() === entityType.toUpperCase() && !m.predefinedType) return null;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, entityId, entityType, mutationViews, mutationVersion]);

  if (!pending) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-sky-200/70 bg-sky-50/50 px-2 py-1 text-2xs dark:border-sky-900/60 dark:bg-sky-950/25">
      <Replace className="h-3 w-3 shrink-0 text-sky-500" />
      <span className="text-zinc-500 dark:text-zinc-400">{t('propertyEditor.reassign.badge')}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-sky-400" />
      <code className="font-mono font-medium text-sky-600 dark:text-sky-300">{pending.newType}</code>
      {pending.predefinedType && (
        <code className="font-mono text-sky-500/80 dark:text-sky-300/70">· {pending.predefinedType}</code>
      )}
      <span className="ml-auto text-zinc-400 dark:text-zinc-500">{t('propertyEditor.reassign.onExport')}</span>
    </div>
  );
}
