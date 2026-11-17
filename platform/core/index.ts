/**
 * Ядро платформы — HTTP-сервис: API раундов, оболочка `/`, интерфейсы игр `/games/<id>/` и SDK `/sdk.js`.
 * Раунды хранятся в `<dataDir>/rounds.json`, деньги проводятся через кошелёк по `walletUrl`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rng } from '../sdk/types.ts';
import { PlatformError } from '../shared/errors.ts';
import { checkJsonBody, checkLocalHost, listen, readJson, sendError, sendJson, type RunningServer } from '../shared/http.ts';
import { RoundEngine, runAsync, type EngineGen } from './engine.ts';
import { loadGames, type LoadedGame } from './games.ts';
import { FileRoundStore } from './store.ts';
import { walletExecutor } from './wallet-client.ts';

/** Запущенный HTTP-сервис ядра (`url`, `close()`), см. `shared/http.ts`. */
export type { RunningServer };

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_FILE = path.join(here, '..', 'sdk', 'client.js');
const SHELL_FILE = path.join(here, 'shell.html');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Настройки запуска ядра. */
export interface CoreOptions {
  /** Порт; 0 — свободный. */
  port: number;
  /** Каталог данных, где лежит `rounds.json`. */
  dataDir: string;
  /** Каталог игр, где ищутся `*\/manifest.json`. */
  gamesDir: string;
  /** Адрес кошелька, например `http://127.0.0.1:4001`. */
  walletUrl: string;
  /** Адрес прослушивания; по умолчанию `127.0.0.1`. */
  host?: string;
  /** Генератор случайных чисел; по умолчанию криптостойкий `cryptoRng`. */
  rng?: Rng;
  /** Общий секрет кошелька (`startWallet({ token })`); передаётся в каждом запросе к кошельку. */
  walletToken?: string;
}

// Ссылка взята при загрузке ядра, до подключения игр: подмена `crypto.randomBytes` из кода игры на неё не влияет.
const randomBytes = crypto.randomBytes;

/** Криптостойкий генератор на `node:crypto`: равномерное число в [0, 1) с шагом 2⁻⁴⁸. Объект заморожен. */
export const cryptoRng: Rng = Object.freeze({
  next: (): number => randomBytes(6).readUIntBE(0, 6) / 2 ** 48,
});

/** Запускает ядро: загружает игры и раунды, поднимает HTTP-сервис. */
export async function startCore(opts: CoreOptions): Promise<RunningServer> {
  const games = await loadGames(opts.gamesDir);
  const byId = new Map<string, LoadedGame>(games.map((g) => [g.manifest.id, g]));
  const engine = new RoundEngine({
    games: games.map((g) => g.module),
    store: new FileRoundStore(path.join(opts.dataDir, 'rounds.json')),
    rng: opts.rng ?? cryptoRng,
    newRoundId: () => crypto.randomUUID(),
  });
  const exec = walletExecutor(opts.walletUrl, opts.walletToken);
  const bindHost = opts.host ?? '127.0.0.1';

  // Операции движка выполняются строго по очереди: проверка «нет открытого раунда» и списание атомарны.
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(gen: () => EngineGen<T>): Promise<T> => {
    const p = queue.then(() => runAsync(gen(), exec));
    queue = p.catch(() => undefined);
    return p;
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, parts: string[]): Promise<void> => {
    const method = req.method ?? 'GET';
    checkLocalHost(req, bindHost);
    // GET /api/games
    if (parts.length === 1 && parts[0] === 'games' && method === 'GET') {
      return sendJson(res, 200, games.map((g) => ({ id: g.manifest.id, title: g.manifest.title })));
    }
    // GET /api/balance — для оболочки
    if (parts.length === 1 && parts[0] === 'balance' && method === 'GET') {
      return sendJson(res, 200, { balance: await exec({ kind: 'balance' }) });
    }
    if (method === 'POST' && parts.length === 3) {
      checkSameOrigin(req);
      const [kind, id, verb] = parts as [string, string, string];
      if (kind === 'games' && verb === 'open') {
        await readJson(req);
        return sendJson(res, 200, await run(() => engine.open(id)));
      }
      if (kind === 'games' && verb === 'rounds') {
        const body = ((await readJson(req)) ?? {}) as { bet?: unknown; params?: unknown };
        return sendJson(res, 200, await run(() => engine.startRound(id, body.bet, body.params)));
      }
      if (kind === 'rounds' && verb === 'actions') {
        const body = ((await readJson(req)) ?? {}) as { action?: unknown };
        return sendJson(res, 200, await run(() => engine.action(id, body.action)));
      }
    }
    throw new PlatformError('NOT_FOUND');
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://core');
      const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
      if (parts[0] === 'api') return await handleApi(req, res, parts.slice(1));
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new PlatformError('NOT_FOUND');
      if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(req, res, SHELL_FILE);
      if (url.pathname === '/sdk.js') return sendFile(req, res, SDK_FILE);
      if (parts[0] === 'games' && parts[1]) {
        const game = byId.get(parts[1]);
        if (!game) throw new PlatformError('GAME_NOT_FOUND');
        if (parts.length === 2 && !url.pathname.endsWith('/')) {
          res.writeHead(301, { location: `/games/${encodeURIComponent(parts[1])}/` });
          return void res.end();
        }
        const uiDir = path.dirname(game.uiFile);
        const rest = parts.slice(2);
        const file = rest.length === 0 ? game.uiFile : path.resolve(uiDir, ...rest);
        if (file !== game.uiFile && !file.startsWith(uiDir + path.sep)) throw new PlatformError('NOT_FOUND');
        return sendFile(req, res, file);
      }
      throw new PlatformError('NOT_FOUND');
    } catch (e) {
      if (e instanceof URIError) return sendError(res, new PlatformError('INVALID_REQUEST'));
      sendError(res, e);
    }
  });

  return listen(server, opts.port, bindHost);
}

/**
 * Защита API от запросов со сторонних сайтов (CSRF): заголовок `Origin`, если он есть, должен совпадать с `Host`
 * (сам `Host` уже проверен по белому списку в `checkLocalHost`), а непустое тело — иметь тип `application/json`.
 */
function checkSameOrigin(req: http.IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    if (!host || host !== req.headers.host) throw new PlatformError('FORBIDDEN');
  }
  checkJsonBody(req);
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  let data: Buffer;
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
    data = fs.readFileSync(file);
  } catch {
    throw new PlatformError('NOT_FOUND');
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}
