/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * /mcp/playground — interactive surface for the @ifc-lite/mcp tool catalogue.
 *
 * Layout: a 3-column resizable workspace
 *   • Left  — sample picker + parsed model summary (entity counts, types,
 *             materials, units), file drop zone for ad-hoc uploads.
 *   • Centre — agent transcript with inline tool-call rendering.
 *   • Right (collapsible later) — selected tool spotlight from the catalogue.
 *
 * The model parses entirely in-browser via @ifc-lite/parser; the agent runs
 * on Anthropic via BYOK; tool calls dispatch through `playground-dispatcher`
 * against the local `BimContext`. No IFC ever leaves the browser.
 */

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, Box, ChevronDown, ChevronRight, Download, Loader2, Upload, FileText, AlertTriangle, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDocumentMeta, useFonts } from './use-mcp-page';
import {
  parsePlaygroundModel,
  supportedToolNames,
  type DispatchContext,
  type LoadedPlaygroundModel,
} from './playground-dispatcher';
import { PlaygroundChat } from './PlaygroundChat';
import { PlaygroundViewer, type ViewerController } from './PlaygroundViewer';
import { playgroundFiles, usePlaygroundFiles, formatBytes as formatFileBytes } from './playground-files';

const NIGHT = '#0a0a0c';
const PANEL = '#101014';
const RULE = 'rgba(237, 228, 211, 0.08)';
const PAPER = '#ede4d3';
const PAPER_DIM = 'rgba(237, 228, 211, 0.55)';
const ACCENT = '#d6ff3f';

const stage: CSSProperties = {
  background: NIGHT,
  color: PAPER,
  fontFamily: '"Bricolage Grotesque", system-ui, sans-serif',
};
const display: CSSProperties = {
  fontFamily: '"Instrument Serif", serif',
  fontStyle: 'normal',
};
const mono: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
};

interface SampleEntry {
  id: string;
  label: string;
  blurb: string;
  url: string;
  approxBytes: number;
}

const SAMPLES: SampleEntry[] = [
  { id: 'hello-wall',          label: 'Hello Wall',          blurb: 'IFC5 minimal · 1 wall, 1 storey',          url: '/samples/hello-wall.ifc',          approxBytes:  78_000 },
  { id: 'building-architecture', label: 'Building / Architecture', blurb: 'buildingSMART sample · 444 entities, IFC4', url: '/samples/building-architecture.ifc', approxBytes: 220_000 },
  { id: 'infra-bridge',        label: 'Infra Bridge',        blurb: 'Infrastructure · IFC4.3 bridge sample',     url: '/samples/infra-bridge.ifc',        approxBytes: 1_800_000 },
];

export function McpPlayground(): ReactNode {
  useFonts(
    'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500;600&display=swap',
  );
  useDocumentMeta('@ifc-lite/mcp · playground', NIGHT);

  const [model, setModel] = useState<LoadedPlaygroundModel | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const viewerRef = useRef<ViewerController | null>(null);

  // Stable context getter — keeps the chat panel from re-running its
  // dispatch closure every render while still letting the viewer ref
  // attach late (the viewer component isn't mounted until the user
  // expands the panel).
  const getDispatchContext = useCallback<() => DispatchContext>(
    () => ({
      viewer: viewerRef.current ?? null,
      openViewerPanel: () => setViewerOpen(true),
    }),
    [],
  );

  const loadFromUrl = useCallback(async (entry: SampleEntry) => {
    setLoadingId(entry.id);
    setError(null);
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`Failed to fetch ${entry.label}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const m = await parsePlaygroundModel(buf, `${entry.id}.ifc`);
      setModel(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }, []);

  const loadFromFile = useCallback(async (file: File) => {
    setLoadingId('upload');
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const m = await parsePlaygroundModel(buf, file.name);
      setModel(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }, []);

  return (
    <main style={stage} className="flex h-screen min-h-screen flex-col antialiased">
      <TopBar onClose={() => setModel(null)} hasModel={!!model} />

      <div className="grid flex-1 min-h-0 grid-cols-1 md:grid-cols-[340px_1fr]">
        {/* Sidebar */}
        <aside
          className="flex flex-col gap-4 overflow-y-auto border-b border-white/10 px-5 py-5 md:border-b-0 md:border-r"
          style={{ background: PANEL }}
        >
          <div>
            <h2
              className="text-[26px] leading-none tracking-tight"
              style={{ ...display, fontStyle: 'italic' }}
            >
              Playground.
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-snug" style={{ color: PAPER_DIM }}>
              Pick a sample IFC. Then chat. The agent drives the same {supportedToolNames().length} tools the stdio MCP exposes — query, mutate, validate, BCF, export. Models stay in your browser.
            </p>
          </div>

          <SampleList samples={SAMPLES} loadingId={loadingId} activeId={model && SAMPLES.find((s) => s.id === modelIdFor(model)) ? modelIdFor(model) : null} onPick={loadFromUrl} />

          <DropZone disabled={loadingId !== null} onFile={loadFromFile} />

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              <AlertTriangle size={12} className="mr-1 inline" />
              {error}
            </div>
          )}

          {model && <ModelSummary model={model} />}

          <DownloadsPanel />

          <FooterLinks />
        </aside>

        {/* Right column: collapsible 3D viewer above the chat. The viewer
            component is unmounted while collapsed so we don’t hold a WebGL
            context for nothing. The dispatcher's `openViewerPanel()` flips
            `viewerOpen` so the agent can request the panel programmatically. */}
        <section className="flex min-h-0 flex-col">
          <ViewerPanel
            model={model}
            open={viewerOpen}
            onToggle={() => setViewerOpen((o) => !o)}
            controllerRef={viewerRef}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            <PlaygroundChat model={model} dispatchContext={getDispatchContext} />
          </div>
        </section>
      </div>
    </main>
  );
}

// ── top bar ────────────────────────────────────────────────────────────────

function TopBar({ onClose, hasModel }: { onClose: () => void; hasModel: boolean }): ReactNode {
  return (
    <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
      <a href="/mcp" className="flex items-center gap-2 text-[13px] text-white/70 hover:text-white">
        <ArrowLeft size={14} />
        <span>back to /mcp</span>
      </a>
      <div className="flex items-center gap-3">
        <a
          href="/"
          className="hidden items-center gap-1 text-[10.5px] uppercase tracking-[0.22em] text-white/40 hover:text-white sm:inline-flex"
          style={mono}
        >
          viewer
        </a>
        <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.22em]">
          /mcp/playground
        </span>
        {hasModel && (
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[10.5px] hover:bg-white/5"
            style={{ ...mono, color: PAPER_DIM }}
          >
            <Trash2 size={11} /> unload
          </button>
        )}
      </div>
    </div>
  );
}

// ── samples ────────────────────────────────────────────────────────────────

function SampleList({
  samples,
  loadingId,
  activeId,
  onPick,
}: {
  samples: SampleEntry[];
  loadingId: string | null;
  activeId: string | null;
  onPick: (s: SampleEntry) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.22em]">
        sample models
      </span>
      <ul className="flex flex-col gap-1.5">
        {samples.map((s) => {
          const isActive = activeId === s.id;
          const isLoading = loadingId === s.id;
          return (
            <li key={s.id}>
              <button
                onClick={() => onPick(s)}
                disabled={loadingId !== null}
                className={cn(
                  'group flex w-full items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                  isActive
                    ? 'border-[#d6ff3f]/60 bg-[#d6ff3f]/10'
                    : 'border-white/10 hover:bg-white/5',
                  loadingId !== null && !isLoading && 'opacity-50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-medium" style={{ color: PAPER }}>
                      {s.label}
                    </span>
                    {isLoading && <Loader2 size={11} className="animate-spin" style={{ color: ACCENT }} />}
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: PAPER_DIM }}>
                    {s.blurb}
                  </p>
                </div>
                <span style={{ ...mono, color: PAPER_DIM }} className="shrink-0 text-[10px]">
                  {formatBytes(s.approxBytes)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DropZone({
  onFile,
  disabled,
}: {
  onFile: (file: File) => void;
  disabled: boolean;
}): ReactNode {
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const f = e.dataTransfer.files[0];
        if (f && /\.ifc$/i.test(f.name)) onFile(f);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-3 py-4 text-center transition-colors',
        hover ? 'border-[#d6ff3f]/60 bg-[#d6ff3f]/10' : 'border-white/15 hover:border-white/25',
        disabled && 'pointer-events-none opacity-40',
      )}
      style={{ color: PAPER_DIM }}
    >
      <Upload size={14} />
      <span className="text-[11.5px]">drop an .ifc, or click to pick</span>
      <input
        ref={inputRef}
        type="file"
        accept=".ifc"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

// ── model summary ─────────────────────────────────────────────────────────

function ModelSummary({ model }: { model: LoadedPlaygroundModel }): ReactNode {
  const top = useMemo(() => {
    const counts: Array<{ type: string; count: number }> = [];
    for (const [type, ids] of model.store.entityIndex.byType) counts.push({ type, count: ids.length });
    counts.sort((a, b) => b.count - a.count);
    return counts.slice(0, 8);
  }, [model]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <FileText size={12} style={{ color: ACCENT }} />
        <span className="text-[11.5px]" style={{ color: PAPER }}>
          {model.name}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[11px]" style={{ ...mono, color: PAPER_DIM }}>
        <div>
          <dt className="text-[9px] uppercase tracking-[0.2em]">schema</dt>
          <dd style={{ color: PAPER }}>{model.store.schemaVersion}</dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-[0.2em]">entities</dt>
          <dd style={{ color: PAPER }}>{model.store.entityCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-[0.2em]">file</dt>
          <dd style={{ color: PAPER }}>{formatBytes(model.fileSize)}</dd>
        </div>
      </dl>

      <div className="mt-1 border-t border-white/10 pt-2">
        <div className="mb-1 text-[9px] uppercase tracking-[0.22em]" style={{ ...mono, color: PAPER_DIM }}>
          top entity types
        </div>
        <ul className="flex flex-col gap-0.5">
          {top.map((row) => (
            <li key={row.type} className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="truncate" style={{ ...mono, color: PAPER_DIM }}>
                {row.type}
              </span>
              <span style={{ ...mono, color: PAPER }}>{row.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── footer ─────────────────────────────────────────────────────────────────

function FooterLinks(): ReactNode {
  return (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/10 pt-3 text-[10.5px]" style={{ ...mono, color: PAPER_DIM }}>
      <a href="/mcp" className="hover:text-white">tools</a>
      <a href="https://github.com/LTplus-AG/ifc-lite" className="hover:text-white">github</a>
      <a href="https://www.npmjs.com/package/@ifc-lite/mcp" className="hover:text-white">npm</a>
      <a href="/" className="hover:text-white">viewer</a>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function modelIdFor(model: LoadedPlaygroundModel): string {
  // The dispatcher derives ids from the filename; we encode SAMPLES with the
  // same prefix so we can spot the active sample in the picker.
  return model.id;
}

// ── downloads panel ───────────────────────────────────────────────────────
//
// Tools that "write a file" (bcf_export, model_save, export_*) push their
// artifact into `playgroundFiles` instead of triggering a browser download.
// This panel renders one row per file with an explicit Download button —
// the actual <a download> click only happens when the USER presses it,
// never auto-triggered.

function DownloadsPanel(): ReactNode {
  const files = usePlaygroundFiles();
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.22em]">
          downloads · {files.length}
        </span>
        <button
          onClick={() => playgroundFiles.clear()}
          style={{ ...mono, color: PAPER_DIM }}
          className="text-[10px] uppercase tracking-[0.18em] hover:text-white"
        >
          clear
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {files.map((f) => (
          <li
            key={f.id}
            className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12.5px]" style={{ color: PAPER }} title={f.filename}>
                {f.filename}
              </span>
              <span style={{ ...mono, color: PAPER_DIM }} className="shrink-0 text-[10px]">
                {formatFileBytes(f.size)}
              </span>
            </div>
            {f.description && (
              <span className="text-[10.5px] leading-snug" style={{ color: PAPER_DIM }}>
                {f.description}
              </span>
            )}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span style={{ ...mono, color: PAPER_DIM }} className="text-[9.5px] uppercase tracking-[0.18em]">
                from {f.source}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => playgroundFiles.remove(f.id)}
                  className="rounded p-1 text-white/40 hover:bg-white/5 hover:text-white"
                  aria-label="Remove"
                  title="Remove from list"
                >
                  <Trash2 size={12} />
                </button>
                <button
                  onClick={() => playgroundFiles.download(f.id)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-semibold"
                  style={{ background: ACCENT, color: NIGHT, ...mono }}
                >
                  <Download size={11} />
                  download
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── inline viewer panel ───────────────────────────────────────────────────

function ViewerPanel({
  model,
  open,
  onToggle,
  controllerRef,
}: {
  model: LoadedPlaygroundModel | null;
  open: boolean;
  onToggle: () => void;
  controllerRef: React.MutableRefObject<ViewerController | null>;
}): ReactNode {
  return (
    <div className={cn('border-b border-white/10 transition-[height]')}>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 hover:bg-white/[0.025]"
      >
        <span className="flex items-center gap-2">
          <Box size={13} style={{ color: ACCENT }} />
          <span className="text-[12px]" style={{ color: PAPER }}>
            3D viewer
          </span>
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.22em]">
            {open ? 'on' : 'off'} · inline · agent-driven
          </span>
        </span>
        <span className="flex items-center gap-2">
          {!model && (
            <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px]">
              load a model first
            </span>
          )}
          {open ? <ChevronDown size={14} style={{ color: PAPER_DIM }} /> : <ChevronRight size={14} style={{ color: PAPER_DIM }} />}
        </span>
      </button>
      {open && (
        <div className="relative h-[360px] w-full border-t border-white/10">
          <PlaygroundViewer
            ref={controllerRef}
            model={model}
            className="absolute inset-0"
          />
        </div>
      )}
    </div>
  );
}
