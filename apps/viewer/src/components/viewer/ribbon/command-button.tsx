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
  onClick: NonNullable<RibbonButtonProps['onClick']>;
};

function useRibbonCommandPresentation(commandId: SurfaceCommandId) {
  const { t } = useTranslation();
  const command = surfaceCommand(commandId, 'ribbon');
  return { command, label: t(command.labelKey) };
}

export const RibbonCommandLargeButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandLargeButton({ commandId, ...props }, ref) {
    const { command, label } = useRibbonCommandPresentation(commandId);
    return <RibbonLargeButton {...props} ref={ref} data-command-id={command.id}
      icon={command.icon} label={label} aria-label={label} shortcut={command.shortcut} />;
  },
);

export const RibbonCommandSmallButton = forwardRef<HTMLButtonElement, RibbonCommandButtonProps>(
  function RibbonCommandSmallButton({ commandId, ...props }, ref) {
    const { command, label } = useRibbonCommandPresentation(commandId);
    return <RibbonSmallButton {...props} ref={ref} data-command-id={command.id}
      icon={command.icon} label={label} aria-label={label} shortcut={command.shortcut} />;
  },
);
