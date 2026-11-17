// Приёмочные тесты «Монетки» через тестовую платформу (games/coin/spec.md, SC-1…SC-9).
// Поведение проверяется снаружи: ответы startRound/open/action, баланс, журнал транзакций, коды ошибок.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import game from '../server/index.ts';
import { createTestPlatform, fixedRng } from '../../../platform/testkit/index.ts';

/** Код ошибки, которую бросает fn; если fn не бросила — тест падает. */
function codeOf(fn: () => unknown): string {
  try {
    const v = fn();
    throw new Error(`ожидалась ошибка, а вызов вернул ${JSON.stringify(v)}`);
  } catch (e: any) {
    if (e instanceof Error && e.message.startsWith('ожидалась ошибка')) throw e;
    return e?.code;
  }
}

function platform(rng: number[], startBalance = 100) {
  return createTestPlatform({ games: [game], rng: fixedRng(rng), startBalance });
}

describe('Монетка: раунды через платформу', () => {
  beforeEach(() => {
    // Исход определяется только переданным rng (spec: «Math.random не используется»).
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random запрещён в игре');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SC-1: выигрыш на орле — выплата bet × 1.96, раунд закрыт сразу', () => {
    const p = platform([0.3]);
    const r = p.startRound('coin', 1, { side: 'heads' });
    expect(r.gameId).toBe('coin');
    expect(r.status).toBe('closed');
    expect(r.bet).toBe(1);
    expect(r.payout).toBe(1.96);
    expect(r.balance).toBe(100.96);
    expect(r.view).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(p.balance()).toBe(100.96);
    const txs = p.transactions();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ type: 'bet', roundId: r.roundId, amount: 1, balanceAfter: 99 });
    expect(txs[1]).toMatchObject({ type: 'payout', roundId: r.roundId, amount: 1.96, balanceAfter: 100.96 });
  });

  it('SC-2: выигрыш на решке при rng ровно 0.5 и максимальной ставке 10', () => {
    const p = platform([0.5]);
    const r = p.startRound('coin', 10, { side: 'tails' });
    expect(r.status).toBe('closed');
    expect(r.bet).toBe(10);
    expect(r.payout).toBe(19.6);
    expect(r.balance).toBe(109.6);
    expect(r.view).toEqual({ side: 'tails', outcome: 'tails', win: true });
    expect(p.balance()).toBe(109.6);
    const txs = p.transactions();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ type: 'bet', amount: 10, balanceAfter: 90 });
    expect(txs[1]).toMatchObject({ type: 'payout', amount: 19.6, balanceAfter: 109.6 });
  });

  it('SC-3: проигрыш — выплата 0, ставка потеряна, раунд закрыт выплатой 0', () => {
    const p = platform([0.7]);
    const r = p.startRound('coin', 5, { side: 'heads' });
    expect(r.status).toBe('closed');
    expect(r.bet).toBe(5);
    expect(r.payout).toBe(0);
    expect(r.balance).toBe(95);
    expect(r.view).toEqual({ side: 'heads', outcome: 'tails', win: false });
    expect(p.balance()).toBe(95);
    const txs = p.transactions();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ type: 'bet', amount: 5, balanceAfter: 95 });
    expect(txs[1]).toMatchObject({ type: 'payout', amount: 0, balanceAfter: 95 });
  });

  it('SC-4: проигрыш у границы — rng 0.4999 даёт орла, ставка на решку проигрывает', () => {
    const p = platform([0.4999]);
    const r = p.startRound('coin', 2, { side: 'tails' });
    expect(r.status).toBe('closed');
    expect(r.view).toEqual({ side: 'tails', outcome: 'heads', win: false });
    expect(r.payout).toBe(0);
    expect(r.balance).toBe(98);
    expect(p.balance()).toBe(98);
    expect(p.transactions().map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([
      ['bet', 2, 98],
      ['payout', 0, 98],
    ]);
  });

  it('SC-4: граница с другой стороны — rng 0.4999 при ставке на орла выигрывает', () => {
    const p = platform([0.4999]);
    const r = p.startRound('coin', 2, { side: 'heads' });
    expect(r.view).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(r.payout).toBe(3.92);
    expect(r.balance).toBe(101.92);
  });

  it('SC-5: выплата округляется до центов — 3.33 × 1.96 = 6.5268 → 6.53', () => {
    const p = platform([0]);
    const r = p.startRound('coin', 3.33, { side: 'heads' });
    expect(r.status).toBe('closed');
    expect(r.bet).toBe(3.33);
    expect(r.view).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(r.payout).toBe(6.53);
    expect(r.balance).toBe(103.2);
    expect(p.balance()).toBe(103.2);
    expect(p.transactions().map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([
      ['bet', 3.33, 96.67],
      ['payout', 6.53, 103.2],
    ]);
  });

  it('SC-6: неверные параметры отклоняются до списания и не расходуют rng', () => {
    const p = platform([0.3]);
    const bad: unknown[] = [{ side: 'edge' }, { side: 'HEADS' }, { side: 1 }, {}, null, 'heads', ['heads'], { side: 'tails ' }];
    for (const params of bad) {
      expect(codeOf(() => p.startRound('coin', 1, params)), `params = ${JSON.stringify(params)}`).toBe('INVALID_PARAMS');
      expect(p.transactions()).toEqual([]);
      expect(p.balance()).toBe(100);
    }
    expect(p.open('coin').activeRound).toBeNull();

    // rng не тронут: единственное число 0.3 достаётся следующему корректному раунду.
    const r = p.startRound('coin', 1, { side: 'heads', extra: 42 });
    expect(r.status).toBe('closed');
    expect(r.payout).toBe(1.96);
    expect(r.balance).toBe(100.96);
    expect(r.view).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(r.view).not.toHaveProperty('extra');
    expect(p.transactions()).toHaveLength(2);
  });

  it('SC-7: ставка вне лимитов отклоняется до списания', () => {
    const p = platform([0.3, 0.3]);
    expect(codeOf(() => p.startRound('coin', 0.5, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    expect(codeOf(() => p.startRound('coin', 10.01, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    expect(p.transactions()).toEqual([]);
    expect(p.balance()).toBe(100);
  });

  it('SC-8: недостаточно средств — ставка не списана, раунд не создан', () => {
    const p = platform([0.3], 5);
    expect(codeOf(() => p.startRound('coin', 6, { side: 'heads' }))).toBe('INSUFFICIENT_FUNDS');
    expect(p.transactions()).toEqual([]);
    expect(p.balance()).toBe(5);
    const o = p.open('coin');
    expect(o.activeRound).toBeNull();
    expect(o.balance).toBe(5);

    // rng не потрачен: следующий доступный по деньгам раунд получает 0.3.
    const r = p.startRound('coin', 5, { side: 'heads' });
    expect(r.payout).toBe(9.8);
    expect(r.balance).toBe(9.8);
  });

  it('SC-9: серия бросков — каждый раунд закрыт, action даёт ROUND_CLOSED, один rng на раунд', () => {
    const p = platform([0.1, 0.9]);
    const r1 = p.startRound('coin', 2, { side: 'heads' });
    expect(r1.status).toBe('closed');
    expect(r1.view).toEqual({ side: 'heads', outcome: 'heads', win: true });
    expect(r1.payout).toBe(3.92);
    expect(r1.balance).toBe(101.92);
    expect(p.open('coin').activeRound).toBeNull();

    expect(codeOf(() => p.action(r1.roundId, 'flip'))).toBe('ROUND_CLOSED');
    expect(p.balance()).toBe(101.92);
    expect(p.transactions()).toHaveLength(2);

    const r2 = p.startRound('coin', 2, { side: 'heads' });
    expect(r2.roundId).not.toBe(r1.roundId);
    expect(r2.status).toBe('closed');
    expect(r2.view).toEqual({ side: 'heads', outcome: 'tails', win: false });
    expect(r2.payout).toBe(0);
    expect(r2.balance).toBe(99.92);

    const o = p.open('coin');
    expect(o).toMatchObject({ gameId: 'coin', limits: { min: 1, max: 10 }, balance: 99.92, activeRound: null });
    expect(o.activeRound).toBeNull();
    expect(p.transactions().map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([
      ['bet', 2, 98],
      ['payout', 3.92, 101.92],
      ['bet', 2, 99.92],
      ['payout', 0, 99.92],
    ]);
  });
});
