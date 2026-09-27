/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Registry-backed ribbon controls. Callers own state and execution, not names. */
import { forwardRef } from 'react';
import { useTranslation } from '@/i18n';
import { surfaceCommand, type SurfaceCommandId } from '../surface-commands';
import { RibbonLargeButton, RibbonSmallButton, type RibbonButtonProps } from './primitives';

export type RibbonCommandButtonProps = Omit<
  RibbonButtonProps,
  'icon' | 'label' | 'shortcut' | 'aria-label'
> & {
  commandId: SurfaceCommandId;
  /** The ribbon may use its established SVG while the palette uses Lucide. */
  icon?: RibbonButtonProps['icon'];
  onClick: NonNullable<RibbonButtonProps['onClick']>;
};

function useRibbonCommandPresentation(commandId: SurfaceCommandId) {
  const { t } = useTranslation();
  const command = surfaceCommand(commandId, 'ribbon');
  return {
    command,
    label: t(command.ribbonLabelKey ?? command.labelKey),
    tooltip: command.ribbonTooltipKey ? t(command.ribbonTooltipKey) : undefined,
  };
}

export const RibbonCommandLargeButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandLargeButton({ commandId, icon, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    return <RibbonLargeButton {...props} ref={ref} data-command-id={command.id}
      icon={icon ?? command.icon} label={label} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} />;
  },
);

export const RibbonCommandSmallButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandSmallButton({ commandId, icon, ...props }, ref) {
    const { command, label, tooltip } = useRibbonCommandPresentation(commandId);
    return <RibbonSmallButton {...props} ref={ref} data-command-id={command.id}
      icon={icon ?? command.icon} label={label} aria-label={label}
      tooltip={props.tooltip ?? tooltip} shortcut={command.shortcut} />;
  },
);
