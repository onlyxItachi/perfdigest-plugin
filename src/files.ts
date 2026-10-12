import { realpath, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './environment.js';

export async function reportFile(workspace: string, name: string) {
  const root = await realpath(workspace);
  const path = await realpath(resolve(root, name));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Report path must stay inside the workspace (including symlinks)');
  }
  const meta = await stat(path);
  if (!meta.isFile() || meta.size > 20 * 1024 * 1024) {
    throw new Error('MVP reports must be regular files no larger than 20 MiB');
  }
  const bytes = await readFile(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: meta.size, modifiedAt: meta.mtime.toISOString() };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, redact(JSON.stringify(data, null, 2)) + '\n', { mode: 0o600 });
}

export async function newRunDirectory(workspace: string): Promise<string> {
  const path = resolve(workspace, '.perfdigest', 'runs', `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
