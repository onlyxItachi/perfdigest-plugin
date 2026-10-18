import { createReadStream } from 'node:fs';
import { realpath, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './environment.js';

const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const STREAM_HASH_THRESHOLD_BYTES = 64 * 1024;

async function sha256File(path: string, size: number): Promise<string> {
  if (size <= STREAM_HASH_THRESHOLD_BYTES) {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_REPORT_BYTES) {
      throw new Error('MVP reports must be regular files no larger than 20 MiB');
    }
    return createHash('sha256').update(bytes).digest('hex');
  }
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    let seen = 0;
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      seen += buf.byteLength;
      if (seen > MAX_REPORT_BYTES) {
        stream.destroy(new Error('MVP reports must be regular files no larger than 20 MiB'));
        return;
      }
      hash.update(buf);
    });
    stream.once('error', rejectHash);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function reportFile(workspace: string, name: string, knownWorkspaceRealpath?: string) {
  const root = knownWorkspaceRealpath ?? await realpath(workspace);
  const path = await realpath(resolve(root, name));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Report path must stay inside the workspace (including symlinks)');
  }
  const meta = await stat(path);
  if (!meta.isFile() || meta.size > MAX_REPORT_BYTES) {
    throw new Error('MVP reports must be regular files no larger than 20 MiB');
  }
  const sha256 = await sha256File(path, meta.size);
  return { path, sha256, bytes: meta.size, modifiedAt: meta.mtime.toISOString() };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, redact(JSON.stringify(data, null, 2)) + '\n', { mode: 0o600 });
}

export async function newRunDirectory(workspace: string): Promise<string> {
  const path = resolve(workspace, '.perfdigest', 'runs', `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
