// «Мины»: поле 5 × 5, игрок выбирает число мин m (1…24, по умолчанию 3); мины расставляются в start за m вызовов rng,
// игрок открывает клетки и забирает выигрыш.
// Спецификация: games/mines/spec.md. Решения: decisions/mines.md (D-002…D-007, D-009, D-019…D-023). Документация: games/mines/README.md.
import type { GameModule, Rng, Step } from '../../../platform/sdk/types.ts';
import { GameError } from '../../../platform/sdk/types.ts';

/** Число клеток поля 5 × 5 (D-002). */
export const CELL_COUNT = 25;

/** Наименьшее допустимое число мин (D-019). */
export const MIN_MINES = 1;

/** Наибольшее допустимое число мин (D-019). */
export const MAX_MINES = 24;

/** Число мин, если игрок его не выбрал (D-019). */
export const DEFAULT_MINES = 3;

/** Доля выплаты после house edge 2 %, в процентах — целое число для точного округления (D-021). */
export const RTP_PERCENT = 98;

/** Нормализованные параметры раунда: число мин (D-019). */
export interface MinesParams {
  /** Число мин, целое от 1 до 24. */
  mines: number;
}

/** Чем закончился раунд: мина, cashout или открыты все безопасные клетки. */
export type MinesOutcome = 'mine' | 'cashout' | 'cleared';

/** Состояние раунда (spec, раздел «Результат и выплата»). Число мин — `mines.length` (D-022). */
export interface MinesState {
  /** Клетки с минами, по возрастанию. */
  mines: number[];
  /** Открытые безопасные клетки в порядке открытия. */
  revealed: number[];
  /** Клетка с миной, на которой игрок проиграл, иначе `null`. */
  hit: number | null;
  /** Исход раунда, `null` пока раунд открыт. */
  outcome: MinesOutcome | null;
}

/** Ход игрока (D-007). */
export type MinesAction = { type: 'reveal'; cell: number } | { type: 'cashout' };

/** Что видит клиент (D-009). Поля `mines`, `hit`, `outcome` есть только после завершения раунда. */
export interface MinesView {
  /** Число мин в раунде, `state.mines.length`. */
  mineCount: number;
  /** Открытые безопасные клетки в порядке открытия (копия). */
  revealed: number[];
  /** Текущий множитель `M(k)`; при `k = 0` равен 1. */
  multiplier: number;
  /** Множитель после следующей безопасной клетки `M(k + 1)`, после завершения — `null`. */
  nextMultiplier: number | null;
  /** Клетки с минами — только после завершения раунда. */
  mines?: number[];
  /** Клетка подрыва или `null` — только после завершения раунда. */
  hit?: number | null;
  /** Исход раунда — только после завершения раунда. */
  outcome?: MinesOutcome | null;
}

/** Целый биномиальный коэффициент C(n, k): на каждом шаге промежуточный результат — целое число. */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Множитель после `k` открытых безопасных клеток при `mineCount` минах (D-021):
 * `M(0) = 1` (только для отображения), иначе `Math.round(98 × C(25, k) / C(25 − m, k)) / 100`.
 *
 * @param k Число открытых безопасных клеток; при `k ≤ 0` возвращается 1.
 * @param mineCount Число мин `m` (1…24), по умолчанию 3. Значения не проверяются: вызывающий код
 *   передаёт `k ≤ 25 − m` и `m` из состояния раунда.
 * @returns Множитель, округлённый до сотых (половина цента — вверх). Исключений не бросает.
 */
export function multiplier(k: number, mineCount: number = DEFAULT_MINES): number {
  if (k <= 0) return 1;
  return Math.round((RTP_PERCENT * binom(CELL_COUNT, k)) / binom(CELL_COUNT - mineCount, k)) / 100;
}

/** Число мин: целое число 1…24, без приведения типов (D-019). */
function isMineCount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= MIN_MINES && x <= MAX_MINES;
}

/** Проверяет и нормализует params до любых побочных действий; лишние поля отбрасываются (D-019). */
function parseParams(params: unknown): MinesParams {
  if (params === undefined) return { mines: DEFAULT_MINES };
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new GameError('INVALID_PARAMS', 'Параметры должны быть объектом { mines }');
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'mines')) return { mines: DEFAULT_MINES };
  const mines = (params as { mines?: unknown }).mines;
  if (!isMineCount(mines)) throw new GameError('INVALID_PARAMS', 'mines должно быть целым числом от 1 до 24');
  return { mines };
}

/** Расстановка `count` мин частичной тасовкой Фишера — Йетса: ровно `count` вызовов rng (D-020). */
function placeMines(rng: Rng, count: number): number[] {
  const c = Array.from({ length: CELL_COUNT }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng.next() * (CELL_COUNT - i));
    const t = c[i] as number;
    c[i] = c[j] as number;
    c[j] = t;
  }
  return c.slice(0, count).sort((a, b) => a - b);
}

function invalidAction(message: string): never {
  throw new GameError('INVALID_ACTION', message);
}

/** Проверяет ход до любых изменений; возвращает нормализованное действие. */
function parseAction(action: unknown, state: MinesState): MinesAction {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    invalidAction('Ход должен быть объектом { type, cell }');
  }
  const type = (action as { type?: unknown }).type;
  if (type === 'cashout') {
    if (state.revealed.length < 1) invalidAction('Забрать выигрыш можно после первой открытой клетки');
    return { type: 'cashout' };
  }
  if (type === 'reveal') {
    const cell = (action as { cell?: unknown }).cell;
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
      invalidAction('cell должен быть целым числом от 0 до 24');
    }
    if (state.revealed.includes(cell)) invalidAction('Клетка уже открыта');
    return { type: 'reveal', cell };
  }
  return invalidAction('Неизвестный тип хода');
}

/**
 * Серверный модуль «Мин».
 *
 * - `validateParams(params)` — `{ mines }` (1…24, по умолчанию 3), лишние поля отбрасываются;
 *   `null`, массив, строка, число и неверное `mines` → `GameError('INVALID_PARAMS')` (D-019).
 * - `start({ params, rng })` — повторная проверка params, затем ровно `m` вызовов `rng.next()`, шаг `continue` (D-020).
 * - `action({ bet, state, action })` — `reveal`/`cashout`; rng и params не используются, число мин — из `state`,
 *   переданный `state` не меняется (D-005…D-007, D-022, D-023).
 * - `publicView(state, finished)` — до конца раунда без `mines`/`hit`/`outcome` (D-009).
 */
const game: GameModule<MinesParams, MinesState, unknown> = {
  id: 'mines',

  validateParams(params: unknown): MinesParams {
    return parseParams(params);
  },

  start({ params, rng }: { bet: number; params: MinesParams; rng: Rng }): Step<MinesState> {
    // Всё, что может упасть, — до обращения к rng (контракт platform/sdk/types.ts).
    const { mines: count } = parseParams(params);
    const mines = placeMines(rng, count);
    return { status: 'continue', state: { mines, revealed: [], hit: null, outcome: null } };
  },

  action({ bet, state, action }: { bet: number; params: MinesParams; state: MinesState; action: unknown; rng: Rng }): Step<MinesState> {
    const a = parseAction(action, state);
    const mines = state.mines.slice();
    const m = mines.length;
    if (a.type === 'cashout') {
      const revealed = state.revealed.slice();
      return {
        status: 'finished',
        state: { mines, revealed, hit: null, outcome: 'cashout' },
        payout: bet * multiplier(revealed.length, m),
      };
    }
    if (mines.includes(a.cell)) {
      return {
        status: 'finished',
        state: { mines, revealed: state.revealed.slice(), hit: a.cell, outcome: 'mine' },
        payout: 0,
      };
    }
    const revealed = [...state.revealed, a.cell];
    if (revealed.length >= CELL_COUNT - m) {
      return {
        status: 'finished',
        state: { mines, revealed, hit: null, outcome: 'cleared' },
        payout: bet * multiplier(revealed.length, m),
      };
    }
    return { status: 'continue', state: { mines, revealed, hit: null, outcome: null } };
  },

  publicView(state: MinesState, finished: boolean): MinesView {
    const k = state.revealed.length;
    const m = state.mines.length;
    const base = { mineCount: m, revealed: state.revealed.slice(), multiplier: multiplier(k, m) };
    if (!finished) return { ...base, nextMultiplier: multiplier(k + 1, m) };
    return { ...base, nextMultiplier: null, mines: state.mines.slice(), hit: state.hit, outcome: state.outcome };
  },
};

/**
 * Модуль игры `mines` (`GameModule`), который платформа загружает по `manifest.json`.
 * `validateParams` и `start` бросают `GameError('INVALID_PARAMS')`, `action` — `GameError('INVALID_ACTION')`;
 * все исключения — до обращения к `rng` и без изменения состояния.
 */
export default game;
