import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function assertSafeDirectoryChain(root: string, segments: string[]): Promise<string> {
  let current = await realpath(root);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw new Error(`Invalid directory segment: ${segment}`);
    }
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Refusing non-directory or symlink path inside .perfdigest: ${segment}`);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700).catch(() => {});
  }
  return current;
}

export async function createExclusiveDirectory(root: string, parentSegments: string[], leaf: string): Promise<string> {
  if (!leaf || leaf === '.' || leaf === '..' || leaf.includes('/') || leaf.includes('\\') || leaf.includes('\0')) {
    throw new Error(`Invalid directory segment: ${leaf}`);
  }
  const parent = await assertSafeDirectoryChain(root, parentSegments);
  const target = join(parent, leaf);
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700).catch(() => {});
  return target;
}

export async function assertContainedRegularFile(workspaceRoot: string, candidatePath: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const abs = resolve(root, candidatePath);
  const info = await lstat(abs);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Artifact path must be a regular non-symlink file');
  }
  const resolved = await realpath(abs);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Artifact path must stay inside the workspace');
  }
  return resolved;
}

export async function writePrivateFile(path: string, content: string | Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync().catch(() => {});
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(tmp, 0o600).catch(() => {});
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writePrivateFile(path, redact(JSON.stringify(data, null, 2)) + '\n');
}

export async function newRunDirectory(workspace: string): Promise<string> {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`;
  return assertSafeDirectoryChain(workspace, ['.perfdigest', 'runs', runId]);
}

export async function ensureRunDirectory(workspace: string, runDirectory: string): Promise<string> {
  const root = await realpath(workspace);
  const runsRoot = await assertSafeDirectoryChain(root, ['.perfdigest', 'runs']);
  const candidate = resolve(root, runDirectory);
  const rel = relative(runsRoot, candidate);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw new Error('runDirectory must be a direct child of .perfdigest/runs inside the workspace');
  }
  return assertSafeDirectoryChain(root, ['.perfdigest', 'runs', rel]);
}
