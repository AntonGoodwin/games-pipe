// Контракт серверного модуля «Монетки» (games/coin/spec.md, SC-10; platform/sdk/types.ts).
// Проверяются только публичные методы GameModule и их результат, без опоры на внутреннее устройство.
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

describe('Монетка: контракт модуля игры', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random запрещён в игре');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SC-10: id и validateParams нормализуют параметры до { side }', () => {
    expect(game.id).toBe('coin');
    expect(game.validateParams({ side: 'tails', x: 1 })).toEqual({ side: 'tails' });
    expect(game.validateParams({ side: 'heads' })).toEqual({ side: 'heads' });
  });

  it('SC-10: validateParams бросает GameError INVALID_PARAMS на неверные параметры', () => {
    for (const p of [{ side: 'edge' }, { side: 'HEADS' }, { side: 1 }, {}, null, undefined, 'heads', ['heads'], 42]) {
      expect(gameErrorCode(() => game.validateParams(p)), `params = ${JSON.stringify(p)}`).toBe('INVALID_PARAMS');
    }
  });

  it('SC-10: start закрывает раунд одним вызовом rng, состояние сериализуемо, publicView = { side, outcome, win }', () => {
    const { rng, calls } = countingRng([0.75]);
    const step: any = game.start({ bet: 4, params: { side: 'tails' }, rng });
    expect(calls()).toBe(1);
    expect(step.status).toBe('finished');
    expect(step.state).toEqual({ side: 'tails', outcome: 'tails', win: true });
    expect(step.payout).toBeCloseTo(7.84, 9);
    expect(JSON.parse(JSON.stringify(step.state))).toEqual(step.state);
    expect(game.publicView(step.state, true)).toEqual({ side: 'tails', outcome: 'tails', win: true });
  });

  it('SC-10: start при несовпадении стороны даёт payout 0 и win: false', () => {
    const { rng, calls } = countingRng([0.75]);
    const step: any = game.start({ bet: 4, params: { side: 'heads' }, rng });
    expect(calls()).toBe(1);
    expect(step.status).toBe('finished');
    expect(step.payout).toBe(0);
    expect(step.state).toEqual({ side: 'heads', outcome: 'tails', win: false });
    expect(game.publicView(step.state, true)).toEqual({ side: 'heads', outcome: 'tails', win: false });

    const low = countingRng([0.2]);
    const s2: any = game.start({ bet: 4, params: { side: 'heads' }, rng: low.rng });
    expect(low.calls()).toBe(1);
    expect(s2.state).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(s2.payout).toBeCloseTo(7.84, 9);
  });

  it('SC-10: action бросает GameError INVALID_ACTION, не обращаясь к rng', () => {
    const first = countingRng([0.75]);
    const params = { side: 'tails' };
    const step: any = game.start({ bet: 4, params, rng: first.rng });
    const { rng, calls } = countingRng([0.1]);
    expect(gameErrorCode(() => game.action({ bet: 4, params, state: step.state, action: 'flip', rng }))).toBe('INVALID_ACTION');
    expect(calls()).toBe(0);
  });
});
