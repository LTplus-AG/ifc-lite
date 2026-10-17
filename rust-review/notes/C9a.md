## C9a design note (coordinator b61983f5)

**WP:** C9a, the LandXML XML driver (`xml::driver`, `FamilyHandler`, `Budget`, `TokenScanner`, one decoder). Charter #7670, issue #7784.
**Base:** `origin/main` @ `ab3857fc91`. This includes B1 #7702 (`890652f680`), B9 #7746 (`ccf60b6bc0`), S3 #7717, S5 #7725 and the fix lane's **#7805 (`b2d6a29145`, #7753 + #7754)**. Every `file:line` below is at this base. Paths are relative to `rust/landxml/src/` unless they say otherwise.
**Findings owned (14):** EDGE-LXPARSE-1, 5, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20, 25, 28.
**Class mix:** 1 G, 3 X, 9 R (13 PRs; 10 required for the stop line).

---

### 0. What this note assumes from the merged base

| Assumption | Where it holds on main | What C9a does with it |
|---|---|---|
| B1: `Event::GeneralRef` reaches every family's text path in source form. The stream consumes a text token through its pad comment. | `xml.rs:144` `general_ref_source`; the 4 `consume_event` arms (`parser.rs:91`, `plan/parser.rs:206`, `pipe_parser.rs:125`, `alignment/parser.rs:212`); `stream.rs:357` | C9a-4 replaces the round-trip through source form with one reference decoder. The B1 tests (`tests/text_references_7680.rs`, `tests/stream_text_references_7680.rs`) are the R oracle. |
| S5/#7677: a stream error is terminal. | `stream/lifecycle.rs:80` `close_on_error` | This settles B1's "session stays open after an error" note; nothing is left for C9a. The driver keeps the rule: *a handler error poisons the driver*. |
| #7753 (in #7805): the stream header commits to a unit only when `<Units>` is read or when the first surface that draws to scale completes. A `<Units>` that arrives after an *assumed* header is refused. | `stream/output.rs:15-45`, `parser/state.rs:166` `declares_units`, `stream.rs:64` `header_assumed` | C9a keeps this rule byte for byte. The driver owns "Units declared" (`RootInfo::units_declared()`), and `output.rs` reads it there instead of from the TIN parser. Pull and stream deliberately differ on a late `<Units>` after an assumption: pull warns and uses the declared units (`parser.rs:288`); stream refuses. That difference is recorded as an accepted divergence in the G0 gate (D78), not reconciled. |
| #7754 (in #7805): one CircCurve length policy in Rust and TS. | `profile_circular.rs`, `packages/create/src/landxml/profile-geometry.ts` | Not touched by C9a. It is numeric code (C9b/C9c territory), and no C9a PR edits it. |
| B9: one numeric home and assumed units in every family. | `numeric.rs`, `semantics.rs:120` `resolve_assumed_units`, called once per entry point | The driver calls `resolve_assumed_units` once per document. Families get it from `RootInfo`. |
| S3: TIN `child_ordinals` only for capture-path names, plus the source-path byte budget. | `parser.rs:157`, `parser/limits.rs:31` | Ported as-is into the TIN handler. `max_source_path_bytes` becomes a `Budget`. |

---

### 1. API

#### 1.1 Module layout (new `xml/` directory replaces `xml.rs`; every file ≤ 400 lines, MPL header)

```
xml/mod.rs        re-exports; error(); Attributes; is_xml_s (the one copy)
xml/budget.rs     Budget, Budgets, Poller (cancellation)
xml/encoding.rs   Decoder (incremental), normalize_encoding = push + finish
xml/scan.rs       TokenScanner (incremental lexical bound; preflight + stream framing)
xml/refs.rs       the one entity/char-reference decoder
xml/element.rs    Element<'e> (decoded once), Namespaces (Rc), split_name
xml/driver.rs     Driver, RootInfo, Cx, FamilyHandler, drive()
xml/values.rs     finite(), coord_list() (EDGE-10)
```

#### 1.2 `Budget` (EDGE-LXPARSE-5, -26 hardening)

```rust
pub(crate) struct Budget { used: usize, max: usize, label: &'static str }
impl Budget {
    pub fn new(max: usize, label: &'static str) -> Self;
    /// checked_add, then > max -> LimitExceeded("{label} limit exceeded").
    pub fn reserve(&mut self, n: usize) -> Result<()>;
    pub fn remaining(&self) -> usize;           // replaces `max - used` arithmetic
}
pub(crate) struct Budgets {                    // driver-owned, document-scoped
    pub work: Budget,            // events + attributes + text bytes, charged ONLY by the driver
    pub char_refs: Budget,       // text + attributes, charged ONLY by xml::refs
    pub references: Budget,      // pntRef / face / roadway refs (families charge)
    pub points: Budget,
    pub source_path_bytes: Budget,
    pub capability_diagnostics: Budget,
    poller: Poller,              // the one cancellation poll
}
```

- **One error shape.** Every cap reports `LimitExceeded` with `"<label> limit exceeded"`. This removes alignment's `InvalidSemantic` "alignment limit exceeded" (`alignment/parser/actions.rs:25-26`, EDGE-LXPARSE-5 drift) in C9a-1.
- **Record caps live in the family that owns the record kind.** Surfaces, pipes, CgPoints and so on are `Budget`s held by each handler, so all 17 hand-written `checked_add → > max` copies collapse into one type. Today's copies: `parser/limits.rs:16-102`, `parser/profiles/guards.rs:41-64`, `plan/parser.rs:178`, `plan/parser/driver.rs:30-49,315-324`, `plan/parser/actions.rs:361`, `pipe_parser/handlers.rs:19-61`, `alignment/parser/driver.rs:24-59`, `xml.rs:22-58`, `stream/decoder.rs:49-55`.
- **Work is charged once, by the driver, per document (D73).** Today TIN and alignment charge `+1` per event in the pull loop (`parser.rs:62`, `alignment/parser.rs:94`), while plan and pipe charge it in `consume_event` (`plan/parser.rs:196`, `pipe_parser.rs:115`). The stream calls only `consume_event`, so one document meant two different `max_work` values. Alignment also folds char-refs into work (`alignment/parser/driver.rs:67`), and TIN `reserve_references` charges work (`parser/limits.rs:75`).
- **AGENTS.md "Bounding walks".** The XML layer has no reference graph. Nesting is a `Vec` stack (iterative, with no recursion to overflow) capped by `max_depth`. Breadth is bounded by `work`, and retained bytes by the size budgets. The act-and-report contract holds because every `Budget` refusal is a hard `Err` naming its label: there is no truncate-and-succeed path in the driver. The capability-diagnostic cap was an error in TIN only (`parser/limits.rs:88`) and a raw `push` in the other three (`plan/parser/driver.rs:85`, `pipe_parser.rs:185`, `alignment/parser/driver.rs:92`). It becomes the shared `Budget` (EDGE-LXPARSE-1b). Reference-graph walks (plan `pntRef` resolution, `plan_resolution_work_limit`) are C9c's, and they consume this same `Budget` type.

#### 1.3 `TokenScanner` (EDGE-LXPARSE-12, the transport half of -16)

```rust
pub(crate) struct TokenScanner { state, depth: usize, token_len: usize, limits: ScanLimits }
pub(crate) enum TokenKind { Text, Comment, CData, Pi, Markup }
impl TokenScanner {
    /// Feed bytes; calls `on_token(kind, &[u8])` per completed token. memchr-driven.
    pub fn push(&mut self, bytes: &[u8], budgets: &mut Budgets,
                on_token: impl FnMut(TokenKind, &[u8]) -> Result<()>) -> Result<()>;
    pub fn finish(&mut self) -> Result<()>; // "unterminated XML token/markup"
}
```

- **One lexer.** It replaces `preflight.rs:16-198` (pull) and `stream.rs:269-325` plus `stream/token.rs` (stream). Pull runs it over the whole normalized buffer with a no-op `on_token`: it is the preflight. Stream uses `on_token` to append each complete token to the quick-xml feed.
- **The `<!-->` bug is fixed in both lexers.** The terminator search starts after the opener (`preflight.rs:134`, `stream.rs:283`). This is an X fix, landed first in C9a-1 against both old copies.
- **Owned rules.** DOCTYPE refusal, per-kind byte caps (`max_text_bytes` for text/comment/CDATA, `max_markup_bytes` for the rest), quote tracking, and the lexical outside-root rule (XML S only; CDATA refused).
- **Transport.** The feed becomes `Vec<u8>` plus an offset instead of a per-byte `VecDeque` pop (`stream.rs:255`, `stream/token.rs:30`). The debug string is built lazily in `map_err` (`stream.rs:332`).
- **Quick-xml stays the authoritative grammar (D71).** The scanner bounds tokens; it does not build events. That keeps quick-xml's name, attribute and end-tag checks, so no PR in this WP silently changes what is malformed.

#### 1.4 The one decoder (`xml::refs`; builds on B1)

```rust
/// Resolve the five predefined entities and numeric char refs; charge char_refs once
/// per reference; `&other;` -> EntityForbidden; char ref to a non-XML Char -> InvalidXml (D76).
pub(crate) fn decode_text<'a>(raw: &'a str, char_refs: &mut Budget) -> Result<Cow<'a, str>>;
pub(crate) fn decode_ref(r: &BytesRef<'_>, char_refs: &mut Budget) -> Result<char_or_str>;
```

- **Callers.** Attribute values (replacing `xml.rs:83-84`), `Event::Text`, and `Event::GeneralRef`. GeneralRef is decoded directly, with no `format!("&{};")` round-trip (`xml.rs:144`).
- **CDATA is never decoded.** It is passed through literally. Today the four `cdata()` copies agree on this; the rule is pinned by test.
- **Retired copies.** `character_references` (`xml.rs:131`) and the four "charge, then `unescape`" sequences: `parser/text.rs:18-22`, `plan/parser/driver.rs:315-327`, `pipe_parser/driver.rs:93-99`, `alignment/parser/driver.rs:261-265`.
- **Encoding.** `xml::encoding::Decoder` absorbs `stream/decoder.rs`. `normalize_encoding` becomes `Decoder::push(input)` followed by `finish()` (EDGE-LXPARSE-11). The BOM table, the UTF-16 decoding, the normalized-size bound and the 1024-byte declaration window each exist once. `check_declared_encoding` (`xml.rs:269`) is already shared.

#### 1.5 Driver and `FamilyHandler` (EDGE-LXPARSE-1, -14, -18, -25, -28)

```rust
pub(crate) struct Element<'e> {
    pub local: &'e str, pub prefix: &'e str, pub namespace: Option<&'e str>,
    pub target: bool,                 // namespace == root namespace
    pub depth: usize,                 // frames.len() after push
    pub attributes: &'e Attributes,   // decoded ONCE per element for all families
}
pub(crate) struct RootInfo {          // validated once at the root start tag
    pub schema: String, pub version: String, pub capability: LandXmlVersionCapability,
    pub target_namespace: Option<String>,
    pub capability_diagnostics: Vec<LandXmlCapabilityDiagnostic>,  // Budget-bounded
    pub assumed_units: Option<LandXmlUnits>,                       // resolve_assumed_units, once
    pub units_attributes: Option<Attributes>,  // raw LandXML/Units/{Metric|Imperial}; "only once" enforced here
}
pub(crate) struct Cx<'d> { pub root: &'d RootInfo, pub budgets: &'d mut Budgets, frames: &'d [Frame] }
impl Cx<'_> {
    pub fn path_is(&self, expected: &[&str]) -> bool;   // the ONE is_path (4 copies today)
    pub fn parent(&self) -> Option<&Frame>;
}
pub(crate) trait FamilyHandler {
    fn start(&mut self, cx: &mut Cx<'_>, element: &Element<'_>) -> Result<()>;
    fn end(&mut self, cx: &mut Cx<'_>, local: &str, target: bool) -> Result<()>;
    /// Only called when `capture_depth() == Some(depth)` (no per-text-node allocation, EDGE-25).
    fn text(&mut self, cx: &mut Cx<'_>, text: &str) -> Result<()>;
    fn capture_depth(&self) -> Option<usize>;
}
pub(crate) struct Driver<'h> { frames: Vec<Frame>, root: Option<RootInfo>, budgets: Budgets,
                               handlers: &'h mut [&'h mut dyn FamilyHandler] }
impl Driver<'_> {
    pub fn event(&mut self, event: Event<'_>) -> Result<()>;   // pull loop and stream both call this
    pub fn finish(self) -> Result<RootInfo>;                    // empty / unclosed / multi-root checks
}
/// Pull: Decoder -> TokenScanner (preflight) -> quick-xml Reader over the slice -> Driver::event.
pub(crate) fn drive(input: &[u8], limits: &LandXmlLimits, cancel: Option<&dyn LandXmlCancellation>,
                    handlers: &mut [&mut dyn FamilyHandler]) -> Result<RootInfo>;
```

**Event loop.** Each quick-xml event is processed once:

1. Charge `work` (1 + attributes + text bytes).
2. For a start tag: apply the depth cap, `split_name`, decode the attributes once, and resolve the namespace through an `Rc<Namespaces>` that is shared unless the element declares `xmlns*` (EDGE-14).
3. At the root: validate it, then classify via `classify_landxml_version`, using the `supports_tin_ingestion` set. That set is now listed once, which deletes `alignment/parser/driver.rs:373-400`.
4. Enforce the capture-nesting policy (D74).
5. Fan out to each handler.

`end()` borrows `frames.last()` instead of cloning the frame (`parser.rs:358`, `plan/parser/driver.rs:256`, `pipe_parser/driver.rs:14`, `alignment/parser/driver.rs:195`). The manual "mismatched closing element" checks are deleted: quick-xml's `check_end_names` (default `true`) already refuses those inputs, with the same `InvalidXml` code. The 4 outside-root text rules collapse into the scanner and driver, and the 3 copies of `is_xml_s` (`parser/text.rs:84`, `plan/parser/driver.rs:381`, `preflight.rs:93`) plus the inline one (`alignment/parser/driver.rs:358`) become one.

**Families (one handler each; their state machines stay family-private):**

| Handler | Today's front-end copy (deleted when ported) | Owns |
|---|---|---|
| `TinHandler` (`parser/`) | `parser.rs:43-98` loop and `consume_event`, `:99-152` prologue, `:357-368` end prologue, `:388` `is_path`; `parser/text.rs` | Surfaces, Definition, Pnts/Faces, SourceData, overlays, CoordinateSystem, extension roots, preserved-only roots, profiles/cross-sections/roadways (`parser/profiles/*`) |
| `PlanHandler` (`plan/parser/`) | `plan/parser.rs:61-95, 178-213`; `plan/parser/driver.rs:12-98, 255-266, 302-383`; `plan/parser/actions.rs:371` `path` | CgPoints scopes, monuments, parcels, plan features, area unit |
| `AlignmentHandler` (`alignment/parser/`) | `alignment/parser.rs:75-108, 202-219`; `alignment/parser/driver.rs:23-116, 194-222, 257-400` | Alignments, CoordGeom, StaEquation, Cant, Superelevation, AlignPIs |
| `PipeHandler` (`pipe_parser/`) | `pipe_parser.rs:33-65, 114-207`; `pipe_parser/driver.rs` (all); `pipe_parser/handlers.rs:19-61`; `pipe_parser.rs:377` `is_path` | PipeNetworks, Structs/Pipes, Inverts, Flows, Features, element-level refusals |

**Units in C9a are structural only.** The driver finds `LandXML/Units/{Metric,Imperial}` once, enforces "declared only once" (replacing the 3 copies at `parser.rs:276-281`, `plan/parser/driver.rs:100-105`, `alignment/parser/driver.rs:118-121`), and stores the raw attributes in `RootInfo`. Each family keeps its own conversion until C9b: `semantics::units` (`semantics.rs:55`), pipe `convert::units` (`pipe_parser/convert.rs:12`) and plan `area_scale` (`plan/parser/value.rs:7`). The scale table, `elevationUnit=""` and pipe sub-units belong to C9b (D75).

**Stream.** `LandXmlTinStreamSession` keeps its public shape and owns one `Driver` with the four handlers. That replaces the four `Option<…Parser>` fields and the 4× `event.clone()` fan-out (`stream.rs:47-50, 386-395`). The pad-comment / PI scheme stays: it is already correct after B1. The stream is the same driver fed one token at a time, so pull and stream share every semantic transition by construction.

#### 1.6 One-pass pull source (EDGE-LXPARSE-8)

```rust
pub fn parse_landxml_source_with_cancel(input: &[u8], limits: &LandXmlSourceLimits,
    cancelled: Option<&dyn LandXmlCancellation>) -> Result<LandXmlSource, LandXmlError>;
pub struct LandXmlSource { pub document: LandXmlDocument, pub alignments: LandXmlAlignmentDocument }
pub struct LandXmlSourceLimits { pub xml: LandXmlLimits, pub plan: LandXmlPlanLimits,
                                 pub alignment: LandXmlAlignmentLimits } // top-level `xml` wins (doc'd)
```

- **What it does.** It runs the four handlers in one `drive`, with `require_pipe_networks = false`. That deletes the string-matched error at `parser/document.rs:17-20` and its stale doc at `:8-12`.
- **Who calls it.** `parse_landxml_document` (`plan.rs:34`). The wasm endpoints too: `parseLandXmlSourceBytes` (`rust/wasm-bindings/src/api/landxml/endpoints/methods.rs:36-64`, 4 passes today) and `parseLandXmlSourceBytesWithOptions` (`:71-115`, 3 passes, and no pipes because it calls `parse_landxml_tin_with_cancel`).
- **Existing pub entry points stay as thin wrappers** that run one handler: `parse_landxml_tin*`, `parse_landxml_plan*`, `parse_landxml_pipe_networks*` and `alignment::parse_landxml_alignments*`.

#### 1.7 Values home (EDGE-LXPARSE-10)

`xml::values::finite(&str, context)` and `coord_list(text, dim, min, &mut Budget, context) -> Vec<f64>`. `coord_list` counts, reserves and then parses once, and callers pass their current messages as `context`. It replaces:
- `semantics.rs:22-53`;
- `parser/capture.rs:57-139`;
- `parser/profiles/values.rs:8-111`;
- `plan/parser/value.rs:26-118`;
- `alignment/parser/actions/values.rs:27-106`;
- `pipe_parser/convert.rs:358-385`. Pipe keeps a `Result<_, String>` adapter until F5.

All 10 sites already refuse NaN/inf (verified by the review), so this is R. Count-before-allocate becomes universal, which is a memory win only.

---

### 2. Every current copy, by finding

| Finding | Copies at base (`file:line`) | PR |
|---|---|---|
| EDGE-LXPARSE-1 (High, DRY) | The four pull loops `parser.rs:43-76`, `plan/parser.rs:61-95`, `pipe_parser.rs:33-65`, `alignment/parser.rs:75-108`; the 4 `consume_event`s `parser.rs:81-98`, `plan/parser.rs:195-213`, `pipe_parser.rs:114-132`, `alignment/parser.rs:202-219`; start prologues `parser.rs:99-152`, `plan/parser/driver.rs:12-98`, `pipe_parser.rs:138-207`, `alignment/parser/driver.rs:60-116` + `validate_root` `:373-400`; end prologues `parser.rs:357-368`, `plan/parser/driver.rs:255-266`, `pipe_parser/driver.rs:13-24`, `alignment/parser/driver.rs:194-205`; `is_path` ×4 (`parser.rs:388`, `plan/parser/actions.rs:371`, `pipe_parser.rs:377`, `alignment/parser/driver.rs:321`) | X1 reconciles; R5–R8 delete |
| EDGE-LXPARSE-5 (DRY) | 17 counters (§1.2) | X1 (alignment code), R2 |
| EDGE-LXPARSE-8 (Perf) | `parser/document.rs:13-23`, `plan.rs:34-41`, wasm `methods.rs:36-115` | X10 |
| EDGE-LXPARSE-10 (DRY) | §1.7 | R9 |
| EDGE-LXPARSE-11 (DRY) | `xml.rs:157-267` vs `stream/decoder.rs:12-170` | R3a |
| EDGE-LXPARSE-12 (DRY + `<!-->` bug) | `preflight.rs:16-198` vs `stream.rs:269-325`; bug at `preflight.rs:134`, `stream.rs:283` | X1 (bug), R3b |
| EDGE-LXPARSE-14 (Perf) | namespace clones `parser.rs:108-113`, `plan/parser/driver.rs:50-53`, `pipe_parser.rs:147-150`, `alignment/parser/driver.rs:69-72`; frame clones in the 4 `end()`s; attributes decoded per family (`xml.rs:60-93`) ×4 in stream | R5 (driver), R8 (stream fan-out) |
| EDGE-LXPARSE-15 (Perf) | `pipe_parser.rs:208` `properties(&attributes)` before the `match` | R8 |
| EDGE-LXPARSE-16 (Perf) | `stream.rs:255` per-byte pop; `stream.rs:269-311` per-byte token push; `stream.rs:332` debug copy; `stream/token.rs:30` per-byte pop; `stream/output.rs:110-117` `serde_json::to_vec` for `.len()` | R3b (feed/scan/debug), R11 (counting writer) |
| EDGE-LXPARSE-18 (DRY) | outside-root: `parser/text.rs:43-57`, `plan/parser/driver.rs:309-314, 354-356`, `pipe_parser/driver.rs:94-96` (Unicode `trim`; no CDATA rule), `alignment/parser/driver.rs:354-372`, `preflight.rs:30-35, 54-59`; nested-in-capture: TIN ignores (`parser/text.rs:59-80`), plan refuses (`plan/parser/driver.rs:13-22`), alignment refuses (`alignment/parser/driver.rs:102-111`), pipe marks invalid (`pipe_parser.rs:198-204`) | X1 |
| EDGE-LXPARSE-19 (DRY) | `parser/state.rs:204` and `plan/parser/state.rs:83` filter `xmlns*`; `pipe_parser/state.rs:63` does not. Property element: `pipe_parser.rs:282` vs `plan/parser/driver.rs:196` | X1 (xmlns), R8 (helper) |
| EDGE-LXPARSE-20 (DRY) | `pipe_parser/convert.rs:107-130, 131-154, 155-178` (+ 89-105, 188-228) | R12 (optional) |
| EDGE-LXPARSE-25 (Perf) | `parser/text.rs:22`, `alignment/parser/driver.rs:265` unescape before the capture check | R5/R7 (`capture_depth`) |
| EDGE-LXPARSE-28 (Maint.) | `start()` god functions (function-length allowlist rows: `parser.rs Parser::start` 257, `plan/parser/driver.rs Parser::start` 243, `pipe_parser.rs PipeParser::start` 238, `parser/capture.rs finish_capture` 164, `parser/finalize.rs finish_surface` 154); sentinel roles `"__location"` (`plan/parser/driver.rs`), `"__align_pi"`/`"__alignment_start"` (`alignment/parser/driver.rs:147,171`); `#[allow(private_interfaces)]` `plan/parser.rs:99`; files at the 400-line cap (`alignment/parser/driver.rs` 400, `plan/parser/actions.rs` 400, `stream.rs` 397, `pipe_parser/convert.rs` 399) | R5–R8 (start splits), R12 (rest) |

**Re-maps.**
- **XCUT-19, landxml bullet** (the work-limit formula; F2a's note sent it to C9a). This is the same code as EDGE-LXPARSE-21, which the ledger assigns to C9c. Record it as `fixed-by:EDGE-LXPARSE-21` in C9c (D79).
- **EDGE-LXPARSE-29** (naming, the two `LandXmlAlignment` types) stays L-landxml / C9b. The "exact LandXML 1.2" doc lines on the entry points C9a rewrites (`parser.rs:37,42`, `pipe_parser.rs:27,32`, `plan/parser.rs:56`) are corrected in passing, as docs drift inside the WP.

---

### 3. Drift reconciliation (all in **C9a-1, X**, before any consolidation)

| # | Drift | Agreed behaviour (pinned by a test that names the finding) |
|---|---|---|
| 1 | Per-event work charge (TIN/alignment in the loop; plan/pipe in `consume_event`; stream sees only `consume_event`) | Charged in `consume_event` in all four, so pull equals stream. Work = events + attributes + text bytes. Alignment stops adding char-refs to work; TIN `reserve_references` stops charging work (D73). |
| 2 | Version-mismatch diagnostic: bounded in TIN, raw `push` elsewhere | Bounded in all four. |
| 3 | Version read with `required` / `.expect` / `unwrap_or_default` | `required(..,"version","LandXML")` in all four (it can't fail after classification, so there is no visible effect). |
| 4 | Messages: "multiple root elements" vs "multiple roots"; plan's own unsupported-version text | "LandXML document has multiple root elements"; one unsupported-version text. |
| 5 | Empty document: "unclosed XML element" (pipe) / "LandXML document is empty" (plan, stream) / "document must contain exactly one root element" (alignment) | "LandXML document is empty" (no root); "unclosed XML element" (root not closed). Stream's "unclosed plan/alignment/pipe XML element" (`stream.rs:199,204,209`) collapse into the second. |
| 6 | Outside-root text: pipe uses Unicode `trim` and accepts CDATA | XML S bytes only; CDATA refused, in all four plus the scanner. |
| 7 | Nested element inside a numeric capture | Refused at the family's granularity (D74): TIN, plan and alignment refuse the document (`InvalidSemantic`); pipe refuses the record (its existing element-level refusal list, D3-consistent). **Visible:** TIN `<P id="1">1 2 <Foo>9</Foo>3</P>` is refused instead of read as "1 2 3". |
| 8 | Alignment limit reported as `InvalidSemantic` | `LimitExceeded`. |
| 9 | Pipe record properties keep `xmlns*` | Filtered, as TIN and plan do (pipe golden moves only if a corpus fixture declares `xmlns` on a pipe element). |
| 10 | `<!-->x-->`: pull falsely refuses, stream hits EOF | Comment terminator searched after the opener in both lexers. |
| 11 | Char reference to a non-XML Char (`&#0;`, `&#xFFFE;`) accepted in text and attributes (B1 review note) | Refused, `InvalidXml` (D76). |
| 12 | Double-fault documents (content outside the root plus another error) report different codes in pull and stream (B1 review note) | First fault in source order wins on both paths, because pull's preflight and the stream scanner run the same rule order. Closed by R3b; the row stays in G0's allowlist until then. |

Not reconciled here: units semantics (C9b, D75); the stream's late-`<Units>` refusal versus pull's warning (accepted, D78); the TIN/alignment double parse of `Alignment` and the two public types (C9b, EDGE-LXPARSE-9).

**Error vs skip policy (D3).** C9a changes no family's semantic granularity. XML-level faults (malformed, limits, outside-root, entities, DTD) refuse the document in every family and both modes. Semantic faults keep their owner's existing contract: TIN, plan and alignment refuse the document; pipe records an element refusal. Only drift #7 is new behaviour.

**Namespaces.** The target namespace is the root's resolved namespace. Every element is classified `target` once by the driver. Foreign elements reach handlers with `target = false` (TIN uses them for extension roots and preserved-only roots). Prefix inheritance goes through `Rc<Namespaces>`.

**CDATA and entities.** CDATA is literal everywhere and never decoded. Text and attribute references go through `xml::refs` only. DOCTYPE is refused by the scanner (the lexical layer) and by the driver (`Event::DocType`, a belt and braces check that is kept).

---

### 4. PR sequence (stacked on one branch line; each one revertible)

| PR | Class | Content | Est. changed lines |
|---|---|---|---|
| **C9a-0** | G | Differential pull-vs-stream oracle. A `differential_landxml` helper in `tests/fuzz/exercise.rs`: for every input it asserts equal `Ok`/`Err` codes, and equal serde JSON of terrain, plan, alignments and pipes, between the pull entry points and the stream at chunk sizes 1, 7 and 4096. Replayed over the golden corpus and the fuzz seeds; the scheduled fuzz target gains the differential. A named allowlist holds today's divergences (drift 1, 10 and 12, and D78). Each X PR deletes its rows; removing a row before its fix fails (the parent-commit check). | ~300 |
| **C9a-1** | X | Drift table §3 rows 1–11, applied to the four current copies and both lexers. Regression tests first. Golden re-pin only where an error-message pin moves (list them in the PR). | ~450 |
| **C9a-2** | R | `xml::Budget`/`Budgets`/`Poller`; all 17 counters migrate. | ~500 |
| **C9a-3a** | R | `xml::encoding::Decoder`; `normalize_encoding` = push + finish; `stream/decoder.rs` deleted. | ~300 |
| **C9a-3b** | R | `TokenScanner` (memchr, slice-backed feed, lazy debug string); `preflight.rs` and stream framing deleted. Closes drift 12. | ~550 |
| **C9a-4** | R | `xml::refs` one decoder; `general_ref_source`/`character_references`/`unescape` call sites go. | ~250 |
| **C9a-5** | R | `xml::{element,driver}` + `TinHandler`; the TIN pull entry and the stream's TIN slot go through the driver; TIN `start()` split (allowlist row out). | ~900 (split into 5a driver+element / 5b TIN port if >1.5k with tests) |
| **C9a-6** | R | `PlanHandler` port; plan `start()` split; `#[allow(private_interfaces)]` gone. | ~650 |
| **C9a-7** | R | `AlignmentHandler` port; `validate_root` deleted; sentinel roles → enum. | ~550 |
| **C9a-8** | R | `PipeHandler` port + EDGE-15 + `xml::properties` helper; the stream owns one `Driver` (4 handlers, 1 decode, `Rc` namespaces). | ~700 |
| **C9a-9** | R | `xml::values` (EDGE-10). | ~400 |
| **C9a-10** | X | `parse_landxml_source_with_cancel` + `LandXmlSourceLimits`/`LandXmlSource`; `parse_landxml_document` and both wasm endpoints on it; WithOptions now returns pipes (EDGE-8). Changeset for `@ifc-lite/wasm`; `pnpm test:wasm-contract` extended for WithOptions pipes; regenerated `.d.ts` only if the binding signature changes (it should not). | ~350 |
| C9a-11 | R | Counting writer for queue sizing (`stream/output.rs:110`). | ~80 |
| C9a-12 | R | EDGE-28 remainder (`finish_capture`, `finish_surface` splits; path-literal constants) + EDGE-20 `PartDims`. | ~500 |

**Evidence for each R PR:**
- `tests/landxml_golden.rs` is byte-identical;
- the G0 differential is green;
- the B1 and 7675/7677/7693 tests are unchanged;
- `cargo test -p ifc-lite-landxml`, `-p ifc-lite-export` (its `landxml_terrain_tests`) and `-p ifc-lite-wasm`;
- `cargo clippy --workspace --all-targets -D warnings`;
- `tests/fuzz_regressions.rs`.

Each X PR also lists the golden pins that moved and why. C9a-1, C9a-3b, C9a-5 and C9a-8 also need a perf verdict (§6). The function-length allowlist rows and module sizes are re-measured on each rebase (G4).

---

### 5. TS twin parity (`packages/create` LandXML)

`packages/create/src/landxml/*` has **no XML parser**. It maps the serialized Rust document (`source-types.ts` declares the structural shape). The viewer hands every `.xml` to the Rust parser (`apps/viewer/src/hooks/ingest/landXmlSniff.ts`). It reads errors by code, except for one message substring match (below). So C9a has no D5 twin edit. Parity obligations:

- **Serde shape is unchanged.** Every R PR is pinned by the golden JSON. C9a-10 is the only shape-visible change: WithOptions gains `pipeNetworks`. In that PR, check that the viewer path that calls WithOptions (`landXmlWasm.ts` / `landXmlPipeWasm.ts`) does not parse pipes a second time, and add the `@ifc-lite/wasm` changeset.
- **Error codes are unchanged** in all PRs except C9a-1. The codes there move only for drift 8 (alignment `InvalidSemantic` → `LimitExceeded`, LXML009 → LXML004) and drift 11 (new LXML006).
- **One message is a viewer contract.** `apps/viewer/src/hooks/ingest/landXmlUnitsRefusal.ts:30` `isLandXmlUnitsRefusal` matches the substrings `linearUnit` and `LandXML/Units`. That string comes from `require_units_for_renderable_tin` and is pinned by `tests/units_required_5175.rs`. No C9a PR may change that message, and no new message may contain both substrings. In particular, #7753's stream refusal "LandXML/Units is declared after …" must keep lacking `linearUnit`, or the viewer would offer a unit picker that cannot help. The C9a-1 test asserts this. The same file mirrors the unit tokens of `semantics.rs::scale`, which is C9b's to keep in sync.
- #7754's shared CircCurve vector (`tests/fixtures/circ-curve-length-vectors.json`) is untouched.

---

### 6. Perf

Baseline and verdict, measured base vs branch, interleaved, 5 runs each, `--release`. Rule: R PRs within ±3%; C9a-8 and C9a-10 must be faster; nothing may get slower.

- **Pull:** wall time and peak RSS (`/usr/bin/time -v`) of `parse_landxml_document` over the 10 golden fixtures, via a small `#[ignore]` probe test added in C9a-0.
- **Stream:** `tests/landxml_streaming_bench_5050.rs` (it already reports timings and queue invariants).
- **Expected:**
  - `parse_landxml_document` drops from 3 encoding+preflight+quick-xml passes to 1, and wasm `parseLandXmlSourceBytes` from 4 to 1.
  - The stream drops from 4 attribute decodes and 4 namespace-map clones per element to 1 decode and an `Rc` clone. Measured at about 60M map allocations for 5M `<P>` + 10M `<F>`.
  - Per-byte `VecDeque` traffic becomes slice copies.
- **Record:** the verdict and lesson go into `scripts/perf/README.md` in C9a-10.

---

### 7. Published API impact

- `ifc-lite-landxml` (published) gains `parse_landxml_source`, `parse_landxml_source_with_cancel`, `LandXmlSource` and `LandXmlSourceLimits`. **Additive only: no `rust-major-offset.json` (break #11) entry** (D77).
- Every existing pub item stays, including `LandXmlTinStreamSession`, the `alignment` module entry points and the `*Limits` structs.
- Error-message text is not semver surface, but the golden pins track it.
- Verify with `cargo-semver-checks` against crates.io in C9a-10. `@ifc-lite/wasm` behaviour changes only in C9a-10 (patch changeset, no signature change).

---

### 8. Stop line

- **Required (counts toward D8):** C9a-0, 1, 2, 3a, 3b, 4, 5, 6, 7, 8, 10.
- **Optional:** C9a-9 (EDGE-10; if skipped, record it `deferred` to L-landxml), C9a-11 and C9a-12 (EDGE-20 and the rest of -28 → L-landxml).
- **Safe to stall at any point** without a third copy:
  - after C9a-2 to 4, the four front-ends remain but share `Budget`, the scanner and the decoder;
  - after C9a-5 to 7, the unported families still run their own prologue (made identical by C9a-1, and held there by G0), while the stream dispatches to the driver for ported families and the legacy `consume_event` for the rest.
- **Never:** a driver PR without at least one family deleted in the same PR (that would add a fifth front-end), and no R PR that moves a golden pin.

**Hot files (waves 3–4, C9a only):** `xml.rs`/`xml/*`, `preflight.rs`, `parser.rs`, `parser/{text,limits,state,path,document}.rs`, `plan/parser*`, `alignment/parser*`, `pipe_parser.rs`, `pipe_parser/{driver,handlers,state}.rs`, `stream.rs`, `stream/{decoder,token,output,lifecycle}.rs`, `plan.rs`, and wasm `api/landxml/endpoints/methods.rs`.
- **C9d** (`terrain*.rs`) is disjoint and may run in parallel.
- **C9c** (`plan/numeric/*`, `alignment/numeric/*`, `stream/derived/*`) is disjoint.
- **C9b** starts after C9a-8, because unit conversion and the model types live in the handlers.

**How C9b, C9c and C9d consume C9a:**
- **C9b:** `RootInfo::units_attributes` → one `units_from(&Attributes)` + `linear_scale` (EDGE-LXPARSE-6 / LXMATH-12; `elevationUnit=""` policy as its own X); one owner for the `Alignment` header across `TinHandler`/`AlignmentHandler` (EDGE-LXPARSE-9); one `max_alignments` (which also collapses `LandXmlSourceLimits`' nested limits).
- **C9c:** `plan_resolution_work_limit` and the resolver use `xml::Budget` (EDGE-LXPARSE-21 + XCUT-19 bullet).
- **C9d:** independent of the driver; may reuse `Budget` for its outcome mapping.

---

### 9. Docs touched

- `docs/architecture/landxml-coverage-ledger.md` §"Cross-cutting precondition: declared units": one driver; the stream's late-`<Units>` refusal after an assumed header (#7753).
- `docs/guide/landxml.md:62`: "identically on every parse path" becomes true by construction; note the late-Units stream refusal.
- `rust/AGENTS.md`: a new short "LandXML ingestion" section. Families implement `FamilyHandler` and never match quick-xml events. Caps are `xml::Budget`. Work is charged by the driver only.
- `rust/landxml/src/lib.rs` crate docs.
- The stale comments in `parser/document.rs:8-12` and `parser/text.rs:12-17`, and the entry-point "exact LandXML 1.2" docs.
- `scripts/perf/README.md` (the C9a-10 verdict).
- `.changeset/*` (C9a-10).
- `rust/processing/tests/function_length_allowlist.txt` (rows 78–82 out).

---

### 10. Failure modes

1. **Reader lag returns in the scanner/driver refactor.** quick-xml splits one text token into Text/GeneralRef/Text, and the pad comment/PI bookkeeping could drop or misplace an event (the EDGE-LXPARSE-3 class). The stream then disagrees with pull, or silently drops a reference.
   *Guard:* G0 runs the differential at chunk sizes 1, 7 and 4096 over the corpus and fuzz seeds; the B1 tests stay; C9a-3b keeps the pad scheme unchanged.
2. **The shared work budget refuses real files that passed before.** In the stream, four families charged four separate counters against `max_work`. A single document-level counter charged only by the driver means the same `max_work` now covers one pass instead of up to four.
   *Guard:* D73 charges work in the driver only (families charge record budgets), which makes stream and pull work equal to today's TIN pull count, not to a sum. C9a-1 logs the corpus maximum work against `max_work` (100M) in the PR.
3. **Message churn breaks the golden oracle or lets an R PR hide behaviour.** `landxml_golden.rs` pins error *messages*, so an "R" consolidation that rewords a message would move a pin and could be waved through as a re-pin.
   *Guard:* every message change lands in C9a-1 (X). Any R PR that moves a golden pin is reclassified X and split. Reviewers check `git diff --stat tests/golden` is empty on R PRs. The viewer's substring match on the LXML009 units message (§5) is a second consumer the golden test does not cover. It stays pinned by `units_required_5175.rs`, and C9a-1 adds a test that no other refusal contains both substrings.

---

### 11. Decisions (D70+)

| ID | Decision |
|---|---|
| D70 | Streaming, not DOM: one event-driven `xml::driver` shared by pull and stream; no document tree is built. |
| D71 | quick-xml stays the authoritative XML grammar in both modes; `TokenScanner` is a lexical bound/framer only (no event construction). |
| D72 | One `xml::Budget`/`Budgets` type; every cap reports `LimitExceeded` "<label> limit exceeded"; record caps are family-owned Budgets. |
| D73 | `work` = events + attributes + text bytes, charged once per document by the driver only; families never charge work; char-refs never count as work. |
| D74 | Nested element inside a numeric capture is refused at the family's granularity (TIN/plan/alignment: document; pipe: record). Visible for TIN. |
| D75 | C9a owns units only structurally (location, once-only, raw attributes in `RootInfo`, assumed unit resolved once); scale tables and `elevationUnit=""` stay C9b. |
| D76 | Char references to non-XML Chars are refused (`InvalidXml`) in text and attributes. |
| D77 | C9a is additive on the published API (`parse_landxml_source*`, `LandXmlSource`, `LandXmlSourceLimits`); no break #11 entry. |
| D78 | Accepted pull/stream divergence: a declared `<Units>` after an assumed stream header is refused in stream (#7753) but used, with a warning, in pull; listed in G0's allowlist permanently. |
| D79 | XCUT-19's landxml work-limit bullet is `fixed-by:EDGE-LXPARSE-21` in C9c (not C9a). |

**Needs the maintainer:** D74 (TIN may now refuse files with markup inside `<P>`/`<F>`; default refuse per D3), D78 (keep the divergence), and C9a-10's visible change (WithOptions returns pipes).
