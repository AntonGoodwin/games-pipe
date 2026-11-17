/**
 * Тестовый набор для игр: тот же движок раундов, что у ядра, но в памяти — без HTTP и диска.
 * Все методы синхронные; ответы такие же, как у HTTP API, ошибки бросаются как `PlatformError`.
 */
import type { GameModule, Rng } from '../sdk/types.ts';
import { RoundEngine, runSync, type OpenResult, type RoundView, type WalletOp } from '../core/engine.ts';
import { MemoryRoundStore } from '../core/store.ts';
import { PlatformError } from '../shared/errors.ts';
import { round2 } from '../shared/money.ts';

/** Ошибка платформы с полем `code`; testkit бросает её так же, как HTTP API отдаёт `{ error: { code } }`. */
export { PlatformError };
/** Ответы `open()` и раундов — те же типы, что у движка и HTTP API. */
export type { OpenResult, RoundView };

/** Запись журнала транзакций тестовой платформы. */
export interface Tx {
  txId: string;
  type: 'bet' | 'payout';
  roundId: string;
  amount: number;
  balanceAfter: number;
}

/** Тестовая платформа. */
export interface TestPlatform {
  /** Открытие игры: лимиты, баланс, незавершённый раунд. */
  open(gameId: string): OpenResult;
  /** Новый раунд со ставкой `bet` и параметрами игры. */
  startRound(gameId: string, bet: unknown, params?: unknown): RoundView;
  /** Ход в раунде. */
  action(roundId: string, action: unknown): RoundView;
  /** Текущий баланс игрока. */
  balance(): number;
  /** Проведённые операции кошелька в порядке выполнения (отклонённые не попадают). */
  transactions(): Tx[];
}

/** Настройки тестовой платформы. */
export interface TestPlatformOptions {
  /** Серверные модули игр. */
  games: GameModule[];
  /** Генератор случайных чисел; по умолчанию `seededRng(1)`. */
  rng?: Rng;
  /** Стартовый баланс; по умолчанию 100. */
  startBalance?: number;
}

/** Создаёт платформу в памяти с кошельком и движком раундов. */
export function createTestPlatform(opts: TestPlatformOptions): TestPlatform {
  let balance = round2(opts.startBalance ?? 100);
  const txs: Tx[] = [];
  let seq = 0;
  const engine = new RoundEngine({
    games: opts.games,
    store: new MemoryRoundStore(),
    rng: opts.rng ?? seededRng(1),
    newRoundId: () => `round-${++seq}`,
  });

  const exec = (op: WalletOp): number => {
    if (op.kind === 'balance') return balance;
    if (op.kind === 'bet') {
      if (op.amount > balance) throw new PlatformError('INSUFFICIENT_FUNDS');
      balance = round2(balance - op.amount);
    } else {
      balance = round2(balance + op.amount);
    }
    txs.push({ txId: op.txId, type: op.kind, roundId: op.roundId, amount: op.amount, balanceAfter: balance });
    return balance;
  };

  return {
    open: (gameId) => runSync(engine.open(gameId), exec),
    startRound: (gameId, bet, params) => runSync(engine.startRound(gameId, bet, params), exec),
    action: (roundId, action) => runSync(engine.action(roundId, action), exec),
    balance: () => balance,
    transactions: () => txs.map((t) => ({ ...t })),
  };
}

/** Генератор, который отдаёт заданные числа по очереди. Когда они кончились — `Error('fixedRng exhausted')`. */
export function fixedRng(values: number[]): Rng {
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1) {
      throw new RangeError(`fixedRng: значение ${v} вне [0, 1)`);
    }
  }
  const queue = [...values];
  let i = 0;
  return {
    next(): number {
      if (i >= queue.length) throw new Error('fixedRng exhausted');
      return queue[i++] as number;
    },
  };
}

/** Воспроизводимый генератор (mulberry32): одинаковый `seed` — одинаковая последовательность в [0, 1). */
export function seededRng(seed: number): Rng {
  let a = Math.trunc(seed) >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
