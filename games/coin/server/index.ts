// «Монетка»: игрок выбирает сторону, один бросок в start определяет исход и закрывает раунд.
// Спецификация: games/coin/spec.md. Решения: decisions/coin.md (D-001…D-006).
import type { GameModule, Rng, Step } from '../../../platform/sdk/types.ts';
import { GameError } from '../../../platform/sdk/types.ts';

/** Сторона монеты. */
export type Side = 'heads' | 'tails';

/** Нормализованные параметры раунда. */
export interface CoinParams {
  side: Side;
}

/** Состояние раунда: выбранная сторона, выпавшая сторона и признак выигрыша. */
export interface CoinState {
  side: Side;
  outcome: Side;
  win: boolean;
}

/** Коэффициент выплаты при угадывании: честные 2 минус 2 % house edge (D-001). */
export const PAYOUT_MULTIPLIER = 1.96;

function isSide(value: unknown): value is Side {
  return value === 'heads' || value === 'tails';
}

/** Исход по одному числу rng: r < 0.5 → heads, иначе tails (D-002). */
function flip(rng: Rng): Side {
  return rng.next() < 0.5 ? 'heads' : 'tails';
}

/**
 * Серверный модуль «Монетки».
 * Тип `P` оставлен по умолчанию (как у заготовки): платформа отдаёт в `start` результат `validateParams`,
 * а `start` ещё раз нормализует параметры до обращения к rng (D-013).
 *
 * - `validateParams(params)` — возвращает `{ side }`; бросает `GameError('INVALID_PARAMS')`, если
 *   `params` не объект или `side` не `'heads'`/`'tails'` (D-005).
 * - `start({ bet, params, rng })` — один вызов `rng.next()`, возвращает закрытый шаг
 *   `{ status: 'finished', state, payout }`, где `payout = win ? bet × 1.96 : 0` (D-001…D-003).
 * - `action()` — всегда бросает `GameError('INVALID_ACTION')`: ходов внутри раунда нет.
 * - `publicView(state)` — `{ side, outcome, win }`, скрытого нет (D-006).
 */
const game: GameModule = {
  id: 'coin',

  validateParams(params: unknown): CoinParams {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new GameError('INVALID_PARAMS', 'Параметры должны быть объектом { side }');
    }
    const side = (params as { side?: unknown }).side;
    if (!isSide(side)) {
      throw new GameError('INVALID_PARAMS', 'side должен быть "heads" или "tails"');
    }
    return { side };
  },

  start({ bet, params, rng }: { bet: number; params: CoinParams; rng: Rng }): Step<CoinState> {
    // Всё, что может упасть, — до обращения к rng (контракт platform/sdk/types.ts).
    const { side } = game.validateParams(params);
    const outcome = flip(rng);
    const win = outcome === side;
    return {
      status: 'finished',
      state: { side, outcome, win },
      payout: win ? bet * PAYOUT_MULTIPLIER : 0,
    };
  },

  action(): Step<CoinState> {
    throw new GameError('INVALID_ACTION', 'Раунд «Монетки» состоит из одного броска');
  },

  publicView(state: CoinState): { side: Side; outcome: Side; win: boolean } {
    return { side: state.side, outcome: state.outcome, win: state.win };
  },
};

/** Модуль игры `coin` (`GameModule`), который платформа загружает по `manifest.json`. */
export default game;
