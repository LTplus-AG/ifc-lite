/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dashboard-level actions: rename, duplicate, delete, export as a
 * `.ifclite-dashboard.json` file, import one. Kept out of the panel header
 * so the panel stays a layout, not a menu.
 */
import { useRef } from 'react';
import { Copy, Download, MoreHorizontal, Pencil, Trash2, Upload } from 'lucide-react';
import type { DashboardSpec } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { DASHBOARD_FILE_SUFFIX, exportDashboard, importDashboard } from '@/lib/charts/persistence';
import { freshId } from '@/lib/charts/presets';

export interface DashboardMenuProps {
  dashboard: DashboardSpec | null;
  onUpsert: (dashboard: DashboardSpec) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string) => void;
}

export function DashboardMenu({ dashboard, onUpsert, onDelete, onActivate }: DashboardMenuProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const rename = (): void => {
    if (!dashboard) return;
    const name = window.prompt('Dashboard name', dashboard.name)?.trim();
    if (name && name !== dashboard.name) onUpsert({ ...dashboard, name });
  };
  const duplicate = (): void => {
    if (!dashboard) return;
    const chartIds = new Map(dashboard.charts.map((c) => [c.id, freshId('chart')]));
    const copy: DashboardSpec = {
      ...dashboard,
      id: freshId('dashboard'),
      name: `${dashboard.name} (copy)`,
      charts: dashboard.charts.map((c) => ({ ...c, id: chartIds.get(c.id) ?? c.id })),
      layout: dashboard.layout.map((l) => ({ ...l, chartId: chartIds.get(l.chartId) ?? l.chartId })),
    };
    onUpsert(copy);
    onActivate(copy.id);
  };
  const remove = (): void => {
    if (!dashboard) return;
    onDelete(dashboard.id);
  };
  const onImportFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const imported = await importDashboard(file);
      onUpsert(imported);
      onActivate(imported.id);
      toast.success(`Imported dashboard "${imported.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import the dashboard');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" aria-label="Dashboard actions" title="Rename, duplicate, delete, export or import a dashboard">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48 text-xs">
          <DropdownMenuItem disabled={!dashboard} onSelect={rename}><Pencil className="h-3.5 w-3.5 mr-2" />Rename</DropdownMenuItem>
          <DropdownMenuItem disabled={!dashboard} onSelect={duplicate}><Copy className="h-3.5 w-3.5 mr-2" />Duplicate</DropdownMenuItem>
          <DropdownMenuItem disabled={!dashboard} onSelect={remove}><Trash2 className="h-3.5 w-3.5 mr-2" />Delete</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!dashboard} onSelect={() => dashboard && exportDashboard(dashboard)}><Download className="h-3.5 w-3.5 mr-2" />Export file…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fileInput.current?.click()}><Upload className="h-3.5 w-3.5 mr-2" />Import file…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInput}
        type="file"
        accept={`${DASHBOARD_FILE_SUFFIX},.json`}
        className="hidden"
        data-dashboard-import
        onChange={(e) => {
          void onImportFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}
