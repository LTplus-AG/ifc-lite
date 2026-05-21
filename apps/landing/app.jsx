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

// ─────────────────────────── package picker ───────────────────────────
const PACKAGES = [
  { id: "parser", name: "@ifc-lite/parser", desc: "Read IFC, schema-aware", size: 84, required: true, group: "core" },
  { id: "geometry", name: "@ifc-lite/geometry", desc: "Tessellation & meshes", size: 96, group: "core" },
  { id: "renderer", name: "@ifc-lite/renderer", desc: "WebGPU 3D viewer", size: 78, group: "viewer" },
  { id: "query", name: "@ifc-lite/query", desc: "Type + property filters, SQL", size: 41, group: "data" },
  { id: "mutations", name: "@ifc-lite/mutations", desc: "Edit properties, undo", size: 22, group: "data" },
  { id: "ids", name: "@ifc-lite/ids", desc: "IDS validation runner", size: 36, group: "bim" },
  { id: "drawing-2d", name: "@ifc-lite/drawing-2d", desc: "Plans, sections, elevations", size: 44, group: "bim" },
  { id: "bcf", name: "@ifc-lite/bcf", desc: "BCF issue tracking", size: 18, group: "bim" },
  { id: "create", name: "@ifc-lite/create", desc: "Author IFC from scratch", size: 52, group: "advanced" },
  { id: "export", name: "@ifc-lite/export", desc: "STEP, glTF, Parquet, IFCX", size: 39, group: "advanced" },
  { id: "server-client", name: "@ifc-lite/server-client", desc: "Talk to the Rust server", size: 14, group: "advanced" },
];

const PRESETS = [
  { id: "parse", label: "Parse only", picks: ["parser"] },
  { id: "viewer", label: "WebGPU viewer", picks: ["parser", "geometry", "renderer", "query"] },
  { id: "threejs", label: "Three.js / Babylon.js", picks: ["parser", "geometry", "query"] },
  { id: "audit", label: "Validate", picks: ["parser", "query", "ids", "bcf"] },
  { id: "edit", label: "Edit", picks: ["parser", "query", "mutations", "export"] },
];

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
    setPicked(new Set(preset.picks));
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

  // detect which preset matches
  const activePreset = PRESETS.find(
    (p) => p.picks.length === list.length && p.picks.every((x) => picked.has(x))
  );

  return (
    <div className="picker">
      <div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p)}
              className="copy-btn"
              style={{
                color: activePreset?.id === p.id ? "var(--bg)" : "var(--ink-3)",
                background: activePreset?.id === p.id ? "var(--ink)" : "transparent",
                borderColor: activePreset?.id === p.id ? "var(--ink)" : "var(--line-2)",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="picker-grid">
          {PACKAGES.map((p) => (
            <div
              key={p.id}
              className="pkg"
              data-on={picked.has(p.id) || p.required}
              data-required={p.required}
              onClick={() => toggle(p.id)}
              style={{ cursor: p.required ? "not-allowed" : "default" }}
            >
              <div className="pkg-check">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2 5.5L4.5 8L9 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="pkg-info">
                <div className="pkg-name">{p.name.replace("@ifc-lite/", "")}</div>
                <div className="pkg-desc">{p.desc}</div>
              </div>
            </div>
          ))}
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
      </div>
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
  { id: "none",     label: "Data only",         tag: "—",     pkgs: [] },
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

      <div className="sb-foot">
        <div className="sb-foot-head">
          <span className="sb-foot-label">npm install</span>
          <button className="be-btn sb-copy" onClick={copy}>{copied ? "✓ copied" : "copy"}</button>
        </div>
        <div className="sb-foot-cmd"><span className="sb-foot-prompt">$</span> {cmd}</div>
      </div>
    </div>
  );
}


// ─────────────────────────── mount ───────────────────────────
const codeTabsRoot = document.getElementById("code-tabs-root");
if (codeTabsRoot) ReactDOM.createRoot(codeTabsRoot).render(<CodeTabs />);

const pickerRoot = document.getElementById("picker-root");
if (pickerRoot) ReactDOM.createRoot(pickerRoot).render(<PackagePicker />);

const benchRoot = document.getElementById("bench-root");
if (benchRoot) ReactDOM.createRoot(benchRoot).render(<BenchExplorer />);

const stackRoot = document.getElementById("stack-root");
if (stackRoot) ReactDOM.createRoot(stackRoot).render(<StackBuilder />);
