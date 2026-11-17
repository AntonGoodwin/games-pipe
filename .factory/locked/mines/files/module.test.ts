// Контракт серверного модуля «Мин» (games/mines/spec.md, SC-14; platform/sdk/types.ts).
// Проверяются публичные методы GameModule: число вызовов rng, неизменяемость state, сериализуемость, коды ошибок.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import game from '../server/index.ts';
import { GameError } from '../../../platform/sdk/types.ts';

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

const START_STATE = { mines: [7, 12, 19], revealed: [], hit: null, outcome: null };

describe('Мины: контракт модуля игры', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random запрещён в игре');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SC-14: id и validateParams нормализуют параметры до {}', () => {
    expect(game.id).toBe('mines');
    expect(game.validateParams({ mines: 5 })).toEqual({});
    expect(game.validateParams(undefined)).toEqual({});
    expect(game.validateParams({})).toEqual({});
    expect(game.validateParams({ mines: 10, extra: 1 })).toEqual({});
  });

  it('SC-14: validateParams бросает GameError INVALID_PARAMS на null, массив, строку и число', () => {
    for (const p of [null, [], 'x', 5]) {
      expect(gameErrorCode(() => game.validateParams(p)), `params = ${JSON.stringify(p)}`).toBe('INVALID_PARAMS');
    }
  });

  it('SC-14: start делает ровно 3 вызова rng, состояние сериализуемо, publicView не раскрывает мины', () => {
    const { rng, calls } = countingRng([0.5, 0.75, 0.25]);
    const step: any = game.start({ bet: 2, params: {}, rng });
    expect(calls()).toBe(3);
    expect(step.status).toBe('continue');
    expect(step).not.toHaveProperty('payout');
    expect(step.state).toEqual(START_STATE);
    expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    expect(game.publicView(step.state, false)).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
  });

  it('SC-14: start расставляет мины по таблице спецификации и хранит их отсортированными', () => {
    const cases: Array<[number[], number[]]> = [
      [[0.5, 0.75, 0.25], [7, 12, 19]],
      [[0, 0, 0], [0, 1, 2]],
      [[0.9999, 0.9999, 0.9999], [0, 1, 24]],
    ];
    for (const [values, mines] of cases) {
      const { rng, calls } = countingRng(values);
      const step: any = game.start({ bet: 1, params: {}, rng });
      expect(calls(), `rng ${values}`).toBe(3);
      expect(step.state, `rng ${values}`).toEqual({ mines, revealed: [], hit: null, outcome: null });
    }
  });

  it('SC-14: action reveal безопасной клетки не вызывает rng и не меняет переданный state', () => {
    const { rng: startRng } = countingRng([0.5, 0.75, 0.25]);
    const state = (game.start({ bet: 2, params: {}, rng: startRng }) as any).state;
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);

    const step: any = game.action({ bet: 2, params: {}, state, action: { type: 'reveal', cell: 0 }, rng });
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
    expect(gameErrorCode(() => game.action({ bet: 2, params: {}, state, action: { type: 'reveal', cell: 30 }, rng }))).toBe(
      'INVALID_ACTION',
    );
    expect(gameErrorCode(() => game.action({ bet: 2, params: {}, state, action: { type: 'cashout' }, rng }))).toBe(
      'INVALID_ACTION',
    );
    expect(calls()).toBe(0);
    expect(state).toEqual(snapshot);
  });

  it('SC-14: cashout при revealed = [0] — finished, payout 2 × 1.11 = 2.22, outcome cashout', () => {
    const state = { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null };
    const snapshot = structuredClone(state);
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 2, params: {}, state, action: { type: 'cashout' }, rng });
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
    const step: any = game.action({ bet: 2, params: {}, state, action: { type: 'reveal', cell: 7 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBe(0);
    expect(step.state).toEqual({ mines: [7, 12, 19], revealed: [0], hit: 7, outcome: 'mine' });
    expect(state).toEqual(snapshot);
  });

  it('SC-14: 22-я безопасная клетка завершает раунд с payout bet × 2254 и outcome cleared', () => {
    const revealed = Array.from({ length: 21 }, (_, i) => i + 3); // 3…23
    const state = { mines: [0, 1, 2], revealed, hit: null, outcome: null };
    const { rng, calls } = countingRng([]);
    const step: any = game.action({ bet: 1, params: {}, state, action: { type: 'reveal', cell: 24 }, rng });
    expect(calls()).toBe(0);
    expect(step.status).toBe('finished');
    expect(step.payout).toBeCloseTo(2254, 9);
    expect(step.state).toEqual({ mines: [0, 1, 2], revealed: [...revealed, 24], hit: null, outcome: 'cleared' });
    expect(revealed).toHaveLength(21);
  });

  it('SC-14: publicView открытого раунда не раскрывает мины ни при каком k', () => {
    const state = { mines: [7, 12, 19], revealed: [0, 6, 24], hit: null, outcome: null };
    const view = game.publicView(state, false);
    expect(view).toEqual({ mineCount: 3, revealed: [0, 6, 24], multiplier: 1.46, nextMultiplier: 1.69 });
    expect(JSON.stringify(view)).not.toMatch(/"mines"|"hit"|"outcome"/);
  });
});
