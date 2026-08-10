/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon rendering of the export registry: the File tab's Export group. Every
 * button is generated from `EXPORT_COMMANDS`, so the ribbon cannot fall behind
 * the classic strip — see `toolbar/export-commands.ts`.
 *
 * The icon set arrives as a prop rather than being imported here: the ribbon's
 * icons come from `@/icons`, which resolves through the `unplugin-icons` Vite
 * plugin and therefore cannot be loaded by the node test runner. Injecting it
 * keeps this component renderable in `export-ui-parity.test.tsx`, while the
 * real set (`RIBBON_EXPORT_ICONS`) stays exhaustive at the type level.
 */

import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  groupExportCommands,
  type CsvExportType,
  type ExportIconSet,
} from '../../toolbar/export-commands';
import { useExportCommands, type ResolvedExportCommand } from '../../toolbar/useExportCommands';
import { RibbonGroup, RibbonLargeButton, RibbonSmallButton, RibbonSmallStack } from '../primitives';

interface RibbonExportButtonProps extends ResolvedExportCommand {
  icons: ExportIconSet;
  onExportCsv: (type: CsvExportType) => void;
  onRunAction: (action: 'json' | 'screenshot') => void;
}

function RibbonExportButton({
  command,
  disabled,
  icons,
  onExportCsv,
  onRunAction,
}: RibbonExportButtonProps) {
  const Button = command.emphasis === 'large' ? RibbonLargeButton : RibbonSmallButton;
  const shared = {
    icon: icons[command.id],
    label: command.label,
    tooltip: command.tooltip,
    disabled,
    'data-export-command': command.id,
  };

  if (command.kind === 'dialog') {
    const { Dialog } = command;
    return <Dialog trigger={<Button {...shared} />} />;
  }

  if (command.kind === 'table-menu') {
    const Icon = icons[command.id];
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button {...shared} hasMenu />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {command.items.map((item) => (
            <React.Fragment key={item.type}>
              {item.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => onExportCsv(item.type)}>
                <Icon className="h-4 w-4 mr-2" />
                {item.label}
              </DropdownMenuItem>
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return <Button {...shared} onClick={() => onRunAction(command.action)} />;
}

/**
 * The File tab's Export group, in registry order. Gating comes from the shared
 * hook: any loaded model (federated sessions leave the legacy single-model
 * `geometryResult` null, which would otherwise hide the whole group), plus a
 * parsed data store for the table exports.
 */
export function RibbonExportGroup({ icons }: { icons: ExportIconSet }) {
  const { commands, handleExportCSV, runExportAction } = useExportCommands();
  const groups = groupExportCommands(commands, (resolved) => resolved.command.group);

  return (
    <RibbonGroup label="Export">
      {groups.map((group) => {
        const buttons = group.map((resolved) => (
          <RibbonExportButton
            key={resolved.command.id}
            {...resolved}
            icons={icons}
            onExportCsv={(type) => void handleExportCSV(type)}
            onRunAction={runExportAction}
          />
        ));
        // A lone headline command stands on its own; everything else stacks.
        return group.length === 1 && group[0].command.emphasis === 'large' ? (
          <React.Fragment key={group[0].command.id}>{buttons}</React.Fragment>
        ) : (
          <RibbonSmallStack key={group[0].command.id}>{buttons}</RibbonSmallStack>
        );
      })}
    </RibbonGroup>
  );
}
