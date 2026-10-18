from pathlib import Path
import json,hashlib,subprocess,datetime,shutil
D=Path(__file__).resolve().parent;A=D.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
proposal=D/'PROPOSED-EXPECTED-DIFF.json';bindings=D/'BINDINGS.json';review=D/'independent-review/REVIEW.md'
assert sha(proposal)=='b6c3bdd6aa0a99a9695ad252f1adfd834bacf2a036d0ddcbac26af4ecda2e0d4'
assert sha(bindings)=='ed4bd1a8bca588614520652949cebbb8840ae2b3ba8cc49c6d09ead56f422847'
b=json.loads(bindings.read_text());p=json.loads(proposal.read_text());assert len(p['entries'])==2
plain=A/'c4-5-native-combined-runtime-v1/pc-results/combined-plain-revit-wall.json'
observed=A/'c4-5-combined-observed-runtime-v1/pc-results/observed-revit-wall.json'
assert sha(plain)=='097f9c2fb717a6dfb306f664f8ec87da853df88c5abe13d41e2e85205080dc54'
assert sha(observed)=='918b7a760c5e520e0b70a2337e8712730c92fee7a996b1d233c40bde3229c1a4'
compare=A/'c4-5-combined-observed-runtime-v1/inputs/adapter/compare.mjs'
assert sha(compare)=='5e660df5173fc211ee3b9ed677a29299f9902fbacdd49e3562ebb3164ab81f65'
node=Path(shutil.which('node'));closure=[node,*sorted(compare.parent.glob('*.mjs')),review,bindings,proposal]
def guard():
 for name,row in b['files'].items():
  q=Path(name);assert q.stat().st_size==row['size'] and sha(q)==row['sha256'],name
 return {str(q):{'size':q.stat().st_size,'sha256':sha(q)} for q in closure}
before=guard()
accepted=p|{'state':'INDEPENDENTLY_REVIEWED_TWO_LEAVES_THIS_SAVED_WITNESS_ONLY','independentReviewSha256':sha(review),'independentReviewTask':'node:delegated-task:command%3Amcp%3Ab6887845-af8d-47bc-b5e6-257c444a9934%3Adelegate-task%3Ac4-fc-q0-two-exact-timing-leaves-independent-disposition-review-20261018-v1','captureFilePins':{str(plain):sha(plain),str(observed):sha(observed)},'performanceAccepted':False,'broaderC4Accepted':False}
policy=D/'ACCEPTED-SINGLE-WITNESS-EXPECTED-DIFF.json'
with policy.open('x') as f:f.write(json.dumps(accepted,indent=2)+'\n')
argv=[str(node),str(compare),str(plain),str(observed),str(policy),'pair:wasm']
r=subprocess.run(argv,text=True,capture_output=True,timeout=30)
with (D/'pure-recomparison.json').open('x') as f:f.write(r.stdout)
with (D/'pure-recomparison.stderr').open('x') as f:f.write(r.stderr)
result=json.loads(r.stdout);assert r.returncode==0 and result['result']=='MATCH_OR_EXACT_EXPECTED_DIFF' and len(result['expected'])==2 and result['unknown']==[] and result['stale']==[]
after=guard();assert after==before
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'argv':argv,'exitCode':r.returncode,'policySha256':sha(policy),'bindingsSha256':sha(bindings),'reviewSha256':sha(review),'outputSha256':sha(D/'pure-recomparison.json'),'result':result,'before':before,'after':after,'allBoundInputsUnchanged':True,'originalObservedWorkerRemains':'FAILED1, originalstrictcomparison INCOMPLETE_UNKNOWN_DIFF','scope':'Pure re-comparison of exact saved JSON only; independently reviewed two scalar timing differences. No runtime rerun, no performance, broader parity/publication or closure acceptance.'}
with (D/'EXECUTION-RECEIPT.json').open('x') as f:f.write(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'exitCode':r.returncode,'result':result,'runtimeRerun':False,'allBoundInputsUnchanged':True},indent=2))
