/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// app.jsx · IFClite landing interactive bits
// Code tabs, package picker, bench explorer, stack builder.

const { useState, useEffect, useMemo, useRef } = React;

// ─────────────────────────── code samples ───────────────────────────
const CODE_SAMPLES = [
  {
    id: "parse",
    label: "Parse",
    title: "Parse a file",
    desc: "Async with progress events. ~1,259 MB/s tokenized on M1/M2. Schema-aware down to property sets.",
    imports: ["@ifc-lite/parser"],
    code: `<span class="kw">import</span> { <span class="ty">IfcParser</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/parser'</span><span class="punct">;</span>

<span class="kw">const</span> <span class="var">parser</span> <span class="punct">=</span> <span class="kw">new</span> <span class="ty">IfcParser</span>()<span class="punct">;</span>
<span class="kw">const</span> <span class="var">buf</span> <span class="punct">=</span> <span class="kw">await</span> <span class="fn">fetch</span>(<span class="str">'model.ifc'</span>)<span class="punct">.</span><span class="fn">then</span>(r <span class="punct">=&gt;</span> r<span class="punct">.</span><span class="fn">arrayBuffer</span>())<span class="punct">;</span>

<span class="kw">const</span> <span class="var">result</span> <span class="punct">=</span> <span class="kw">await</span> <span class="var">parser</span><span class="punct">.</span><span class="fn">parse</span>(<span class="var">buf</span><span class="punct">,</span> {
  <span class="fn">onProgress</span><span class="punct">:</span> ({ phase<span class="punct">,</span> percent }) <span class="punct">=&gt;</span>
    <span class="fn">console</span><span class="punct">.</span><span class="fn">log</span>(<span class="str">\`\${phase}: \${percent}%\`</span>)<span class="punct">,</span>
})<span class="punct">;</span>

<span class="cmt">// → 142,883 entities &middot; IFC4 &middot; 312 ms</span>
<span class="fn">console</span><span class="punct">.</span><span class="fn">log</span>(<span class="var">result</span><span class="punct">.</span>entityCount<span class="punct">,</span> <span class="var">result</span><span class="punct">.</span>schemaVersion)<span class="punct">;</span>`,
  },
  {
    id: "view",
    label: "View",
    title: "WebGPU viewer",
    desc: "Pass it a canvas. Picking, instancing, fit-to-view included. Or hand the meshes to Three.js / Babylon.js if you already have an engine.",
    imports: ["@ifc-lite/parser", "@ifc-lite/geometry", "@ifc-lite/renderer"],
    code: `<span class="kw">import</span> { <span class="ty">IfcParser</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/parser'</span><span class="punct">;</span>
<span class="kw">import</span> { <span class="ty">GeometryProcessor</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/geometry'</span><span class="punct">;</span>
<span class="kw">import</span> { <span class="ty">Renderer</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/renderer'</span><span class="punct">;</span>

<span class="kw">const</span> <span class="var">renderer</span> <span class="punct">=</span> <span class="kw">new</span> <span class="ty">Renderer</span>(<span class="var">canvas</span>)<span class="punct">;</span>
<span class="kw">const</span> <span class="var">geom</span> <span class="punct">=</span> <span class="kw">new</span> <span class="ty">GeometryProcessor</span>()<span class="punct">;</span>
<span class="kw">await</span> <span class="ty">Promise</span><span class="punct">.</span><span class="fn">all</span>([<span class="var">renderer</span><span class="punct">.</span><span class="fn">init</span>()<span class="punct">,</span> <span class="var">geom</span><span class="punct">.</span><span class="fn">init</span>()])<span class="punct">;</span>

<span class="kw">const</span> <span class="var">meshes</span> <span class="punct">=</span> <span class="kw">await</span> <span class="var">geom</span><span class="punct">.</span><span class="fn">process</span>(<span class="var">buffer</span>)<span class="punct">;</span>
<span class="var">renderer</span><span class="punct">.</span><span class="fn">loadGeometry</span>(<span class="var">meshes</span>)<span class="punct">;</span>
<span class="var">renderer</span><span class="punct">.</span><span class="fn">fitToView</span>()<span class="punct">;</span> <span class="var">renderer</span><span class="punct">.</span><span class="fn">render</span>()<span class="punct">;</span>

<span class="cmt">// Pick at (x, y) in canvas pixels</span>
<span class="kw">const</span> <span class="var">hit</span> <span class="punct">=</span> <span class="kw">await</span> <span class="var">renderer</span><span class="punct">.</span><span class="fn">pick</span>(<span class="num">120</span><span class="punct">,</span> <span class="num">240</span>)<span class="punct">;</span>`,
  },
  {
    id: "query",
    label: "Query",
    title: "Type + property filters, or SQL",
    desc: "Fluent builder for common cases, DuckDB-WASM for the rest. Columnar TypedArray storage stays fast on million-entity models.",
    imports: ["@ifc-lite/query"],
    code: `<span class="kw">import</span> { <span class="ty">IfcQuery</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/query'</span><span class="punct">;</span>

<span class="kw">const</span> <span class="var">query</span> <span class="punct">=</span> <span class="kw">new</span> <span class="ty">IfcQuery</span>(<span class="var">store</span>)<span class="punct">;</span>

<span class="cmt">// External, load-bearing walls</span>
<span class="kw">const</span> <span class="var">walls</span> <span class="punct">=</span> <span class="var">query</span>
  <span class="punct">.</span><span class="fn">ofType</span>(<span class="str">'IfcWall'</span><span class="punct">,</span> <span class="str">'IfcWallStandardCase'</span>)
  <span class="punct">.</span><span class="fn">whereProperty</span>(<span class="str">'Pset_WallCommon'</span><span class="punct">,</span> <span class="str">'IsExternal'</span><span class="punct">,</span> <span class="str">'='</span><span class="punct">,</span> <span class="kw">true</span>)
  <span class="punct">.</span><span class="fn">whereProperty</span>(<span class="str">'Pset_WallCommon'</span><span class="punct">,</span> <span class="str">'LoadBearing'</span><span class="punct">,</span> <span class="str">'='</span><span class="punct">,</span> <span class="kw">true</span>)
  <span class="punct">.</span><span class="fn">execute</span>()<span class="punct">;</span>

<span class="cmt">// Or drop into SQL when the builder runs out</span>
<span class="kw">const</span> <span class="var">top</span> <span class="punct">=</span> <span class="kw">await</span> <span class="var">query</span><span class="punct">.</span><span class="fn">sql</span>(<span class="str">\`
  SELECT type, COUNT(*) AS n FROM entities
  GROUP BY type ORDER BY n DESC LIMIT 10
\`</span>)<span class="punct">;</span>`,
  },
  {
    id: "edit",
    label: "Edit",
    title: "Edit properties with undo",
    desc: "Mutation layer over the columnar store. Track changes, replay, undo. STEP exporter applies pending mutations on export.",
    imports: ["@ifc-lite/mutations", "@ifc-lite/data"],
    code: `<span class="kw">import</span> { <span class="ty">MutablePropertyView</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/mutations'</span><span class="punct">;</span>
<span class="kw">import</span> { <span class="ty">PropertyValueType</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/data'</span><span class="punct">;</span>

<span class="kw">const</span> <span class="var">view</span> <span class="punct">=</span> <span class="kw">new</span> <span class="ty">MutablePropertyView</span>(<span class="var">store</span><span class="punct">.</span>properties<span class="punct">,</span> <span class="str">'model-a'</span>)<span class="punct">;</span>

<span class="var">view</span><span class="punct">.</span><span class="fn">setProperty</span>(
  <span class="var">wallExpressId</span><span class="punct">,</span>
  <span class="str">'Pset_WallCommon'</span><span class="punct">,</span>
  <span class="str">'FireRating'</span><span class="punct">,</span>
  <span class="str">'REI 120'</span><span class="punct">,</span>
  <span class="ty">PropertyValueType</span><span class="punct">.</span>Label<span class="punct">,</span>
)<span class="punct">;</span>

<span class="cmt">// Replayable change history; round-trips through STEP</span>
<span class="kw">const</span> <span class="var">log</span> <span class="punct">=</span> <span class="var">view</span><span class="punct">.</span><span class="fn">getMutations</span>()<span class="punct">;</span>`,
  },
  {
    id: "validate",
    label: "Validate",
    title: "Run IDS specifications",
    desc: "Run IDS specifications against a model. Structured pass/fail report, translated failure messages, BCF handoff.",
    imports: ["@ifc-lite/ids"],
    code: `<span class="kw">import</span> { <span class="fn">parseIDS</span><span class="punct">,</span> <span class="fn">validateIDS</span><span class="punct">,</span> <span class="fn">createTranslationService</span> } <span class="kw">from</span> <span class="str">'@ifc-lite/ids'</span><span class="punct">;</span>

<span class="kw">const</span> <span class="var">spec</span> <span class="punct">=</span> <span class="fn">parseIDS</span>(<span class="var">idsXml</span>)<span class="punct">;</span>
<span class="kw">const</span> <span class="var">t</span> <span class="punct">=</span> <span class="fn">createTranslationService</span>(<span class="str">'en'</span>)<span class="punct">;</span>
<span class="kw">const</span> <span class="var">report</span> <span class="punct">=</span> <span class="kw">await</span> <span class="fn">validateIDS</span>(<span class="var">spec</span><span class="punct">,</span> <span class="var">store</span><span class="punct">,</span> { <span class="fn">translator</span><span class="punct">:</span> <span class="var">t</span> })<span class="punct">;</span>

<span class="kw">for</span> (<span class="kw">const</span> <span class="var">s</span> <span class="kw">of</span> <span class="var">report</span><span class="punct">.</span>specificationResults) {
  <span class="fn">console</span><span class="punct">.</span><span class="fn">log</span>(<span class="str">\`\${s.specificationName}: \${s.passRate}% passed\`</span>)<span class="punct">;</span>
}

<span class="cmt">// Architecture: 96% &middot; Fire Safety: 100% &middot; Acoustics: 84%</span>`,
  },
  {
    id: "export",
    label: "Export",
    title: "STEP, glTF, Parquet, IFCX",
    desc: "Write STEP for round-trips. glTF for the web. Parquet for analytics (~20× smaller than JSON). IFC5 / IFCX JSON.",
    imports: ["@ifc-lite/export"],
    code: `<span class="kw">import</span> {
  <span class="fn">exportToStep</span><span class="punct">,</span>
  <span class="ty">GLTFExporter</span><span class="punct">,</span>
  <span class="ty">ParquetExporter</span><span class="punct">,</span>
  <span class="ty">Ifc5Exporter</span><span class="punct">,</span>
} <span class="kw">from</span> <span class="str">'@ifc-lite/export'</span><span class="punct">;</span>

<span class="cmt">// Back to STEP, applying any pending edits</span>
<span class="kw">const</span> <span class="var">step</span> <span class="punct">=</span> <span class="fn">exportToStep</span>(<span class="var">store</span><span class="punct">,</span> { <span class="fn">schema</span><span class="punct">:</span> <span class="str">'IFC4'</span><span class="punct">,</span> <span class="fn">applyMutations</span><span class="punct">:</span> <span class="kw">true</span> })<span class="punct">;</span>

<span class="cmt">// glTF / GLB for the web</span>
<span class="kw">const</span> <span class="var">glb</span> <span class="punct">=</span> <span class="kw">await</span> <span class="kw">new</span> <span class="ty">GLTFExporter</span>()<span class="punct">.</span><span class="fn">export</span>(<span class="var">parseResult</span><span class="punct">,</span> { <span class="fn">format</span><span class="punct">:</span> <span class="str">'glb'</span> })<span class="punct">;</span>

<span class="cmt">// Parquet, queryable from DuckDB, Polars, pandas</span>
<span class="kw">const</span> <span class="var">parquet</span> <span class="punct">=</span> <span class="kw">await</span> <span class="kw">new</span> <span class="ty">ParquetExporter</span>()<span class="punct">.</span><span class="fn">exportEntities</span>(<span class="var">parseResult</span>)<span class="punct">;</span>`,
  },
];

function CodeTabs() {
  const [active, setActive] = useState("parse");
  const sample = CODE_SAMPLES.find((s) => s.id === active);
  return (
    <div className="codeblock">
      <div className="codeblock-tabs" role="tablist" aria-label="API examples">
        {CODE_SAMPLES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={active === s.id}
            className="codeblock-tab"
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="codeblock-body">
        <div className="codeblock-desc">
          <h4>{sample.title}</h4>
          <p>{sample.desc}</p>
          <div className="imports">
            {sample.imports.map((i) => (
              <span key={i} className="imp">{i}</span>
            ))}
          </div>
        </div>
        <pre className="codeblock-pre" dangerouslySetInnerHTML={{ __html: sample.code }} />
      </div>
    </div>
  );
}

// ─────────────────────────── conveyor pipeline ───────────────────────────
// Real IFC sample: apps/landing/samples/hello-wall.ifc (Bonsai-authored IFC4).
// Parse and View use the real file. Query, Edit, Validate operate on a richer curated set
// of named entities so the demos can show meaningful filtering, mixed FireRating, etc.
const HELLO_WALL_PATH = "samples/hello-wall.ifc";
const HELLO_WALL_NAMED = [
  { id: 1,    type: "IfcProject",         name: "Demo House" },
  { id: 30,   type: "IfcSite",            name: "Site" },
  { id: 36,   type: "IfcBuilding",        name: "House" },
  { id: 42,   type: "IfcBuildingStorey",  name: "Level 1" },
  // Walls: 4 total, mixed FireRating to make Validate interesting
  { id: 1222, type: "IfcWall",            name: "Wall-North", height: 3.0, length: 10.0, fireRating: null },
  { id: 2001, type: "IfcWall",            name: "Wall-South", height: 3.0, length: 10.0, fireRating: "REI60" },
  { id: 2002, type: "IfcWall",            name: "Wall-East",  height: 3.0, length:  5.0, fireRating: "REI60" },
  { id: 2003, type: "IfcWall",            name: "Wall-West",  height: 2.2, length:  5.0, fireRating: null },
  // Slabs
  { id: 2010, type: "IfcSlab",            name: "Floor",      area: 50.0 },
  { id: 2011, type: "IfcSlab",            name: "Roof",       area: 50.0 },
  // Openings
  { id: 1262, type: "IfcWindow",          name: "Window-S1",  height: 1.2, width: 0.9 },
  { id: 1407, type: "IfcWindow",          name: "Window-S2",  height: 1.2, width: 0.9 },
  { id: 2020, type: "IfcWindow",          name: "Window-N",   height: 1.4, width: 1.5 },
  { id: 2030, type: "IfcDoor",            name: "Door-Main",  height: 2.1, width: 0.9 },
  { id: 2031, type: "IfcDoor",            name: "Door-Back",  height: 2.1, width: 0.8 },
  // Spaces
  { id: 1494, type: "IfcSpace",           name: "Living",     area: 22.0 },
  { id: 2040, type: "IfcSpace",           name: "Kitchen",    area: 12.0 },
  { id: 2041, type: "IfcSpace",           name: "Bathroom",   area:  6.0 },
  // Structural
  { id: 2050, type: "IfcColumn",          name: "Column-1",   height: 3.0 },
  { id: 2051, type: "IfcColumn",          name: "Column-2",   height: 3.0 },
];

// Convert IFC uppercase form (IFCWALL) to Title case (IfcWall) for display.
function ifcTitleCase(raw) {
  return "Ifc" + raw.charAt(0) + raw.slice(1).toLowerCase();
}

// Parse a STEP file's data lines into {id, type, name} chips.
// Stops at maxEntities so we don't choke the browser on big files.
function parseIfcEntities(text, maxEntities = 40) {
  const out = [];
  if (!text) return out;
  const re = /^#(\d+)=IFC([A-Z_]+)\(/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = Number(m[1]);
    const type = ifcTitleCase(m[2]);
    // Try to extract Name (typically the second quoted field after a $ or GUID).
    const lineEnd = text.indexOf("\n", m.index);
    const line = text.slice(m.index, lineEnd === -1 ? undefined : lineEnd);
    const nameMatch = line.match(/'[^']*',\$?[^,]*,'([^']*)'/);
    const name = nameMatch ? nameMatch[1] : null;
    out.push({ id, type, name });
    if (out.length >= maxEntities) break;
  }
  return out;
}

const STAGES = [
  { id: "parse",    num: "01", title: "Parse",    blurb: "STEP · IFCX" },
  { id: "view",     num: "02", title: "View",     blurb: "WebGPU + point cloud" },
  { id: "query",    num: "03", title: "Query",    blurb: "Fluent · SQL" },
  { id: "edit",     num: "04", title: "Edit",     blurb: "Mutate · author" },
  { id: "validate", num: "05", title: "Validate", blurb: "IDS · BCF" },
  { id: "export",   num: "06", title: "Export",   blurb: "STEP · glTF · Parquet · IFCX · 2D" },
  { id: "automate", num: "07", title: "Automate", blurb: "CLI · SDK · MCP" },
];

const STAGE_DEMOS = {
  parse:    ParseDemo,
  view:     ViewDemo,
  query:    QueryDemo,
  edit:     EditDemo,
  validate: ValidateDemo,
  export:   ExportDemo,
  automate: AutomateDemo,
};

function ConveyorPipeline() {
  const [active, setActive] = useState("parse");
  const [ifcText, setIfcText] = useState(null);
  const [entities, setEntities] = useState([]);
  const [mountedSet, setMountedSet] = useState(() => new Set(["parse"]));

  // Fetch real IFC sample once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch(HELLO_WALL_PATH)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText)))
      .then((text) => {
        if (cancelled) return;
        setIfcText(text);
        setEntities(parseIfcEntities(text, 40));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Once a stage is visited, keep it mounted for instant tab switches.
  useEffect(() => {
    setMountedSet((s) => (s.has(active) ? s : new Set([...s, active])));
  }, [active]);

  // Pre-mount the View stage on idle so the embed iframe (~5 MB of WASM + the
  // demo model) loads in the background; by the time the user clicks View, the
  // model is already parsed, the camera has auto-fitted, and the panel becomes
  // visible instantly. The panel stays display:none until activated — modern
  // browsers still load DOM-mounted iframes inside hidden parents.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const preload = () => {
      if (cancelled) return;
      setMountedSet((s) => (s.has("view") ? s : new Set([...s, "view"])));
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 2500 });
      return () => { cancelled = true; window.cancelIdleCallback?.(id); };
    }
    const id = window.setTimeout(preload, 1500);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, []);

  const activeIndex = STAGES.findIndex((s) => s.id === active);
  const move = (delta) => {
    const next = Math.max(0, Math.min(STAGES.length - 1, activeIndex + delta));
    setActive(STAGES[next].id);
  };
  const onKey = (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    if (e.key === "ArrowLeft")  { e.preventDefault(); move(-1); }
  };

  const sharedProps = { ifcText, entities, ifcPath: HELLO_WALL_PATH };

  return (
    <div className="conveyor" onKeyDown={onKey}>
      <div className="conveyor-rail" role="tablist" aria-label="Pipeline stages">
        {STAGES.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && (
              <span className="conveyor-link" data-on={activeIndex >= i} aria-hidden="true" />
            )}
            <button
              role="tab"
              aria-selected={active === s.id}
              aria-controls={`conveyor-panel-${s.id}`}
              id={`conveyor-tab-${s.id}`}
              tabIndex={active === s.id ? 0 : -1}
              className="conveyor-stage"
              data-active={active === s.id}
              data-passed={activeIndex > i}
              onClick={() => setActive(s.id)}
            >
              <span className="conveyor-num mono">{s.num}</span>
              <span className="conveyor-title">{s.title}</span>
              <span className="conveyor-blurb mono">{s.blurb}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
      <div className="conveyor-panel">
        {STAGES.map((s) => {
          if (!mountedSet.has(s.id)) return null;
          const Demo = STAGE_DEMOS[s.id];
          const hidden = s.id !== active ? { display: "none" } : null;
          return (
            <div
              key={s.id}
              style={hidden}
              role="tabpanel"
              id={`conveyor-panel-${s.id}`}
              aria-labelledby={`conveyor-tab-${s.id}`}
            >
              <Demo {...sharedProps} active={s.id === active} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── stage demos ───────────────────────────────────────────────────────────
function ParseDemo({ ifcText, entities }) {
  const [phase, setPhase] = useState("idle");
  const [streamIdx, setStreamIdx] = useState(0);
  const intervalRef = useRef(null);
  const total = entities.length;

  useEffect(() => () => intervalRef.current && clearInterval(intervalRef.current), []);

  const start = () => {
    if (phase === "running" || !total) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setPhase("running");
    setStreamIdx(0);
    intervalRef.current = setInterval(() => {
      setStreamIdx((i) => {
        if (i >= total) {
          clearInterval(intervalRef.current);
          setPhase("done");
          return i;
        }
        return i + 1;
      });
    }, 80);
  };

  const reset = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setPhase("idle");
    setStreamIdx(0);
  };

  const stepDisplay = ifcText
    ? (ifcText.length > 1800 ? ifcText.slice(0, 1800) + "\n  …" : ifcText)
    : "loading hello-wall.ifc…";
  const fileSize = ifcText ? (ifcText.length / 1024).toFixed(1) + " KB" : "…";

  return (
    <div className="demo demo-parse">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/parser · hello-wall.ifc</span>
          <h3>Read the file</h3>
          <p>Schema-aware reader. Streams entities into a columnar TypedArray store. Returns properties, quantities, relationships, and spatial structure.</p>
        </div>
        <div className="demo-actions">
          {phase !== "running" ? (
            <button className="btn btn-primary demo-run" onClick={start} disabled={!total}>
              {phase === "done" ? "↻ Re-parse" : "▶ Parse"}
            </button>
          ) : (
            <button className="btn btn-ghost demo-run" onClick={reset}>■ Stop</button>
          )}
        </div>
      </div>
      <div className="demo-split">
        <div className="demo-pane demo-pane-code">
          <div className="demo-pane-head">
            <span className="mono">hello-wall.ifc</span>
            <span className="mono demo-pane-meta">STEP · {fileSize}</span>
          </div>
          <pre className="demo-step">{stepDisplay}</pre>
        </div>
        <div className="demo-pane demo-pane-stream">
          <div className="demo-pane-head">
            <span className="mono">entities</span>
            <span className="mono demo-pane-meta">{streamIdx}/{total} shown · 1,045 total</span>
          </div>
          <div className="demo-stream">
            {entities.slice(0, streamIdx).map((e) => (
              <span key={e.id} className="demo-chip">
                <span className="mono demo-chip-id">#{e.id}</span>
                <span className="demo-chip-type">{e.type}</span>
                {e.name && <span className="demo-chip-name mono">{e.name}</span>}
              </span>
            ))}
            {phase === "idle" && (
              <div className="demo-empty demo-empty-cta">Hit ▶ Parse to stream entities</div>
            )}
          </div>
          {phase === "done" && (
            <div className="demo-stream-done">
              <span className="mono">✓ 1,045 entities · IFC4</span>
              <span className="demo-stream-time mono">0.04 s</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ViewDemo() {
  // The iframe mounts as soon as this component renders. ConveyorPipeline
  // pre-mounts the View panel on idle (in a display:none parent) so the embed
  // boots + auto-loads the model before the user clicks the View tab — making
  // the switch feel instant. Modern browsers still fetch and run scripts in
  // iframes inside hidden ancestors.

  // Mirror the landing's theme into the embed so a light-mode visitor doesn't get a
  // black iframe popping out of the page. The embed treats anything other than
  // 'dark' as light, so we only forward when we're definitely in dusk.
  const [embedTheme, setEmbedTheme] = useState(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dusk" ? "dark" : "light"
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setEmbedTheme(document.documentElement.dataset.theme === "dusk" ? "dark" : "light");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // embed.ifclite.com/v1 is the trimmed viewer with built-in URL-param model autoload.
  // hello-wall.ifc is hosted on www.ifclite.com with CORS open.
  const modelUrl = "https://www.ifclite.com/samples/hello-wall.ifc";
  const iframeSrc = `https://embed.ifclite.com/v1?modelUrl=${encodeURIComponent(modelUrl)}&theme=${embedTheme}&autoLoad=true`;

  return (
    <div className="demo demo-view">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/viewer-core · @ifc-lite/renderer · @ifc-lite/pointcloud</span>
          <h3>Inspect the model</h3>
          <p>The real viewer, embedded. hello-wall.ifc auto-loads on first visit. WebGPU rendering, picking, fit-to-view, section planes, point cloud overlay.</p>
        </div>
        <div className="demo-actions">
          <a className="copy-btn" href="samples/hello-wall.ifc" download>↓ sample.ifc</a>
          <a className="copy-btn" href="https://www.ifclite.com/" target="_blank" rel="noopener">open ifclite.com ↗</a>
        </div>
      </div>
      <div className="demo-iframe-wrap">
        <iframe
          src={iframeSrc}
          className="demo-iframe"
          title="IFClite viewer"
          loading="eager"
          allow="cross-origin-isolated; clipboard-write; fullscreen"
        />
      </div>
    </div>
  );
}

function QueryDemo() {
  const [type, setType] = useState("IfcWall");
  const [filter, setFilter] = useState("all");
  const [sqlView, setSqlView] = useState(false);

  const types = ["*", "IfcWall", "IfcSlab", "IfcDoor", "IfcWindow", "IfcSpace", "IfcColumn", "IfcBuildingStorey"];

  const results = HELLO_WALL_NAMED.filter((e) => {
    if (type !== "*" && e.type !== type) return false;
    if (filter === "has-fire" && !e.fireRating) return false;
    if (filter === "no-fire"  && e.fireRating)  return false;
    return true;
  });

  const sql = `SELECT id, name, height, length, fireRating
FROM   entities
WHERE  ${type === "*" ? "1 = 1" : `type = '${type}'`}${filter === "has-fire" ? "\n  AND  fireRating IS NOT NULL" : filter === "no-fire" ? "\n  AND  fireRating IS NULL" : ""};`;

  return (
    <div className="demo demo-query">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/query · @ifc-lite/lens · hello-wall.ifc</span>
          <h3>Filter the model</h3>
          <p>Type and property filters as a fluent builder. Toggle SQL for the long-tail. DuckDB-WASM under the hood for serious analytics.</p>
        </div>
        <div className="demo-actions">
          <div className="demo-pillbar">
            <button data-on={!sqlView} onClick={() => setSqlView(false)}>Fluent</button>
            <button data-on={sqlView} onClick={() => setSqlView(true)}>SQL</button>
          </div>
        </div>
      </div>
      {!sqlView ? (
        <div className="demo-query-builder">
          <span className="demo-clause-kw mono">where</span>
          <span className="demo-clause-k">type</span>
          <span className="demo-clause-op mono">=</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="demo-select">
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="demo-clause-and mono">and</span>
          <span className="demo-clause-k">FireRating</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="demo-select">
            <option value="all">is anything</option>
            <option value="has-fire">is set</option>
            <option value="no-fire">is null</option>
          </select>
        </div>
      ) : (
        <pre className="demo-sql"><code>{sql}</code></pre>
      )}
      <div className="demo-results">
        <div className="demo-pane-head">
          <span className="mono">results</span>
          <span className="mono demo-pane-meta">{results.length} {results.length === 1 ? "row" : "rows"}</span>
        </div>
        {results.length > 0 ? (
          <div className="demo-table-wrap">
            <table className="demo-table">
              <thead><tr><th className="mono">#id</th><th>type</th><th>name</th><th className="mono">height</th><th className="mono">length</th><th>FireRating</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.id}</td>
                    <td>{r.type}</td>
                    <td>{r.name ?? "·"}</td>
                    <td className="mono">{r.height ?? "·"}</td>
                    <td className="mono">{r.length ?? "·"}</td>
                    <td className="mono">{r.fireRating ?? "·"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="demo-empty">No matches.</div>
        )}
      </div>
    </div>
  );
}

function EditDemo() {
  // Target the real IfcWall entity from hello-wall.ifc (#1222)
  const initial = useMemo(() => {
    const base = HELLO_WALL_NAMED.find((e) => e.id === 1222);
    return { ...base, fireRating: base.fireRating ?? "" };
  }, []);
  const [working, setWorking] = useState(initial);
  const [diffs, setDiffs] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  const set = (field, value) => {
    const from = working[field];
    const isNum = typeof initial[field] === "number";
    const to = isNum ? Number(value) : (value || null);
    if (from === to) return;
    setDiffs((d) => [...d, { field, from, to }]);
    setRedoStack([]);
    setWorking((w) => ({ ...w, [field]: to }));
  };

  const undo = () => {
    if (!diffs.length) return;
    const last = diffs[diffs.length - 1];
    setDiffs((d) => d.slice(0, -1));
    setRedoStack((r) => [...r, last]);
    setWorking((w) => ({ ...w, [last.field]: last.from }));
  };

  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setDiffs((d) => [...d, next]);
    setWorking((w) => ({ ...w, [next.field]: next.to }));
  };

  const reset = () => { setWorking(initial); setDiffs([]); setRedoStack([]); };

  const wallH = Math.max(20, 80 * (working.height / 3.0));
  const wallW = Math.max(40, 140 * (working.length / 10.0));

  return (
    <div className="demo demo-edit">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/mutations · @ifc-lite/create · #{initial.id} IfcWall</span>
          <h3>Mutate the wall</h3>
          <p>Change a property; the diff strip grows. Undo, redo, replay. Round-trip back to STEP with every edit applied. No out-of-band metadata.</p>
        </div>
        <div className="demo-actions demo-actions-row">
          <button className="copy-btn" onClick={undo} disabled={!diffs.length}>↶ undo</button>
          <button className="copy-btn" onClick={redo} disabled={!redoStack.length}>↷ redo</button>
          <button className="copy-btn" onClick={reset}>reset</button>
        </div>
      </div>
      <div className="demo-split demo-split-edit">
        <div className="demo-edit-form">
          <div className="demo-edit-rows">
            <div className="demo-edit-row">
              <label className="mono">height <span>(m)</span></label>
              <input type="number" step="0.1" min="0.1" max="6" value={working.height} onChange={(e) => set("height", e.target.value)} />
            </div>
            <div className="demo-edit-row">
              <label className="mono">length <span>(m)</span></label>
              <input type="number" step="0.1" min="0.5" max="10" value={working.length} onChange={(e) => set("length", e.target.value)} />
            </div>
            <div className="demo-edit-row">
              <label className="mono">FireRating</label>
              <select value={working.fireRating || ""} onChange={(e) => set("fireRating", e.target.value)}>
                <option value="">(none)</option>
                <option value="REI30">REI30</option>
                <option value="REI60">REI60</option>
                <option value="REI90">REI90</option>
                <option value="REI120">REI120</option>
              </select>
            </div>
          </div>
          <div className="demo-edit-proxy" aria-hidden="true">
            <div className="demo-edit-wall" style={{ height: `${wallH}px`, width: `${wallW}px` }}>
              <span className="mono">#{initial.id}</span>
            </div>
            <div className="demo-edit-floor" />
          </div>
        </div>
        <div className="demo-pane demo-pane-side">
          <div className="demo-pane-head">
            <span className="mono">diff log</span>
            <span className="mono demo-pane-meta">{diffs.length} mutation{diffs.length === 1 ? "" : "s"}</span>
          </div>
          {diffs.length ? (
            <ol className="demo-diff-list">
              {diffs.map((d, i) => (
                <li key={i} className="demo-diff">
                  <span className="mono demo-diff-field">{d.field}</span>
                  <span className="mono demo-diff-from">{String(d.from ?? "null")}</span>
                  <span className="demo-diff-arrow">→</span>
                  <span className="mono demo-diff-to">{String(d.to ?? "null")}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="demo-empty">No edits yet. Change a value.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── BCF zip writer (BCF v2.1 minimal) ─────────────────────────────────────
// Generates a real .bcfzip that BCF-aware tools can open. Plain "stored" ZIP
// (no deflate) keeps the implementation tiny.
function _bcfCrc32(bytes) {
  let crc = ~0 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}
function _bcfDosTimeDate(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const da = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t, da };
}
function _bcfBuildZip(files) {
  const enc = new TextEncoder();
  const { t, da } = _bcfDosTimeDate(new Date());
  let offset = 0;
  const local = [];
  const central = [];
  for (const f of files) {
    const nb = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = _bcfCrc32(data);
    const size = data.length;
    const lfh = new Uint8Array(30 + nb.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, t, true); lv.setUint16(12, da, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
    lfh.set(nb, 30);
    local.push(lfh, data);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, t, true);
    cv.setUint16(14, da, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true);
    cv.setUint32(24, size, true); cv.setUint16(28, nb.length, true); cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    offset += lfh.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of local) { out.set(c, pos); pos += c.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}
function _bcfEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _bcfUuid() {
  try { return crypto.randomUUID(); } catch (_) {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}
function buildBcfBlob({ rule, failures, source }) {
  const iso = new Date().toISOString();
  const author = "ifclite.com";
  const files = [
    { name: "bcf.version", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>\n` },
    { name: "project.bcfp", data: `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectExtension>\n  <Project ProjectId="${_bcfUuid()}">\n    <Name>${_bcfEscape(source || "hello-wall.ifc")}</Name>\n  </Project>\n  <ExtensionSchema>extensions.xsd</ExtensionSchema>\n</ProjectExtension>\n` },
  ];
  for (const f of failures) {
    const topicGuid = _bcfUuid();
    const e = f.entity;
    const title = `${rule.label}`;
    const description = `${rule.reason}: ${e.name || e.type} (#${e.id})`;
    files.push({
      name: `${topicGuid}/markup.bcf`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${topicGuid}" TopicType="ISSUE" TopicStatus="OPEN">
    <Title>${_bcfEscape(title)}</Title>
    <Priority>Major</Priority>
    <CreationDate>${iso}</CreationDate>
    <CreationAuthor>${_bcfEscape(author)}</CreationAuthor>
    <ModifiedDate>${iso}</ModifiedDate>
    <ModifiedAuthor>${_bcfEscape(author)}</ModifiedAuthor>
    <Description>${_bcfEscape(description)}</Description>
  </Topic>
</Markup>
`,
    });
  }
  const bytes = _bcfBuildZip(files);
  return new Blob([bytes], { type: "application/octet-stream" });
}

function ValidateDemo() {
  const rules = [
    { id: "fire",   label: "All IfcWall must have FireRating",  applies: (e) => e.type === "IfcWall", check: (e) => !!e.fireRating, reason: "missing FireRating" },
    { id: "name",   label: "All elements must have a Name",     applies: () => true,                  check: (e) => !!e.name,       reason: "missing Name" },
    { id: "height", label: "IfcWall.height must be ≥ 2.4 m",    applies: (e) => e.type === "IfcWall", check: (e) => (e.height ?? 0) >= 2.4, reason: "height < 2.4 m" },
  ];

  const [ruleId, setRuleId] = useState("fire");
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef(null);

  const rule = rules.find((r) => r.id === ruleId);
  const targets = HELLO_WALL_NAMED.filter(rule.applies);
  const results = targets.map((t) => ({ entity: t, pass: rule.check(t) }));

  useEffect(() => () => intervalRef.current && clearInterval(intervalRef.current), []);
  useEffect(() => { setPhase("idle"); setProgress(0); if (intervalRef.current) clearInterval(intervalRef.current); }, [ruleId]);

  const start = () => {
    if (phase === "running") return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setPhase("running");
    setProgress(0);
    intervalRef.current = setInterval(() => {
      setProgress((p) => {
        if (p >= targets.length) {
          clearInterval(intervalRef.current);
          setPhase("done");
          return p;
        }
        return p + 1;
      });
    }, 220);
  };

  const failures = results.filter((r) => !r.pass);
  const passes   = results.filter((r) =>  r.pass);

  return (
    <div className="demo demo-validate">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/ids · @ifc-lite/bcf · hello-wall.ifc</span>
          <h3>Run an IDS check</h3>
          <p>Information Delivery Specification specs translated to structured pass/fail. Failures bundle into a BCF for your tracker.</p>
        </div>
        <div className="demo-actions">
          <button className="btn btn-primary demo-run" onClick={start} disabled={phase === "running"}>
            {phase === "done" ? "↻ re-run" : phase === "running" ? "running…" : "▶ Run"}
          </button>
          <button
            className="copy-btn"
            onClick={() => {
              const blob = buildBcfBlob({ rule, failures: results.filter((r) => !r.pass), source: "hello-wall.ifc" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `hello-wall-${rule.id}.bcfzip`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 1500);
            }}
            disabled={phase !== "done" || results.every((r) => r.pass)}
            title={phase !== "done" ? "Run the check first" : results.every((r) => r.pass) ? "No issues to bundle" : "Download issues as BCF v2.1"}
          >
            ↓ BCF
          </button>
        </div>
      </div>
      <div className="demo-validate-rules" role="radiogroup" aria-label="IDS rule">
        {rules.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={r.id === ruleId}
            className="demo-chip-rule"
            data-on={r.id === ruleId}
            onClick={() => setRuleId(r.id)}
          >
            <span className="mono demo-chip-rule-id">IDS-{r.id.toUpperCase()}</span>
            <span className="demo-chip-rule-label">{r.label}</span>
          </button>
        ))}
      </div>
      <div className="demo-validate-grid">
        {targets.map((t, i) => {
          const checked = i < progress;
          const r = results[i];
          return (
            <div
              key={t.id}
              className="demo-validate-cell"
              data-state={!checked ? "pending" : r.pass ? "pass" : "fail"}
            >
              <span className="demo-validate-mark">{!checked ? "·" : r.pass ? "✓" : "✗"}</span>
              <span className="mono demo-validate-name">{t.name || t.type}</span>
            </div>
          );
        })}
      </div>
      {phase === "done" && (
        <div className="demo-validate-summary">
          <div className="demo-validate-counts">
            <span className="mono demo-summary-pass">{passes.length} ✓</span>
            <span className="mono demo-summary-fail">{failures.length} ✗</span>
            <span className="mono demo-validate-runtime">· 0.01 s</span>
          </div>
          {failures.length > 0 && (
            <div className="demo-bcf">
              <span className="mono demo-bcf-head">{failures.length} issue{failures.length > 1 ? "s" : ""} bundled to BCF</span>
              {failures.slice(0, 4).map((f) => (
                <div key={f.entity.id} className="demo-bcf-item">
                  <span className="mono demo-bcf-id">#{f.entity.id}</span>
                  <span className="demo-bcf-name">{f.entity.name || f.entity.type}</span>
                  <span className="demo-bcf-reason">{rule.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExportDemo() {
  // Real, pre-generated artifacts live in apps/landing/samples/. STEP is the source IFC,
  // the rest were converted once by @ifc-lite/export and committed.
  const formats = [
    { id: "step",    label: "STEP",    ext: "ifc",        bytes: 79592, mime: "application/x-step",       desc: "Round-trip",                path: "samples/hello-wall.ifc" },
    { id: "gltf",    label: "glTF",    ext: "gltf",       bytes:  1336, mime: "model/gltf+json",          desc: "Web 3D",                    path: "samples/hello-wall.gltf" },
    { id: "parquet", label: "Parquet", ext: "parquet",    bytes:  2719, mime: "application/vnd.apache.parquet", desc: "Columnar analytics",  path: "samples/hello-wall.parquet" },
    { id: "ifcx",    label: "IFCX",    ext: "ifcx.json",  bytes:  2538, mime: "application/json",         desc: "IFC5 / next-gen",           path: "samples/hello-wall.ifcx.json" },
    { id: "2d",      label: "2D",      ext: "svg",        bytes:  1868, mime: "image/svg+xml",            desc: "Plans, sections",           path: "samples/hello-wall-plan.svg" },
  ];

  const [fmt, setFmt] = useState("step");
  const sel = formats.find((f) => f.id === fmt);
  const max = Math.max(...formats.map((f) => f.bytes));

  const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;

  const download = async () => {
    const res = await fetch(sel.path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sel.path.split("/").pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  return (
    <div className="demo demo-export">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/export · @ifc-lite/drawing-2d · hello-wall.ifc</span>
          <h3>Write it back out</h3>
          <p>STEP for round-trips, glTF for the web, Parquet for analytics (~20× smaller than JSON), IFC5 (IFCX) JSON, and 2D drawings as SVG.</p>
        </div>
        <div className="demo-actions">
          <button className="btn btn-primary demo-run" onClick={download}>↓ download hello-wall.{sel.ext}</button>
        </div>
      </div>
      <div className="demo-export-grid">
        {formats.map((f) => (
          <button key={f.id} className="demo-export-card" data-on={f.id === fmt} onClick={() => setFmt(f.id)}>
            <div className="demo-export-top">
              <span className="mono demo-export-label">{f.label}</span>
              <span className="mono demo-export-bytes">{fmtBytes(f.bytes)}</span>
            </div>
            <div className="demo-export-bar">
              <div className="demo-export-fill" style={{ width: `${(f.bytes / max) * 100}%` }} />
            </div>
            <span className="demo-export-desc">{f.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AutomateDemo() {
  const [tab, setTab] = useState("cli");
  return (
    <div className="demo demo-automate">
      <div className="demo-head">
        <div>
          <span className="demo-eyebrow mono">@ifc-lite/cli · @ifc-lite/sdk · @ifc-lite/mcp · hello-wall.ifc</span>
          <h3>BIM your tools can talk to</h3>
          <p>Command line for scripts. A <span className="mono">bim.*</span> API for code. MCP server so agents (Claude, Cursor, your IDE) can read and edit IFC directly.</p>
        </div>
        <div className="demo-actions">
          <div className="demo-pillbar">
            <button data-on={tab === "cli"} onClick={() => setTab("cli")}>CLI</button>
            <button data-on={tab === "sdk"} onClick={() => setTab("sdk")}>SDK</button>
            <button data-on={tab === "mcp"} onClick={() => setTab("mcp")}>MCP</button>
          </div>
        </div>
      </div>
      {tab === "cli" && <AutomateCLI />}
      {tab === "sdk" && <AutomateSDK />}
      {tab === "mcp" && <AutomateMCP />}
    </div>
  );
}

function AutomateCLI() {
  const cmds = [
    {
      label: "query",
      cmd: "ifc-lite query --type IfcWall hello-wall.ifc",
      out: [
        "#1222  IfcWall  Wall-North  3.0m × 10.0m  none",
        "#2001  IfcWall  Wall-South  3.0m × 10.0m  REI60",
        "#2002  IfcWall  Wall-East   3.0m ×  5.0m  REI60",
        "#2003  IfcWall  Wall-West   2.2m ×  5.0m  none",
        "  4 rows · 14 ms",
      ],
    },
    {
      label: "validate",
      cmd: "ifc-lite validate --ids fire.ids hello-wall.ifc",
      out: [
        "✗ #1222  Wall-North  missing FireRating",
        "✓ #2001  Wall-South  REI60",
        "✓ #2002  Wall-East   REI60",
        "✗ #2003  Wall-West   missing FireRating",
        "  2 pass · 2 fail",
      ],
    },
    {
      label: "export",
      cmd: "ifc-lite export --format parquet hello-wall.ifc",
      out: ["✓ wrote hello-wall.parquet · 3.9 KB (was 78 KB STEP)"],
    },
  ];
  const [idx, setIdx] = useState(0);
  const c = cmds[idx];
  return (
    <div className="demo-cli">
      <div className="demo-cli-tabs">
        {cmds.map((cm, i) => (
          <button key={i} className="copy-btn" data-on={i === idx} onClick={() => setIdx(i)}>
            {cm.label}
          </button>
        ))}
      </div>
      <pre className="demo-cli-out">
        <span className="demo-cli-prompt">$</span> <span className="demo-cli-cmd">{c.cmd}</span>
        {c.out.map((line, i) => "\n" + line).join("")}
      </pre>
    </div>
  );
}

function AutomateSDK() {
  const samples = [
    {
      label: "count by type",
      code: `await bim.byType("IfcWall").length;`,
      result: "4",
    },
    {
      label: "walls without FireRating",
      code: `await bim
  .byType("IfcWall")
  .where(w => !w.FireRating)
  .map(w => w.Name);`,
      result: `["Wall-North", "Wall-West"]`,
    },
    {
      label: "patch & export",
      code: `for (const w of await bim.byType("IfcWall")) {
  if (!w.FireRating) w.FireRating = "REI60";
}
await bim.export("step", "patched.ifc");`,
      result: `✓ wrote patched.ifc · 2 mutations`,
    },
  ];
  const [idx, setIdx] = useState(0);
  const s = samples[idx];
  return (
    <div className="demo-sdk">
      <div className="demo-sdk-tabs">
        {samples.map((sm, i) => (
          <button key={i} className="copy-btn" data-on={i === idx} onClick={() => setIdx(i)}>
            {sm.label}
          </button>
        ))}
      </div>
      <pre className="demo-sdk-code"><code>{s.code}</code></pre>
      <div className="demo-sdk-result">
        <span className="mono demo-sdk-arrow">→</span>
        <pre className="mono demo-sdk-result-val">{s.result}</pre>
      </div>
    </div>
  );
}

function AutomateMCP() {
  const turns = [
    { who: "user", text: "Which walls in hello-wall.ifc are missing a FireRating?" },
    { who: "tool", call: "query", args: { type: "IfcWall", missing: ["FireRating"] }, result: { count: 2, names: ["Wall-North", "Wall-West"] } },
    { who: "assistant", text: "Two walls: Wall-North (#1222) and Wall-West (#2003). Set REI60 on both and re-export?" },
    { who: "user", text: "Yes." },
    { who: "tool", call: "mutate", args: { ids: [1222, 2003], set: { FireRating: "REI60" } }, result: { ok: true, mutations: 2 } },
    { who: "tool", call: "export", args: { format: "step", out: "patched.ifc" }, result: { ok: true, bytes: 79912 } },
    { who: "assistant", text: "Done. patched.ifc written (78 KB). Both walls now carry REI60." },
  ];
  return (
    <div className="demo-mcp">
      {turns.map((t, i) => {
        if (t.who === "user") {
          return (
            <div key={i} className="demo-mcp-turn demo-mcp-user">
              <span className="mono demo-mcp-who">user</span>
              <div className="demo-mcp-bubble">{t.text}</div>
            </div>
          );
        }
        if (t.who === "assistant") {
          return (
            <div key={i} className="demo-mcp-turn demo-mcp-assistant">
              <span className="mono demo-mcp-who">assistant</span>
              <div className="demo-mcp-bubble">{t.text}</div>
            </div>
          );
        }
        return (
          <div key={i} className="demo-mcp-turn demo-mcp-tool">
            <span className="mono demo-mcp-who">tool · {t.call}</span>
            <div className="demo-mcp-tool-grid">
              <pre className="mono demo-mcp-args">{JSON.stringify(t.args, null, 2)}</pre>
              <pre className="mono demo-mcp-result">→ {JSON.stringify(t.result)}</pre>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── package picker ───────────────────────────
// Groups order maps to the visual sections in the picker grid.
const PKG_GROUPS = [
  { id: "core",   label: "Core",    desc: "Parsing, schema, data" },
  { id: "viewer", label: "Viewer",  desc: "Rendering, geometry, point cloud" },
  { id: "data",   label: "Data",    desc: "Query, filter, list" },
  { id: "edit",   label: "Edit",    desc: "Mutate, author, round-trip" },
  { id: "bim",    label: "BIM",     desc: "IDS, BCF, drawings" },
  { id: "collab", label: "Collab",  desc: "Real-time multi-user" },
  { id: "agent",  label: "Automate", desc: "CLI, SDK, MCP" },
  { id: "server", label: "Server",  desc: "Rust backend, embed" },
];

const PACKAGES = [
  // ── core ────────────────────────────────────────────────────────
  { id: "parser",    name: "@ifc-lite/parser",    ver: "2.4.1",  desc: "Read IFC, schema-aware",            size: 84,  required: true, group: "core" },
  { id: "data",      name: "@ifc-lite/data",      ver: "1.17.0", desc: "Columnar TypedArray store",         size: 28,  group: "core" },
  { id: "wasm",      name: "@ifc-lite/wasm",      ver: "1.16.10", desc: "Rust WASM core",                   size: 112, group: "core" },
  { id: "encoding",  name: "@ifc-lite/encoding",  ver: "1.14.6", desc: "IFC string + value encoding",       size: 8,   group: "core" },
  { id: "ifcx",      name: "@ifc-lite/ifcx",      ver: "2.1.1",  desc: "IFC5 / IFCX schema",                size: 38,  group: "core" },
  { id: "cache",     name: "@ifc-lite/cache",     ver: "1.14.5", desc: "Binary cache for fast reloads",     size: 16,  group: "core" },
  { id: "codegen",   name: "@ifc-lite/codegen",   ver: "1.15.2", desc: "EXPRESS to TypeScript types",       size: 18,  group: "core" },

  // ── viewer ──────────────────────────────────────────────────────
  { id: "geometry",  name: "@ifc-lite/geometry",  ver: "1.18.5", desc: "Tessellation & meshes",             size: 96,  group: "viewer" },
  { id: "renderer",  name: "@ifc-lite/renderer",  ver: "1.21.0", desc: "WebGPU 3D viewer",                  size: 78,  group: "viewer" },
  { id: "viewer-core", name: "@ifc-lite/viewer-core", ver: "0.2.3", desc: "Interactive WebGL viewer",       size: 64,  group: "viewer" },
  { id: "pointcloud", name: "@ifc-lite/pointcloud", ver: "0.3.1", desc: "Point cloud decoders + types",     size: 32,  group: "viewer" },
  { id: "drawing-2d", name: "@ifc-lite/drawing-2d", ver: "1.16.0", desc: "Plans, sections, elevations",     size: 44,  group: "viewer" },

  // ── data / query ────────────────────────────────────────────────
  { id: "query",     name: "@ifc-lite/query",     ver: "1.14.7", desc: "Fluent + SQL filters",              size: 41,  group: "data" },
  { id: "lens",      name: "@ifc-lite/lens",      ver: "1.14.4", desc: "Rule-based color & filter",         size: 24,  group: "data" },
  { id: "lists",     name: "@ifc-lite/lists",     ver: "1.14.12", desc: "Schedules + property tables",      size: 22,  group: "data" },
  { id: "spatial",   name: "@ifc-lite/spatial",   ver: "1.14.5", desc: "Spatial index, BVH",                size: 18,  group: "data" },

  // ── edit ────────────────────────────────────────────────────────
  { id: "mutations", name: "@ifc-lite/mutations", ver: "1.15.0", desc: "Edit props, undo, replay",          size: 22,  group: "edit" },
  { id: "create",    name: "@ifc-lite/create",    ver: "1.15.0", desc: "Author IFC from scratch",           size: 52,  group: "edit" },
  { id: "export",    name: "@ifc-lite/export",    ver: "1.18.1", desc: "STEP, glTF, Parquet, IFCX",         size: 39,  group: "edit" },

  // ── bim ─────────────────────────────────────────────────────────
  { id: "ids",       name: "@ifc-lite/ids",       ver: "1.15.2", desc: "IDS validation runner",             size: 36,  group: "bim" },
  { id: "bcf",       name: "@ifc-lite/bcf",       ver: "1.15.3", desc: "BCF issue tracking",                size: 18,  group: "bim" },

  // ── collab ──────────────────────────────────────────────────────
  { id: "collab",         name: "@ifc-lite/collab",         ver: "0.2.0",  desc: "CRDT live multi-user",   size: 28, group: "collab" },
  { id: "collab-server",  name: "@ifc-lite/collab-server",  ver: "0.2.0",  desc: "Websocket sync server",  size: 42, group: "collab" },

  // ── agent ───────────────────────────────────────────────────────
  { id: "sdk",       name: "@ifc-lite/sdk",       ver: "1.16.0", desc: "bim.* scripting API",               size: 26,  group: "agent" },
  { id: "sandbox",   name: "@ifc-lite/sandbox",   ver: "1.15.0", desc: "QuickJS sandboxed execution",       size: 38,  group: "agent" },
  { id: "mcp",       name: "@ifc-lite/mcp",       ver: "0.2.0",  desc: "MCP server (stdio + HTTP)",         size: 32,  group: "agent" },
  { id: "cli",       name: "@ifc-lite/cli",       ver: "0.8.0",  desc: "Query, validate, export, create",   size: 64,  group: "agent" },

  // ── server / embed ──────────────────────────────────────────────
  { id: "server-client",  name: "@ifc-lite/server-client",  ver: "1.15.3", desc: "Rust server REST client", size: 14,  group: "server" },
  { id: "server-bin",     name: "@ifc-lite/server-bin",     ver: "1.14.4", desc: "Pre-built server binary", size: 0,   group: "server", note: "native" },
  { id: "embed-sdk",      name: "@ifc-lite/embed-sdk",      ver: "1.14.4", desc: "Iframe embed SDK",        size: 8,   group: "server" },
  { id: "embed-protocol", name: "@ifc-lite/embed-protocol", ver: "1.14.4", desc: "postMessage protocol",    size: 4,   group: "server" },
];

// "*" picks → select every package. Otherwise a list of ids.
const PRESETS = [
  { id: "all",      label: "All",                 picks: "*" },
  { id: "parse",    label: "Parse only",          picks: ["parser"] },
  { id: "viewer",   label: "WebGPU viewer",       picks: ["parser", "geometry", "renderer", "query"] },
  { id: "threejs",  label: "Headless geometry",   picks: ["parser", "geometry", "query"] },
  { id: "pcloud",   label: "+ Point cloud",       picks: ["parser", "geometry", "renderer", "pointcloud"] },
  { id: "edit",     label: "Edit & save",         picks: ["parser", "query", "mutations", "create", "export"] },
  { id: "audit",    label: "Validate (IDS/BCF)",  picks: ["parser", "query", "ids", "bcf"] },
  { id: "drawings", label: "2D drawings",         picks: ["parser", "geometry", "drawing-2d", "export"] },
  { id: "collab",   label: "Collaborate",         picks: ["parser", "geometry", "renderer", "collab"] },
  { id: "agent",    label: "Agent / MCP",         picks: ["parser", "query", "sdk", "mcp", "cli"] },
  { id: "embed",    label: "Embed iframe",        picks: ["embed-sdk", "embed-protocol"] },
];

// Generic FLIP: animates children of a container when their order changes.
// Each child must have a stable `data-flip-id`. Uses Web Animations API
// (supported in Safari 13.1+, Chrome 84+, Firefox 75+, Edge 84+).
function useFlipReorder(deps) {
  const containerRef = useRef(null);
  const positionsRef = useRef(new Map());
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const reduced = typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const newPositions = new Map();
    const items = root.querySelectorAll("[data-flip-id]");
    items.forEach((el) => {
      const id = el.getAttribute("data-flip-id");
      const rect = el.getBoundingClientRect();
      newPositions.set(id, { x: rect.left, y: rect.top });
      const prev = positionsRef.current.get(id);
      if (prev && !reduced) {
        const dx = prev.x - rect.x;
        const dy = prev.y - rect.y;
        if (dx !== 0 || dy !== 0) {
          el.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.85 },
              { transform: "translate(0, 0)", opacity: 1 },
            ],
            { duration: 320, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" }
          );
        }
      }
    });
    positionsRef.current = newPositions;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return containerRef;
}

function PackagePicker() {
  const [picked, setPicked] = useState(new Set(["parser", "geometry", "renderer", "query"]));
  const [copied, setCopied] = useState(false);

  const toggle = (id) => {
    const p = PACKAGES.find((x) => x.id === id);
    if (p.required) return;
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const applyPreset = (preset) => {
    if (preset.picks === "*") {
      setPicked(new Set(PACKAGES.map((p) => p.id)));
    } else {
      setPicked(new Set(preset.picks));
    }
  };

  const list = useMemo(() => Array.from(picked), [picked]);
  const cmd = `npm install ${list.map((id) => PACKAGES.find((p) => p.id === id).name).join(" ")}`;
  const totalKb = list.reduce((a, id) => a + PACKAGES.find((p) => p.id === id).size, 0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  };

  // Detect which preset matches the current selection (handles "*" too).
  const activePreset = PRESETS.find((p) => {
    if (p.picks === "*") return list.length === PACKAGES.length;
    return p.picks.length === list.length && p.picks.every((x) => picked.has(x));
  });

  // Sized packages contribute to the bundle bar; native binaries (server-bin) sit out.
  const sized = list
    .map((id) => PACKAGES.find((p) => p.id === id))
    .filter((p) => p.size > 0)
    .sort((a, b) => b.size - a.size);

  // Sort all packages: selected first (preserving original order), then unselected
  // (preserving original group order). This lifts the user's selection above the fold.
  const ordered = useMemo(() => {
    const isOn = (p) => picked.has(p.id) || p.required;
    const on = PACKAGES.filter(isOn);
    const off = PACKAGES.filter((p) => !isOn(p));
    return [...on, ...off];
  }, [picked]);

  const gridRef = useFlipReorder([picked]);

  return (
    <div className="picker">
      <div className="picker-main">
        <div className="picker-presets" role="group" aria-label="Preset stacks">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p)}
              className="copy-btn picker-preset"
              data-on={activePreset?.id === p.id}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="picker-counter" aria-live="polite">
          <span className="mono">{list.length}/{PACKAGES.length}</span>
          <span>packages selected</span>
        </div>
        <div className="picker-list">
          <div className="picker-grid" ref={gridRef}>
            {ordered.map((p) => (
              <PkgCard
                key={p.id}
                p={p}
                on={picked.has(p.id) || p.required}
                onToggle={() => toggle(p.id)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="picker-out">
        <div className="picker-out-head">
          <span className="label">Install</span>
          <span className="count">{list.length} packages</span>
        </div>
        <div className="picker-out-cmd">
          <span className="prompt">$</span>
          {cmd}
        </div>
        <div className="picker-out-size">
          <span>est. bundle <strong>~{totalKb} KB</strong> <span style={{ opacity: 0.6 }}>gzipped</span></span>
          <button onClick={copy} className="copy-btn">{copied ? "✓ copied" : "copy"}</button>
        </div>
        <BundleComposition items={sized} total={totalKb} />
      </div>
    </div>
  );
}

function PkgCard({ p, on, onToggle }) {
  const shortName = p.name.replace("@ifc-lite/", "");
  const npmUrl = `https://www.npmjs.com/package/${p.name}`;
  return (
    <div
      className="pkg"
      data-on={on}
      data-required={p.required}
      data-flip-id={p.id}
      onClick={onToggle}
      style={{ cursor: p.required ? "not-allowed" : "pointer" }}
    >
      <div className="pkg-check" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 5.5L4.5 8L9 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="pkg-info">
        <div className="pkg-name-row">
          <span className="pkg-name">{shortName}</span>
          <span className="pkg-ver mono">v{p.ver}</span>
        </div>
        <div className="pkg-desc">{p.desc}</div>
      </div>
      <a
        className="pkg-npm"
        href={npmUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label={`Open ${shortName} on npm`}
        title="Open on npm"
      >
        npm ↗
      </a>
    </div>
  );
}

// Horizontal stacked bar + legend showing how the selected packages compose the bundle.
function BundleComposition({ items, total }) {
  if (!items.length || total === 0) {
    return (
      <div className="pkg-bundle">
        <div className="pkg-bundle-head">
          <span>Bundle composition</span>
          <span className="mono pkg-bundle-empty">no packages selected</span>
        </div>
        <div className="pkg-bundle-bar pkg-bundle-bar-empty" />
      </div>
    );
  }
  return (
    <div className="pkg-bundle">
      <div className="pkg-bundle-head">
        <span>Bundle composition</span>
        <span className="mono">by gzipped size</span>
      </div>
      <div className="pkg-bundle-bar" role="img" aria-label="Bundle composition by package size">
        {items.map((p, idx) => (
          <div
            key={p.id}
            className="pkg-bundle-seg"
            style={{
              width: `${(p.size / total) * 100}%`,
              opacity: 1 - idx * 0.07,
            }}
            title={`${p.name.replace("@ifc-lite/", "")} · ${p.size} KB`}
          />
        ))}
      </div>
      <ul className="pkg-bundle-legend">
        {items.slice(0, 8).map((p, idx) => (
          <li key={p.id}>
            <span className="pkg-bundle-dot" style={{ opacity: 1 - idx * 0.07 }} />
            <span className="pkg-bundle-name mono">{p.name.replace("@ifc-lite/", "")}</span>
            <span className="pkg-bundle-size mono">{p.size}<span className="pkg-bundle-unit"> KB</span></span>
          </li>
        ))}
        {items.length > 8 && (
          <li className="pkg-bundle-more">
            <span className="pkg-bundle-dot pkg-bundle-dot-faint" />
            <span className="pkg-bundle-name mono">+{items.length - 8} more</span>
            <span className="pkg-bundle-size mono">
              {items.slice(8).reduce((a, p) => a + p.size, 0)}<span className="pkg-bundle-unit"> KB</span>
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

// ─────────────────────────── bench explorer ───────────────────────────
// Canonical from louistrue/profiling@apples-to-apples-with-native, results/RESULTS.md
// Corpus: 21 public IFCs. Times are total parse + geometry, seconds.
// IOS rows reproduced from Moult's hardware; web-ifc + ifc-lite from M4 (10-core).
const BENCH_MODELS = [
  { id: "duplex",   name: "duplex.ifc",                              size: 2.3,   products: 215,   ifclite_n: 0.02, ifclite_w: 0.11, webifc: 0.16, iosmax: 0.12, ios1c: 0.19 },
  { id: "ac20",     name: "AC20-FZK-Haus.ifc",                       size: 2.4,   products: 83,    ifclite_n: 0.02, ifclite_w: 0.09, webifc: 0.13, iosmax: 0.15, ios1c: 0.22 },
  { id: "i005",     name: "ISSUE_005_haus.ifc",                      size: 2.4,   products: 83,    ifclite_n: 0.02, ifclite_w: 0.08, webifc: 0.10, iosmax: 0.13, ios1c: 0.21 },
  { id: "i021",     name: "ISSUE_021_Mini Project.ifc",              size: 3.2,   products: 2636,  ifclite_n: 0.04, ifclite_w: 0.15, webifc: 0.29, iosmax: 0.29, ios1c: 0.53 },
  { id: "officeA",  name: "Office_A_20110811.ifc",                   size: 3.8,   products: 803,   ifclite_n: 0.03, ifclite_w: 0.14, webifc: 0.11, iosmax: 0.25, ios1c: 0.29 },
  { id: "i126",     name: "ISSUE_126_model.ifc",                     size: 4.2,   products: 257,   ifclite_n: 0.02, ifclite_w: 0.14, webifc: 0.07, iosmax: 0.32, ios1c: 0.46 },
  { id: "i034",     name: "ISSUE_034_HouseZ.ifc",                    size: 4.8,   products: 228,   ifclite_n: 0.04, ifclite_w: 0.16, webifc: 0.09, iosmax: 0.38, ios1c: 0.71 },
  { id: "i102",     name: "ISSUE_102_M3D-CON.ifc",                   size: 6.0,   products: 138,   ifclite_n: 0.04, ifclite_w: 0.22, webifc: 0.14, iosmax: 0.49, ios1c: 0.62 },
  { id: "i159",     name: "ISSUE_159_kleine_Wohnung_R22.ifc",        size: 9.5,   products: 425,   ifclite_n: 0.08, ifclite_w: 0.46, webifc: 0.33, iosmax: 0.91, ios1c: 1.65 },
  { id: "c20",      name: "C20-Institute-Var-2.ifc",                 size: 10.3,  products: 702,   ifclite_n: 0.09, ifclite_w: 0.31, webifc: 0.30, iosmax: 0.67, ios1c: 0.71 },
  { id: "i129",     name: "ISSUE_129_N1540_17_EXE.ifc",              size: 11.5,  products: 947,   ifclite_n: 0.09, ifclite_w: 0.37, webifc: 0.33, iosmax: 0.89, ios1c: 1.52 },
  { id: "dental",   name: "dental_clinic.ifc",                       size: 12.4,  products: 2583,  ifclite_n: 0.10, ifclite_w: 0.49, webifc: 0.42, iosmax: 0.99, ios1c: 1.25 },
  { id: "fmarc",    name: "FM_ARC_DigitalHub.ifc",                   size: 13.4,  products: 703,   ifclite_n: 0.09, ifclite_w: 0.71, webifc: 0.53, iosmax: 1.54, ios1c: 2.43 },
  { id: "bridge",   name: "ifcbridge-model01.ifc",                   size: 14.5,  products: 165,   ifclite_n: 0.12, ifclite_w: 0.54, webifc: 0.20, iosmax: 1.32, ios1c: 2.05 },
  { id: "i102cd",   name: "ISSUE_102_M3D-CON-CD.ifc",                size: 25.6,  products: 1616,  ifclite_n: 0.25, ifclite_w: 1.57, webifc: 1.89, iosmax: 2.66, ios1c: 4.02 },
  { id: "soffice",  name: "S_Office_Integrated Design Archi.ifc",    size: 29.6,  products: 3396,  ifclite_n: 0.25, ifclite_w: 1.17, webifc: 2.62, iosmax: 2.94, ios1c: 4.04 },
  { id: "advanced", name: "advanced_model.ifc",                      size: 33.7,  products: 6401,  ifclite_n: 0.29, ifclite_w: 1.46, webifc: 1.36, iosmax: 3.00, ios1c: 3.92 },
  { id: "schep",    name: "schependomlaan.ifc",                      size: 47.0,  products: 3569,  ifclite_n: 0.41, ifclite_w: 1.70, webifc: 0.59, iosmax: 2.85, ios1c: 3.35 },
  { id: "i068",     name: "ISSUE_068_ARK_NUS_skolebygg.ifc",         size: 53.7,  products: 4459,  ifclite_n: 0.52, ifclite_w: 2.37, webifc: 3.32, iosmax: 4.11, ios1c: 5.72 },
  { id: "i098",     name: "ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX.ifc",    size: 68.4,  products: 11123, ifclite_n: 0.59, ifclite_w: 2.72, webifc: 13.05, iosmax: 5.82, ios1c: 8.42 },
  { id: "i053",     name: "ISSUE_053_Holter_Tower_10.ifc",           size: 169.2, products: 60285, ifclite_n: 1.70, ifclite_w: 8.23, webifc: 6.06, iosmax: 13.70, ios1c: 19.53 },
];

const BENCH_ENGINES = [
  { key: "ifclite_n", name: "ifc-lite", sub: "native, 10 threads", primary: true, shade: "deep" },
  { key: "ifclite_w", name: "ifc-lite", sub: "WASM, 1 thread",     primary: true, shade: "light" },
  { key: "webifc",    name: "web-ifc",  sub: "WASM, 1 thread" },
  { key: "iosmax",    name: "IfcOpenShell", sub: "native, multi-thread" },
];

const BENCH_SORTS = [
  { id: "random",       label: "Random",          fn: null },
  { id: "size-asc",     label: "Size (small → large)",      fn: (a, b) => a.size - b.size },
  { id: "size-desc",    label: "Size (large → small)",      fn: (a, b) => b.size - a.size },
  { id: "products-desc",label: "Most products",   fn: (a, b) => b.products - a.products },
  { id: "ifclite-asc",  label: "ifc-lite fastest",fn: (a, b) => a.ifclite_w - b.ifclite_w },
  { id: "ifclite-desc", label: "ifc-lite slowest",fn: (a, b) => b.ifclite_w - a.ifclite_w },
];

function pickRandomIds(n, exclude = new Set()) {
  const pool = BENCH_MODELS.filter((m) => !exclude.has(m.id));
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map((m) => m.id);
}

function fmtSize(mb) {
  return mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : mb.toFixed(1) + " MB";
}

function withViewTransition(fn) {
  if (typeof document !== "undefined" && typeof document.startViewTransition === "function") {
    document.startViewTransition(fn);
  } else {
    fn();
  }
}

function BenchRow({ model, onShuffle, onRemove, canRemove }) {
  const times = BENCH_ENGINES.map((e) => model[e.key]).filter((t) => t != null);
  const maxTime = Math.max(...times);
  const minTime = Math.min(...times);
  return (
    <div className="be-row" style={{ viewTransitionName: `be-row-${model.id}` }}>
      <div className="be-row-head">
        <div className="be-row-title">
          <span className="be-row-name mono">{model.name}</span>
          <span className="be-row-meta">
            {fmtSize(model.size)} <span className="dot">·</span> {model.products.toLocaleString()} products
          </span>
        </div>
        <div className="be-row-actions">
          <button className="be-icon" onClick={onShuffle} title="Swap to a different model" aria-label="Swap model">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 5h7l-2-2M14 11H7l2 2"/>
              <path d="M11 2l3 3-3 3M5 8l-3 3 3 3"/>
            </svg>
          </button>
          {canRemove && (
            <button className="be-icon" onClick={onRemove} title="Hide this model" aria-label="Hide model">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4l8 8M12 4l-8 8"/>
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="be-bars">
        {BENCH_ENGINES.map((e) => {
          const t = model[e.key];
          const width = (t / maxTime) * 100;
          const isFastest = t === minTime;
          const cls = ["be-bar"];
          if (e.primary) cls.push("us");
          if (e.shade) cls.push(`shade-${e.shade}`);
          if (isFastest) cls.push("fastest");
          return (
            <div className={cls.join(" ")} key={e.key}>
              <div className="be-bar-label">
                <span className="be-bar-name">{e.name}</span>
                <span className="be-bar-sub mono">{e.sub}</span>
              </div>
              <div className="be-bar-track">
                <div className="be-bar-fill" style={{ width: `${width}%` }} />
              </div>
              <span className="be-bar-value">
                {t.toFixed(2)}<span className="be-bar-unit">s</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BenchExplorer() {
  const [slotIds, setSlotIds] = useState(() => pickRandomIds(3));
  const [sort, setSort] = useState("random");
  const [sortOpen, setSortOpen] = useState(false);

  const slots = useMemo(
    () => slotIds.map((id) => BENCH_MODELS.find((m) => m.id === id)).filter(Boolean),
    [slotIds]
  );

  const sortFn = BENCH_SORTS.find((s) => s.id === sort)?.fn;
  const sorted = useMemo(() => (sortFn ? [...slots].sort(sortFn) : slots), [slots, sortFn]);

  const shuffleSlot = (idx) => {
    withViewTransition(() => {
      setSlotIds((cur) => {
        const next = [...cur];
        const used = new Set(cur);
        const candidates = BENCH_MODELS.filter((m) => !used.has(m.id));
        if (!candidates.length) return cur;
        next[idx] = candidates[Math.floor(Math.random() * candidates.length)].id;
        return next;
      });
    });
  };

  const removeSlot = (idx) => {
    withViewTransition(() => setSlotIds((cur) => cur.filter((_, i) => i !== idx)));
  };

  const addSlot = () => {
    withViewTransition(() => {
      setSlotIds((cur) => {
        const used = new Set(cur);
        const pool = BENCH_MODELS.filter((m) => !used.has(m.id));
        if (!pool.length) return cur;
        return [...cur, pool[Math.floor(Math.random() * pool.length)].id];
      });
    });
  };

  const shuffleAll = () => {
    withViewTransition(() => setSlotIds(pickRandomIds(Math.max(3, slotIds.length))));
  };

  const setSortAnimated = (id) => {
    withViewTransition(() => {
      setSort(id);
      setSortOpen(false);
    });
  };

  // close sort menu on outside click
  const menuRef = useRef(null);
  useEffect(() => {
    if (!sortOpen) return;
    const onDoc = (e) => { if (!menuRef.current?.contains(e.target)) setSortOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [sortOpen]);

  return (
    <div className="be">
      <div className="be-controls">
        <div className="be-legend">
          {BENCH_ENGINES.map((e) => {
            const chipLabel = e.primary
              ? `${e.name} ${e.shade === "deep" ? "(native)" : "(WASM)"}`
              : e.name;
            const cls = ["be-chip"];
            if (e.primary) cls.push("us");
            if (e.shade) cls.push(`shade-${e.shade}`);
            return (
              <span key={e.key} className={cls.join(" ")}>
                <span className="be-chip-dot" />
                {chipLabel}
              </span>
            );
          })}
        </div>
        <div className="be-actions">
          <div className="be-menu" ref={menuRef}>
            <button className="be-btn" onClick={() => setSortOpen((v) => !v)}>
              <span>Sort: {BENCH_SORTS.find((s) => s.id === sort)?.label}</span>
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 3.2L4.5 6.2L7.5 3.2"/></svg>
            </button>
            {sortOpen && (
              <div className="be-menu-pop" role="listbox">
                {BENCH_SORTS.map((s) => (
                  <button key={s.id} className={`be-menu-item ${sort === s.id ? "on" : ""}`} onClick={() => setSortAnimated(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="be-btn be-btn-primary" onClick={shuffleAll}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 5h7l-2-2M14 11H7l2 2"/>
              <path d="M11 2l3 3-3 3M5 8l-3 3 3 3"/>
            </svg>
            Shuffle
          </button>
        </div>
      </div>

      <div className="be-rows">
        {sorted.map((m) => (
          <BenchRow
            key={m.id}
            model={m}
            onShuffle={() => shuffleSlot(slotIds.indexOf(m.id))}
            onRemove={() => removeSlot(slotIds.indexOf(m.id))}
            canRemove={slotIds.length > 1}
          />
        ))}
      </div>

      {slotIds.length < 6 && (
        <button className="be-add" onClick={addSlot}>
          <span>+</span> Add another model
        </button>
      )}

      <div className="be-foot">
        <span><strong>{BENCH_MODELS.length}</strong> models <span style={{ color: "var(--ink-3)" }}>· parse + geometry, lower is better</span></span>
        <a href="https://github.com/louistrue/profiling/tree/apples-to-apples-with-native" target="_blank" rel="noopener" className="mono">full methodology →</a>
      </div>
    </div>
  );
}


// ─────────────────────────── stack builder ───────────────────────────
const SB_FRAMEWORKS = [
  { id: "react",   label: "React",   meta: "useEffect / hooks" },
  { id: "vue",     label: "Vue",     meta: "composition API" },
  { id: "svelte",  label: "Svelte",  meta: "reactive stores" },
  { id: "vanilla", label: "Vanilla", meta: "no framework" },
];

const SB_RENDERERS = [
  { id: "webgpu",   label: "WebGPU (built-in)", tag: "WGPU",  pkgs: ["geometry", "renderer"] },
  { id: "threejs",  label: "Three.js",          tag: "WebGL", pkgs: ["geometry"] },
  { id: "babylon",  label: "Babylon.js",        tag: "WebGL", pkgs: ["geometry"] },
  { id: "none",     label: "Data only",         tag: "none",  pkgs: [] },
];

const SB_MODES = [
  { id: "browser", label: "Browser",  meta: "client-side, runs from a CDN",       pkgs: [] },
  { id: "server",  label: "Server",   meta: "Rust backend, streamed to clients",  pkgs: ["server-client"], runtime: { tag: "RUST", name: "@ifc-lite/server", meta: "caching · streaming · parallel parse" } },
  { id: "desktop", label: "Desktop",  meta: "Tauri build, native filesystem",     pkgs: [], runtime: { tag: "TAURI", name: "Tauri runtime", meta: "multi-threaded · native fs · offline" } },
];

const SB_FEATURES = [
  { id: "query",     label: "Query",     pkg: "query",     desc: "filters + SQL" },
  { id: "mutations", label: "Edit",      pkg: "mutations", desc: "props + undo" },
  { id: "ids",       label: "Validate",  pkg: "ids",       desc: "IDS specs" },
  { id: "drawing",   label: "2D plans",  pkg: "drawing-2d",desc: "sections · elevations" },
  { id: "bcf",       label: "BCF",       pkg: "bcf",       desc: "issue tracking" },
  { id: "export",    label: "Export",    pkg: "export",    desc: "glTF · Parquet · IFCX" },
];

function SBSeg({ value, options, onChange }) {
  return (
    <div className="sb-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={`sb-seg-opt ${value === o.id ? "on" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SBLayer({ tag, tagKind, name, meta, kind, dim }) {
  return (
    <div className={`sb-layer ${kind || ""} ${dim ? "dim" : ""}`} style={{ viewTransitionName: `sb-${name.replace(/\W+/g, "")}` }}>
      <span className={`sb-tag sb-tag-${tagKind || "ts"}`}>{tag}</span>
      <div className="sb-layer-body">
        <span className="sb-layer-name">{name}</span>
        <span className="sb-layer-meta">{meta}</span>
      </div>
    </div>
  );
}

function SBArrow() {
  return (
    <div className="sb-arrow" aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M5.5 1.5v8M2 6.5l3.5 3.5L9 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

function StackBuilder() {
  const [framework, setFramework] = useState("react");
  const [renderer, setRenderer]   = useState("webgpu");
  const [mode, setMode]           = useState("browser");
  const [features, setFeatures]   = useState(() => new Set(["query"]));

  const setFw = (v) => withViewTransition(() => setFramework(v));
  const setRn = (v) => withViewTransition(() => setRenderer(v));
  const setMd = (v) => withViewTransition(() => setMode(v));
  const toggleFeature = (id) =>
    withViewTransition(() => {
      setFeatures((cur) => {
        const next = new Set(cur);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    });

  const r = SB_RENDERERS.find((x) => x.id === renderer);
  const m = SB_MODES.find((x) => x.id === mode);
  const fw = SB_FRAMEWORKS.find((x) => x.id === framework);

  const pkgs = useMemo(() => {
    const base = ["parser"];
    r.pkgs.forEach((p) => base.push(p));
    m.pkgs.forEach((p) => base.push(p));
    SB_FEATURES.filter((f) => features.has(f.id)).forEach((f) => base.push(f.pkg));
    return Array.from(new Set(base));
  }, [r, m, features]);

  const cmd = `npm install ${pkgs.map((p) => `@ifc-lite/${p}`).join(" ")}`;

  // approximate gzipped sizes used in PACKAGES list
  const sizeMap = Object.fromEntries(PACKAGES.map((p) => [p.id, p.size]));
  const totalKb = pkgs.reduce((a, p) => a + (sizeMap[p] || 30), 0);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  };

  return (
    <div className="sb">
      <div className="sb-controls">
        <div className="sb-ctrl">
          <span className="sb-ctrl-label">Framework</span>
          <SBSeg value={framework} options={SB_FRAMEWORKS} onChange={setFw} />
        </div>
        <div className="sb-ctrl">
          <span className="sb-ctrl-label">3D engine</span>
          <SBSeg value={renderer} options={SB_RENDERERS.map((x) => ({ id: x.id, label: x.id === "webgpu" ? "WebGPU" : x.id === "threejs" ? "Three.js" : x.id === "babylon" ? "Babylon" : "Data only" }))} onChange={setRn} />
        </div>
        <div className="sb-ctrl">
          <span className="sb-ctrl-label">Runs on</span>
          <SBSeg value={mode} options={SB_MODES} onChange={setMd} />
        </div>
        <div className="sb-ctrl">
          <span className="sb-ctrl-label">Extras</span>
          <div className="sb-feats">
            {SB_FEATURES.map((f) => (
              <button
                key={f.id}
                className={`sb-feat ${features.has(f.id) ? "on" : ""}`}
                onClick={() => toggleFeature(f.id)}
                title={f.desc}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="sb-foot sb-foot-top">
        <div className="sb-foot-head">
          <span className="sb-foot-label">npm install · {pkgs.length} packages · ~{totalKb} KB gzipped</span>
          <button className="be-btn sb-copy" onClick={copy}>{copied ? "✓ copied" : "copy"}</button>
        </div>
        <div className="sb-foot-cmd"><span className="sb-foot-prompt">$</span> {cmd}</div>
      </div>

      <div className="sb-stack">
        <SBLayer tag="APP"  tagKind="app"  name={fw.label}                         meta={`Your code, ${fw.meta}`} />
        <SBArrow />
        <SBLayer tag="TS"   tagKind="ts"   name="@ifc-lite packages"               meta={`${pkgs.length} packages · ~${totalKb} KB gzipped`} />
        {renderer !== "none" && (
          <>
            <SBArrow />
            <SBLayer tag={r.tag} tagKind={renderer === "webgpu" ? "wgpu" : "wgl"} name={r.label} meta={renderer === "webgpu" ? "instanced · pickable · fit-to-view" : "you render, ifc-lite tessellates"} />
          </>
        )}
        <SBArrow />
        <SBLayer tag="WASM" tagKind="wasm" name="wasm-bindgen bindings"            meta="streaming · zero-copy buffers" />
        <SBArrow />
        <SBLayer tag="RUST" tagKind="rust" name="ifc-lite-core"                    meta="tokenizer · tessellator · query engine" kind="core" />
        {m.runtime && (
          <>
            <SBArrow />
            <SBLayer tag={m.runtime.tag} tagKind={m.runtime.tag === "TAURI" ? "tauri" : "rust"} name={m.runtime.name} meta={m.runtime.meta} kind="runtime" />
          </>
        )}
      </div>
    </div>
  );
}


// ─────────────────────────── browser test ───────────────────────────
const STATIC_BROWSERS = [
  { name: "Chrome",  ver: "113+" },
  { name: "Edge",    ver: "113+" },
  { name: "Firefox", ver: "127+" },
  { name: "Safari",  ver: "18+"  },
  { name: "Arc",     ver: "stable" },
  { name: "Brave",   ver: "1.65+" },
];

// 30-byte WASM module that uses v128 SIMD opcodes. Validating == SIMD supported.
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
  3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

async function runBrowserTests() {
  const results = [];

  // WebGPU
  let webgpuOk = false;
  let webgpuNote = "not detected";
  try {
    if ("gpu" in navigator) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        webgpuOk = true;
        let info = "adapter ready";
        try {
          const ai = typeof adapter.requestAdapterInfo === "function"
            ? await adapter.requestAdapterInfo()
            : adapter.info;
          if (ai) {
            const parts = [ai.vendor, ai.architecture, ai.description].filter(Boolean);
            if (parts.length) info = parts.slice(0, 2).join(" · ");
          }
        } catch (_) { /* requestAdapterInfo not always exposed */ }
        webgpuNote = info;
      } else {
        webgpuNote = "no adapter (driver or flag missing)";
      }
    }
  } catch (_) { /* swallow */ }
  results.push({ id: "webgpu", label: "WebGPU", ok: webgpuOk, note: webgpuNote });

  // WebAssembly + SIMD
  const wasmOk = typeof WebAssembly === "object" && typeof WebAssembly.validate === "function";
  let simdOk = false;
  if (wasmOk) {
    try { simdOk = WebAssembly.validate(WASM_SIMD_PROBE); } catch (_) {}
  }
  results.push({
    id: "wasm",
    label: "WebAssembly · SIMD",
    ok: wasmOk && simdOk,
    warn: wasmOk && !simdOk,
    note: simdOk ? "full speed Rust core" : wasmOk ? "available, no SIMD (slower core)" : "not available",
  });

  // SharedArrayBuffer is Spectre-gated: Chrome 91+, Firefox 79+, Safari 15.2+ hide
  // the global from any page that isn't cross-origin isolated (COOP + COEP headers).
  // So an "undefined" result here doesn't mean the browser lacks support — it
  // usually means this specific page didn't enable cross-origin isolation.
  // Distinguish the two cases so visitors don't blame their browser.
  const sabAvailable = typeof SharedArrayBuffer !== "undefined";
  const coiKnown    = typeof crossOriginIsolated !== "undefined";
  const coiOk       = coiKnown && crossOriginIsolated;
  let sabState;
  if (sabAvailable && coiOk) {
    sabState = { ok: true,  warn: false, note: "threaded WASM enabled" };
  } else if (sabAvailable && !coiOk) {
    sabState = { ok: false, warn: true,  note: "browser ready, this page not cross-origin isolated" };
  } else if (coiKnown) {
    // Browser knows the COI concept but withheld SAB → it's a page-header issue.
    sabState = { ok: false, warn: true,  note: "gated by cross-origin isolation (page needs COOP+COEP)" };
  } else {
    sabState = { ok: false, warn: false, note: "not available in this browser" };
  }
  results.push(Object.assign({ id: "sab", label: "SharedArrayBuffer" }, sabState));

  // Origin Private File System (OPFS)
  const opfsOk = typeof navigator !== "undefined"
    && "storage" in navigator
    && navigator.storage
    && typeof navigator.storage.getDirectory === "function";
  results.push({
    id: "opfs",
    label: "OPFS",
    ok: opfsOk,
    note: opfsOk ? "fast cached reloads" : "cache falls back to IndexedDB",
  });

  // Worker + ResizeObserver
  const workerOk = typeof Worker !== "undefined";
  const roOk = typeof ResizeObserver !== "undefined";
  results.push({
    id: "worker",
    label: "Worker · ResizeObserver",
    ok: workerOk && roOk,
    note: workerOk && roOk
      ? "parser off main thread"
      : !workerOk ? "no Worker" : "no ResizeObserver",
  });

  return results;
}

function detectBrowserLabel() {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  let name = "unknown";
  let pat = null;
  if (/Edg\//.test(ua))                       { name = "Edge";    pat = /Edg\/(\d+)/;     }
  else if (/Firefox\//.test(ua))              { name = "Firefox"; pat = /Firefox\/(\d+)/; }
  else if (/Chrome\//.test(ua))               { name = "Chrome";  pat = /Chrome\/(\d+)/;  }
  else if (/Version\/[\d.]+ Safari/.test(ua)) { name = "Safari";  pat = /Version\/(\d+)/; }
  const m = pat ? ua.match(pat) : null;
  return name + (m ? " " + m[1] : "");
}

function BrowserTest() {
  const [phase, setPhase] = useState("idle"); // idle | running | done
  const [results, setResults] = useState(null);

  const run = async () => {
    setPhase("running");
    try {
      const r = await runBrowserTests();
      setResults(r);
      setPhase("done");
    } catch (err) {
      console.error("Browser test failed:", err);
      setPhase("idle");
    }
  };

  const reset = () => { setPhase("idle"); setResults(null); };

  if (phase === "done" && results) {
    const passCount = results.filter((r) => r.ok).length;
    return (
      <div className="br-test br-test-done">
        <div className="br-test-head">
          <span className="br-test-source mono">{detectBrowserLabel()}</span>
          <span className="br-test-counts mono">{passCount}/{results.length} ✓</span>
          <button className="copy-btn br-test-reset" onClick={reset}>↻ reset</button>
        </div>
        <ul className="br-test-list">
          {results.map((r) => (
            <li key={r.id} className="br-test-row" data-state={r.ok ? "pass" : r.warn ? "warn" : "fail"}>
              <span className="br-test-mark">{r.ok ? "✓" : r.warn ? "⚠" : "✗"}</span>
              <div className="br-test-body">
                <span className="br-test-label mono">{r.label}</span>
                <span className="br-test-note">{r.note}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="br-test">
      <div className="browsers">
        {STATIC_BROWSERS.map((b) => (
          <div className="browser" key={b.name}>
            <span className="nm">{b.name}</span>
            <span className="ver">{b.ver}</span>
          </div>
        ))}
      </div>
      <button
        className="btn btn-primary br-test-btn"
        onClick={run}
        disabled={phase === "running"}
      >
        {phase === "running" ? "Testing…" : "▶ Test my browser"}
      </button>
    </div>
  );
}


// ─────────────────────────── mount ───────────────────────────
const pipelineRoot = document.getElementById("pipeline-root");
if (pipelineRoot) ReactDOM.createRoot(pipelineRoot).render(<ConveyorPipeline />);

const codeTabsRoot = document.getElementById("code-tabs-root");
if (codeTabsRoot) ReactDOM.createRoot(codeTabsRoot).render(<CodeTabs />);

const pickerRoot = document.getElementById("picker-root");
if (pickerRoot) ReactDOM.createRoot(pickerRoot).render(<PackagePicker />);

const benchRoot = document.getElementById("bench-root");
if (benchRoot) ReactDOM.createRoot(benchRoot).render(<BenchExplorer />);

const stackRoot = document.getElementById("stack-root");
if (stackRoot) ReactDOM.createRoot(stackRoot).render(<StackBuilder />);

const browserTestRoot = document.getElementById("browser-test-root");
if (browserTestRoot) ReactDOM.createRoot(browserTestRoot).render(<BrowserTest />);
