import json,subprocess,sys,os
from pathlib import Path
p=Path(__file__).parent;r=json.loads((p/'request.json').read_text())
with (p/'original-controller-output.log').open('xb') as f:
 q=subprocess.Popen(r['command'],env=os.environ|r['env'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for b in iter(lambda:q.stdout.read1(65536),b''):f.write(b);f.flush();sys.stdout.buffer.write(b);sys.stdout.buffer.flush()
 code=q.wait()
(p/'original-controller-terminal.json').write_text(json.dumps({'exitCode':code,'originalController':True})+'\n')
raise SystemExit(code)
