/**
 * Кошелёк партнёра — отдельный HTTP-сервис, который владеет балансом игрока `player-1`.
 *
 * - `GET /balance` → `{ balance }`
 * - `POST /bet { txId, roundId, amount }` → `{ balance }` или `402 INSUFFICIENT_FUNDS`
 * - `POST /payout { txId, roundId, amount }` → `{ balance }`
 *
 * Повтор `txId` с теми же данными возвращает сохранённый ответ, с другими — `409 TX_CONFLICT`.
 * Баланс и журнал хранятся в `<dataDir>/wallet.json`.
 *
 * Доступ: только локальный `Host`, без заголовка `Origin` (запрос со страницы в браузере — `403`), тело POST —
 * `application/json` (`415`). Если задан `token`, каждый запрос должен нести его в `x-wallet-token` (`401`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PlatformError } from '../shared/errors.ts';
import { writeFileDurable } from '../shared/fs.ts';
import { checkJsonBody, checkLocalHost, listen, readJson, sendError, sendJson, type RunningServer } from '../shared/http.ts';
import { round2 } from '../shared/money.ts';

/** Запущенный HTTP-сервис кошелька (`url`, `close()`), см. `shared/http.ts`. */
export type { RunningServer };

/** Начальный баланс игрока. */
export const START_BALANCE = 100;
/** Единственный игрок. */
export const PLAYER_ID = 'player-1';

/** Запись журнала транзакций кошелька. */
export interface WalletTx {
  type: 'bet' | 'payout';
  roundId: string;
  amount: number;
  /** Сумма из запроса до округления — по ней повтор `txId` сравнивается с исходным. */
  requestedAmount?: number;
  /** Сохранённый ответ: повтор `txId` отдаёт его без изменений. */
  status: number;
  body: unknown;
}

/** Содержимое `wallet.json`. */
export interface WalletState {
  player: string;
  balance: number;
  transactions: Record<string, WalletTx>;
}

/** Настройки запуска кошелька. */
export interface WalletOptions {
  /** Порт; 0 — свободный. */
  port: number;
  /** Каталог данных, где лежит `wallet.json`. */
  dataDir: string;
  /** Адрес прослушивания; по умолчанию `127.0.0.1`. */
  host?: string;
  /** Общий секрет с ядром: запрос без него в заголовке `x-wallet-token` отклоняется с `401`. Не задан — проверки нет. */
  token?: string;
}

/** Заголовок, в котором ядро передаёт кошельку общий секрет. */
export const WALLET_TOKEN_HEADER = 'x-wallet-token';

/** Запускает HTTP-сервис кошелька. */
export async function startWallet(opts: WalletOptions): Promise<RunningServer> {
  const file = path.join(opts.dataDir, 'wallet.json');
  const state = loadState(file);

  const persist = (next: WalletState): void => {
    writeFileDurable(file, `${JSON.stringify(next, null, 1)}\n`);
  };

  const transact = (type: 'bet' | 'payout', input: unknown): { status: number; body: unknown } => {
    const { txId, roundId, amount } = (input ?? {}) as { txId?: unknown; roundId?: unknown; amount?: unknown };
    if (typeof txId !== 'string' || !txId || typeof roundId !== 'string' || !roundId) {
      throw new PlatformError('INVALID_REQUEST', 'Нужны строковые txId и roundId');
    }
    const value = typeof amount === 'number' && Number.isFinite(amount) ? round2(amount) : Number.NaN;
    if (!Number.isFinite(value) || (type === 'bet' ? value <= 0 : value < 0)) {
      return { status: 400, body: { error: { code: 'INVALID_AMOUNT', message: 'Некорректная сумма' } } };
    }

    const requested = amount as number;
    const prev = state.transactions[txId];
    if (prev) {
      // Сравнивается сумма из запроса до округления: 2.5 и 2.504 — разные данные (у старых записей — округлённая).
      const prevRequested = prev.requestedAmount ?? prev.amount;
      if (prev.type === type && prev.roundId === roundId && prevRequested === requested) return { status: prev.status, body: prev.body };
      return { status: 409, body: { error: { code: 'TX_CONFLICT', message: 'txId уже использован с другими данными' } } };
    }

    let balance = state.balance;
    let result: { status: number; body: unknown };
    if (type === 'bet' && value > balance) {
      result = { status: 402, body: { error: { code: 'INSUFFICIENT_FUNDS', message: 'Недостаточно средств' }, balance } };
    } else {
      balance = round2(type === 'bet' ? balance - value : balance + value);
      result = { status: 200, body: { balance } };
    }
    const tx: WalletTx = { type, roundId, amount: value, requestedAmount: requested, status: result.status, body: result.body };
    // Сначала диск, потом память: если запись упадёт, баланс и журнал в памяти останутся прежними.
    persist({ ...state, balance, transactions: { ...state.transactions, [txId]: tx } });
    state.balance = balance;
    state.transactions[txId] = tx;
    return result;
  };

  const bindHost = opts.host ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    try {
      checkLocalHost(req, bindHost);
      // Кошелёк вызывает только ядро, не браузер: запрос с Origin пришёл со страницы — отклоняем.
      if (req.headers.origin !== undefined) throw new PlatformError('FORBIDDEN');
      if (opts.token !== undefined && !sameSecret(req.headers[WALLET_TOKEN_HEADER], opts.token)) {
        throw new PlatformError('UNAUTHORIZED');
      }
      const url = new URL(req.url ?? '/', 'http://wallet');
      if (req.method === 'GET' && url.pathname === '/balance') return sendJson(res, 200, { balance: state.balance });
      if (req.method === 'POST' && (url.pathname === '/bet' || url.pathname === '/payout')) {
        checkJsonBody(req);
        const body = await readJson(req);
        const r = transact(url.pathname === '/bet' ? 'bet' : 'payout', body);
        return sendJson(res, r.status, r.body);
      }
      throw new PlatformError('NOT_FOUND');
    } catch (e) {
      sendError(res, e);
    }
  });

  return listen(server, opts.port, bindHost);
}

/** Сравнение секрета за постоянное время. */
function sameSecret(got: string | string[] | undefined, expected: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadState(file: string): WalletState {
  if (!fs.existsSync(file)) return { player: PLAYER_ID, balance: START_BALANCE, transactions: {} };
  // Битый файл — ошибка запуска: молча сбросить баланс игрока нельзя.
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WalletState>;
  if (typeof data.balance !== 'number' || !Number.isFinite(data.balance)) throw new Error(`${file}: некорректный баланс`);
  return { player: PLAYER_ID, balance: data.balance, transactions: data.transactions ?? {} };
}
