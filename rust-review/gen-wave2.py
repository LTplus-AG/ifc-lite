import csv,re,sys,json,subprocess,os
D='/home/louistrue/rust-review'
REPO='LTplus-AG/ifc-lite'
DRY = len(sys.argv)<2 or sys.argv[1]!='go'
led=list(csv.DictReader(open(f'{D}/ledger.csv')))
cov={r['id']:r for r in csv.DictReader(open(f'{D}/plan-coverage.csv'))}
plan=open(f'{D}/PLAN.md').read().split('\n')
rows={}
for ln in plan:
    m=re.match(r'\| \*\*([A-Z][0-9a-z-]*)\*\* \|',ln)
    if m: rows[m.group(1)]=[c.strip() for c in ln.strip().strip('|').split('|')]
issues=dict(l.split('\t') for l in open(f'{D}/issues.tsv').read().split('\n') if l)
def scope(wp):
    c=rows[wp][1:]
    return ' — '.join(c)
WPS=[ # wp, kind, title
('F2a','wp','Cross-crate math home ifc_lite_geometry::math (v3, mat4, aabb, frame)'),
('F2b','wp','Geometry-internal 2D predicates consolidated on geom2d'),
('F2c','wp','Tolerance catalogue math::tol with documented units'),
('F3a','wp','Core units and project (one ProjectUnits, cached length_unit_scale, one IFCPROJECT locator)'),
('F3c','wp','Typed values: AttributeValue::Typed, as_logical(), symmetric accessors'),
('F3d','wp','Core micro-homes: guid, hash (FNV, xxh3 content key), fmt_num, colour keys'),
('F4','wp','One STEP grammar in core (StepRecord::parse, split_top_level_args, numeric grammar)'),
('F3b','dn','core entity reading (point3/direction3, axis placements, resolve_chain)'),
('F3e','dn','typed attribute slots in core replacing positional reads'),
('C2','dn','router restructure (RepresentationWalk, CutStrategy, EdgeLedger, GeometryRouter split)'),
('C4','dn','processing orchestration (process entry point, browser batch entry)'),
('C6','dn','ifc_lite_processing::data_model shared by export and server'),
('C9a','dn','LandXML XML driver (FamilyHandler, Budget, TokenScanner, one decoder)'),
]
Q={
'F2a':["Seam between `ifc_lite_clash` and `ifc_lite_geometry`: promote geometry's existing dev-dependency on clash to a normal dependency, or keep the 14-line clone and add a parity test. Which, and what does it do to the crate graph and publish order?",
 "API of `math::{v3, mat4, aabb, frame}` (each file under 400 lines), and which of the Plato helpers clash keeps.",
 "Migration order per (foundation x crate), drift-reconciliation list (copies that disagree are pinned in an X PR first, then deleted in an R PR), stop line (which migrations are optional and what is safe to delete if migration stalls at crate N), docs touched."],
'F3b':["Policy for malformed points, placements and units per D3 (fail closed: refuse the item, record a diagnostic, count refused elements in `ProcessingResult`), applied reconcile-then-delete: which copies disagree today and in what order they are reconciled.",
 "API of `point3`/`direction3`, `Axis2Placement::{2d,3d}` -> one `build_axis2_matrix`, `Axis1Placement`, `placement::resolve_chain` (depth from `core::limits`). Which half of CORE-13 (readers) lives here; the unscaled 1000.0 half is F3a.",
 "Migration order, drift-reconciliation list, stop line, docs touched."],
'F3e':["Shape of the typed attribute slots in core that replace ~1,400 magic positional reads (per-entity structs vs slot enums vs generated tables), and how they interact with F3c's `AttributeValue::Typed`.",
 "Whether slots are generated or hand-written, and how schema families (IFC2X3/IFC4/IFC4X3) are represented.",
 "Migration order, drift-reconciliation list, stop line, docs touched."],
'F4':["API of `StepRecord::parse`, one `split_top_level_args` with grammar options, one numeric grammar, trivia/comments handling and binary literals; what the grammar options are and who sets them.",
 "Scope of the **G7** differential fuzz target (STEP grammar differential) and which implementations it compares.",
 "Migration order across core, export, geometry and processing, drift-reconciliation list, stop line, docs touched."],
'C2':["Where `RepresentationWalk` lives (decided: in geometry, with C4/C5 consuming it): its API, and how the mapped-source walks are routed through `process_representation_item`.",
 "The `CutStrategy` list, `EdgeLedger` (from F1a), the `GeometryRouter` split, and deletion of the `profile_extractor` fork.",
 "Migration order, drift-reconciliation list, stop line, docs touched. This is the only WP that edits `prism_cut.rs` / `apply_void_context_inner`."],
'C4':["The native `process(content, &ProcessingRequest, &mut dyn ProcessingSink)` entry point collapsing the 11 `process_geometry*` entry points: request/sink shapes and the migration of each caller.",
 "The browser's one pull-driven batch entry (D12: browser batch entry points stay stable) sharing `ScanCollector`/`Discovery`, `TypeGeometryPlan`, `GeometryPass`, `BatchRouterConfig` and `resolve_element_color`; `ContentCaches::reset()`.",
 "Migration order, drift-reconciliation list, stop line, docs touched."],
'C6':["Typed row model of `ifc_lite_processing::data_model` (pset/qset/material/classification/relationship/spatial) and how export's CSV/JSON/BOS writers and the server's Parquet writer consume it.",
 "What is deleted: `apps/server/src/services/data_model/{properties,quantities,relationships,materials,classifications}.rs` and the generators `scripts/generate-server-attr-indices.mjs` and `generate-server-relationship-slots.mjs`; one `SchemaFamily`.",
 "Migration order, drift-reconciliation list, stop line, docs touched."],
'C9a':["Shape of the LandXML XML driver: `xml::driver`, `FamilyHandler`, `Budget`, `TokenScanner` and one decoder (builds on B1's entity/character-reference fix).",
 "How C9b, C9c and C9d consume it, and what the drift-reconciliation list for the existing parsers is.",
 "Migration order, stop line, docs touched."],
}
SEV={'High':0,'Medium':1,'Low':2}
def block(f,i):
    r=block1(f,i)
    m=re.match(r'EDGE-[A-Z]+-(\d+)$',i)
    if r is None and m: r=block1(f,'EDGE-'+m.group(1))
    return r
def block1(f,i):
    t=open(f'{D}/{f}').read().split('\n')
    s=None
    for n,l in enumerate(t):
        if re.match(r'^###+\s+'+re.escape(i)+r'(\b|:)(?![-\w])',l) : s=n;break
    if s is None: return None
    e=len(t)
    for n in range(s+1,len(t)):
        if re.match(r'^##+ ',t[n]): e=n;break
    b=t[s:e]
    while b and (not b[-1].strip() or b[-1].strip()=='---'): b.pop()
    return '\n'.join(b)
missing=[]
out={}
EV="Evidence and PR rules: charter §1.2 (R/X/G classes), §1.3 and §1.4 (adversarial review before merge). Rows marked `verify-first` are reproduced as the first commit of the fix PR. If one does not reproduce, the ledger records it as `rejected` with evidence."
for wp,kind,what in WPS:
    fs=[r for r in led if r['wp']==wp]
    fs.sort(key=lambda r:(SEV[r['severity']],r['id']))
    tab=['| ID | Sev | Category | Disposition | Note |','|---|---|---|---|---|']
    for r in fs:
        c=cov[r['id']]
        note=c['note'].replace(' | ','; ').replace('|','/')[:160]
        tab.append(f"| {r['id']} | {r['severity']} | {c['category']} | {c['disposition_hint']} | {note} |")
    dets=[]
    for r in fs:
        b=block(r['file'],r['id'])
        if b is None: missing.append((wp,r['id'],r['file'])); continue
        dets.append(f"<details><summary><b>{r['id']}</b>: {r['severity']}</summary>\n\n{b}\n\n</details>\n")
    ready = kind=='dn' or wp in ('F2a','F3a','F3c','F3d','F4')
    if kind=='wp':
        title=f'Rust sweep {wp}: {what}'
        head=f"Work package **{wp}** of the Rust maintainability sweep charter #7670.\n\n**Scope (from the charter):** {scope(wp)}\n\n{EV}\n"
        if wp in('F2b','F2c'): head+=f"\nBlocked by F2a #{{F2A}}. Not labelled `ready` until F2a lands.\n"
    else:
        title=f'Rust sweep {wp} design note: {what}'
        qs='\n'.join(f'{n}. {q}' for n,q in enumerate(Q[wp],1))
        head=(f"Design-note issue for work package **{wp}** of the Rust maintainability sweep charter #7670. No code lands for {wp} before this note is written and reviewed (charter §1.4: Fable writes the note and reviews the {wp} PRs).\n\n"
              f"**Scope (from the charter):** {scope(wp)}\n\n"
              f"**The note decides:**\n\n{qs}\n\n"
              "Every note covers API, migration order, drift-reconciliation list, stop line and docs touched (charter §1.3, §1.4). Behaviour-policy changes are never combined with a consolidation (reconcile-then-delete, §1.2).\n\n"
              f"Findings below are the ones the note must cite; full text is in the review reports under `~/rust-review/` (files listed per ID in the ledger).\n")
    body=head+f"\n## Findings ({len(fs)})\n\n"+'\n'.join(tab)+'\n'
    comment=None
    if kind=='wp':
        pre=body+"\n## Full finding text\n\n"
        ins=[];over=[]
        used=len(pre)+2000
        for d in dets:
            if used+len(d)+1<=65000: ins.append(d);used+=len(d)+1
            else: over.append(d)
        body=pre+'\n'.join(ins)
        if over:
            body+=f"\n_{len(over)} further findings continue in the first comment (GitHub's 65,536-character body limit)._\n"
            comment='## Full finding text (continued)\n\n'+'\n'.join(over)
            assert len(comment)<65000,len(comment)
    out[wp]=dict(title=title,body=body,comment=comment,ready=ready,n=len(fs))
    print(wp,len(fs),len(body),'comment' if comment else '',file=sys.stderr)
print('MISSING',missing,file=sys.stderr)
json.dump(out,open('/tmp/w2/out.json','w'))
if DRY: sys.exit()
def run(a): return subprocess.check_output(a,text=True).strip()
res={}
for wp,kind,_ in WPS:
    if wp in issues: print('already',wp);continue
    ex=run(['gh','issue','list','--repo',REPO,'--search',f'Rust sweep {wp}','--state','all','--json','number,title','-q',f'.[]|select(.title|startswith("Rust sweep {wp}:") or startswith("Rust sweep {wp} design"))|.number'])
    if ex: print('EXISTS',wp,ex);continue
    o=out[wp]
    body=o['body'].replace('{F2A}',res.get('F2a','F2a').split('/')[-1])
    open('/tmp/w2/body.md','w').write(body)
    labels=['rust-sweep']+(['ready'] if o['ready'] else [])
    a=['gh','issue','create','--repo',REPO,'--title',o['title'],'--body-file','/tmp/w2/body.md']
    for l in labels: a+=['--label',l]
    url=run(a); res[wp]=url; print(wp,url)
    if o['comment']:
        open('/tmp/w2/c.md','w').write(o['comment'])
        run(['gh','issue','comment',url,'--body-file','/tmp/w2/c.md'])
    open(f'{D}/issues.tsv','a').write(f'{wp}\t{url}\n')
