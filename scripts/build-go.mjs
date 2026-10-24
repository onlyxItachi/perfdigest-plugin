#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inspectBinaryHeader, normalizeArch, normalizePlatform, toGoTarget } from './ensure-binary.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CROSS_TARGETS = [
  { goos: 'linux', goarch: 'amd64', expectedFormat: 'elf', expectedPlatform: 'linux', expectedArch: 'x64' },
  { goos: 'linux', goarch: 'arm64', expectedFormat: 'elf', expectedPlatform: 'linux', expectedArch: 'arm64' },
  { goos: 'darwin', goarch: 'amd64', expectedFormat: 'macho', expectedPlatform: 'darwin', expectedArch: 'x64' },
  { goos: 'darwin', goarch: 'arm64', expectedFormat: 'macho', expectedPlatform: 'darwin', expectedArch: 'arm64' },
  { goos: 'windows', goarch: 'amd64', expectedFormat: 'pe', expectedPlatform: 'win32', expectedArch: 'x64' },
  { goos: 'windows', goarch: 'arm64', expectedFormat: 'pe', expectedPlatform: 'win32', expectedArch: 'arm64' },
];

export async function buildGoBinary({ goos, goarch, outPath }) {
  await mkdir(dirname(outPath), { recursive: true });
  await execFileAsync(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', outPath, './cmd/perfdigest-plugin'],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        ...(goos ? { GOOS: goos } : {}),
        ...(goarch ? { GOARCH: goarch } : {}),
      },
      timeout: 120_000,
    },
  );
  if (process.platform !== 'win32') {
    await chmod(outPath, 0o755);
  }
  return inspectBinaryHeader(outPath);
}

export async function verifyCrossCompilation() {
  const scratch = await mkdtemp(join(tmpdir(), 'perfdigest-cross-build-'));
  try {
    const results = [];
    for (const target of CROSS_TARGETS) {
      const ext = target.goos === 'windows' ? '.exe' : '';
      const outPath = join(scratch, `perfdigest-plugin-${target.goos}-${target.goarch}${ext}`);
      const header = await buildGoBinary({
        goos: target.goos,
        goarch: target.goarch,
        outPath,
      });
      if (
        header.kind !== 'native' ||
        header.format !== target.expectedFormat ||
        header.platform !== target.expectedPlatform ||
        header.arch !== target.expectedArch
      ) {
        throw new Error(
          `Header mismatch for ${target.goos}/${target.goarch}: got ${JSON.stringify(header)}`,
        );
      }
      if (header.bytes <= 1_000_000) {
        throw new Error(
          `Binary size too small for ${target.goos}/${target.goarch}: ${header.bytes} bytes`,
        );
      }
      results.push({
        target: `${target.goos}/${target.goarch}`,
        format: header.format,
        platform: header.platform,
        arch: header.arch,
        bytes: header.bytes,
      });
    }
    return { status: 'ok', targets: results };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = { verifyCross: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify-cross') {
      opts.verifyCross = true;
    } else if (arg === '--os') {
      opts.os = argv[++i];
    } else if (arg === '--arch') {
      opts.arch = argv[++i];
    } else if (arg === '--out') {
      opts.out = argv[++i];
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.verifyCross) {
    const summary = await verifyCrossCompilation();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const target = toGoTarget(
      opts.os ?? normalizePlatform(process.platform),
      opts.arch ?? normalizeArch(process.arch),
    );
    const defaultBin = join(packageRoot, 'dist/perfdigest-plugin');
    const outPath = resolve(opts.out ?? defaultBin);
    await buildGoBinary({
      goos: target.goos,
      goarch: target.goarch,
      outPath,
    });
    if (target.goos === 'windows' && !opts.out) {
      await copyFile(outPath, `${defaultBin}.exe`);
    }
  }
}
