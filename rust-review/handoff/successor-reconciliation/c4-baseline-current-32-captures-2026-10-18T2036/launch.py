from pathlib import Path
import subprocess,json,time,sys
D=Path(__file__).resolve().parent
with (D/'original-launch.log').open('x') as log:
 p=subprocess.Popen(['ssh','ifc-pc-worker','bash -s'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 p.stdin.write((D/'launch-remote.sh').read_text());p.stdin.close()
 for line in p.stdout:log.write(line);log.flush();print(line,end='',flush=True)
 code=p.wait()
(D/'original-exec-terminal.json').write_text(json.dumps({'exitCode':code,'finishedAt':time.time()},indent=2)+'\n')
raise SystemExit(code)
