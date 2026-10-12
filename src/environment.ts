import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// An allowlist prevents a new credential variable from accidentally reaching a child.
// HOME/CODEX_HOME preserve the user's existing Codex login without copying tokens.
const inherited = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
  'TERM', 'COLORTERM', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined && (inherited.has(key) || /^LC_[A-Z_]+$/.test(key)),
  )) as Record<string, string>;
}

export function redact(text: string, source: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const [key, value] of Object.entries(source)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value && value.length >= 6) {
      result = result.replaceAll(value, '[REDACTED]');
    }
  }
  return result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

export function executable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (name.includes('/') || name.includes('\\')) {
    accessSync(name, constants.X_OK);
    return name;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try next entry. */ }
  }
  throw new Error(`${name} is not on PATH`);
}
