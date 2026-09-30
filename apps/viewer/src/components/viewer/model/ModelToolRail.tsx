/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's tool rail (charter #6232, M2 §1.3): a 48 px column
 * on the viewport's left edge, styled like the sidebar's activity bar, with
 * one button per `RAIL_TOOLS` row, grouped menus when the rows do not fit,
 * and Leave in the footer. Rendered only
 * while the workspace is open, and only on desktop (phones reach the same
 * tools through the palette).
 *
 * A tool that cannot start says why in its tooltip: no storey / workplane
 * for the drawing tools, no selection for Split.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
import { shortcutLabel, type KeyCommandId } from '@/lib/commands/shortcut-label';
import { tourAnchor, toolAnchor } from '@/lib/tours/anchors';
import { sessionWorkplaneBlock } from '@/lib/commands/modeling/workspace-storeys';
import { GitBranch, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { LEAVE_TOOL, RAIL_TOOLS, type RailTool } from './rail-tools';
import { effectiveModelLayout, splitFits, useSplitWidth } from './model-layout';
import { CompactRailGroup } from './CompactRailGroup';

const TOOL_GROUPS = [...new Set(RAIL_TOOLS.map((tool) => tool.group))];
const DIVIDERS = RAIL_TOOLS.filter((tool, i) => i > 0 && tool.group !== RAIL_TOOLS[i - 1].group).length;

/** Measure the same buttons, gaps and footer used by the full rail; grouping must not oscillate as rows disappear. */
function useCompactRail(open: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const rail = ref.current;
    if (!open || !rail) return;
    const list = rail.querySelector<HTMLElement>('[data-rail-list]');
    const footer = rail.querySelector<HTMLElement>('[data-rail-footer]');
    if (!list || !footer) return;
    const measure = () => {
      const button = rail.querySelector<HTMLElement>('[data-rail-tool="select"]');
      const divider = rail.querySelector<HTMLElement>('[data-rail-divider]');
      const rowHeight = button?.getBoundingClientRect().height ?? 0;
      const height = rail.getBoundingClientRect().height;
      if (!rowHeight || !height) return;
      const style = getComputedStyle(list);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const lineStyle = divider && getComputedStyle(divider);
      const lineHeight = divider && lineStyle
        ? divider.getBoundingClientRect().height + pixels(lineStyle.marginTop) + pixels(lineStyle.marginBottom) : 0;
      const needed = RAIL_TOOLS.length * rowHeight + DIVIDERS * lineHeight
        + (RAIL_TOOLS.length + DIVIDERS - 1) * pixels(style.rowGap)
        + pixels(style.paddingTop) + pixels(style.paddingBottom) + footer.getBoundingClientRect().height;
      setCompact(height < needed);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [open]);
  return { ref, compact };
}

/** Why the drawing tools are off: no storey, or the builder's refusal. */
function useWorkplaneBlockText(): string | null {
  const { t } = useTranslation();
  const modelId = useViewerStore((s) => s.session?.modelId ?? null);
  const workplane = useViewerStore((s) => s.session?.workplane ?? null);
  const models = useViewerStore((s) => s.models);
  const placement = useViewerStore((s) => s.modelPlacement);
  const block = useMemo(
    () => (modelId ? sessionWorkplaneBlock(useViewerStore.getState()) : null),
    // The inputs `buildStoreyWorkplane` reads: the session's plane, the model, its placement.
    [modelId, workplane, models, placement],
  );
  if (!block) return null;
  return block.kind === 'noStorey' ? t('modelWorkspace.blocked.noStorey') : block.reason;
}

export function ModelToolRail() {
  const { t } = useTranslation();
  const open = useViewerStore((s) => s.workspaceMode === 'model');
  const workplaneBlock = useWorkplaneBlockText();
  // Per row: is it active, and its own reason to be off (flat, so shallow-equal).
  const rows = useViewerStore(useShallow((s) => RAIL_TOOLS.flatMap((tool) => [tool.isActive(s), tool.blockedKey?.(s) ?? null])));
  const { ref, compact } = useCompactRail(open);
  if (!open) return null;

  const tools = RAIL_TOOLS.map((tool, i) => {
    const blockedKey = rows[2 * i + 1] as TranslationKey | null;
    return { tool, active: rows[2 * i] === true,
      reason: tool.drawsOnWorkplane && workplaneBlock ? workplaneBlock : blockedKey ? t(blockedKey) : null };
  });

  let previous: RailTool['group'] | null = null;
  return (
    <nav
      ref={ref}
      data-model-tool-rail
      data-rail-layout={compact ? 'grouped' : 'full'}
      aria-label={t('modelWorkspace.rail.aria')}
      className="relative flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-background"
    >
      <div data-rail-list className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden py-1.5">
        {compact ? TOOL_GROUPS.map((group, i) => (
          <div key={group} className="contents">
            {i > 0 && <span data-rail-divider aria-hidden className="my-1 h-px w-6 shrink-0 bg-border/70" />}
            {group === 'select' ? <RailButton id="select" labelKey={tools[0].tool.labelKey} Icon={tools[0].tool.Icon} shortcut={tools[0].tool.shortcut} active={tools[0].active} disabledReason={tools[0].reason} onClick={tools[0].tool.run} />
              : <CompactRailGroup group={group} tools={tools.filter(({ tool }) => tool.group === group)} />}
          </div>
        )) : tools.map(({ tool, active, reason }) => {
          const divider = previous !== null && tool.group !== previous;
          previous = tool.group;
          return (
            <div key={tool.id} className="contents">
              {divider && <span data-rail-divider aria-hidden className="my-1 h-px w-6 shrink-0 bg-border/70" />}
              <RailButton
                id={tool.id}
                labelKey={tool.labelKey}
                Icon={tool.Icon}
                shortcut={tool.shortcut}
                active={active}
                disabledReason={reason}
                onClick={tool.run}
              />
            </div>
          );
        })}
      </div>
      <div data-rail-footer className="flex w-full shrink-0 flex-col items-center gap-0.5 border-t border-border py-1.5">
        <ChangeSetsButton />
        <PlanToggle />
        <RailButton
          id={LEAVE_TOOL.id}
          labelKey={LEAVE_TOOL.labelKey}
          Icon={LEAVE_TOOL.Icon}
          shortcut={LEAVE_TOOL.shortcut}
          active={false}
          disabledReason={null}
          onClick={LEAVE_TOOL.run}
        />
      </div>
    </nav>
  );
}

/** Show / hide the plan beside 3D (M2.4); off, with the reason, while the split has no room for it. */
function PlanToggle() {
  const { t } = useTranslation();
  const pick = useViewerStore((s) => s.modelLayout);
  const setModelLayout = useViewerStore((s) => s.setModelLayout);
  const width = useSplitWidth();
  const shown = effectiveModelLayout(pick, width) !== '3d';
  return (
    <RailButton
      id="plan"
      labelKey={shown ? 'modelWorkspace.plan.hide' : 'modelWorkspace.plan.show'}
      Icon={shown ? PanelLeftClose : PanelLeftOpen}
      active={shown}
      disabledReason={shown || splitFits(width) ? null : t('modelWorkspace.plan.noRoom')}
      onClick={() => setModelLayout(shown ? '3d' : 'split')}
    />
  );
}

/** Opens the Change sets panel (#6232 D4); the tooltip names the set new edits land in. */
function ChangeSetsButton() {
  const { t } = useTranslation();
  const open = useViewerStore((s) => s.sidebarActivePanel === 'changeSets');
  const activeName = useViewerStore((s) => (s.activeChangeSetId ? s.changeSets.get(s.activeChangeSetId)?.name : undefined));
  return (
    <RailButton
      id="change-sets"
      labelKey="changeSets.rail.label"
      Icon={GitBranch}
      active={open}
      detail={activeName ? t('changeSets.rail.active', { name: activeName }) : t('changeSets.rail.none')}
      disabledReason={null}
      onClick={() => useViewerStore.getState().toggleWorkspacePanel('changeSets', 'rail')}
    />
  );
}

interface RailButtonProps {
  id: string;
  labelKey: TranslationKey;
  Icon: ComponentType<{ className?: string }>;
  shortcut?: KeyCommandId;
  /** A second tooltip line that states the button's current state. */
  detail?: string;
  active: boolean;
  disabledReason: string | null;
  onClick: () => void;
}

function RailButton({ id, labelKey, Icon, shortcut, detail, active, disabledReason, onClick }: RailButtonProps) {
  const { t } = useTranslation();
  const label = t(labelKey);
  const disabled = disabledReason !== null;
  const button = (
    <button
      type="button"
      {...tourAnchor(toolAnchor(id))}
      data-rail-tool={id}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-overlay-accent-soft text-overlay-accent'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      {active && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r bg-overlay-accent" />}
      <Icon className="h-4 w-4" />
    </button>
  );
  const tip: ReactNode = (
    <>
      {label}
      {shortcut && <span className="ml-1 text-muted-foreground">{t('modelWorkspace.tool.shortcutHint', { key: shortcutLabel(shortcut) })}</span>}
      {detail && <span className="block text-muted-foreground">{detail}</span>}
      {disabledReason && <span className="block text-muted-foreground">{disabledReason}</span>}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events, so its reason needs a live trigger around it. */}
        {disabled ? <span data-rail-disabled={id} className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}
