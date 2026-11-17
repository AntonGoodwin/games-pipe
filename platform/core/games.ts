/** Автоподключение игр: находит `<gamesDir>/*\/manifest.json` и загружает серверные модули. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameModule } from '../sdk/types.ts';
import { messageOf } from '../shared/errors.ts';

/** Манифест игры `{ id, title, server, ui }`. */
export interface GameManifest {
  id: string;
  title: string;
  server: string;
  ui: string;
}

/** Подключённая игра: манифест, серверный модуль и абсолютный путь к интерфейсу. */
export interface LoadedGame {
  manifest: GameManifest;
  module: GameModule;
  /** Каталог игры. */
  dir: string;
  /** Абсолютный путь к файлу интерфейса (`ui` из манифеста). */
  uiFile: string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Загружает игры из каталога, отсортированные по `id`. Некорректный манифест или модуль
 * не роняет загрузку: игра пропускается с предупреждением в лог.
 */
export async function loadGames(gamesDir: string, log: (msg: string) => void = console.warn): Promise<LoadedGame[]> {
  if (!fs.existsSync(gamesDir)) return [];
  const loaded = new Map<string, LoadedGame>();
  const dirs = fs
    .readdirSync(gamesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of dirs) {
    const dir = path.join(gamesDir, name);
    const manifestFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    try {
      const manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
      if (loaded.has(manifest.id)) throw new Error(`игра с id "${manifest.id}" уже подключена`);
      const serverFile = inside(dir, manifest.server);
      const uiFile = inside(dir, manifest.ui);
      const mod = (await import(pathToFileURL(serverFile).href)) as { default?: unknown };
      const game = checkModule(mod.default, manifest.id);
      loaded.set(manifest.id, { manifest, module: game, dir, uiFile });
    } catch (e) {
      log(`[core] игра в ${dir} пропущена: ${messageOf(e)}`);
    }
  }
  return [...loaded.values()].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
}

function parseManifest(text: string): GameManifest {
  const m = JSON.parse(text) as Partial<Record<keyof GameManifest, unknown>> | null;
  if (!m || typeof m !== 'object') throw new Error('манифест не объект');
  for (const key of ['id', 'title', 'server', 'ui'] as const) {
    if (typeof m[key] !== 'string' || !m[key]) throw new Error(`в манифесте нет строки "${key}"`);
  }
  if (!ID_RE.test(m.id as string)) throw new Error(`недопустимый id "${String(m.id)}"`);
  return { id: m.id as string, title: m.title as string, server: m.server as string, ui: m.ui as string };
}

function inside(dir: string, rel: string): string {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(dir + path.sep)) throw new Error(`путь "${rel}" выходит за каталог игры`);
  if (!fs.existsSync(full)) throw new Error(`файл "${rel}" не найден`);
  return full;
}

function checkModule(mod: unknown, id: string): GameModule {
  const g = mod as Partial<GameModule> | undefined;
  if (!g || typeof g !== 'object') throw new Error('серверный модуль не экспортирует default');
  for (const fn of ['validateParams', 'start', 'action', 'publicView'] as const) {
    if (typeof g[fn] !== 'function') throw new Error(`в модуле нет функции ${fn}`);
  }
  if (g.id !== id) throw new Error(`id модуля "${String(g.id)}" не совпадает с манифестом "${id}"`);
  return g as GameModule;
}
