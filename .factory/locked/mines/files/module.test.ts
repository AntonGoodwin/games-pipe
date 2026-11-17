// Контракт серверного модуля «Мин» (games/mines/spec.md, SC-14; platform/sdk/types.ts).
// Проверяются публичные методы GameModule: число вызовов rng, неизменяемость state, сериализуемость, коды ошибок.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gameModule from '../server/index.ts';
import { GameError } from '../../../platform/sdk/types.ts';
import type { GameModule } from '../../../platform/sdk/types.ts';

// Модуль проверяется только снаружи, по контракту GameModule (platform/sdk/types.ts), и не зависит
// от того, как игра объявила тип своих params: params { mines } из spec не должны ломать проверку типов
// ни на старом коде (MinesParams = Record<string, never>), ни на новой реализации.
const game = gameModule as unknown as GameModule;

/** rng, который отдаёт заданные числа и бросает, когда они кончились; считает вызовы. */
function countingRng(values: number[]) {
  let calls = 0;
  const rng = {
    next(): number {
      calls += 1;
      if (calls > values.length) throw new Error('rng: лишний вызов');
      return values[calls - 1] as number;
    },
  };
  return { rng, calls: () => calls };
}

function gameErrorCode(fn: () => unknown): string {
  try {
    const v = fn();
    throw new Error(`ожидалась GameError, а вызов вернул ${JSON.stringify(v)}`);
  } catch (e: any) {
    expect(e).toBeInstanceOf(GameError);
    return e.code;
  }
}

const P3 = { mines: 3 };
const START_STATE = { mines: [7, 12, 19], revealed: [], hit: null, outcome: null };
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('Мины: контракт модуля игры', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random запрещён в игре');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SC-14: id и validateParams — mines 1…24, по умолчанию 3, лишние поля отброшены', () => {
    expect(game.id).toBe('mines');
    expect(game.validateParams({ mines: 5, extra: 1 })).toEqual({ mines: 5 });
    expect(game.validateParams(undefined)).toEqual({ mines: 3 });
    expect(game.validateParams({})).toEqual({ mines: 3 });
    expect(game.validateParams({ extra: 1 })).toEqual({ mines: 3 });
    expect(game.validateParams({ mines: 1 })).toEqual({ mines: 1 });
    expect(game.validateParams({ mines: 24 })).toEqual({ mines: 24 });
    expect(game.validateParams({ mines: 3 })).toEqual({ mines: 3 });
  });

  it('SC-14: validateParams бросает GameError INVALID_PARAMS на неверные params и mines', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      5,
      { mines: 0 },
      { mines: 25 },
      { mines: -3 },
      { mines: 2.5 },
      { mines: '5' },
      { mines: null },
    ];
    for (const p of bad) {
      expect(gameErrorCode(() => game.validateParams(p)), `params = ${JSON.stringify(p)}`).toBe('INVALID_PARAMS');
    }
  });

  it('SC-14: start с { mines: 3 } делает ровно 3 вызова rng, состояние сериализуемо, publicView не раскрывает мины', () => {
    const { rng, calls } = countingRng([0.5, 0.75, 0.25]);
    const step: any = game.start({ bet: 2, params: P3, rng });
    expect(calls()).toBe(3);
    expect(step.status).toBe('continue');
    expect(step).not.toHaveProperty('payout');
    expect(step.state).toEqual(START_STATE);
    expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
  });

  it('SC-14: start расставляет m мин по таблице спецификации за ровно m вызовов rng и хранит их отсортированными', () => {
    const cases: Array<[number, number[], number[]]> = [
      [3, [0.5, 0.75, 0.25], [7, 12, 19]],
      [3, [0, 0, 0], [0, 1, 2]],
      [3, [0.9999, 0.9999, 0.9999], [0, 1, 24]],
      [1, [0.5], [12]],
      [5, [0.5, 0.75, 0.25, 0, 0], [3, 4, 7, 12, 19]],
      [24, Array(24).fill(0), range(0, 23)],
      [24, Array(24).fill(0.9999), [...range(0, 22), 24]],
    ];
    for (const [m, values, mines] of cases) {
      const { rng, calls } = countingRng(values);
      const step: any = game.start({ bet: 1, params: { mines: m }, rng });
      expect(calls(), `m = ${m}, rng ${values}`).toBe(m);
      expect(step.status).toBe('continue');
      expect(step.state, `m = ${m}, rng ${values}`).toEqual({ mines, revealed: [], hit: null, outcome: null });
      expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    }
  });

  it('SC-14: start с { mines: 1 } — 1 вызов rng, мина 12, publicView с множителем от одной мины', () => {
    const { rng, calls } = countingRng([0.5]);
    const step: any = game.start({ bet: 1, params: { mines: 1 }, rng });
    expect(calls()).toBe(1);
    expect(step.state.mines).toEqual([12]);
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 1, revealed: [], multiplier: 1, nextMultiplier: 1.02 });
  });

  it('SC-14: start с { mines: 24 } и rng = 0 — ровно 24 вызова, мины 0…23', () => {
    let calls = 0;
    const rng = {
      next(): number {
        calls += 1;
        return 0;
      },
    };
    const step: any = game.start({ bet: 1, params: { mines: 24 }, rng });
    expect(calls).toBe(24);
    expect(step.state.mines).toEqual(range(0, 23));
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 24, revealed: [], multiplier: 1, nextMultiplier: 24.5 });
  });

  it('SC-14: start с неверным mines в обход validateParams — INVALID_PARAMS до rng', () => {
    for (const params of [{ mines: 0 }, { mines: 30 }]) {
      const { rng, calls } = countingRng(Array(30).fill(0));
      expect(gameErrorCode(() => game.start({ bet: 1, params, rng })), `params = ${JSON.stringify(params)}`).toBe(
        'INVALID_PARAMS',
      );
      expect(calls(), `params = ${JSON.stringify(params)}`).toBe(0);
    }
  });

  it('SC-14: action reveal безопасной клетки не вызывает rng и не меняет переданный state', () => {
    const { rng: startRng } = countingRng([0.5, 0.75, 0.25]);
    const state = (game.start({ bet: 2, params: P3, rng: startRng }) as any).state;
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);

    const step: any = game.action({ bet: 2, params: P3, state, action: { type: 'reveal', cell: 0 }, rng });
    expect(calls()).toBe(0);
    expect(step).toEqual({ status: 'continue', state: { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null } });
    expect(state).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 });
  });

  it('SC-14: action с недопустимой клеткой бросает GameError INVALID_ACTION, rng не вызван, state не изменён', () => {
    const state = structuredClone(START_STATE);
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    expect(gameErrorCode(() => game.action({ bet: 2, params: P3, state, action: { type: 'reveal', cell: 30 }, rng }))).toBe(
      'INVALID_ACTION',
    );
    expect(gameErrorCode(() => game.action({ bet: 2, params: P3, state, action: { type: 'cashout' }, rng }))).toBe(
      'INVALID_ACTION',
    );
    expect(calls()).toBe(0);
    expect(state).toEqual(snapshot);
  });

  it('SC-14: cashout при revealed = [0] — finished, payout 2 × 1.11 = 2.22, outcome cashout', () => {
    const state = { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null };
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 2, params: P3, state, action: { type: 'cashout' }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBeCloseTo(2.22, 9);
    expect(step.state).toEqual({ mines: [7, 12, 19], revealed: [0], hit: null, outcome: 'cashout' });
    expect(state).toEqual(snapshot);
    expect(game.publicView(step.state, true)).toEqual({
      mineCount: 3,
      revealed: [0],
      multiplier: 1.11,
      nextMultiplier: null,
      mines: [7, 12, 19],
      hit: null,
      outcome: 'cashout',
    });
  });

  it('SC-14: reveal мины — finished, payout 0, hit и outcome mine, rng не вызван', () => {
    const state = { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null };
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 2, params: P3, state, action: { type: 'reveal', cell: 7 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBe(0);
    expect(step.state).toEqual({ mines: [7, 12, 19], revealed: [0], hit: 7, outcome: 'mine' });
    expect(state).toEqual(snapshot);
  });

  it('SC-14: 22-я безопасная клетка при 3 минах завершает раунд с payout bet × 2254 и outcome cleared', () => {
    const revealed = range(3, 23);
    const state = { mines: [0, 1, 2], revealed, hit: null, outcome: null };
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 1, params: P3, state, action: { type: 'reveal', cell: 24 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBeCloseTo(2254, 9);
    expect(step.state).toEqual({ mines: [0, 1, 2], revealed: [...revealed, 24], hit: null, outcome: 'cleared' });
    expect(revealed).toHaveLength(21);
  });

  it('SC-14: число мин берётся из state, а не из params', () => {
    const state = { mines: [12], revealed: [], hit: null, outcome: null };
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 1, params: P3, state, action: { type: 'reveal', cell: 0 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('continue');
    expect(step.state).toEqual({ mines: [12], revealed: [0], hit: null, outcome: null });
    expect(state).toEqual(snapshot);
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 1, revealed: [0], multiplier: 1.02, nextMultiplier: 1.07 });
  });

  it('SC-14: при 5 минах раунд закрывается сам на 20-й безопасной клетке с M(20) = 52067.4', () => {
    const mines = [3, 4, 7, 12, 19];
    const safe = range(0, 24).filter((c) => !mines.includes(c)); // 20 клеток
    expect(safe).toHaveLength(20);
    const revealed = safe.slice(0, 19);
    const state = { mines, revealed, hit: null, outcome: null };
    // Пока открыто 19 клеток, раунд открыт: M(19) = 8677.9, M(20) = 52067.4.
    expect(game.publicView(state, false)).toEqual({ mineCount: 5, revealed, multiplier: 8677.9, nextMultiplier: 52067.4 });

    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 2, params: { mines: 5 }, state, action: { type: 'reveal', cell: 24 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBeCloseTo(104134.8, 6);
    expect(step.state).toEqual({ mines, revealed: [...revealed, 24], hit: null, outcome: 'cleared' });
    expect(revealed).toHaveLength(19);
  });

  it('SC-14: при 5 минах 2-я и 4-я безопасные клетки дают 1.55 и 2.56 (таблица m = 5)', () => {
    const state = { mines: [3, 4, 7, 12, 19], revealed: [0, 1], hit: null, outcome: null };
    expect(game.publicView(state, false)).toEqual({ mineCount: 5, revealed: [0, 1], multiplier: 1.55, nextMultiplier: 1.98 });
    const state4 = { ...state, revealed: [0, 1, 2, 5] };
    expect(game.publicView(state4, false)).toMatchObject({ mineCount: 5, multiplier: 2.56 });
  });

  it('SC-14: при 24 минах cashout невозможен, а единственная безопасная клетка завершает раунд с 24.5', () => {
    const mines = [...range(0, 22), 24];
    const state = { mines, revealed: [], hit: null, outcome: null };
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    expect(gameErrorCode(() => game.action({ bet: 3, params: { mines: 24 }, state, action: { type: 'cashout' }, rng }))).toBe(
      'INVALID_ACTION',
    );
    const step: any = game.action({ bet: 3, params: { mines: 24 }, state, action: { type: 'reveal', cell: 23 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBeCloseTo(73.5, 9);
    expect(step.state).toEqual({ mines, revealed: [23], hit: null, outcome: 'cleared' });
    expect(state).toEqual(snapshot);
    expect(game.publicView(step.state, true)).toEqual({
      mineCount: 24,
      revealed: [23],
      multiplier: 24.5,
      nextMultiplier: null,
      mines,
      hit: null,
      outcome: 'cleared',
    });
  });

  it('SC-14: publicView открытого раунда не раскрывает мины ни при каком k', () => {
    const state = { mines: [7, 12, 19], revealed: [0, 6, 24], hit: null, outcome: null };
    const view = game.publicView(state, false);
    expect(view).toEqual({ mineCount: 3, revealed: [0, 6, 24], multiplier: 1.46, nextMultiplier: 1.69 });
    expect(JSON.stringify(view)).not.toMatch(/"mines"|"hit"|"outcome"/);
  });
});
