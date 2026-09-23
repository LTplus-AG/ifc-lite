import subprocess,os,json,pathlib,hashlib,time
p=pathlib.Path('/tmp/ifc-export-spikes');root=pathlib.Path('/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393');out=p/'cohort-functional';out.mkdir(exist_ok=False)
fixtures=['ara3d/AC20-FZK-Haus.ifc','ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc','ara3d/ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC','ara3d/ISSUE_053_20181220Holter_Tower_10.ifc','issues/472_2222.ifc']
rows=[]
for f in fixtures:
 for q in ['float','quantize']:
  for arm in ['base','spool','skip-georef']:
   stem=f.split('/')[-1].split('.')[0]+'-'+q+'-'+arm;dst=out/(stem+'.glb');env=os.environ.copy();env.pop('IFC_SPIKE_SPOOL',None);env.pop('IFC_SPIKE_GEOREF',None)
   binary=p/('base-probe' if arm=='base' else 'combined-probe')
   if arm=='spool':env['IFC_SPIKE_SPOOL']=str(out/'scratch')
   if arm!='base':env['IFC_SPIKE_GEOREF']='skip' if arm=='skip-georef' else 'timed'
   (out/(stem+'.host')).write_text(subprocess.check_output(['ps','-eo','pid,comm,pcpu,rss','--sort=-pcpu'],text=True))
   cmd=['/usr/bin/time','-v','-o',str(out/(stem+'.time')),str(binary),str(root/'tests/models'/f),str(dst),q]
   with open(out/(stem+'.stdout'),'w') as stdout,open(out/(stem+'.stderr'),'w') as stderr:
    r=subprocess.run(cmd,env=env,stdout=stdout,stderr=stderr,timeout=300)
   row={'fixture':f,'mode':q,'arm':arm,'exit':r.returncode,'qualification':'functional only: known concurrent builds/other host work','sha256':hashlib.sha256(dst.read_bytes()).hexdigest() if dst.exists() else None}
   rows.append(row);(out/'results.json').write_text(json.dumps(rows,indent=2));print(stem,r.returncode,row['sha256'],flush=True)
  group=rows[-3:]
  assert all(r['exit']==0 for r in group) and len({r['sha256'] for r in group})==1,group
print('ALL 10 fixture/mode groups byte identical across 3 arms',flush=True)
