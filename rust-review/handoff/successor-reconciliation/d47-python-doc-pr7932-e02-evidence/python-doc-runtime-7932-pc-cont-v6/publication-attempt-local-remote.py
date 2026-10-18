import subprocess,pathlib,json
B=pathlib.Path('/home/louistrue/.t3/artifacts/ifc-issue-resolution-bc9e57fa/d47-shared-set-budget');p=B/'python-doc-runtime-7932-pc-cont-v6';s=B/'python-doc-contract-779-v1/source'
head='e02f657dd877bc6aaa5864bada3994d940edf1fd';old='58460fe102dc70159601602a1a3b043592dee88f'
def cmd(args):return subprocess.check_output(args,cwd=s,text=True).strip()
assert cmd(['git','rev-parse','HEAD'])==head and not cmd(['git','status','--porcelain'])
r=cmd(['git','ls-remote','origin','refs/heads/t3/d47-python-property-doc']);(p/'remote-before-push.txt').write_text(r+'\n');assert r.split()[0]==old,r
assert json.loads((p/'pr-fresh-before.json').read_text())['headRefOid']==old
with (p/'push.log').open('xb') as f:a=subprocess.run(['git','push','origin','HEAD:refs/heads/t3/d47-python-property-doc'],cwd=s,stdout=f,stderr=subprocess.STDOUT)
assert a.returncode==0
with (p/'pr-edit.log').open('xb') as f:a=subprocess.run(['gh','pr','edit','7932','--repo','LTplus-AG/ifc-lite','--body-file',str(p/'pr-body.md')],cwd=s,stdout=f,stderr=subprocess.STDOUT)
assert a.returncode==0
with (p/'coderabbit-reply-response.json').open('xb') as f:a=subprocess.run(['gh','api','-X','POST','repos/LTplus-AG/ifc-lite/pulls/7932/comments/4308878611/replies','--input',str(p/'coderabbit-reply.json')],cwd=s,stdout=f)
assert a.returncode==0
r=json.loads(cmd(['gh','pr','view','7932','--repo','LTplus-AG/ifc-lite','--json','headRefOid,state,body,url']));assert r['headRefOid']==head and r['state']=='OPEN';assert r['body']==(p/'pr-body.md').read_text();(p/'pr-after-publication.json').write_text(json.dumps(r,indent=2)+'\n')
print('PUBLISHED',r['url'],r['headRefOid'])
