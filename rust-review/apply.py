import csv,re,sys,collections,json
D='/home/louistrue/rust-review'
ids={r['id'] for r in csv.DictReader(open(f'{D}/ids.csv'))}
rows=list(csv.DictReader(open(f'{D}/plan-coverage.csv')))
fields=list(rows[0].keys())
by={r['id']:r for r in rows}
orig={r['id']:(r['wp'],r['disposition_hint'],r['note']) for r in rows}

TOK=re.compile(r'\b((?:EDGE-)?(?:LXMATH|LXPARSE|[A-Z]+(?:-[A-Z]+)?))-(S?\d+)((?:(?:/|\.\.)S?\d+)*)')
def expand(text):
    out=[]
    for m in TOK.finditer(text):
        p,first,rest=m.groups()
        if p in('LXMATH','LXPARSE'): p='EDGE-'+p
        s=first.startswith('S')
        nums=[first]
        prev=first
        for sep,n in re.findall(r'(/|\.\.)(S?\d+)',rest):
            if s and not n.startswith('S'): n='S'+n
            if sep=='..':
                a=int(prev.lstrip('S')); b=int(n.lstrip('S'))
                nums+=[('S' if s else '')+str(i) for i in range(a+1,b+1)]
            else: nums.append(n)
            prev=n
        for n in nums: out.append(f'{p}-{n}')
    return out
def exp(text):
    r=expand(text)
    bad=[i for i in r if i not in ids]
    assert not bad,(text,bad)
    return r

assign={}   # id -> (wp, note)
def put(wp,text,note='',force=True):
    for i in exp(text):
        if i in assign and assign[i][0]!=wp:
            assign[i]=(assign[i][0],assign[i][1]+f'; also named in {wp} row of PLAN v2' )
            continue
        assign.setdefault(i,(wp,note))

# --- step 1: review correction table (applied first, authoritative) ---
corr=[]
def C(text,wp,note=''):
    for i in exp(text):
        corr.append((i,wp,note))
C('ROUTER-26','B6f','PLAN-REVIEW: mapped-source walks rebase/drain, fix now')
C('ROUTER-27','B6f','PLAN-REVIEW: mapped-source walks rebase/drain, fix now')
C('PROC-2','B6f','PLAN-REVIEW: B6f now, fork deleted in C2')
C('EXPORT-MERGE-2','B4','PLAN-REVIEW: arity from core registry; SERVER-28 stays C6')
C('EDGE-WASM-4','C4','PLAN-REVIEW: DRY type-geometry sets = PROCESSING-2 class')
C('PROCESSING-18','F3a','PLAN-REVIEW: storey elevation unit-resolution defect')
C('PROCESSING-23','C4','PLAN-REVIEW: geometry_count vs geometry_entity_count discovery defect')
C('EDGE-WASM-26','L-bindings','PLAN-REVIEW: likely-reject, harmless')
C('KERNEL-17','B6d','PLAN-REVIEW: silent partial result, not reachable panic')
C('EDGE-FFI-8','S5','PLAN-REVIEW: panic-safety policy')
C('EDGE-FFI-3','S1','PLAN-REVIEW: same sites as EDGE-FFI-1')
C('EDGE-CLASH-4','F2a','PLAN-REVIEW: clash/geometry clone is the XCUT-19 seam')
C('PROCESSING-SYM-5/9/12/13','C11','PLAN-REVIEW: pdf_vector path and affine model')
C('PROCESSING-SYM-10','C11','PLAN-REVIEW: Affine2 taken from F2a')
C('PROCESSING-APP-5/7/8/9','C12','PLAN-REVIEW: appearance entry-point scaffolding')
C('CORE-13','F3a','PLAN-REVIEW split: F3b (readers) + F3a (unscaled 1000.0); placed in F3a as the first PLAN v2 row naming it (F3a before F3b); readers half in F3b')
C('CORE-18','L-core','PLAN-REVIEW: own perf issue, verdict required (decoder architecture)')
C('CORE-19','F3e','PLAN-REVIEW: typed attribute slots in core')
C('EXPORT-GEOM-17','L-export','PLAN-REVIEW: ZIP writer / CRC32 dependency choice')
C('PROCESSING-13','F3d','PLAN-REVIEW split: fingerprint hashers -> F3d; vertex welds -> C3 (KERNEL-9, XCUT-29)')
C('XCUT-19','F2a','PLAN-REVIEW split: clash seam -> F2a; profile_extractor -> C2; work limit -> C9c (EDGE-LXPARSE-21); CDT move -> C13')
C('KERNEL-35','C13','PLAN-REVIEW: same item as the CDT move')
C('EDGE-LXMATH-22','L-landxml','PLAN-REVIEW: terrain.rs god function (with EDGE-LXPARSE-13); unreachable! arms noted in S5')
C('EDGE-LXPARSE-23','B9','PLAN-REVIEW: declaration sniffing, not GeneralRef/stream sync')
C('EXPORT-STEP-5, EXPORT-GEOM-16, EDGE-FFI-5','S6b','PLAN-REVIEW: non-finite serialisation policy (output)')
C('SERVER-37, SERVER-41, XCUT-25','L-server','PLAN-REVIEW: server quirks / hasher stability, not fail-closed exports')
C('ROUTER-20/21/22/23/24/25','C2-perf','PLAN-REVIEW: perf with own verdict')
C('ROUTER-7, GEOM-13/14, KERNEL-16, PROC-19, XCUT-28, PROC-S8','F2b','PLAN-REVIEW: geometry-internal 2D predicates (2D half of PROC-S8)')
C('XCUT-12, ROUTER-47, PROC-27, PROC-S32, PROCESSING-SYM-21, EXPORT-DATA-23, GEOM-22, GEOM-38','F2c','PLAN-REVIEW: tolerance catalogue')
C('ROUTER-5, GEOM-17, KERNEL-2/8','F1a','PLAN-REVIEW: production mesh_check oracles')
C('GEOM-8, XCUT-22','F1b','PLAN-REVIEW: fold only when a test is touched (D9)')
C('SERVER-14','S3','PLAN-REVIEW split: guard -> S3; dedupe -> C8')
C('PROCESSING-5, SERVER-18','B7','PLAN-REVIEW: keep; make processing detect_schema_version pub, delete server copy')
for i,wp,n in corr:
    assert i not in assign,i
    assign[i]=(wp,n)

# --- step 2/3: PLAN.md v2 explicit lists (Core IDs columns) and MF8 lists ---
plan=open(f'{D}/PLAN.md').read().split('\n')
def core_ids(line):
    cells=[c.strip() for c in line.strip().strip('|').split('|')]
    return cells
tables={}
for ln in plan:
    m=re.match(r'\| \*\*([A-Z][0-9a-z-]*)\*\* \|',ln)
    if m: tables[m.group(1)]=core_ids(ln)
def plan_put(wp,text):
    for i in exp(text):
        if i in assign:
            if assign[i][0]!=wp and not assign[i][1].startswith('PLAN-REVIEW') :
                assign[i]=(assign[i][0],assign[i][1]+f'; also named in {wp} row')
            elif assign[i][0]!=wp:
                assign[i]=(assign[i][0],assign[i][1]+f'; also named in PLAN v2 {wp} row')
            continue
        assign[i]=(wp,'PLAN v2 explicit')
for wp in ['S1','S2','S3','S4','S6a','S6b','B1','B2','B3','B4','B5','B6a','B6b','B6c','B6d','B6e','B6f','B7','B8','B9','B10a','B10b']:
    cells=tables[wp]
    t=cells[2]
    if wp=='S3': t=t.replace('SERVER-14 (the guard)','')
    if wp=='B6c': pass
    if wp=='B7': pass
    plan_put(wp,t)
# S5 row: skip the LXMATH-22 arms
plan_put('S5',tables['S5'][2].replace('the `unreachable!` arms of EDGE-LXMATH-22',''))
for wp in ['F0','F1a','F1b','F2a','F2b','F2c','F3a','F3b','F3c','F3d','F3e','F4','F5','F6']:
    t=tables[wp][2]
    t=t.replace('the 2D half of PROC-S8','PROC-S8').replace('GEOM-8/XCUT-22','GEOM-8, XCUT-22')
    if wp=='F3d': t=t.replace('the fingerprint half of PROCESSING-13','PROCESSING-13')
    if wp=='F3b': t=t.replace('CORE-13 (readers)','CORE-13')
    if wp=='F5': t='XCUT-15'
    if wp=='F1b': t=t.replace('test-fixture items,','')
    plan_put(wp,t)
# C11-C13 from description cells
plan_put('C11','PROCESSING-SYM-5/9/10/12/13')
plan_put('C12','PROCESSING-APP-5/7/8/9')
plan_put('C13','XCUT-19, KERNEL-35')

# MF8 lists
MF={}
MF['F2a']='XCUT-3/4/5/8, PROCESSING-10/11/12, GEOM-11/15, EXPORT-GEOM-3, SERVER-15, EDGE-CLASH-2/8/12, EDGE-WASM-9, PROCESSING-APP-3/4/15, ROUTER-11/14/42, PROCESSING-SYM-11'
MF['C1a']='PROC-S1, PROC-5/6/7/8/11, PROC-AL-29, GEOM-29, PROC-S26'
MF['C1b']='PROC-S3/S4/S13, PROC-17/18, ROUTER-36, PROC-S22'
MF['C1c']='ROUTER-12/34, PROC-24, PROC-S12, PROC-9/10, KERNEL-10/11, PROC-S15'
MF['C1d']='PROC-AL-2/3/4/6/7/8/11/18/24, EDGE-LXMATH-2/7/17'
MF['C9a']='LXPARSE-1/5/8/10/11/12/14/15/16/18/19/20/25/28'
MF['C9b']='LXPARSE-6/9, LXMATH-12/16'
MF['C9c']='LXMATH-3/4/5/8/13/14/15/18/20/24, LXPARSE-21/22'
MF['C9d']='LXMATH-6/19/21/22/23, LXPARSE-13'
V1={'F1','F2','C1','C9','S6','B10'}
mf_misses=[]
for wp,t in MF.items():
    for i in exp(t):
        if i in assign:
            if assign[i][0]!=wp: mf_misses.append((i,wp,assign[i][0]))
            continue
        assign[i]=(wp,'PLAN-REVIEW MF8 list')
json.dump(mf_misses,open(f'{D}/.work/mf_misses.json','w'))
print('MF8 ids already assigned elsewhere:',mf_misses)

# --- apply ---
changed=set()
for r in rows:
    i=r['id']
    if i in assign:
        wp,n=assign[i]
        if r['wp']!=wp:
            r['wp']=wp
        if not n.startswith('PLAN v2 explicit') and not n.startswith('PLAN-REVIEW MF8'):
            pass
leftovers=[r for r in rows if r['wp'] in V1]
print('leftover',len(leftovers))
for r in leftovers:
    t=next(x for x in csv.DictReader(open(f'{D}/ids.csv')) if x['id']==r['id'])['title']
    print(r['id'],r['wp'],'|',t[:130])
json.dump({k:v for k,v in assign.items()},open(f'{D}/.work/assign.json','w'))

# ---- finalize ----
LEFT={'ROUTER-6':'F1a','KERNEL-5':'F2a'}
for r in leftovers:
    wp=LEFT.get(r['id'],'F1b')
    r['wp']=wp
    assign.setdefault(r['id'],(wp,'leftover'))
assert not [r for r in rows if r['wp'] in V1]
for i,(wp,n) in assign.items():
    assert by[i]['wp']==wp,(i,wp,by[i]['wp'])
for i,(wp,n) in assign.items():
    if 'also named' in n: print('DUAL',i,wp,n)

extra={'PROC-S20':'also named in PLAN v2 C1a row (trimming half -> C1a); diagnostic now in B6c',
       'EDGE-LXPARSE-13':'same finding as EDGE-LXMATH-22 (which PLAN-REVIEW moved to L-landxml); kept in C9d per MF8 and the C9d row (adapt_faceless_tin split)'}
for r in rows:
    i=r['id']; n=assign.get(i,('',''))[1]
    add=[]
    if n.startswith('PLAN-REVIEW:') or n.startswith('PLAN-REVIEW split') : add.append(n)
    elif 'also named' in n: add.append(n)
    if i in extra: add.append(extra[i])
    if add:
        r['note']=(r['note']+' | ' if r['note'] else '')+'v2: '+'; '.join(add)
    wp=r['wp']; h=r['disposition_hint']
    if h in('fix-now','fix-in-wp'):
        r['disposition_hint']='fix-now' if wp[0] in 'SB' else 'fix-in-wp'
import io
with open(f'{D}/plan-coverage.csv','w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n'); w.writeheader(); w.writerows(rows)
cw=sum(1 for r in rows if r['wp']!=orig[r['id']][0])
ca=sum(1 for r in rows if (r['wp'],r['disposition_hint'],r['note'])!=orig[r['id']])
ch=sum(1 for r in rows if r['disposition_hint']!=orig[r['id']][1])
print('wp changed',cw,'any field changed',ca,'hint changed',ch)
