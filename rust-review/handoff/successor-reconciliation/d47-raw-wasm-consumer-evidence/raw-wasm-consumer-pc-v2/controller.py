import json,subprocess,sys
from pathlib import Path
p=Path(__file__).parent
original=p/'request.json'
r=json.loads(original.read_text())
with (p/'resume-controller-output.log').open('xb') as f:
 q=subprocess.Popen(r['command'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for b in iter(lambda:q.stdout.read1(65536),b''):
  f.write(b);f.flush();sys.stdout.buffer.write(b);sys.stdout.buffer.flush()
 code=q.wait()
(p/'resume-controller-terminal.json').write_text(json.dumps({'exitCode':code,'originalController':True,'request':str(original)})+'\n')
raise SystemExit(code)
