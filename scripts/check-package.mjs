// Install the actual npm tarball in an isolated prefix, then exercise its bin and MCP.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment } from '../dist/environment.js';

const exec = promisify(execFile);
const parent = resolve('work/package'); await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'smoke-'));
const packed = JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root])).stdout)[0];
const paths = packed.files.map(f => f.path);
for (const path of ['dist/cli.js', 'dist/perfdigest-plugin', 'dist/index.d.ts', 'dist/providers.js', 'dist/setup.js', 'docs/SETUP.md', 'examples/cpu-workload.mjs', '.mcp.json', '.codex-plugin/plugin.json', 'skills/perfdigest-evidence/SKILL.md', 'README.md', 'LICENSE', 'go.mod', 'cmd/perfdigest-plugin/main.go', 'internal/perfdigest/run.go', 'scripts/build-go.mjs', 'scripts/ensure-binary.mjs']) assert.ok(paths.includes(path), path);
assert.ok(paths.every(p => !/(^|\/)(?:\.env(?:\.|$)|work\/|test\/|\.perfdigest\/|node_modules\/)/.test(p)), 'no credentials, test inputs, or run data in tarball');
await exec('npm', ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], { timeout: 180_000 });
const postinstallOut = JSON.parse((await exec(process.execPath, [join(root, 'node_modules/perfdigest-plugin/scripts/ensure-binary.mjs'), '--json'])).stdout);
assert.equal(postinstallOut.action, 'preserved');
assert.equal(postinstallOut.header.kind, 'native');
const cli = join(root, 'node_modules/perfdigest-plugin/dist/cli.js');
const binary = join(root, 'node_modules/.bin/perfdigest-plugin');
assert.match((await exec(binary, ['--help'])).stdout, /Codex-first MVP/);
await assert.rejects(exec(binary, ['init', '--workspace', root]), (error) => /Interactive init requires a terminal/.test(error.stderr));
const setup = await exec('npx', ['--no-install', 'perfdigest-plugin', 'init', '--workspace', root, '--provider', 'offline', '--yes'], { cwd: root });
assert.match(setup.stderr, /Active provider: offline/);
assert.deepEqual(JSON.parse(await readFile(join(root, '.perfdigest/config.json'), 'utf8')), { version: 1, provider: 'offline' });
const run = JSON.parse((await exec(process.execPath, [cli, 'demo', '--workspace', root], { timeout: 90_000 })).stdout);
assert.equal(run.status, 'complete'); assert.equal(run.agent, 'none'); assert.equal(run.routing, 'offline');
const client = new Client({ name: 'package-smoke', version: '0.0.0' });
const metadata = JSON.parse(await readFile(join(root, 'node_modules/perfdigest-plugin/.mcp.json'), 'utf8'));
const mcp = metadata.mcpServers['perfdigest-evidence'];
assert.equal(mcp.command, 'perfdigest-plugin');
const transport = new StdioClientTransport({ command: binary, args: mcp.args, cwd: root, env: childEnvironment(), stderr: 'pipe' });
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
} finally { await client.close(); await transport.close(); }
console.log(JSON.stringify({ status: 'passed', package: packed.filename, bytes: packed.size, files: paths.length,
  tarball: join(root, packed.filename), scope: 'clean local install + npx noninteractive init + real offline demo + plugin MCP discovery' }, null, 2));
