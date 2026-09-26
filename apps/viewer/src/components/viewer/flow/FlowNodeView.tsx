/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One node on the canvas: title, typed handles, a param summary, and the
 * status of the last run. Handle colours follow the value kind so a
 * connection's compatibility is visible before it is attempted.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PortDef } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import type { CanvasNode } from '@/lib/flow/view-model';
import { KIND_COLOR } from '@/lib/flow/view-model';

const STATUS_CLASS: Record<string, string> = {
  ok: 'bg-emerald-500/20 text-emerald-300',
  memo: 'bg-sky-500/20 text-sky-300',
  noop: 'bg-zinc-500/20 text-zinc-300',
  skipped: 'bg-amber-500/20 text-amber-300',
  error: 'bg-red-500/20 text-red-300',
};

function accessMark(p: PortDef): string {
  return p.type.access === 'item' ? '·' : p.type.access === 'list' ? '⋮' : '⊞';
}

function PortRow({ port, side }: { port: PortDef; side: 'in' | 'out' }) {
  const color = KIND_COLOR[port.type.kind];
  return (
    // `py-1`, not `py-0.5`: three adjacent ports (the Script node's a/b/c)
    // were ~15px apart at fit-view zoom, close enough that a dropped
    // connection snapped to the neighbour of the one aimed at.
    <div className={`relative flex items-center gap-1 px-2 py-1 text-2xs leading-4 ${side === 'in' ? 'justify-start' : 'justify-end'}`} title={`${port.type.kind} · ${port.type.access}${port.optional ? ' · optional' : ''}`}>
      <Handle
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        id={port.name}
        style={{ background: color, width: 10, height: 10, border: '1px solid var(--background, #1a1b26)' }}
      />
      {side === 'in' && <span className="text-muted-foreground">{accessMark(port)}</span>}
      <span className={port.optional ? 'text-muted-foreground' : ''}>{port.name}</span>
      {side === 'out' && <span className="text-muted-foreground">{accessMark(port)}</span>}
    </div>
  );
}

function FlowNodeViewInner({ data, selected }: NodeProps<CanvasNode>) {
  const { t } = useTranslation();
  const status = data.status;
  return (
    <div
      className={`min-w-[150px] rounded border bg-card text-card-foreground shadow-sm ${selected ? 'border-[#7aa2f7]' : 'border-border'} ${data.known ? '' : 'border-dashed border-red-400'}`}
      data-flow-node={data.nodeId}
    >
      <div className="flex items-center gap-1 rounded-t border-b border-border bg-muted/40 px-2 py-1 text-2xs font-medium">
        <span className="truncate" title={data.type}>{data.label ?? data.title}</span>
        {data.tracked && <span className="text-2xs text-[#bb9af7]" title={t('flowPanel.inspector.tracking')}>◎</span>}
        {data.isInput && <span className="text-2xs text-[#e0af68]" title={t('flowPanel.inspector.isInput')}>▸</span>}
        {data.isOutput && <span className="text-2xs text-[#9ece6a]" title={t('flowPanel.inspector.isOutput')}>▪</span>}
        <span className="ml-auto" />
        {status && (
          <span className={`rounded px-1 text-2xs ${STATUS_CLASS[status] ?? ''}`} title={data.error}>
            {t(`flowPanel.status.${status}` as const)}{data.lanes !== undefined && data.lanes > 1 ? ` ×${data.lanes}` : ''}
          </span>
        )}
      </div>
      <div className="flex justify-between py-0.5">
        <div className="flex flex-col">{data.inputs.map((p) => <PortRow key={p.name} port={p} side="in" />)}</div>
        <div className="flex flex-col">{data.outputs.map((p) => <PortRow key={p.name} port={p} side="out" />)}</div>
      </div>
      {data.summary && <div className="truncate border-t border-border px-2 py-0.5 text-2xs text-muted-foreground" title={data.summary}>{data.summary}</div>}
    </div>
  );
}

export const FlowNodeView = memo(FlowNodeViewInner);
