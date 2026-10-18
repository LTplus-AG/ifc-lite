// SOURCE ONLY. Exclusive path reservation; callers retain descriptors until final write.
import { openSync, closeSync, writeSync, fstatSync } from 'node:fs';
export function reserveOutput(path) {
  const fd=openSync(path,'wx',0o600);
  return { path, fd, write(bytes) { if(fstatSync(fd).size!==0) throw Error('reserved output already contains bytes'); writeSync(fd,bytes,0,bytes.length,0); }, close(){closeSync(fd);} };
}
