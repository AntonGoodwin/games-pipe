// Shared helpers for the factory: paths, shell, hashing, globs, frontmatter.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const rel = (p: string): string => path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join('/');
export const abs = (p: string): string => path.resolve(ROOT, p);

export function readText(p: string): string {
  return fs.readFileSync(abs(p), 'utf8');
}

export function readTextIfExists(p: string): string | null {
  return fs.existsSync(abs(p)) ? readText(p) : null;
}

export function writeText(p: string, content: string): void {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), content);
}

export function exists(p: string): boolean {
  return fs.existsSync(abs(p));
}

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Runs a command synchronously in the repo root and captures output. */
export function sh(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): ShResult {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''),
    durationMs: Date.now() - started,
  };
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'data', 'runs']);

/** Lists files under a directory (repo-relative, forward slashes), skipping ignored dirs. */
export function listFiles(dir: string, ignoreDirs: Set<string> = IGNORED_DIRS): string[] {
  const out: string[] = [];
  const base = abs(dir);
  if (!fs.existsSync(base)) return out;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name) || (e.name === 'tmp' && d.endsWith('.factory'))) continue;
        walk(path.join(d, e.name));
      } else if (e.isFile()) {
        out.push(rel(path.join(d, e.name)));
      }
    }
  };
  if (fs.statSync(base).isFile()) return [rel(base)];
  walk(base);
  return out.sort();
}

/** path -> sha256 for every file under the given roots. */
export function hashTree(roots: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of roots) {
    for (const f of listFiles(r)) map[f] = sha256(fs.readFileSync(abs(f)));
  }
  return map;
}

export function diffHashes(before: Record<string, string>, after: Record<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of Object.entries(before)) if (after[k] !== v) changed.add(k);
  for (const k of Object.keys(after)) if (!(k in before)) changed.add(k);
  return [...changed].sort();
}

/** Minimal glob: ** = any path, * = any chars except '/', ? = one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

export interface Doc<T> {
  data: T;
  body: string;
}

export function parseFrontmatter<T>(text: string): Doc<T> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {} as T, body: text };
  return { data: (YAML.parse(m[1]) ?? {}) as T, body: m[2] };
}

export function stringifyFrontmatter<T>(doc: Doc<T>): string {
  return `---\n${YAML.stringify(doc.data).trimEnd()}\n---\n${doc.body}`;
}

export const nowIso = (): string => new Date().toISOString();
export const hhmm = (): string => new Date().toTimeString().slice(0, 5);

export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

export function truncate(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[обрезано ${s.length - max} символов]`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
