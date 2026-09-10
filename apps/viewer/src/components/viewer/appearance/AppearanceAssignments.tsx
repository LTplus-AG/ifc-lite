/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AppearanceMembershipChanges } from './AppearanceMembershipChanges.js';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { AppearanceAssignmentList } from './AppearanceAssignmentList.js';
import type { useAppearanceAssignments } from './useAppearanceAssignments.js';
import type { AppearancePanelViewProps } from './types.js';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';

type Controller = ReturnType<typeof useAppearanceAssignments>;
function queryLabel(row: AppearanceAssignment): string {
  const query = row.query;
  return query.kind === 'model' ? 'Whole model' : query.kind === 'selection' ? 'Selected objects'
    : query.kind === 'class' ? query.ifcClass : query.kind === 'filter' ? `Filter: ${query.query.name}` : `IFC type ${query.GlobalId}`;
}
function ReviewBinding({ row, controller, base }: { row: AppearanceAssignment; controller: Controller; base: AppearancePanelViewProps }) {
  const { modelId, sourceId } = controller.binding(row);
  return <div className="space-y-2 rounded border p-2 text-xs">
    <p className="font-medium">{row.model.name} · {queryLabel(row)}</p>
    <p className="text-[11px] text-muted-foreground">Bind this saved scope to a loaded model and its original image.</p>
    <label className="block">Loaded model<select className="mt-1 w-full rounded border bg-background p-1" value={modelId}
      disabled={controller.busy} onChange={event => controller.setBinding(row.id, { modelId: event.currentTarget.value })}>
      <option value="">Choose loaded model</option>
      {!base.models.some(model => model.id === modelId) && modelId && <option value={modelId} disabled>Unavailable: {row.model.name}</option>}
      {base.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    <label className="block">Original source<select className="mt-1 w-full rounded border bg-background p-1" value={sourceId}
      disabled={controller.busy} onChange={event => controller.setBinding(row.id, { sourceId: event.currentTarget.value })}>
      <option value="">Choose original source</option>
      {!base.sources.some(source => source.id === sourceId) && sourceId && <option value={sourceId} disabled>Unavailable: {row.source.name}</option>}
      {base.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
    </select></label>
    <Button size="sm" variant="outline" disabled={controller.busy || !controller.canReview(row.id)} onClick={() => controller.reviewRow(row.id)}>Review current scope</Button>
  </div>;
}
export function AppearanceAssignments({ controller: c, base, formValid = true }: { controller: Controller; base: AppearancePanelViewProps; formValid?: boolean }) {
  const objectName = (modelId: string, expressId: number) => useViewerStore.getState().models.get(modelId)?.ifcDataStore?.entities.getName(expressId) || `IFC object #${expressId}`;
  return <section className="space-y-3 border-t pt-3" aria-label="Appearance assignments">
    <div><h3 className="text-xs font-semibold">Several scopes together</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">Capture the image, mapping and scope above. Later assignments win where objects overlap.</p></div>
    <Button variant="outline" size="sm" className="w-full" disabled={!formValid || c.busy || base.sourceBusy || !!base.unavailableReason || !base.modelId || !base.sourceId}
      onClick={c.add}>Add this scope</Button>
    {!formValid && <p className="text-[11px] text-destructive">Finish editing the highlighted fields before adding this scope.</p>}
    {!!c.rows.length && <>
      <AppearanceAssignmentList rows={c.resolved} disabled={c.busy} objectName={objectName}
        onMove={c.move} onRemove={c.remove} onExclude={(id, GlobalId, excluded) => c.change(id, row => ({ ...row,
          excludedGlobalIds: excluded ? [...row.excludedGlobalIds, GlobalId] : row.excludedGlobalIds.filter(guid => guid !== GlobalId) }))} />
      {c.rows.map(row => c.bound(row.id) ? <p key={row.id} className="text-[11px] text-muted-foreground">{row.model.name} · {queryLabel(row)} · Scope reviewed{row.settings.representationPolicy === 'evaluatedOccurrence' ? ' · Mapped conversion enabled' : ''}</p>
        : <ReviewBinding key={row.id} row={row} controller={c} base={base} />)}
      {c.review && <div role="region" aria-label="Membership review" className="space-y-2 rounded border bg-muted/30 p-2 text-xs">
        {c.review.map(item => <div key={item.proposed.assignment.id}>
          <p>{item.proposed.assignment.model.name} · {queryLabel(item.proposed.assignment)}</p>
          <p>{item.changes.added.length} added · {item.changes.removed.length} removed · {item.changes.renumbered.length} renumbered</p>
          <AppearanceMembershipChanges review={item} />
          {item.sourceModelChanged && <p>The model file differs from the saved source.</p>}
          {!!item.removedExclusions.length && <p>{item.removedExclusions.length} excluded objects no longer exist in this scope.</p>}
        </div>)}
        <Button size="sm" disabled={c.busy} onClick={c.acceptReview}>Accept reviewed scope</Button>
      </div>}
      <Button className="w-full" size="sm" variant="outline" disabled={c.busy || !!c.blockedReason || c.rows.some(row => !c.bound(row.id))}
        onClick={c.previewAll}>Preview all assignments</Button>
    </>}
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={c.busy || !c.rows.length} onClick={c.download}>Save recipe</Button>
      <label className="cursor-pointer text-xs underline">Restore recipe<input aria-label="Restore assignment recipe" type="file" accept="application/json,.json"
        className="sr-only" disabled={c.busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) c.restore(file); event.currentTarget.value = ''; }} /></label>
    </div>
    {!c.rows.length && <p role={c.status === 'error' ? 'alert' : 'status'} className="text-[11px] text-muted-foreground">{c.notice}</p>}
  </section>;
}
