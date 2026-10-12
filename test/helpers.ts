import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export async function testDirectory(label: string): Promise<string> {
  const parent = resolve('work/tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${label}-`));
}

// Test-only executable, never used by the application or real integration suite.
export async function fixtureUv(root: string): Promise<string> {
  const bin = join(root, 'bin'); await mkdir(bin);
  const script = join(bin, 'uvx');
  await writeFile(script, `#!${process.execPath}\nimport(${JSON.stringify(new URL('./fixtures/mcp-server.js', import.meta.url).href)});\n`);
  await chmod(script, 0o755);
  return bin;
}
