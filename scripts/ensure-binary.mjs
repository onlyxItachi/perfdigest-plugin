#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, copyFile, open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function normalizePlatform(platform) {
  if (platform === 'windows') return 'win32';
  return platform;
}

export function normalizeArch(arch) {
  if (arch === 'amd64') return 'x64';
  return arch;
}

export function toGoTarget(platform, arch) {
  const normPlatform = normalizePlatform(platform);
  const normArch = normalizeArch(arch);
  const goos =
    normPlatform === 'linux'
      ? 'linux'
      : normPlatform === 'darwin'
        ? 'darwin'
        : normPlatform === 'win32'
          ? 'windows'
          : null;
  const goarch = normArch === 'x64' ? 'amd64' : normArch === 'arm64' ? 'arm64' : null;
  return { goos, goarch };
}

export async function inspectBinaryHeader(filePath) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0) {
      return { kind: 'missing', format: null, platform: null, arch: null, bytes: 0 };
    }
    const buf = Buffer.alloc(Math.min(4096, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);

    // Check Node.js shebang
    if (slice.length >= 2 && slice[0] === 0x23 && slice[1] === 0x21) {
      const firstLine = slice.toString('utf8', 0, Math.min(slice.length, 128)).split(/\r?\n/)[0] ?? '';
      if (firstLine.includes('node')) {
        return { kind: 'node-js-cli', format: 'shebang', platform: 'any', arch: 'any', bytes: st.size };
      }
    }

    // Check ELF: 0x7f 'E' 'L' 'F'
    if (slice.length >= 20 && slice[0] === 0x7f && slice[1] === 0x45 && slice[2] === 0x4c && slice[3] === 0x46) {
      const machine = slice.readUInt16LE(18);
      const arch = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `unknown-${machine}`;
      return { kind: 'native', format: 'elf', platform: 'linux', arch, bytes: st.size };
    }

    // Check Mach-O 64-bit little-endian: 0xcf 0xfa 0xed 0xfe
    if (slice.length >= 8 && slice[0] === 0xcf && slice[1] === 0xfa && slice[2] === 0xed && slice[3] === 0xfe) {
      const cpuType = slice.readUInt32LE(4);
      const arch =
        cpuType === 0x01000007 ? 'x64' : cpuType === 0x0100000c ? 'arm64' : `unknown-0x${cpuType.toString(16)}`;
      return { kind: 'native', format: 'macho', platform: 'darwin', arch, bytes: st.size };
    }

    // Check PE/COFF: 'M' 'Z'
    if (slice.length >= 0x40 && slice[0] === 0x4d && slice[1] === 0x5a) {
      const peOffset = slice.readUInt32LE(0x3c);
      let peBuf = slice;
      let localOffset = peOffset;
      if (peOffset + 6 > slice.length) {
        const extra = Buffer.alloc(6);
        const { bytesRead: peRead } = await fh.read(extra, 0, 6, peOffset);
        if (peRead < 6) {
          return { kind: 'unknown', format: 'mz', platform: null, arch: null, bytes: st.size };
        }
        peBuf = extra;
        localOffset = 0;
      }
      if (
        peBuf[localOffset] === 0x50 &&
        peBuf[localOffset + 1] === 0x45 &&
        peBuf[localOffset + 2] === 0x00 &&
        peBuf[localOffset + 3] === 0x00
      ) {
        const machine = peBuf.readUInt16LE(localOffset + 4);
        const arch =
          machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `unknown-0x${machine.toString(16)}`;
        return { kind: 'native', format: 'pe', platform: 'win32', arch, bytes: st.size };
      }
    }

    return { kind: 'unknown', format: 'unknown', platform: null, arch: null, bytes: st.size };
  } catch {
    return { kind: 'missing', format: null, platform: null, arch: null, bytes: 0 };
  } finally {
    await fh?.close();
  }
}

async function fileExists(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function ensureBinary(options = {}) {
  const targetPlatform = normalizePlatform(options.targetPlatform ?? process.platform);
  const targetArch = normalizeArch(options.targetArch ?? process.arch);
  const binPath = resolve(options.binPath ?? join(packageRoot, 'dist/perfdigest-plugin'));
  const cliJsPath = resolve(options.cliJsPath ?? join(packageRoot, 'dist/cli.js'));
  const noGo = Boolean(options.noGo);

  const currentHeader = await inspectBinaryHeader(binPath);
  if (
    currentHeader.kind === 'native' &&
    currentHeader.platform === targetPlatform &&
    currentHeader.arch === targetArch
  ) {
    if (process.platform !== 'win32') {
      await chmod(binPath, 0o755);
    }
    return {
      action: 'preserved',
      targetPlatform,
      targetArch,
      binPath,
      header: currentHeader,
    };
  }

  const { goos, goarch } = toGoTarget(targetPlatform, targetArch);
  const mainGoPath = join(packageRoot, 'cmd/perfdigest-plugin/main.go');
  if (!noGo && goos && goarch && (await fileExists(mainGoPath))) {
    try {
      await execFileAsync(
        'go',
        ['build', '-trimpath', '-ldflags=-s -w', '-o', binPath, './cmd/perfdigest-plugin'],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            CGO_ENABLED: '0',
            GOOS: goos,
            GOARCH: goarch,
          },
          timeout: 120_000,
        },
      );
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }
      const rebuiltHeader = await inspectBinaryHeader(binPath);
      if (
        rebuiltHeader.kind === 'native' &&
        rebuiltHeader.platform === targetPlatform &&
        rebuiltHeader.arch === targetArch
      ) {
        return {
          action: 'rebuilt-go',
          targetPlatform,
          targetArch,
          binPath,
          header: rebuiltHeader,
        };
      }
    } catch {
      // Fall through to dist/cli.js fallback if Go toolchain is missing or fails
    }
  }

  if (await fileExists(cliJsPath)) {
    await copyFile(cliJsPath, binPath);
    if (process.platform !== 'win32') {
      await chmod(binPath, 0o755);
    }
    const fallbackHeader = await inspectBinaryHeader(binPath);
    return {
      action: 'fallback-node-cli',
      targetPlatform,
      targetArch,
      binPath,
      header: fallbackHeader,
    };
  }

  throw new Error(
    `Unable to provision perfdigest-plugin binary for ${targetPlatform}/${targetArch}: neither Go build nor dist/cli.js fallback succeeded.`,
  );
}

function parseArgs(argv) {
  const opts = { json: false, noGo: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target-platform') {
      opts.targetPlatform = argv[++i];
    } else if (arg === '--target-arch') {
      opts.targetArch = argv[++i];
    } else if (arg === '--bin-path') {
      opts.binPath = argv[++i];
    } else if (arg === '--cli-js-path') {
      opts.cliJsPath = argv[++i];
    } else if (arg === '--no-go') {
      opts.noGo = true;
    } else if (arg === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseArgs(process.argv.slice(2));
  const result = await ensureBinary(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
