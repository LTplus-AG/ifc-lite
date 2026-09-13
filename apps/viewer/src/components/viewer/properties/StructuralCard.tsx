/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StructuralCard — surface `extractStructuralOnDemand`'s read model in the
 * Inspector when the selected entity is itself an `IfcStructuralMember`
 * subtype (curve or surface). Mirrors `ScheduleCard`'s shape: a self-contained
 * card that renders nothing when there is nothing to show, so it is safe to
 * mount unconditionally next to the other property cards.
 *
 * Scope, per #4206 layer "properties card": list the member's analysis
 * model(s), the connections it is joined to (with their boundary condition,
 * when the file carries one), and the loads applied to it via its activities.
 * Nothing here edits structural data — this is a read surface, matching
 * layer 3 (`bim.structural`), which is read-only too.
 */

import { useMemo } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Boxes, Anchor, ArrowDownToLine, TriangleAlert } from 'lucide-react';
import type {
  StructuralExtraction,
  StructuralMemberInfo,
  StructuralConnectionInfo,
  StructuralActivityInfo,
  StructuralLoadInfo,
} from '@ifc-lite/parser';

interface StructuralCardProps {
  /** Structural read model for the current model (or null if none/unextracted). */
  structuralData: StructuralExtraction | null;
  /** Selected entity's local express ID. */
  selectedExpressId: number | null;
  /** Selected entity's globalId (federation-safe match, preferred over expressId). */
  selectedGlobalId?: string | null;
}

export function StructuralCard({
  structuralData,
  selectedExpressId,
  selectedGlobalId,
}: StructuralCardProps) {
  const member = useMemo(
    () => findMember(structuralData, selectedExpressId, selectedGlobalId),
    [structuralData, selectedExpressId, selectedGlobalId],
  );

  const analysisModelNames = useMemo(() => {
    const map = new Map<string, string>();
    if (!structuralData) return map;
    for (const m of structuralData.analysisModels) {
      if (m.globalId && m.name) map.set(m.globalId, m.name);
    }
    return map;
  }, [structuralData]);

  const connections = useMemo(() => {
    if (!member || !structuralData) return [];
    const byId = new Map(structuralData.connections.map((c) => [c.globalId, c]));
    return member.connectionGlobalIds
      .map((id) => byId.get(id))
      .filter((c): c is StructuralConnectionInfo => Boolean(c));
  }, [member, structuralData]);

  const activities = useMemo(() => {
    if (!member || !structuralData) return [];
    const byId = new Map(structuralData.activities.map((a) => [a.globalId, a]));
    return member.activityGlobalIds
      .map((id) => byId.get(id))
      .filter((a): a is StructuralActivityInfo => Boolean(a));
  }, [member, structuralData]);

  if (!member) return null;

  const modelLabels = member.analysisModelGlobalIds
    .map((id) => analysisModelNames.get(id))
    .filter((s): s is string => Boolean(s));

  return (
    <Collapsible
      defaultOpen
      className="border-2 border-violet-200 dark:border-violet-800 bg-violet-50/20 dark:bg-violet-950/20 w-full max-w-full overflow-hidden"
    >
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-violet-50 dark:hover:bg-violet-900/30 text-left transition-colors overflow-hidden">
        <Boxes className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400 shrink-0" />
        <span className="font-bold text-xs text-violet-700 dark:text-violet-400 truncate flex-1 min-w-0">
          Structural Analysis
        </span>
        {structuralData?.loadsTruncated && (
          <span
            className="flex items-center gap-1 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 shrink-0"
            title="One or more applied loads were bounded during extraction — this member may carry more load data than shown"
          >
            <TriangleAlert className="h-2.5 w-2.5" aria-hidden />
            Truncated
          </span>
        )}
        <span className="text-[10px] font-mono bg-violet-100 dark:bg-violet-900/50 px-1.5 py-0.5 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 shrink-0">
          {member.type.replace(/^Ifc/, '')}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-violet-200 dark:border-violet-800 divide-y divide-violet-100 dark:divide-violet-900/30">
          <div className="px-3 py-2 text-xs">
            <div className="grid grid-cols-[minmax(70px,auto)_1fr] gap-x-2 gap-y-0.5 text-[11px]">
              {member.predefinedType && (
                <>
                  <span className="text-muted-foreground">Predefined</span>
                  <span className="font-mono text-foreground/90">{member.predefinedType}</span>
                </>
              )}
              {member.thickness !== undefined && (
                <>
                  <span className="text-muted-foreground">Thickness</span>
                  <span className="font-mono text-foreground/90">{member.thickness}</span>
                </>
              )}
              {modelLabels.length > 0 && (
                <>
                  <span className="text-muted-foreground">Model</span>
                  <span className="text-foreground/90 truncate" title={modelLabels.join(', ')}>
                    {modelLabels.join(', ')}
                  </span>
                </>
              )}
            </div>
          </div>

          {connections.length > 0 && (
            <div className="px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 mb-1.5 text-violet-700 dark:text-violet-400">
                <Anchor className="h-3 w-3 shrink-0" />
                <span className="font-semibold text-[11px]">
                  Connections ({connections.length})
                </span>
              </div>
              <div className="space-y-1.5 ml-1">
                {connections.map((c) => (
                  <ConnectionRow key={c.globalId} connection={c} />
                ))}
              </div>
            </div>
          )}

          {activities.length > 0 && (
            <div className="px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 mb-1.5 text-violet-700 dark:text-violet-400">
                <ArrowDownToLine className="h-3 w-3 shrink-0" />
                <span className="font-semibold text-[11px]">
                  Applied loads ({activities.length})
                </span>
              </div>
              <div className="space-y-1.5 ml-1">
                {activities.map((a) => (
                  <ActivityRow key={a.globalId} activity={a} />
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConnectionRow({ connection }: { connection: StructuralConnectionInfo }) {
  const condition = connection.appliedCondition;
  return (
    <div className="text-[11px]">
      <div className="font-medium text-foreground/90 truncate" title={connection.name}>
        {connection.name || connection.type.replace(/^Ifc/, '')}
      </div>
      {condition && (
        <div className="text-muted-foreground ml-2 truncate" title={formatDofs(condition.components)}>
          {condition.name ? `${condition.name} — ` : ''}
          {formatDofs(condition.components)}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ activity }: { activity: StructuralActivityInfo }) {
  const load = activity.appliedLoad;
  return (
    <div className="text-[11px]">
      <div className="font-medium text-foreground/90 truncate" title={activity.name}>
        {activity.name || activity.type.replace(/^Ifc/, '')}
        {activity.predefinedType && (
          <span className="text-muted-foreground font-normal"> · {activity.predefinedType}</span>
        )}
      </div>
      {load && (
        <div className="text-muted-foreground ml-2">
          {formatLoad(load)}
        </div>
      )}
    </div>
  );
}

/** Render a load's own components, or — for a configuration — every entry's. */
function formatLoad(load: StructuralLoadInfo): string {
  if (load.configuration) {
    const parts = load.configuration.entries.map((entry) => {
      if (!entry.value) return `[dropped: ${entry.dropped}]`;
      const at = entry.location ? ` @ ${entry.location.join(',')}` : '';
      return `${formatComponents(entry.value.components)}${at}`;
    });
    return parts.join('; ');
  }
  return formatComponents(load.components);
}

function formatComponents(components: Record<string, number>): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return '(no components)';
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
}

/** Summarize the boolean and stiffness-select branches per degree of freedom. */
function formatDofs(components: Record<string, number | boolean>): string {
  const entries = Object.entries(components);
  if (entries.length === 0) return '(no DOFs)';
  const fixed = entries.filter(([, value]) => value === true).length;
  const free = entries.filter(([, value]) => value === false).length;
  const elastic = entries.length - fixed - free;
  const label = (count: number, kind: string) => `${count} ${count === 1 ? 'DOF' : 'DOFs'} ${kind}`;
  return [
    fixed > 0 ? label(fixed, 'fixed') : null,
    elastic > 0 ? label(elastic, 'elastic') : null,
    free > 0 ? label(free, 'free') : null,
  ].filter((part): part is string => part !== null).join(', ');
}

/**
 * Find the structural member matching the current selection.
 *
 * Federation-aware, matching `ScheduleCard`'s convention: prefer globalId
 * whenever the extraction and the selection both carry one — local
 * expressIds can collide across federated models. Fall back to expressId
 * only when no globalId match is possible.
 */
function findMember(
  data: StructuralExtraction | null,
  selectedExpressId: number | null,
  selectedGlobalId: string | null | undefined,
): StructuralMemberInfo | null {
  if (!data || data.members.length === 0) return null;
  if (selectedGlobalId) {
    const byGlobalId = data.members.find((m) => m.globalId === selectedGlobalId);
    if (byGlobalId) return byGlobalId;
  }
  if (selectedExpressId !== null && selectedExpressId > 0) {
    return data.members.find((m) => m.expressId === selectedExpressId) ?? null;
  }
  return null;
}
