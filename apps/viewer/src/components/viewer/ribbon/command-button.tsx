/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Registry-backed ribbon controls. Callers own state and execution, not names. */
import { forwardRef } from 'react';
import { useTranslation } from '@/i18n';
import { surfaceCommand, type SurfaceCommandDefinition, type SurfaceCommandId } from '../surface-commands';
import { runSurfaceCommand } from '../surface-command-run';
import { RibbonLargeButton, RibbonSmallButton, type RibbonButtonProps } from './primitives';

export type RibbonCommandButtonProps = Omit<
  RibbonButtonProps,
  'icon' | 'label' | 'shortcut' | 'aria-label' | 'onClick'
> & {
  commandId: SurfaceCommandId;
  /** The ribbon may use its established SVG while the palette uses Lucide. */
  icon?: RibbonButtonProps['icon'];
} & (
  | { onClick: NonNullable<RibbonButtonProps['onClick']>; triggerOnly?: false }
  | { onClick?: never; triggerOnly: true }
);

function useRibbonCommandPresentation(commandId: SurfaceCommandId) {
  const { t } = useTranslation();
  const command = surfaceCommand(commandId, 'ribbon');
  return {
    command,
    label: t(command.ribbonLabelKey ?? command.labelKey),
    tooltip: command.ribbonTooltipKey ? t(command.ribbonTooltipKey) : undefined,
  };
}

/** Radix supplies its menu/dialog handlers through asChild. Execute once on the handler that opens it. */
function mountedTriggerHandlers(
  command: SurfaceCommandDefinition,
  props: Pick<RibbonButtonProps, 'onClick' | 'onPointerDown' | 'onKeyDown' | 'aria-haspopup'>,
  triggerOnly: boolean | undefined,
) {
  if (!triggerOnly) return {
    onClick: props.onClick, onPointerDown: props.onPointerDown, onKeyDown: props.onKeyDown,
  };
  const execute = (action: (() => void) | undefined) => {
    if (!action) throw new Error(`${command.id} requires a mounted menu or dialog trigger`);
    runSurfaceCommand(command, { surface: 'ribbon', contextAction: action });
  };
  if (props['aria-haspopup'] === 'menu') return {
    onClick: props.onClick,
    onPointerDown: (event: Parameters<NonNullable<RibbonButtonProps['onPointerDown']>>[0]) => {
      if (event.button === 0 && !event.ctrlKey) {
        execute(props.onPointerDown ? () => props.onPointerDown?.(event) : undefined);
      }
      else props.onPointerDown?.(event);
    },
    onKeyDown: (event: Parameters<NonNullable<RibbonButtonProps['onKeyDown']>>[0]) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        execute(props.onKeyDown ? () => props.onKeyDown?.(event) : undefined);
      } else props.onKeyDown?.(event);
    },
  };
  return {
    onClick: (event: Parameters<NonNullable<RibbonButtonProps['onClick']>>[0]) =>
      execute(props.onClick ? () => props.onClick?.(event) : undefined),
    onPointerDown: props.onPointerDown,
    onKeyDown: props.onKeyDown,
  };
}

export const RibbonCommandLargeButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandLargeButton({ commandId, icon, triggerOnly, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    const handlers = mountedTriggerHandlers(command, props, triggerOnly);
    return <RibbonLargeButton {...props} ref={ref} data-command-id={command.id}
      data-command-trigger={triggerOnly || undefined}
      icon={icon ?? command.icon} label={label} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} {...handlers} />;
  },
);

export const RibbonCommandSmallButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandSmallButton({ commandId, icon, triggerOnly, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    const handlers = mountedTriggerHandlers(command, props, triggerOnly);
    return <RibbonSmallButton {...props} ref={ref} data-command-id={command.id}
      data-command-trigger={triggerOnly || undefined}
      icon={icon ?? command.icon} label={label} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} {...handlers} />;
  },
);
