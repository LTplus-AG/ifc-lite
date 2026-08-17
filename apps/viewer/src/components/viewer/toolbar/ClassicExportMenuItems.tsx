/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classic toolbar (`MainToolbar`) rendering of the export registry: the body
 * of the Download dropdown. Every row is generated from `EXPORT_COMMANDS`, so
 * the classic strip cannot fall behind the ribbon — see `export-commands.ts`.
 */

import React from 'react';
import { Camera, Download, FileJson, FileSpreadsheet, FileText, Globe2 } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { groupExportCommands, type CsvExportType, type ExportIconSet } from './export-commands';
import { useExportCommands, type ResolvedExportCommand } from './useExportCommands';

/** Lucide icon per format — exhaustive, so a new registry entry breaks the build here. */
export const CLASSIC_EXPORT_ICONS: ExportIconSet = {
  ifc: FileText,
  glb: Download,
  kmz: Globe2,
  usd: Download,
  energy: Download,
  csv: FileSpreadsheet,
  json: FileJson,
  screenshot: Camera,
  pdf: FileText,
};

interface ClassicExportRowProps extends ResolvedExportCommand {
  onExportCsv: (type: CsvExportType) => void;
  onRunAction: (action: 'json' | 'screenshot') => void;
}

function ClassicExportRow({ command, disabled, onExportCsv, onRunAction }: ClassicExportRowProps) {
  const Icon = CLASSIC_EXPORT_ICONS[command.id];

  if (command.kind === 'dialog') {
    const { Dialog } = command;
    return (
      <Dialog
        trigger={
          <DropdownMenuItem
            data-export-command={command.id}
            disabled={disabled}
            onSelect={(e) => e.preventDefault()}
          >
            <Icon className="h-4 w-4 mr-2" />
            {command.menuLabel}
          </DropdownMenuItem>
        }
      />
    );
  }

  if (command.kind === 'table-menu') {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-export-command={command.id} disabled={disabled}>
          <Icon className="h-4 w-4 mr-2" />
          {command.menuLabel}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {command.items.map((item) => (
            <React.Fragment key={item.type}>
              {item.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => onExportCsv(item.type)}>
                <Icon className="h-4 w-4 mr-2" />
                {item.label}
              </DropdownMenuItem>
            </React.Fragment>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem
      data-export-command={command.id}
      disabled={disabled}
      onClick={() => onRunAction(command.action)}
    >
      <Icon className="h-4 w-4 mr-2" />
      {command.menuLabel}
    </DropdownMenuItem>
  );
}

/** The rows of the classic export dropdown, in registry order. */
export function ClassicExportMenuItems() {
  const { commands, handleExportCSV, runExportAction } = useExportCommands();
  const groups = groupExportCommands(commands, (resolved) => resolved.command.group);

  return (
    <>
      {groups.map((group, index) => (
        <React.Fragment key={group[0].command.id}>
          {index > 0 && <DropdownMenuSeparator />}
          {group.map((resolved) => (
            <ClassicExportRow
              key={resolved.command.id}
              {...resolved}
              onExportCsv={(type) => void handleExportCSV(type)}
              onRunAction={runExportAction}
            />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}
