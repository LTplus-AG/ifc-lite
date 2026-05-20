/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Variant B — "Stage"
 *
 * Cinematic, dark-by-default, demo-driven. The point of this variant is to
 * make people feel the agent driving the model. So the hero is an animated
 * IFC wireframe that progressively colorises itself as a fake transcript
 * scrolls underneath ("agent: viewer_isolate IfcWall …"). Big confident
 * type, generous breathing room, and recipes shown as a horizontally
 * scrolling carousel of stylised agent conversations.
 *
 * Typography: Instrument Serif (italic, for the flex character) carries
 * display + numerals. Bricolage Grotesque (variable) does the body work.
 * JetBrains Mono for code. The chartreuse accent (#d6ff3f) is a nod to
 * construction-safety hi-vis — distinctive on a black field, never seen on
 * a generic SaaS landing.
 *
 * The variant explicitly forces dark on its own subtree without flipping
 * the global .dark class, so the rest of the SPA isn’t affected when the
 * user navigates away.
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Play,
  Sparkles,
  Sun,
  Terminal,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { HeroScene, HERO_STEPS, HERO_STEP_MS, type HeroStep } from './HeroScene';
import {
  CATALOG,
  CATEGORY_BLURBS,
  CATEGORY_ORDER,
  CLIENTS,
  EXAMPLES,
  FAMILY_ACCENT,
  MCP_VERSION,
  RECIPES,
  catalogStats,
  exampleCall,
  makeConfigSnippet,
  makeDeepLink,
  paramsFor,
  toolsByCategory,
  type ParamRow,
} from './data';
import type { CatalogTool, McpClient, McpClientId, ToolCategory } from './types';
import { scrollToAnchor, useCopyToClipboard, useDocumentMeta, useFonts } from './use-mcp-page';

const NIGHT = '#0a0a0c';
const NIGHT_2 = '#121215';
const PAPER = '#ede4d3';
const PAPER_DIM = '#9c9486';
const ACCENT = '#d6ff3f'; // hi-vis chartreuse
const ACCENT_2 = '#ff5cdc'; // magenta for hover/active
const RULE = 'rgba(237, 228, 211, 0.10)';

const stage: CSSProperties = {
  background: NIGHT,
  color: PAPER,
  fontFamily: '"Bricolage Grotesque", "Inter Tight", system-ui, sans-serif',
  fontFeatureSettings: '"ss01" 1, "ss02" 1, "cv11" 1',
};

const display: CSSProperties = {
  fontFamily: '"Instrument Serif", "Newsreader", Georgia, serif',
  fontWeight: 400,
  fontStyle: 'normal',
};

const mono: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

export function McpLanding(): ReactNode {
  useFonts(
    'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500;600&display=swap',
  );
  useDocumentMeta('@ifc-lite/mcp — drive an IFC from any LLM', NIGHT);

  return (
    <main style={stage} className="relative min-h-screen overflow-hidden antialiased">
      <BackdropGrain />
      <TopBar />
      <Hero />
      <FloatingScrollHint />
      <InstallSection />
      <RecipesSection />
      <CatalogSection />
      <Footer />
    </main>
  );
}

// ── backdrop ────────────────────────────────────────────────────────────────

function BackdropGrain(): ReactNode {
  // SVG fractal noise gives the dark field a subtle grain — keeps the page
  // from looking like flat black, especially on OLEDs.
  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full opacity-[0.08] mix-blend-overlay"
    >
      <filter id="g">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#g)" />
    </svg>
  );
}

// ── top bar ─────────────────────────────────────────────────────────────────

function TopBar(): ReactNode {
  return (
    <div className="relative z-10 border-b" style={{ borderColor: RULE }}>
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-5">
        <div className="flex items-baseline gap-3">
          {/* Brand also acts as the back-to-viewer affordance, but the
              Viewer link in the nav makes that explicit so it doesn't
              rely on users guessing. */}
          <a href="/" className="text-[16px] tracking-tight" style={{ color: PAPER, fontWeight: 600 }}>
            ifc-lite
          </a>
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.22em]">
            / mcp · {MCP_VERSION}
          </span>
        </div>
        <nav className="hidden items-center gap-7 text-[13.5px] sm:flex" style={{ color: PAPER_DIM, fontWeight: 500 }}>
          <a
            href="/"
            className="group inline-flex items-center gap-1 transition-colors hover:text-[var(--paper)]"
            style={{ ['--paper' as never]: PAPER }}
          >
            <ArrowLeft size={12} className="transition-transform group-hover:-translate-x-0.5" />
            Viewer
          </a>
          <a href="#install" className="transition-colors hover:text-[var(--paper)]" style={{ ['--paper' as never]: PAPER }}>Install</a>
          <a href="#recipes" className="transition-colors hover:text-[var(--paper)]" style={{ ['--paper' as never]: PAPER }}>Recipes</a>
          <a href="#tools" className="transition-colors hover:text-[var(--paper)]" style={{ ['--paper' as never]: PAPER }}>Tools</a>
        </nav>
        <a
          href="/mcp/playground"
          className="group relative inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium tracking-tight transition-colors"
          style={{ background: ACCENT, color: NIGHT, borderRadius: 999 }}
        >
          <Play size={12} fill={NIGHT} />
          Playground
          <ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────────

function Hero(): ReactNode {
  const stats = useMemo(() => catalogStats(), []);
  return (
    <section className="relative z-10 overflow-hidden">
      <div className="mx-auto max-w-[1280px] px-6 pt-20 pb-32 md:pt-32 md:pb-44">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 md:col-span-7">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.2em]" style={{ borderColor: RULE, color: ACCENT, ...mono }}>
              <Sparkles size={12} />
              new · @ifc-lite/mcp v{MCP_VERSION}
            </div>
            <h1
              className="text-[58px] leading-[0.92] tracking-[-0.022em] md:text-[112px]"
              style={{ ...display, color: PAPER }}
            >
              Drive a building.
              <br />
              <span style={{ fontStyle: 'italic', color: ACCENT }}>From a chat.</span>
            </h1>
            <p
              className="mt-8 max-w-[34rem] text-[18px] leading-[1.55] md:text-[20px]"
              style={{ color: PAPER_DIM, fontWeight: 400 }}
            >
              {stats.total} typed tools that let any LLM agent query, validate, mutate, and
              visualise real IFC building models. The same toolkit your engineers ship with, in a
              chat.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <a
                href="/mcp/playground"
                className="group relative inline-flex items-center gap-2 px-7 py-4 text-[15px] font-semibold tracking-tight"
                style={{ background: ACCENT, color: NIGHT, borderRadius: 6 }}
              >
                <Play size={14} fill={NIGHT} />
                Try in playground
                <ArrowUpRight size={14} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                <span
                  className="absolute -bottom-1 -right-1 -z-10 h-full w-full"
                  style={{ background: ACCENT_2, borderRadius: 6 }}
                  aria-hidden
                />
              </a>
              <button
                onClick={() => scrollToAnchor('install')}
                className="inline-flex items-center gap-2 px-6 py-4 text-[15px] font-medium tracking-tight transition-colors hover:bg-white/5"
                style={{ border: `1px solid ${PAPER}40`, color: PAPER, borderRadius: 6 }}
              >
                <Terminal size={14} />
                Install
              </button>
            </div>
            <div className="mt-12 flex flex-wrap items-center gap-x-10 gap-y-4">
              <Stat number={stats.total} label="typed tools" />
              <Stat number={stats.categories} label="categories" />
              <Stat number={5} label="MCP clients" />
              <Stat number={2} label="transports" sublabel="stdio · http" />
            </div>
          </div>

          <div className="col-span-12 md:col-span-5">
            <WireframeStage />
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ number, label, sublabel }: { number: number; label: string; sublabel?: string }): ReactNode {
  return (
    <div className="flex items-baseline gap-2">
      <span style={{ ...display, color: PAPER, fontStyle: 'italic' }} className="text-[44px] leading-none">
        {number}
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[12px] uppercase tracking-[0.18em]" style={{ color: PAPER_DIM, fontWeight: 600 }}>
          {label}
        </span>
        {sublabel && (
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px]">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Hero stage — a real Three.js building (HeroScene.tsx) driven by twelve
 * distinct agent-transcript steps. Each step:
 *
 *   • mutates the WebGL scene (colour / isolation / section / new entity / camera),
 *   • prints its tool-call line under the canvas,
 *   • optionally overlays a UI badge or panel (audit score, count histogram,
 *     bSDD pset list, BCF pin, describe-selection card).
 *
 * The 12-step loop covers 7 of the MCP categories (Discovery, Query,
 * Validation, Mutation, BCF, bSDD, Viewer) so a viewer instantly sees the
 * surface is much wider than "colour the walls".
 */
function WireframeStage(): ReactNode {
  const [step, setStep] = useState(0);
  // Pin position in container-local pixels, fed by HeroScene every rAF.
  const [pinFrame, setPinFrame] = useState<{ x: number; y: number; visible: boolean } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setStep((s) => (s + 1) % HERO_STEPS.length), HERO_STEP_MS);
    return () => clearTimeout(t);
  }, [step]);

  const current = HERO_STEPS[step];

  return (
    <div
      className="relative aspect-[4/5] w-full overflow-hidden rounded-lg border"
      style={{ borderColor: RULE, background: NIGHT_2 }}
    >
      {/* faint grid behind the canvas, masked outward so the building feels lit */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage: `linear-gradient(${RULE} 1px, transparent 1px), linear-gradient(90deg, ${RULE} 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
          maskImage: 'radial-gradient(ellipse at 50% 45%, transparent 12%, black 70%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 45%, transparent 12%, black 70%)',
        }}
      />
      {/* WebGL canvas */}
      <div className="absolute inset-0 z-10">
        <HeroScene step={step} className="h-full w-full" onPinFrame={setPinFrame} />
      </div>

      {/* per-step overlays (audit score, count histogram, pset list, pin caption, info card) */}
      <HeroOverlay step={current} pinFrame={pinFrame} />

      {/* progress dots */}
      <div className="absolute right-3 top-3 z-30 flex flex-col gap-1.5">
        {HERO_STEPS.map((_, i) => (
          <span
            key={i}
            className="block h-1 rounded-full transition-all"
            style={{
              background: i === step ? ACCENT : `${PAPER}40`,
              width: i === step ? 18 : 6,
            }}
          />
        ))}
      </div>

      {/* Transcript: verb as the story headline, technical line beneath.
         Both sit on a thin glass strip so the building stays the hero. */}
      <div
        className="absolute inset-x-0 bottom-0 z-30 border-t"
        style={{ borderColor: RULE, background: 'rgba(10,10,12,0.82)', backdropFilter: 'blur(10px)' }}
      >
        <div className="flex items-end gap-4 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div
              className="mb-0.5 flex items-center gap-2 text-[9.5px] uppercase tracking-[0.22em]"
              style={{ ...mono }}
            >
              <span className="inline-flex items-center gap-1.5" style={{ color: ACCENT }}>
                <span
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                  style={{ background: ACCENT }}
                />
                {current.family}
              </span>
              <span style={{ color: PAPER_DIM }}>· step {String(step + 1).padStart(2, '0')} / {HERO_STEPS.length}</span>
            </div>
            <div className="flex items-baseline gap-3">
              <span
                style={{ ...display, color: PAPER, fontStyle: 'italic' }}
                className="truncate text-[28px] leading-none tracking-[-0.01em]"
              >
                {current.verb}.
              </span>
              <code className="truncate text-[11.5px]" style={{ ...mono, color: PAPER_DIM }}>
                {current.line}
              </code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * HeroOverlay — sparse, iconic UI per step. Each one shows the smallest
 * possible "proof of action" so the canvas stays the hero. No prose, no
 * tool names duplicated from the transcript bar — just the result.
 *
 * Pointer-events are off everywhere so OrbitControls never lose clicks.
 */
function HeroOverlay({
  step,
  pinFrame,
}: {
  step: HeroStep;
  pinFrame: { x: number; y: number; visible: boolean } | null;
}): ReactNode {
  if (!step.overlay) return null;
  const o = step.overlay;

  const chrome =
    'absolute z-20 rounded-md border px-3 py-2.5 backdrop-blur-md pointer-events-none';
  const chromeStyle: CSSProperties = {
    borderColor: RULE,
    background: 'rgba(18,18,21,0.82)',
    color: PAPER,
    ...mono,
  };

  // ── Audit: huge score in display serif, single sparkline-y bar.
  if (o.kind === 'audit') {
    const pct = Math.max(0, Math.min(100, o.score));
    return (
      <div className={chrome} style={{ ...chromeStyle, left: 14, top: 14, width: 132 }}>
        <div className="flex items-baseline gap-1.5">
          <span style={{ ...display, color: ACCENT }} className="text-[44px] leading-none">{o.score}</span>
          <span className="text-[9px] uppercase tracking-[0.2em]" style={{ color: PAPER_DIM }}>
            / 100
          </span>
        </div>
        <div className="mt-2 h-px w-full" style={{ background: `${PAPER}22` }}>
          <div className="h-px transition-all" style={{ width: `${pct}%`, background: ACCENT }} />
        </div>
        <div className="mt-1.5 text-[9.5px] uppercase tracking-[0.2em]" style={{ color: PAPER_DIM }}>
          {o.note}
        </div>
      </div>
    );
  }

  // ── Counts: a tiny histogram. Tall numerals, faint type labels, a bar
  //    proportional to the largest row. Three rows max.
  if (o.kind === 'counts') {
    const max = Math.max(...o.rows.map((r) => r.n), 1);
    return (
      <div className={chrome} style={{ ...chromeStyle, left: 14, top: 14, width: 188 }}>
        <ul className="flex flex-col gap-2">
          {o.rows.map((row) => (
            <li key={row.type} className="grid grid-cols-[1fr_auto] items-baseline gap-2">
              <div>
                <div className="text-[9px] uppercase tracking-[0.22em]" style={{ color: PAPER_DIM }}>
                  Ifc{row.type}
                </div>
                <div className="mt-1 h-[2px] w-full" style={{ background: `${PAPER}18` }}>
                  <div
                    className="h-[2px] transition-all"
                    style={{ width: `${(row.n / max) * 100}%`, background: ACCENT }}
                  />
                </div>
              </div>
              <span style={{ ...display, color: PAPER }} className="text-[22px] leading-none">
                {row.n}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // ── Psets (bSDD): an alphanumeric data tag — Pset header rules + a few
  //    canonical properties with their datatypes. Reads as a real spec
  //    sheet, not a vague label list.
  if (o.kind === 'psets') {
    // Hard-coded sample property rows per Pset so the page renders even
    // before the live MCP tools/call response is wired up. Order kept
    // deterministic so the text doesn’t reflow between renders.
    const SAMPLE_ROWS: Record<string, Array<{ k: string; v: string; t: string }>> = {
      Pset_WallCommon: [
        { k: 'FireRating',     v: 'EI60',  t: 'string'  },
        { k: 'IsExternal',     v: 'true',  t: 'boolean' },
        { k: 'LoadBearing',    v: 'false', t: 'boolean' },
        { k: 'AcousticRating', v: 'R45',   t: 'string'  },
      ],
      Qto_WallBaseQuantities: [
        { k: 'Length', v: '5.20', t: 'm'   },
        { k: 'Height', v: '3.00', t: 'm'   },
        { k: 'Volume', v: '3.74', t: 'm³'  },
      ],
      Pset_ConcreteElementGeneral: [
        { k: 'StrengthClass', v: 'C30/37', t: 'string' },
        { k: 'AssemblyPlace', v: 'SITE',   t: 'enum'   },
      ],
    };

    return (
      <div
        className={chrome}
        style={{ ...chromeStyle, right: 14, top: 14, width: 280, padding: 0, overflow: 'hidden' }}
      >
        <header
          className="flex items-baseline justify-between gap-2 px-3 py-2 border-b"
          style={{ borderColor: RULE, background: 'rgba(46,95,199,0.18)' }}
        >
          <span className="text-[9.5px] uppercase tracking-[0.24em]" style={{ color: '#7aa2f7' }}>
            bSDD · IfcWall
          </span>
          <span className="text-[9.5px]" style={{ color: PAPER_DIM }}>
            {o.psets.length} Psets
          </span>
        </header>
        <div className="max-h-[260px] overflow-hidden">
          {o.psets.map((psetName) => {
            const rows = SAMPLE_ROWS[psetName] ?? [];
            return (
              <div key={psetName} className="border-b last:border-b-0" style={{ borderColor: RULE }}>
                <div
                  className="px-3 py-1.5 text-[10px] uppercase tracking-[0.18em]"
                  style={{ color: ACCENT, background: 'rgba(255,255,255,0.02)' }}
                >
                  {psetName}
                </div>
                {rows.length > 0 ? (
                  <table className="w-full">
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.k}>
                          <td className="px-3 py-0.5 text-[10.5px]" style={{ color: PAPER }}>{r.k}</td>
                          <td className="px-2 py-0.5 text-right text-[10.5px]" style={{ color: PAPER }}>
                            {r.v}
                          </td>
                          <td className="px-3 py-0.5 text-right text-[9px] uppercase tracking-[0.18em]" style={{ color: PAPER_DIM }}>
                            {r.t}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="px-3 py-1.5 text-[9.5px]" style={{ color: PAPER_DIM }}>
                    — schema only —
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── BCF pin caption — the pin itself lives in WebGL (a Sprite anchored
  //    to the wall), so this overlay is just the small alphanumeric label
  //    that follows the pin's projected screen position. Hidden if we
  //    don't have a fresh projection yet.
  if (o.kind === 'pin') {
    if (!pinFrame || !pinFrame.visible) return null;
    return (
      <div
        className={chrome}
        style={{
          ...chromeStyle,
          left: pinFrame.x + 22,
          top: pinFrame.y - 14,
          borderColor: '#ff3a3a55',
          padding: '4px 8px',
          background: 'rgba(40,12,12,0.86)',
        }}
      >
        <span className="text-[10.5px] tracking-[0.08em]" style={{ color: '#ffb6b6' }}>
          {o.ref}
        </span>
      </div>
    );
  }

  // ── Inspect card: a hairline frame, ref + at most two evidence lines.
  if (o.kind === 'card') {
    return (
      <div className={chrome} style={{ ...chromeStyle, right: 14, bottom: 78, width: 268 }}>
        <div style={{ ...display, color: PAPER }} className="text-[18px] leading-none">
          {o.ref}
        </div>
        <div className="mt-2 h-px w-full" style={{ background: `${PAPER}22` }} />
        <ul className="mt-2 flex flex-col gap-1">
          {o.lines.map((line, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span style={{ ...mono, color: ACCENT }} className="text-[9px]">
                ↳
              </span>
              <span className="text-[10.5px] leading-snug" style={{ color: PAPER }}>
                {line}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}

function FloatingScrollHint(): ReactNode {
  return (
    <button
      onClick={() => scrollToAnchor('install')}
      className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 flex-col items-center gap-2 md:flex"
      style={{ color: PAPER_DIM }}
    >
      <ArrowDown size={14} className="animate-bounce" />
      <span style={{ ...mono }} className="text-[10px] uppercase tracking-[0.2em]">scroll</span>
    </button>
  );
}

// ── install ─────────────────────────────────────────────────────────────────

function InstallSection(): ReactNode {
  const [openClient, setOpenClient] = useState<McpClientId | null>(null);
  const primary = CLIENTS.filter((c) => c.id !== 'goose');
  const goose = CLIENTS.find((c) => c.id === 'goose');

  return (
    <section id="install" className="relative z-10 border-t border-b py-24" style={{ borderColor: RULE }}>
      <div className="mx-auto max-w-[1280px] px-6">
        <SectionHeader number="01" eyebrow="Install" title="Pick your client. We brought a snippet." />

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {primary.map((c, i) => (
            <BigClientCard
              key={c.id}
              client={c}
              index={i}
              onOpen={() => setOpenClient(c.id)}
            />
          ))}
        </div>

        {goose && (
          <button
            onClick={() => setOpenClient('goose')}
            className="group mt-6 flex w-full items-center justify-between gap-4 rounded-md border px-6 py-5 text-left transition-colors hover:bg-white/5"
            style={{ borderColor: RULE }}
          >
            <div className="flex items-baseline gap-4">
              <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.2em]">also</span>
              <span className="text-[16px] font-medium" style={{ color: PAPER }}>{goose.name}</span>
              <span className="text-[13px]" style={{ color: PAPER_DIM }}>{goose.blurb}</span>
            </div>
            <ArrowUpRight size={16} style={{ color: PAPER_DIM }} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </button>
        )}
      </div>

      <Dialog open={openClient !== null} onOpenChange={(o) => !o && setOpenClient(null)}>
        <DialogContent
          className="max-w-2xl border-0 p-0 shadow-2xl"
          style={{ background: NIGHT_2, color: PAPER, borderRadius: 12 }}
        >
          <DialogTitle className="sr-only">Install instructions</DialogTitle>
          {openClient && <BigInstallDetail client={CLIENTS.find((c) => c.id === openClient)!} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function BigClientCard({
  client,
  index,
  onOpen,
}: {
  client: McpClient;
  index: number;
  onOpen: () => void;
}): ReactNode {
  return (
    <button
      onClick={onOpen}
      className="group relative flex flex-col gap-6 overflow-hidden rounded-xl border p-7 text-left transition-all hover:-translate-y-0.5"
      style={{ borderColor: RULE, background: NIGHT_2 }}
    >
      <div
        className="absolute -right-12 -top-12 h-40 w-40 rounded-full opacity-0 blur-3xl transition-opacity group-hover:opacity-30"
        style={{ background: ACCENT }}
        aria-hidden
      />
      <div className="flex items-baseline justify-between">
        <span style={{ ...mono, color: ACCENT }} className="text-[10px] uppercase tracking-[0.22em]">
          0{index + 1} / {client.deepLinkPrefix ? 'one-click' : 'paste config'}
        </span>
        <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px]">
          {client.deepLinkPrefix ?? 'manual'}
        </span>
      </div>
      <div>
        <h3
          className="text-[36px] leading-[0.95] tracking-[-0.01em] transition-colors group-hover:text-[var(--accent)]"
          style={{ ...display, color: PAPER, ['--accent' as never]: ACCENT }}
        >
          {client.name}
        </h3>
        <p className="mt-3 text-[14.5px] leading-[1.5]" style={{ color: PAPER_DIM }}>
          {client.blurb}
        </p>
      </div>
      <div className="flex items-center justify-between">
        <code style={{ ...mono, color: PAPER_DIM }} className="text-[10.5px] truncate" title={client.configHint}>
          {client.configHint.replace(/^~/, '~')}
        </code>
        <ArrowUpRight size={16} className="transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" style={{ color: PAPER }} />
      </div>
    </button>
  );
}

function BigInstallDetail({ client }: { client: McpClient }): ReactNode {
  const { copy, copiedKey } = useCopyToClipboard();
  const snippet = makeConfigSnippet(client.id);
  const deepLink = makeDeepLink(client.id);
  return (
    <div className="flex flex-col gap-5 p-6">
      <header>
        <span style={{ ...mono, color: ACCENT }} className="text-[10px] uppercase tracking-[0.22em]">
          install / {client.name}
        </span>
        <h2 style={{ ...display, color: PAPER }} className="mt-1 text-[34px] leading-[1] tracking-[-0.01em]">
          {client.deepLinkPrefix ? 'One click. Or copy.' : 'Drop in. Restart.'}
        </h2>
      </header>
      {deepLink && (
        <a
          href={deepLink}
          className="inline-flex w-fit items-center gap-2 rounded px-4 py-2 text-[13px]"
          style={{ background: ACCENT, color: NIGHT, ...mono, fontWeight: 600 }}
        >
          Open in {client.name} <ArrowUpRight size={13} />
        </a>
      )}
      <div className="rounded-lg border" style={{ borderColor: RULE, background: NIGHT }}>
        <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: RULE }}>
          <code style={{ ...mono, color: PAPER_DIM }} className="text-[10.5px]">
            {client.configHint}
          </code>
          <button
            onClick={() => copy(snippet, `b-${client.id}`)}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] hover:bg-white/5"
            style={{ ...mono, color: copiedKey === `b-${client.id}` ? ACCENT : PAPER }}
          >
            {copiedKey === `b-${client.id}` ? <Check size={12} /> : <Copy size={12} />}
            {copiedKey === `b-${client.id}` ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto px-4 py-4 text-[12.5px] leading-[1.55]" style={{ ...mono, color: PAPER }}>
          {snippet}
        </pre>
      </div>
    </div>
  );
}

// ── recipes (horizontal carousel) ───────────────────────────────────────────

function RecipesSection(): ReactNode {
  const { copy, copiedKey } = useCopyToClipboard();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ atStart: true, atEnd: false, page: 0, pages: 1 });

  // Recompute scroll state on scroll + resize. Drives the fade gradients
  // and the pagination dots underneath. Pages are computed from how many
  // cards actually fit in the viewport so dots and page indices stay in
  // sync — when the last few cards are all visible, the last dot becomes
  // (and stays) active instead of being unreachable.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const computeState = () => {
      const max = el.scrollWidth - el.clientWidth;
      const atStart = el.scrollLeft <= 4;
      const atEnd = max - el.scrollLeft <= 4;
      const cardWidth = 360 + 24;
      const cardsPerPage = Math.max(1, Math.floor(el.clientWidth / cardWidth));
      const pages = Math.max(1, Math.ceil(RECIPES.length / cardsPerPage));
      const rawPage = Math.round(el.scrollLeft / (cardsPerPage * cardWidth));
      const page = Math.max(0, Math.min(pages - 1, rawPage));
      setScrollState({ atStart, atEnd, page, pages });
    };
    computeState();
    el.addEventListener('scroll', computeState, { passive: true });
    const ro = new ResizeObserver(computeState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', computeState);
      ro.disconnect();
    };
  }, []);

  function scrollByCard(dir: -1 | 1) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * (360 + 24), behavior: 'smooth' });
  }

  return (
    <section id="recipes" className="relative z-10 border-b py-24" style={{ borderColor: RULE }}>
      <div className="mx-auto max-w-[1280px] px-6">
        <SectionHeader
          number="02"
          eyebrow="Recipes"
          title="Eight things to ask, once it’s installed."
          right={
            <div className="flex gap-2">
              <CarouselButton onClick={() => scrollByCard(-1)} dir="left" disabled={scrollState.atStart} />
              <CarouselButton onClick={() => scrollByCard(1)} dir="right" disabled={scrollState.atEnd} />
            </div>
          }
        />
      </div>

      {/* Full-bleed scroller wrapper so fades + spacers can sit outside the
          1280-max content column. The cards align to the same gutter as the
          section header by padding the scroller with a calc() that mirrors
          the centred content width. */}
      <div className="relative mt-12">
        <div
          ref={scrollerRef}
          className="flex snap-x snap-mandatory gap-6 overflow-x-auto pb-6 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            paddingLeft: 'max(1.5rem, calc((100vw - 1280px) / 2 + 1.5rem))',
            paddingRight: 'max(1.5rem, calc((100vw - 1280px) / 2 + 1.5rem))',
            scrollPaddingLeft: 'max(1.5rem, calc((100vw - 1280px) / 2 + 1.5rem))',
          }}
        >
          {RECIPES.map((recipe) => (
            <article
              key={recipe.id}
              className="relative flex w-[360px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border"
              style={{ borderColor: RULE, background: NIGHT_2 }}
            >
              <div
                className="border-b px-5 py-3"
                style={{
                  borderColor: RULE,
                  background: `linear-gradient(180deg, ${FAMILY_ACCENT[recipe.family]}18 0%, transparent 100%)`,
                }}
              >
                <span
                  style={{ ...mono, color: FAMILY_ACCENT[recipe.family] }}
                  className="text-[10px] uppercase tracking-[0.22em]"
                >
                  / {recipe.family}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-4 p-5">
                <h3
                  style={{ ...display, color: PAPER }}
                  className="text-[26px] leading-[1.05] tracking-[-0.01em]"
                >
                  {recipe.title}
                </h3>

                <div
                  className="rounded-md border bg-black/40 p-4 text-[12.5px] leading-[1.55]"
                  style={{ ...mono, borderColor: RULE, color: PAPER }}
                >
                  <div
                    className="mb-2 flex items-center gap-2 text-[9.5px] uppercase tracking-[0.2em]"
                    style={{ color: PAPER_DIM }}
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: FAMILY_ACCENT[recipe.family] }}
                    />
                    user
                  </div>
                  <p style={{ color: PAPER }}>{recipe.prompt}</p>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {recipe.uses.slice(0, 3).map((tool) => (
                      <a
                        key={tool}
                        href={`#${tool}`}
                        onClick={(e) => {
                          e.preventDefault();
                          scrollToAnchor(tool);
                        }}
                        style={{ ...mono, color: PAPER_DIM, borderColor: RULE }}
                        className="rounded-full border px-2 py-0.5 text-[10px] hover:text-white"
                      >
                        {tool}
                      </a>
                    ))}
                  </div>
                  <button
                    onClick={() => copy(recipe.prompt, `b-r-${recipe.id}`)}
                    className="inline-flex items-center gap-1 text-[11px]"
                    style={{ ...mono, color: copiedKey === `b-r-${recipe.id}` ? ACCENT : PAPER_DIM }}
                  >
                    {copiedKey === `b-r-${recipe.id}` ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === `b-r-${recipe.id}` ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>

        {/* edge fades — purely cosmetic, must not eat clicks */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-16 transition-opacity"
          style={{
            background: `linear-gradient(to right, ${'rgb(10 10 12)'} 10%, transparent)`,
            opacity: scrollState.atStart ? 0 : 1,
          }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-32 transition-opacity"
          style={{
            background: `linear-gradient(to left, ${'rgb(10 10 12)'} 10%, transparent)`,
            opacity: scrollState.atEnd ? 0 : 1,
          }}
          aria-hidden
        />
      </div>

      {/* pagination dots */}
      <div className="mx-auto mt-2 flex max-w-[1280px] items-center justify-between gap-3 px-6">
        <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.2em]">
          {RECIPES.length} recipes · scroll →
        </span>
        <div className="flex items-center gap-1.5">
          {/* One dot per page (not per recipe), so as cards-per-page changes
              with viewport width the active highlight remains reachable. */}
          {Array.from({ length: scrollState.pages }, (_, i) => (
            <span
              key={i}
              className="block h-1 rounded-full transition-all"
              style={{
                background: i === scrollState.page ? ACCENT : `${PAPER}30`,
                width: i === scrollState.page ? 18 : 6,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function CarouselButton({
  onClick,
  dir,
  disabled,
}: {
  onClick: () => void;
  dir: 'left' | 'right';
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      style={{ borderColor: RULE, color: PAPER }}
      aria-label={dir === 'left' ? 'Scroll left' : 'Scroll right'}
    >
      <ArrowUpRight
        size={14}
        style={{ transform: dir === 'left' ? 'rotate(225deg)' : 'rotate(45deg)' }}
      />
    </button>
  );
}

// ── catalog ─────────────────────────────────────────────────────────────────

function CatalogSection(): ReactNode {
  const grouped = useMemo(() => toolsByCategory(), []);
  const [activeCat, setActiveCat] = useState<ToolCategory>('Viewer');

  return (
    <section id="tools" className="relative z-10 py-24">
      <div className="mx-auto max-w-[1280px] px-6">
        <SectionHeader
          number="03"
          eyebrow="Catalog"
          title={
            <>
              <span>{CATALOG.tools.length}</span>{' '}
              <span style={{ fontStyle: 'italic', color: ACCENT }}>typed tools.</span>{' '}
              <br className="hidden sm:block" />
              Everything an agent needs.
            </>
          }
        />

        <div className="mt-12 grid grid-cols-12 gap-6">
          <div className="col-span-12 md:col-span-3">
            <div className="md:sticky md:top-6 flex flex-row flex-wrap gap-2 md:flex-col">
              {CATEGORY_ORDER.map((cat) => {
                const isActive = activeCat === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveCat(cat)}
                    className={cn(
                      'group relative flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[13px] transition-all',
                      isActive ? 'border' : 'opacity-60 hover:opacity-100',
                    )}
                    style={{
                      borderColor: isActive ? ACCENT : RULE,
                      background: isActive ? `${ACCENT}14` : 'transparent',
                      color: PAPER,
                    }}
                  >
                    <span className="flex items-baseline gap-2 font-medium">
                      {cat}
                    </span>
                    <span
                      style={{ ...mono, color: isActive ? ACCENT : PAPER_DIM }}
                      className="text-[10.5px]"
                    >
                      {(grouped.get(cat) ?? []).length.toString().padStart(2, '0')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="col-span-12 md:col-span-9">
            <div className="rounded-xl border" style={{ borderColor: RULE, background: NIGHT_2 }}>
              <div className="border-b px-6 py-4" style={{ borderColor: RULE }}>
                <h3 style={{ ...display, color: PAPER }} className="text-[28px] leading-tight">
                  {activeCat}
                </h3>
                <p className="mt-1 text-[13.5px]" style={{ color: PAPER_DIM }}>
                  {CATEGORY_BLURBS[activeCat]}
                </p>
              </div>
              <ul className="divide-y" style={{ borderColor: RULE }}>
                {(grouped.get(activeCat) ?? []).map((tool) => (
                  <CatalogToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CatalogToolRow({ tool }: { tool: CatalogTool }): ReactNode {
  const [open, setOpen] = useState(false);
  const params = useMemo(() => paramsFor(tool), [tool]);
  const example = useMemo(() => exampleCall(tool), [tool]);
  const signature = useMemo(() => buildSignature(tool.name, params), [tool.name, params]);
  return (
    <li id={tool.name} className="scroll-mt-16">
      <button
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-12 items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-white/[0.025]"
        aria-expanded={open}
      >
        <div className="col-span-12 sm:col-span-4 flex items-center gap-3">
          <span style={{ ...mono, color: ACCENT }} className="text-[14px]">
            {tool.name}
          </span>
        </div>
        <div className="col-span-12 sm:col-span-7 text-[13px]" style={{ color: PAPER_DIM }}>
          {tool.description}
        </div>
        <div className="col-span-12 flex items-center justify-end gap-2 sm:col-span-1">
          <ScopePill scope={tool.scope} />
          <ChevronRight
            size={14}
            className={cn('transition-transform', open && 'rotate-90')}
            style={{ color: PAPER_DIM }}
          />
        </div>
      </button>
      {open && <CatalogToolDetail tool={tool} signature={signature} params={params} example={example} />}
    </li>
  );
}

/** Pretty function-style signature for the detail header. */
function buildSignature(name: string, params: ParamRow[]): string {
  if (params.length === 0) return `${name}()`;
  const reqd = params.filter((p) => p.required);
  if (reqd.length === 0) return `${name}({ … })`;
  return `${name}({ ${reqd.map((p) => p.name).join(', ')}${reqd.length < params.length ? ', …' : ''} })`;
}

function CatalogToolDetail({
  tool,
  signature,
  params,
  example,
}: {
  tool: CatalogTool;
  signature: string;
  params: ParamRow[];
  example: string;
}): ReactNode {
  const { copy, copiedKey } = useCopyToClipboard();
  return (
    <div className="mx-6 mb-5 grid grid-cols-12 gap-4 rounded-md border p-4" style={{ borderColor: RULE, background: NIGHT }}>
      {/* Signature */}
      <div className="col-span-12">
        <div className="mb-1 text-[10px] uppercase tracking-[0.22em]" style={{ ...mono, color: PAPER_DIM }}>
          Signature
        </div>
        <code className="block break-all text-[13px]" style={{ ...mono, color: ACCENT }}>
          {signature}
        </code>
        <p className="mt-2 text-[13px] leading-[1.55]" style={{ color: PAPER_DIM }}>
          {tool.description}
        </p>
      </div>

      {/* Parameter table */}
      <div className="col-span-12 lg:col-span-7">
        <div className="mb-2 text-[10px] uppercase tracking-[0.22em]" style={{ ...mono, color: PAPER_DIM }}>
          Parameters · {params.length}
        </div>
        {params.length === 0 ? (
          <p className="text-[12.5px]" style={{ color: PAPER_DIM }}>
            No parameters — call with <code style={{ ...mono }}>{`{}`}</code>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse">
              <thead>
                <tr style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.18em]">
                  <th className="border-b py-1.5 pr-4 text-left font-normal" style={{ borderColor: RULE }}>name</th>
                  <th className="border-b py-1.5 pr-4 text-left font-normal" style={{ borderColor: RULE }}>type</th>
                  <th className="border-b py-1.5 pr-4 text-left font-normal" style={{ borderColor: RULE }}>req</th>
                  <th className="border-b py-1.5 text-left font-normal" style={{ borderColor: RULE }}>description</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p.name} className="align-top">
                    <td className="border-b py-2 pr-4" style={{ borderColor: RULE }}>
                      <code className="text-[12.5px]" style={{ ...mono, color: PAPER }}>{p.name}</code>
                    </td>
                    <td className="border-b py-2 pr-4" style={{ borderColor: RULE }}>
                      <code className="text-[11.5px]" style={{ ...mono, color: '#73daca' }}>{p.type}</code>
                    </td>
                    <td className="border-b py-2 pr-4" style={{ borderColor: RULE }}>
                      {p.required ? (
                        <span style={{ ...mono, color: ACCENT_2 }} className="text-[10px] uppercase tracking-[0.18em]">
                          yes
                        </span>
                      ) : (
                        <span style={{ ...mono, color: PAPER_DIM }} className="text-[10px] uppercase tracking-[0.18em]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="border-b py-2 text-[12.5px] leading-[1.45]" style={{ borderColor: RULE, color: PAPER_DIM }}>
                      {p.description ?? <span className="opacity-40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Example call */}
      <div className="col-span-12 lg:col-span-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.22em]" style={{ ...mono, color: PAPER_DIM }}>
            Example call
          </span>
          <button
            onClick={() => copy(example, `ex-${tool.name}`)}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ ...mono, color: copiedKey === `ex-${tool.name}` ? ACCENT : PAPER_DIM }}
          >
            {copiedKey === `ex-${tool.name}` ? <Check size={12} /> : <Copy size={12} />}
            {copiedKey === `ex-${tool.name}` ? 'Copied' : 'Copy JSON-RPC'}
          </button>
        </div>
        <pre
          className="overflow-x-auto rounded-md border p-3 text-[11.5px] leading-[1.55]"
          style={{ ...mono, background: '#070709', borderColor: RULE, color: PAPER }}
        >
          {example}
        </pre>
      </div>

      {/* Footer actions */}
      <div className="col-span-12 flex flex-wrap items-center justify-between gap-3 border-t pt-3" style={{ borderColor: RULE }}>
        <a
          href={`#${tool.name}`}
          className="inline-flex items-center gap-1 text-[11px]"
          style={{ ...mono, color: PAPER_DIM }}
          onClick={(e) => {
            e.preventDefault();
            scrollToAnchor(tool.name);
            // also copy the deep link to clipboard for sharing
            const url = new URL(window.location.href);
            url.hash = tool.name;
            void navigator.clipboard?.writeText(url.toString()).catch(() => undefined);
          }}
        >
          # {tool.name} · share link
        </a>
        <a
          href={`/mcp/playground?prompt=${encodeURIComponent(`Call ${tool.name} with ${JSON.stringify(EXAMPLES[tool.name] ?? {})}`)}`}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px]"
          style={{ ...mono, background: ACCENT, color: NIGHT, fontWeight: 600 }}
        >
          Try in playground <ArrowUpRight size={12} />
        </a>
      </div>
    </div>
  );
}

function ScopePill({ scope }: { scope: CatalogTool['scope'] }): ReactNode {
  const colors: Record<CatalogTool['scope'], string> = {
    read: ACCENT,
    mutate: ACCENT_2,
    export: '#73daca',
  };
  return (
    <span
      style={{ ...mono, color: colors[scope], borderColor: `${colors[scope]}50` }}
      className="rounded-full border px-2 py-0.5 text-[9.5px] uppercase tracking-[0.18em]"
    >
      {scope}
    </span>
  );
}

// ── footer ──────────────────────────────────────────────────────────────────

function Footer(): ReactNode {
  return (
    <footer className="relative z-10 border-t" style={{ borderColor: RULE }}>
      <div className="mx-auto max-w-[1280px] px-6 py-14">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 md:col-span-6">
            <h3 style={{ ...display, color: PAPER }} className="text-[44px] leading-[0.95] tracking-[-0.01em]">
              Bring your model.<br />
              <span style={{ fontStyle: 'italic', color: ACCENT }}>We brought the tools.</span>
            </h3>
            <a
              href="/mcp/playground"
              className="mt-6 inline-flex items-center gap-2 px-6 py-3 text-[14px] font-semibold"
              style={{ background: ACCENT, color: NIGHT, borderRadius: 6 }}
            >
              Open the playground <ArrowUpRight size={14} />
            </a>
          </div>
          <nav className="col-span-12 grid grid-cols-3 gap-6 md:col-span-6 text-[13px]">
            <FooterCol heading="Source" links={[
              { href: 'https://github.com/LTplus-AG/ifc-lite', label: 'GitHub' },
              { href: 'https://www.npmjs.com/package/@ifc-lite/mcp', label: 'npm' },
            ]} />
            <FooterCol heading="Docs" links={[
              { href: '/mcp/playground', label: 'Playground' },
              { href: '/', label: 'Viewer' },
            ]} />
            <FooterCol heading="Spec" links={[
              { href: 'https://modelcontextprotocol.io', label: 'MCP' },
              { href: 'https://technical.buildingsmart.org', label: 'IFC' },
            ]} />
          </nav>
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t pt-6" style={{ borderColor: RULE }}>
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10.5px]">
            ifc-lite/mcp · v{MCP_VERSION} · MPL-2.0
          </span>
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10.5px] flex items-center gap-1.5">
            <Sun size={11} />
            Dark by intent.
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ heading, links }: { heading: string; links: { href: string; label: string }[] }): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <span style={{ ...mono, color: ACCENT }} className="text-[10px] uppercase tracking-[0.22em]">
        {heading}
      </span>
      {links.map((l) => (
        <a key={l.href} href={l.href} className="text-[13px] transition-colors hover:text-[var(--p)]" style={{ color: PAPER_DIM, ['--p' as never]: PAPER }}>
          {l.label}
        </a>
      ))}
    </div>
  );
}

// ── shared shells ───────────────────────────────────────────────────────────

function SectionHeader({
  number,
  eyebrow,
  title,
  right,
}: {
  number: string;
  eyebrow: string;
  title: ReactNode;
  right?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="mb-3 flex items-baseline gap-3">
          <span style={{ ...mono, color: ACCENT }} className="text-[11px] uppercase tracking-[0.22em]">
            §{number}
          </span>
          <span style={{ ...mono, color: PAPER_DIM }} className="text-[10.5px] uppercase tracking-[0.2em]">
            {eyebrow}
          </span>
        </div>
        <h2
          style={{ ...display, color: PAPER }}
          className="max-w-[40rem] text-[44px] leading-[1.02] tracking-[-0.015em] md:text-[60px]"
        >
          {title}
        </h2>
      </div>
      {right}
    </div>
  );
}
