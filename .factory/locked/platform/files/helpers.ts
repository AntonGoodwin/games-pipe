/**
 * Общие помощники приёмочных тестов платформы.
 *
 * Тесты написаны до реализации, поэтому модули платформы подключаются динамически
 * (путь в переменной), а их ожидаемый интерфейс описан здесь типами. Так `tsc` проходит,
 * пока реализации нет, а тесты падают с понятной ошибкой загрузки.
 *
 * Ожидаемые модули (допущения этапа tests, см. decisions):
 * - `platform/testkit/index.ts` — `createTestPlatform`, `fixedRng`, `seededRng` (контракт из spec.md).
 * - `platform/wallet/index.ts` — `startWallet({ port, dataDir })` → `Promise<{ url, close() }>`.
 *   Баланс и журнал хранятся в `<dataDir>/wallet.json`. `port: 0` — свободный порт, `url` — `http://127.0.0.1:<порт>`.
 * - `platform/core/index.ts` — `startCore({ port, dataDir, gamesDir, walletUrl })` → `Promise<{ url, close() }>`.
 *   Раунды хранятся в `<dataDir>/rounds.json`, игры ищутся в `<gamesDir>/*\/manifest.json`.
 * - `platform/sdk/types.ts` — `GameError` (контракт из spec.md).
 */
import fs from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Каталог платформы (`platform/`). */
export const PLATFORM_DIR = path.resolve(here, '..');
/** Каталог с тестовыми играми t-flip и t-steps (у каждой есть manifest.json). */
export const FIXTURES_DIR = path.join(here, 'fixtures');

// ---------- типы ожидаемого контракта ----------

/** Генератор случайных чисел в [0, 1). */
export interface Rng {
  next(): number;
}

/** Ответ раунда — одинаковый у HTTP API и testkit. */
export interface RoundView {
  roundId: string;
  gameId: string;
  bet: number;
  status: 'open' | 'closed';
  view: any;
  payout: number | null;
  balance: number;
}

/** Ответ открытия игры. */
export interface OpenResult {
  gameId: string;
  limits: { min: number; max: number };
  balance: number;
  activeRound: RoundView | null;
}

/** Запись журнала транзакций testkit. */
export interface Tx {
  txId: string;
  type: 'bet' | 'payout';
  roundId: string;
  amount: number;
  balanceAfter: number;
}

/** Тестовая платформа из testkit. Методы могут быть синхронными или асинхронными — тесты всегда используют await. */
export interface TestPlatform {
  open(gameId: string): OpenResult | Promise<OpenResult>;
  startRound(gameId: string, bet: unknown, params: unknown): RoundView | Promise<RoundView>;
  action(roundId: string, action: unknown): RoundView | Promise<RoundView>;
  balance(): number | Promise<number>;
  transactions(): Tx[] | Promise<Tx[]>;
}

/** Модуль `platform/testkit/index.ts`. */
export interface TestkitModule {
  createTestPlatform(opts: { games: any[]; rng?: Rng; startBalance?: number }): TestPlatform;
  fixedRng(values: number[]): Rng;
  seededRng(seed: number): Rng;
}

/** Запущенный HTTP-сервис. */
export interface RunningServer {
  url: string;
  close(): Promise<void> | void;
}

/** Модуль `platform/wallet/index.ts`. */
export interface WalletModule {
  startWallet(opts: { port: number; dataDir: string }): Promise<RunningServer>;
}

/** Модуль `platform/core/index.ts`. */
export interface CoreModule {
  startCore(opts: { port: number; dataDir: string; gamesDir: string; walletUrl: string }): Promise<RunningServer>;
}

// ---------- загрузка модулей ----------

async function load<T>(rel: string): Promise<T> {
  const p: string = path.join(PLATFORM_DIR, rel);
  return (await import(p)) as T;
}

/** Загружает testkit. */
export const loadTestkit = (): Promise<TestkitModule> => load<TestkitModule>('testkit/index.ts');
/** Загружает модуль кошелька. */
export const loadWallet = (): Promise<WalletModule> => load<WalletModule>('wallet/index.ts');
/** Загружает модуль ядра. */
export const loadCore = (): Promise<CoreModule> => load<CoreModule>('core/index.ts');

/** Загружает тестовые игры t-flip и t-steps (серверные модули фикстур). */
export async function loadFixtureGames(): Promise<{ tFlip: any; tSteps: any }> {
  const flipPath: string = path.join(FIXTURES_DIR, 't-flip/server/index.js');
  const stepsPath: string = path.join(FIXTURES_DIR, 't-steps/server/index.js');
  const tFlip = ((await import(flipPath)) as { default: unknown }).default;
  const tSteps = ((await import(stepsPath)) as { default: unknown }).default;
  return { tFlip, tSteps };
}

// ---------- ошибки ----------

/** Выполняет fn и возвращает брошенную (или отклонённую) ошибку. Если ошибки не было — падает. */
export async function caught(fn: () => unknown): Promise<any> {
  let result: unknown;
  try {
    result = await fn();
  } catch (e) {
    return e;
  }
  throw new Error(`ожидалась ошибка, но вызов успешно вернул ${JSON.stringify(result)}`);
}

/** Код ошибки, которую бросил fn. */
export async function codeOf(fn: () => unknown): Promise<string> {
  const e = await caught(fn);
  return e?.code;
}

// ---------- временные каталоги ----------

const tmpDirs: string[] = [];

/** Создаёт пустой временный каталог; удаляется в `cleanupTmp()`. */
export function tmpDir(prefix = 'plat-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Удаляет все созданные временные каталоги. */
export function cleanupTmp(): void {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
}

// ---------- HTTP ----------

/** Ответ HTTP-запроса. */
export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  body: any;
}

/** HTTP-запрос через node:http (не зависит от окружения vitest). Тело — JSON. */
export function request(base: string, method: string, urlPath: string, body?: unknown): Promise<HttpResponse> {
  const url = new URL(urlPath, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Останавливает сервисы, не падая на уже остановленных. */
export async function closeAll(servers: Array<RunningServer | undefined>): Promise<void> {
  for (const s of servers.splice(0)) {
    if (s) await s.close();
  }
}
