// «Мины»: поле 5 × 5, 3 мины расставляются в start тремя вызовами rng; игрок открывает клетки и забирает выигрыш.
// Спецификация: games/mines/spec.md. Решения: decisions/mines.md (правила — D-001…D-009). Документация: games/mines/README.md.
import type { GameModule, Rng, Step } from '../../../platform/sdk/types.ts';
import { GameError } from '../../../platform/sdk/types.ts';

/** Число клеток поля 5 × 5 (D-002). */
export const CELL_COUNT = 25;

/** Число мин на поле, фиксировано (D-001). */
export const MINE_COUNT = 3;

/** Число безопасных клеток: открытие последней завершает раунд (D-006). */
export const SAFE_COUNT = CELL_COUNT - MINE_COUNT;

/** Доля выплаты после house edge 2 % (D-004). */
export const RTP = 0.98;

/** Нормализованные параметры раунда: у игры их нет (D-008). */
export type MinesParams = Record<string, never>;

/** Чем закончился раунд: мина, cashout или открыты все безопасные клетки. */
export type MinesOutcome = 'mine' | 'cashout' | 'cleared';

/** Состояние раунда (spec, раздел «Результат и выплата»). */
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
  mineCount: number;
  revealed: number[];
  multiplier: number;
  nextMultiplier: number | null;
  mines?: number[];
  hit?: number | null;
  outcome?: MinesOutcome | null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Множитель после `k` открытых безопасных клеток (D-004):
 * `M(0) = 1` (только для отображения), иначе `round2(0.98 × C(25, k) / C(22, k))`.
 */
export function multiplier(k: number): number {
  if (k <= 0) return 1;
  return round2((RTP * binom(CELL_COUNT, k)) / binom(SAFE_COUNT, k));
}

/** Расстановка мин частичной тасовкой Фишера — Йетса: ровно 3 вызова rng (D-003). */
function placeMines(rng: Rng): number[] {
  const c = Array.from({ length: CELL_COUNT }, (_, i) => i);
  for (let i = 0; i < MINE_COUNT; i++) {
    const j = i + Math.floor(rng.next() * (CELL_COUNT - i));
    const t = c[i] as number;
    c[i] = c[j] as number;
    c[j] = t;
  }
  return c.slice(0, MINE_COUNT).sort((a, b) => a - b);
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
 * - `validateParams(params)` — `{}` для объекта или `undefined`, лишние поля отбрасываются;
 *   `null`, массив, строка, число → `GameError('INVALID_PARAMS')` (D-008).
 * - `start({ rng })` — 3 вызова `rng.next()`, расстановка мин, шаг `continue` (D-003).
 * - `action({ bet, state, action })` — `reveal`/`cashout`, rng не используется, `state` не меняется (D-005…D-007).
 * - `publicView(state, finished)` — до конца раунда без `mines`/`hit`/`outcome` (D-009).
 */
const game: GameModule<MinesParams, MinesState, unknown> = {
  id: 'mines',

  validateParams(params: unknown): MinesParams {
    if (params === undefined) return {};
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new GameError('INVALID_PARAMS', 'Параметры должны быть объектом');
    }
    return {};
  },

  start({ params, rng }: { bet: number; params: MinesParams; rng: Rng }): Step<MinesState> {
    // Всё, что может упасть, — до обращения к rng (контракт platform/sdk/types.ts).
    game.validateParams(params);
    const mines = placeMines(rng);
    return { status: 'continue', state: { mines, revealed: [], hit: null, outcome: null } };
  },

  action({ bet, state, action }: { bet: number; params: MinesParams; state: MinesState; action: unknown; rng: Rng }): Step<MinesState> {
    const a = parseAction(action, state);
    const mines = state.mines.slice();
    if (a.type === 'cashout') {
      const revealed = state.revealed.slice();
      return {
        status: 'finished',
        state: { mines, revealed, hit: null, outcome: 'cashout' },
        payout: bet * multiplier(revealed.length),
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
    if (revealed.length >= SAFE_COUNT) {
      return {
        status: 'finished',
        state: { mines, revealed, hit: null, outcome: 'cleared' },
        payout: bet * multiplier(revealed.length),
      };
    }
    return { status: 'continue', state: { mines, revealed, hit: null, outcome: null } };
  },

  publicView(state: MinesState, finished: boolean): MinesView {
    const k = state.revealed.length;
    const base = { mineCount: MINE_COUNT, revealed: state.revealed.slice(), multiplier: multiplier(k) };
    if (!finished) return { ...base, nextMultiplier: multiplier(k + 1) };
    return { ...base, nextMultiplier: null, mines: state.mines.slice(), hit: state.hit, outcome: state.outcome };
  },
};

/** Модуль игры `mines` (`GameModule`), который платформа загружает по `manifest.json`. */
export default game;
