/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Registry-backed ribbon controls. Callers supply host inputs; the table owns execution. */
import { forwardRef, type MouseEvent } from 'react';
import { useTranslation } from '@/i18n';
import { surfaceCommand, type SurfaceCommandContext, type SurfaceCommandDefinition, type SurfaceCommandId } from '../surface-commands';
import { runSurfaceCommand } from '../surface-command-run';
import { RibbonContentLargeButton, RibbonContentSmallButton, type RibbonContentButtonProps } from './primitives';

type RibbonCommandContext = Omit<SurfaceCommandContext, 'surface'>
  | ((event: MouseEvent<HTMLButtonElement>) => Omit<SurfaceCommandContext, 'surface'>);

export type RibbonCommandButtonProps = Omit<
  RibbonContentButtonProps,
  'icon' | 'contentLabel' | 'contentSource' | 'contentId' | 'shortcut' | 'aria-label' | 'onClick'
> & {
  commandId: SurfaceCommandId;
  /** The ribbon may use its established SVG while the palette uses Lucide. */
  icon?: RibbonContentButtonProps['icon'];
  /** Mounted hosts supply only the inputs their registered command needs. */
  commandContext?: RibbonCommandContext;
} & (
  | { onClick?: never; triggerOnly?: false }
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
  props: Pick<RibbonContentButtonProps, 'onClick' | 'onPointerDown' | 'onKeyDown' | 'aria-haspopup'>,
) {
  const execute = (action: (() => void) | undefined) => {
    if (!action) throw new Error(`${command.id} requires a mounted menu or dialog trigger`);
    runSurfaceCommand(command, { surface: 'ribbon', contextAction: action });
  };
  if (props['aria-haspopup'] === 'menu') return {
    onClick: props.onClick,
    onPointerDown: (event: Parameters<NonNullable<RibbonContentButtonProps['onPointerDown']>>[0]) => {
      if (event.button === 0 && !event.ctrlKey) {
        execute(props.onPointerDown ? () => props.onPointerDown?.(event) : undefined);
      }
      else props.onPointerDown?.(event);
    },
    onKeyDown: (event: Parameters<NonNullable<RibbonContentButtonProps['onKeyDown']>>[0]) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        execute(props.onKeyDown ? () => props.onKeyDown?.(event) : undefined);
      } else props.onKeyDown?.(event);
    },
  };
  return {
    onClick: (event: Parameters<NonNullable<RibbonContentButtonProps['onClick']>>[0]) =>
      execute(props.onClick ? () => props.onClick?.(event) : undefined),
    onPointerDown: props.onPointerDown,
    onKeyDown: props.onKeyDown,
  };
}

function commandHandlers(
  command: SurfaceCommandDefinition,
  props: Pick<RibbonContentButtonProps, 'onClick' | 'onPointerDown' | 'onKeyDown' | 'aria-haspopup'>,
  triggerOnly: boolean | undefined,
  commandContext: RibbonCommandContext | undefined,
) {
  if (triggerOnly) return mountedTriggerHandlers(command, props);
  return {
    onClick: (event: MouseEvent<HTMLButtonElement>) => runSurfaceCommand(command, {
      surface: 'ribbon',
      ...(typeof commandContext === 'function' ? commandContext(event) : commandContext),
    }),
  };
}

export const RibbonCommandLargeButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandLargeButton({ commandId, icon, triggerOnly, commandContext, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    const handlers = commandHandlers(command, props, triggerOnly, commandContext);
    return <RibbonContentLargeButton {...props} ref={ref} data-command-id={command.id}
      data-command-trigger={triggerOnly || undefined}
      icon={icon ?? command.icon} contentLabel={label} contentSource="registered" contentId={command.id} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} {...handlers} />;
  },
);

export const RibbonCommandSmallButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandSmallButton({ commandId, icon, triggerOnly, commandContext, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    const handlers = commandHandlers(command, props, triggerOnly, commandContext);
    return <RibbonContentSmallButton {...props} ref={ref} data-command-id={command.id}
      data-command-trigger={triggerOnly || undefined}
      icon={icon ?? command.icon} contentLabel={label} contentSource="registered" contentId={command.id} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} {...handlers} />;
  },
);
