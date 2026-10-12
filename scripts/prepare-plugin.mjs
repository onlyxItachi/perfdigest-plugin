import { cp, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Only plugin metadata and the skill go into Codex's plugin cache. The separately
// installed npm executable supplies the runtime. Never copy node_modules or run data.
const target = resolve('work/codex-plugin');
await mkdir(join(target, '.codex-plugin'), { recursive: true });
await copyFile('.codex-plugin/plugin.json', join(target, '.codex-plugin/plugin.json'));
await copyFile('.mcp.json', join(target, '.mcp.json'));
await cp('skills', join(target, 'skills'), { recursive: true });
console.log(`Prepared local Codex plugin: ${target}`);
