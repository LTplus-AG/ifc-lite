/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CommandPalette — Ctrl+K / Cmd+K
 *
 * Raycast-style command palette for the entire viewer.
 * Keyboard-first, scored search, recent usage tracking.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import {
  Search,
  Play,
  MousePointer2,
  PersonStanding,
  Ruler,
  Scissors,
  Home,
  Maximize2,
  Crosshair,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Box,
  EyeOff,
  Eye,
  Equal,
  Plus,
  Minus,
  RotateCcw,
  SquareX,
  Building2,
  Layout,
  TreeDeciduous,
  FileCode2,
  MessageSquare,
  ClipboardCheck,
  FileSpreadsheet,
  Palette,
  Camera,
  Download,
  FileJson,
  Sun,
  Info,
  Orbit,
  FolderOpen,
  Clock,
  Save,
  CalendarClock,
  CalendarPlus,
  Sparkles,
  Eraser,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import {
  executeBasketSet,
  executeBasketAdd,
  executeBasketRemove,
  executeBasketToggleVisibility,
  executeBasketSaveView,
  executeBasketClear,
} from '@/store/basket/basketCommands';
import { useSandbox } from '@/hooks/useSandbox';
import { SCRIPT_TEMPLATES } from '@/lib/scripts/templates';
import { GLTFExporter, CSVExporter } from '@ifc-lite/export';
import { getRecentFiles, formatFileSize, getCachedFile } from '@/lib/recent-files';
import type { RecentFileEntry } from '@/lib/recent-files';
import { closeActiveAnalysisExtension } from '@/services/analysis-extensions';

// ── Types ──────────────────────────────────────────────────────────────

type Category =
  | 'Recent'
  | 'File'
  | 'View'
  | 'Tools'
  | 'Visibility'
  | 'Panels'
  | 'Export'
  | 'Automation'
  | 'Preferences';

interface Command {
  id: string;
  label: string;
  keywords: string;           // extra search tokens (no UI display)
  category: Exclude<Category, 'Recent'>;
  icon: React.ElementType;
  shortcut?: string;
  detail?: string;            // subtle secondary text (e.g. file size)
  action: () => void;
}

interface FlatItem {
  cmd: Command;
  flatIdx: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const RECENT_KEY = 'ifc-lite:cmd-palette:recent';
const MAX_RECENT = 5;
const CATEGORY_ORDER: Category[] = [
  'Recent', 'File', 'View', 'Tools', 'Visibility', 'Panels', 'Export', 'Automation', 'Preferences',
];

// ── Search scoring ─────────────────────────────────────────────────────

/**
 * Score how well `query` matches `text`.
 *   0   = no match
 *   100 = exact substring
 *   50  = word-start initials
 *   1-25 = tight fuzzy (avg gap ≤ 5)
 */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring
  if (t.includes(q)) return 100;

  // Word-start initials (e.g. "cs" → "Color Spaces")
  const words = t.split(/[\s\-_:\/,]+/);
  let wi = 0, qi = 0;
  while (wi < words.length && qi < q.length) {
    if (words[wi].length > 0 && words[wi][0] === q[qi]) qi++;
    wi++;
  }
  if (qi === q.length) return 50;

  // Tight fuzzy — reject if chars are scattered
  let lastIdx = -1, totalGap = 0;
  qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (lastIdx >= 0) totalGap += i - lastIdx - 1;
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const avgGap = q.length > 1 ? totalGap / (q.length - 1) : 0;
  if (avgGap > 5) return 0;
  return Math.max(1, 25 - Math.round(avgGap * 3));
}

/** Rank a command against the search query. Label dominates. */
function rankCommand(cmd: Command, query: string): number {
  const l = score(query, cmd.label);
  const k = score(query, cmd.keywords) * 0.9;
  const c = score(query, cmd.category) * 0.5;
  return Math.max(l, k, c);
}

// ── Recent usage ───────────────────────────────────────────────────────

function getRecentIds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); }
  catch { return []; }
}
function recordUsage(id: string) {
  try {
    const r = getRecentIds().filter(x => x !== id);
    r.unshift(id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 30)));
  } catch { /* noop */ }
}

// ── Utilities ──────────────────────────────────────────────────────────

function downloadBlob(data: BlobPart, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

/** Exclusively activate a right-panel content panel (BCF / IDS / Lens).
 *  Closes all others first so the if-else chain in ViewerLayout renders it.
 *  If the target is already active, closes it (back to Properties). */
function activateRightPanel(panel: 'bcf' | 'ids' | 'lens') {
  const s = useViewerStore.getState();
  const isActive =
    panel === 'bcf' ? s.bcfPanelVisible :
    panel === 'ids' ? s.idsPanelVisible :
    s.lensPanelVisible;

  closeActiveAnalysisExtension();

  // Close all content panels
  s.setBcfPanelVisible(false);
  s.setIdsPanelVisible(false);
  s.setLensPanelVisible(false);

  if (!isActive) {
    // Open the target, expand right panel
    s.setRightPanelCollapsed(false);
    if (panel === 'bcf') s.setBcfPanelVisible(true);
    else if (panel === 'ids') s.setIdsPanelVisible(true);
    else s.setLensPanelVisible(true);
  }
  // If was active → all closed → falls back to Properties
}

/** Exclusively activate a bottom panel (Script / List / Gantt).
 *  Closes the other first so the if-else chain in ViewerLayout renders it.
 *  If the target is already active, closes it. */
function activateBottomPanel(panel: 'script' | 'list' | 'gantt') {
  const s = useViewerStore.getState();
  const isActive =
    panel === 'script' ? s.scriptPanelVisible
    : panel === 'list' ? s.listPanelVisible
    : s.ganttPanelVisible;

  closeActiveAnalysisExtension();

  // Close all bottom panels — only one slots into the bottom strip at a time.
  s.setScriptPanelVisible(false);
  s.setListPanelVisible(false);
  s.setGanttPanelVisible(false);

  if (!isActive) {
    s.setRightPanelCollapsed(false);
    if (panel === 'script') s.setScriptPanelVisible(true);
    else if (panel === 'list') s.setListPanelVisible(true);
    else s.setGanttPanelVisible(true);
  }
}

// ── Component ──────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigatedByKeyboard = useRef(false);

  const { execute } = useSandbox();

  useEffect(() => {
    if (open) {
      setRecentIds(getRecentIds());
      setRecentFiles(getRecentFiles());
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ── Command definitions ──
  const commands = useMemo<Command[]>(() => {
    const c: Command[] = [];

    // ── File ──
    c.push(
      { id: 'file:open', label: 'Open File', keywords: 'ifc ifcx glb load model browse', category: 'File', icon: FolderOpen,
        action: () => {
          const input = document.getElementById('file-input-open') as HTMLInputElement | null;
          if (input) input.click();
        } },
    );
    for (const rf of recentFiles) {
      const fileName = rf.name;
      c.push({
        id: `file:recent:${fileName}`, label: fileName,
        keywords: `recent open ${formatFileSize(rf.size)}`,
        category: 'File', icon: Clock,
        detail: formatFileSize(rf.size),
        action: () => {
          // Try loading from IndexedDB blob cache → dispatches to MainToolbar's loadFile
          getCachedFile(rf).then(file => {
            if (file) {
              window.dispatchEvent(new CustomEvent('ifc-lite:load-file', { detail: file }));
            } else {
              // Cache miss — fall back to file picker
              const input = document.getElementById('file-input-open') as HTMLInputElement | null;
              if (input) input.click();
            }
          });
        },
      });
    }

    // ── View ──
    c.push(
      { id: 'view:home', label: 'Home', keywords: 'isometric reset camera', category: 'View', icon: Home, shortcut: 'H',
        action: () => { goHomeFromStore(); } },
      { id: 'view:fit', label: 'Fit All', keywords: 'zoom extents entire model', category: 'View', icon: Maximize2, shortcut: 'Z',
        action: () => { useViewerStore.getState().cameraCallbacks.fitAll?.(); } },
      { id: 'view:frame', label: 'Frame Selection', keywords: 'zoom focus selected', category: 'View', icon: Crosshair, shortcut: 'F',
        action: () => { useViewerStore.getState().cameraCallbacks.frameSelection?.(); } },
      { id: 'view:projection', label: 'Projection', keywords: 'perspective orthographic ortho toggle switch', category: 'View', icon: Orbit,
        action: () => { useViewerStore.getState().toggleProjectionMode(); } },
      { id: 'view:top', label: 'Top View', keywords: 'camera plan', category: 'View', icon: ArrowUp, shortcut: '1',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('top'); } },
      { id: 'view:bottom', label: 'Bottom View', keywords: 'camera', category: 'View', icon: ArrowDown, shortcut: '2',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('bottom'); } },
      { id: 'view:front', label: 'Front View', keywords: 'camera elevation', category: 'View', icon: ArrowRight, shortcut: '3',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('front'); } },
      { id: 'view:back', label: 'Back View', keywords: 'camera', category: 'View', icon: ArrowLeft, shortcut: '4',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('back'); } },
      { id: 'view:left', label: 'Left View', keywords: 'camera', category: 'View', icon: ArrowLeft, shortcut: '5',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('left'); } },
      { id: 'view:right', label: 'Right View', keywords: 'camera', category: 'View', icon: ArrowRight, shortcut: '6',
        action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('right'); } },
    );

    // ── Tools ──
    c.push(
      { id: 'tool:select', label: 'Select', keywords: 'pick click pointer', category: 'Tools', icon: MousePointer2, shortcut: 'V',
        action: () => { useViewerStore.getState().setActiveTool('select'); } },
      { id: 'tool:walk', label: 'Walk', keywords: 'first person navigate wasd', category: 'Tools', icon: PersonStanding, shortcut: 'C',
        action: () => { useViewerStore.getState().setActiveTool('walk'); } },
      { id: 'tool:measure', label: 'Measure', keywords: 'distance ruler dimension', category: 'Tools', icon: Ruler, shortcut: 'M',
        action: () => { useViewerStore.getState().setActiveTool('measure'); } },
      { id: 'tool:section', label: 'Section', keywords: 'clip cut plane', category: 'Tools', icon: Scissors, shortcut: 'X',
        action: () => { useViewerStore.getState().setActiveTool('section'); } },
    );

    // ── Visibility ──
    c.push(
      { id: 'vis:hide', label: 'Hide Selection', keywords: 'hide selected invisible', category: 'Visibility', icon: EyeOff, shortcut: 'Del',
        action: () => {
          const s = useViewerStore.getState();
          const ids = s.selectedEntityIds.size > 0 ? Array.from(s.selectedEntityIds) : s.selectedEntityId !== null ? [s.selectedEntityId] : [];
          if (ids.length > 0) { s.hideEntities(ids); s.clearSelection(); }
        } },
      { id: 'vis:show', label: 'Show All', keywords: 'unhide reset visible', category: 'Visibility', icon: Eye, shortcut: 'A',
        action: () => { resetVisibilityForHomeFromStore(); } },
      { id: 'vis:set-iso', label: 'Isolate (Set Basket)', keywords: 'basket isolate set selection hierarchy view equals', category: 'Visibility', icon: Equal, shortcut: 'I',
        action: () => executeBasketSet() },
      { id: 'vis:add-iso', label: 'Add to Basket', keywords: 'basket plus selection hierarchy view', category: 'Visibility', icon: Plus, shortcut: '+',
        action: () => executeBasketAdd() },
      { id: 'vis:remove-iso', label: 'Remove from Basket', keywords: 'basket minus selection hierarchy view', category: 'Visibility', icon: Minus, shortcut: '−',
        action: () => executeBasketRemove() },
      { id: 'vis:toggle-iso', label: 'Toggle Basket Visibility', keywords: 'basket show hide', category: 'Visibility', icon: Eye,
        action: () => executeBasketToggleVisibility() },
      { id: 'vis:save-view', label: 'Save Basket as View', keywords: 'basket presentation thumbnail', category: 'Visibility', icon: Save,
        action: () => executeBasketSaveView().catch((err) => {
          console.error('[CommandPalette] Failed to save basket view:', err);
        }) },
      { id: 'vis:toggle-presentation', label: 'Toggle Basket Presentation Dock', keywords: 'basket panel carousel thumbnails', category: 'Visibility', icon: Layout,
        action: () => { useViewerStore.getState().toggleBasketPresentationVisible(); } },
      { id: 'vis:clear-iso', label: 'Clear Basket', keywords: 'basket clear reset', category: 'Visibility', icon: RotateCcw,
        action: () => executeBasketClear() },
      { id: 'vis:spaces', label: 'Spaces', keywords: 'IfcSpace rooms show hide', category: 'Visibility', icon: Box,
        action: () => { useViewerStore.getState().toggleTypeVisibility('spaces'); } },
      { id: 'vis:openings', label: 'Openings', keywords: 'IfcOpeningElement show hide', category: 'Visibility', icon: SquareX,
        action: () => { useViewerStore.getState().toggleTypeVisibility('openings'); } },
      { id: 'vis:site', label: 'Site', keywords: 'IfcSite terrain show hide', category: 'Visibility', icon: Building2,
        action: () => { useViewerStore.getState().toggleTypeVisibility('site'); } },
      { id: 'vis:reset-colors', label: 'Reset Colors', keywords: 'clear color override', category: 'Visibility', icon: Palette,
        action: () => { execute('bim.viewer.resetColors()\nconsole.log("Colors reset")'); } },
    );

    // ── Panels ──
    c.push(
      { id: 'panel:properties', label: 'Inspector', keywords: 'properties attributes material classification schedule task panel right', category: 'Panels', icon: Layout,
        action: () => { const s = useViewerStore.getState(); s.setRightPanelCollapsed(!s.rightPanelCollapsed); } },
      { id: 'panel:tree', label: 'Spatial Tree', keywords: 'hierarchy left panel', category: 'Panels', icon: TreeDeciduous,
        action: () => { const s = useViewerStore.getState(); s.setLeftPanelCollapsed(!s.leftPanelCollapsed); } },
      { id: 'panel:script', label: 'Script Editor', keywords: 'code automation console', category: 'Panels', icon: FileCode2,
        action: () => { activateBottomPanel('script'); } },
      { id: 'panel:bcf', label: 'BCF Issues', keywords: 'collaboration topics comments viewpoint', category: 'Panels', icon: MessageSquare,
        action: () => { activateRightPanel('bcf'); } },
      { id: 'panel:ids', label: 'IDS Validation', keywords: 'information delivery specification check', category: 'Panels', icon: ClipboardCheck,
        action: () => { activateRightPanel('ids'); } },
      { id: 'panel:lists', label: 'Entity Lists', keywords: 'table spreadsheet', category: 'Panels', icon: FileSpreadsheet,
        action: () => { activateBottomPanel('list'); } },
      { id: 'panel:gantt', label: 'Construction Schedule (Gantt)', keywords: '4d timeline tasks ifctask sequence playback animation', category: 'Panels', icon: CalendarClock,
        action: () => { activateBottomPanel('gantt'); } },
      { id: 'panel:lens', label: 'Lens Rules', keywords: 'color filter highlight', category: 'Panels', icon: Palette,
        action: () => { activateRightPanel('lens'); } },
    );

    // ── Schedule / 4D (Tools) ─────────────────────────────
    c.push(
      { id: 'schedule:generate', label: 'Generate Schedule from Storeys…',
        keywords: '4d ifctask construction sequence storey building create gantt',
        category: 'Tools', icon: CalendarPlus,
        action: () => {
          // Make sure the Gantt panel is mounted so the dialog has a host
          // before flipping the dialog flag. Order matters — closing other
          // panels first prevents the bottom strip from rendering them.
          const s = useViewerStore.getState();
          if (!s.ganttPanelVisible) activateBottomPanel('gantt');
          // Same tick is fine — the dialog is portalled via Radix and doesn't
          // depend on GanttPanel finishing its first render.
          useViewerStore.getState().setGenerateScheduleDialogOpen(true);
        } },
      { id: 'schedule:toggle-animation', label: 'Toggle 4D Construction Animation',
        keywords: 'play pause schedule task gantt simulation',
        category: 'Visibility', icon: Sparkles,
        action: () => {
          const s = useViewerStore.getState();
          s.setAnimationEnabled(!s.animationEnabled);
        } },
      { id: 'schedule:reset', label: 'Reset Schedule (Clear 4D Data)',
        keywords: 'remove gantt tasks ifctask delete clear',
        category: 'Tools', icon: Eraser,
        action: () => {
          const s = useViewerStore.getState();
          s.setScheduleData(null);
          s.setAnimationEnabled(false);
          s.pauseSchedule();
        } },
    );

    // ── Export ──
    c.push(
      { id: 'export:screenshot', label: 'Screenshot', keywords: 'capture png image viewport', category: 'Export', icon: Camera,
        action: () => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return;
          try { const d = canvas.toDataURL('image/png'); Object.assign(document.createElement('a'), { href: d, download: 'screenshot.png' }).click(); }
          catch (e) { console.error('Screenshot failed:', e); }
        } },
      { id: 'export:glb', label: 'Export GLB', keywords: '3d model gltf download', category: 'Export', icon: Download,
        action: () => {
          const gr = useViewerStore.getState().geometryResult; if (!gr) return;
          try { const e = new GLTFExporter(gr); downloadBlob(new Uint8Array(e.exportGLB({ includeMetadata: true })), 'model.glb', 'model/gltf-binary'); }
          catch (e) { console.error('GLB export failed:', e); }
        } },
      { id: 'export:csv-entities', label: 'Export CSV: Entities', keywords: 'spreadsheet properties download', category: 'Export', icon: FileSpreadsheet,
        action: () => { const d = useViewerStore.getState().ifcDataStore; if (!d) return; try { downloadBlob(new CSVExporter(d).exportEntities(undefined, { includeProperties: true, flattenProperties: true }), 'entities.csv', 'text/csv'); } catch (e) { console.error(e); } } },
      { id: 'export:csv-properties', label: 'Export CSV: Properties', keywords: 'pset spreadsheet download', category: 'Export', icon: FileSpreadsheet,
        action: () => { const d = useViewerStore.getState().ifcDataStore; if (!d) return; try { downloadBlob(new CSVExporter(d).exportProperties(), 'properties.csv', 'text/csv'); } catch (e) { console.error(e); } } },
      { id: 'export:csv-quantities', label: 'Export CSV: Quantities', keywords: 'qto spreadsheet download', category: 'Export', icon: FileSpreadsheet,
        action: () => { const d = useViewerStore.getState().ifcDataStore; if (!d) return; try { downloadBlob(new CSVExporter(d).exportQuantities(), 'quantities.csv', 'text/csv'); } catch (e) { console.error(e); } } },
      { id: 'export:csv-spatial', label: 'Export CSV: Spatial', keywords: 'hierarchy spreadsheet download', category: 'Export', icon: FileSpreadsheet,
        action: () => { const d = useViewerStore.getState().ifcDataStore; if (!d) return; try { downloadBlob(new CSVExporter(d).exportSpatialHierarchy(), 'spatial-hierarchy.csv', 'text/csv'); } catch (e) { console.error(e); } } },
      { id: 'export:json', label: 'Export JSON', keywords: 'data entities all download', category: 'Export', icon: FileJson,
        action: () => {
          const d = useViewerStore.getState().ifcDataStore; if (!d) return;
          try {
            const out: Record<string, unknown>[] = [];
            for (let i = 0; i < d.entities.count; i++) { const id = d.entities.expressId[i]; out.push({ expressId: id, globalId: d.entities.getGlobalId(id), name: d.entities.getName(id), type: d.entities.getTypeName(id), properties: d.properties.getForEntity(id) }); }
            downloadBlob(JSON.stringify({ entities: out }, null, 2), 'model-data.json', 'application/json');
          } catch (e) { console.error(e); }
        } },
    );

    // ── Automation (scripts — last, power-user feature) ──
    for (const t of SCRIPT_TEMPLATES) {
      c.push({
        id: `auto:${t.name}`, label: t.name, keywords: `script run ${t.description}`,
        category: 'Automation', icon: Play,
        action: () => { const s = useViewerStore.getState(); s.setListPanelVisible(false); s.setScriptPanelVisible(true); s.setScriptEditorContent(t.code); execute(t.code); },
      });
    }

    // ── Preferences ──
    c.push(
      { id: 'pref:theme', label: 'Theme', keywords: 'dark light mode appearance switch', category: 'Preferences', icon: Sun, shortcut: 'T',
        action: () => { useViewerStore.getState().toggleTheme(); } },
      { id: 'pref:tooltips', label: 'Hover Tooltips', keywords: 'entity info mouse hover show hide', category: 'Preferences', icon: Info,
        action: () => { useViewerStore.getState().toggleHoverTooltips(); } },
    );

    return c;
  }, [execute, recentFiles]);

  // ── Search: score, filter, sort ──
  // When searching, results are FLAT sorted by relevance — no category grouping.
  // When browsing (no query), results are grouped by category.
  const { grouped, flatItems } = useMemo(() => {
    const groups: { category: string; items: FlatItem[] }[] = [];
    const flat: FlatItem[] = [];
    let idx = 0;

    if (query) {
      // ── Searching: flat ranked list, no categories ──
      const scored = commands
        .map(cmd => ({ cmd, s: rankCommand(cmd, query) }))
        .filter(x => x.s > 0);
      scored.sort((a, b) => b.s - a.s);

      if (scored.length > 0) {
        const items: FlatItem[] = scored.map(({ cmd }) => {
          const item = { cmd, flatIdx: idx++ };
          flat.push(item);
          return item;
        });
        groups.push({ category: '', items }); // empty category = no header
      }
    } else {
      // ── Browsing: recent on top, then categories ──
      if (recentIds.length > 0) {
        const items: FlatItem[] = [];
        for (const id of recentIds.slice(0, MAX_RECENT)) {
          const cmd = commands.find(c => c.id === id);
          if (cmd) { const item = { cmd, flatIdx: idx++ }; items.push(item); flat.push(item); }
        }
        if (items.length > 0) groups.push({ category: 'Recent', items });
      }

      for (const cat of CATEGORY_ORDER) {
        if (cat === 'Recent') continue;
        const catCmds = commands.filter(c => c.category === cat);
        if (catCmds.length > 0) {
          const items: FlatItem[] = catCmds.map(cmd => {
            const item = { cmd, flatIdx: idx++ };
            flat.push(item);
            return item;
          });
          groups.push({ category: cat, items });
        }
      }
    }

    return { grouped: groups, flatItems: flat };
  }, [commands, query, recentIds]);

  useEffect(() => { setSelectedIndex(0); }, [query, open]);

  useEffect(() => {
    if (!navigatedByKeyboard.current || !listRef.current) return;
    navigatedByKeyboard.current = false;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const runCommand = useCallback((cmd: Command) => {
    onOpenChange(false);
    recordUsage(cmd.id);
    requestAnimationFrame(() => cmd.action());
  }, [onOpenChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedIndex(i => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); navigatedByKeyboard.current = true;
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item) runCommand(item.cmd);
    }
  }, [flatItems, selectedIndex, runCommand]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-lg overflow-hidden" aria-label="Command palette" hideCloseButton>
        {/* Search */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What do you need?"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto py-1" role="listbox">
          {flatItems.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No results
            </div>
          )}

          {grouped.map((group) => (
            <div key={group.category || '__flat'}>
              {group.category && (
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  {group.category}
                </div>
              )}
              {group.items.map(({ cmd, flatIdx }) => {
                const Icon = cmd.icon;
                return (
                  <button
                    key={`${group.category}:${cmd.id}`}
                    role="option"
                    data-index={flatIdx}
                    aria-selected={flatIdx === selectedIndex}
                    className={cn(
                      'flex items-center gap-3 w-full px-3 py-2 text-left text-sm',
                      flatIdx === selectedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50',
                    )}
                    onClick={() => runCommand(cmd)}
                    onMouseMove={() => { if (selectedIndex !== flatIdx) setSelectedIndex(flatIdx); }}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.detail && (
                      <span className="text-[11px] text-muted-foreground shrink-0">{cmd.detail}</span>
                    )}
                    {cmd.shortcut && (
                      <kbd className="ml-auto hidden sm:inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground shrink-0">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-3 py-1.5 border-t text-[10px] text-muted-foreground select-none">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> run</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
