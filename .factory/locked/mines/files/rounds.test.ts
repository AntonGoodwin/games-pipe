// Приёмочные тесты «Мин» через тестовую платформу (games/mines/spec.md, SC-1…SC-13, SC-16…SC-18).
// Поведение проверяется снаружи: ответы startRound/action/open, баланс, журнал транзакций, коды ошибок.
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

const R = (cell: unknown) => ({ type: 'reveal', cell });
const CO = { type: 'cashout' };

/** Журнал транзакций в виде [type, amount, balanceAfter]. */
const txList = (p: ReturnType<typeof platform>) => p.transactions().map((t) => [t.type, t.amount, t.balanceAfter]);

/** Поля, которые не должны появляться во view открытого раунда. */
function expectHidden(view: unknown): void {
  expect(view).not.toHaveProperty('mines');
  expect(view).not.toHaveProperty('hit');
  expect(view).not.toHaveProperty('outcome');
}

describe('Мины: раунды через платформу', () => {
  beforeEach(() => {
    // Исход определяется только переданным rng (spec: «Math.random не используется»).
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random запрещён в игре');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SC-1: три безопасные клетки и cashout — выплата 2 × 1.46 = 2.92', () => {
    const p = platform([0.5, 0.75, 0.25]); // мины 7, 12, 19
    const r0 = p.startRound('mines', 2, {});
    expect(r0.gameId).toBe('mines');
    expect(r0.status).toBe('open');
    expect(r0.bet).toBe(2);
    expect(r0.payout).toBeNull();
    expect(r0.balance).toBe(98);
    expect(r0.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
    expect(p.balance()).toBe(98);
    expect(txList(p)).toEqual([['bet', 2, 98]]);

    const r1 = p.action(r0.roundId, R(0));
    expect(r1.roundId).toBe(r0.roundId);
    expect(r1.status).toBe('open');
    expect(r1.payout).toBeNull();
    expect(r1.balance).toBe(98);
    expect(r1.view).toEqual({ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 });

    const r2 = p.action(r0.roundId, R(6));
    expect(r2.status).toBe('open');
    expect(r2.view).toEqual({ mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 });

    const r3 = p.action(r0.roundId, R(24));
    expect(r3.status).toBe('open');
    expect(r3.balance).toBe(98);
    expect(r3.view).toEqual({ mineCount: 3, revealed: [0, 6, 24], multiplier: 1.46, nextMultiplier: 1.69 });
    expect(p.transactions()).toHaveLength(1);

    const r4 = p.action(r0.roundId, CO);
    expect(r4.status).toBe('closed');
    expect(r4.payout).toBe(2.92);
    expect(r4.balance).toBe(100.92);
    expect(r4.view).toEqual({
      mineCount: 3,
      revealed: [0, 6, 24],
      multiplier: 1.46,
      nextMultiplier: null,
      mines: [7, 12, 19],
      hit: null,
      outcome: 'cashout',
    });
    expect(p.balance()).toBe(100.92);
    const txs = p.transactions();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ type: 'bet', roundId: r0.roundId, amount: 2, balanceAfter: 98 });
    expect(txs[1]).toMatchObject({ type: 'payout', roundId: r0.roundId, amount: 2.92, balanceAfter: 100.92 });
    expect(p.open('mines').activeRound).toBeNull();
  });

  it('SC-1: множитель растёт по таблице M(1)…M(5), cashout при k = 5 платит 1.98', () => {
    const p = platform([0.5, 0.75, 0.25]); // мины 7, 12, 19
    const r = p.startRound('mines', 1, {});
    const expected: Array<[number, number, number]> = [
      [0, 1.11, 1.27],
      [1, 1.27, 1.46],
      [2, 1.46, 1.69],
      [3, 1.69, 1.98],
      [4, 1.98, 2.33],
    ];
    for (const [cell, m, next] of expected) {
      const v = p.action(r.roundId, R(cell));
      expect(v.status).toBe('open');
      expect(v.view).toMatchObject({ multiplier: m, nextMultiplier: next });
      expectHidden(v.view);
    }
    const out = p.action(r.roundId, CO);
    expect(out.payout).toBe(1.98);
    expect(out.balance).toBe(100.98);
  });

  it('SC-2: мина после безопасной клетки — выплата 0, мины раскрыты', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 5, {});
    expect(r0.balance).toBe(95);
    const r1 = p.action(r0.roundId, R(0));
    expect(r1.status).toBe('open');
    expect(r1.balance).toBe(95);

    const r2 = p.action(r0.roundId, R(12));
    expect(r2.status).toBe('closed');
    expect(r2.payout).toBe(0);
    expect(r2.balance).toBe(95);
    expect(r2.view).toEqual({
      mineCount: 3,
      revealed: [0],
      multiplier: 1.11,
      nextMultiplier: null,
      mines: [7, 12, 19],
      hit: 12,
      outcome: 'mine',
    });
    expect(p.balance()).toBe(95);
    expect(txList(p)).toEqual([
      ['bet', 5, 95],
      ['payout', 0, 95],
    ]);
    expect(p.open('mines').activeRound).toBeNull();
  });

  it('SC-3: мина первым ходом — проигрыш, revealed пуст', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 1, {});
    const r = p.action(r0.roundId, R(19));
    expect(r.status).toBe('closed');
    expect(r.payout).toBe(0);
    expect(r.balance).toBe(99);
    expect(r.view).toEqual({
      mineCount: 3,
      revealed: [],
      multiplier: 1,
      nextMultiplier: null,
      mines: [7, 12, 19],
      hit: 19,
      outcome: 'mine',
    });
    expect(txList(p)).toEqual([
      ['bet', 1, 99],
      ['payout', 0, 99],
    ]);
  });

  it('SC-3: каждая из трёх мин (7, 12, 19) проигрывает, соседние клетки безопасны', () => {
    for (const mine of [7, 12, 19]) {
      const p = platform([0.5, 0.75, 0.25]);
      const r0 = p.startRound('mines', 1, {});
      const r = p.action(r0.roundId, R(mine));
      expect(r.status, `клетка ${mine}`).toBe('closed');
      expect(r.payout).toBe(0);
      expect(r.view).toMatchObject({ hit: mine, outcome: 'mine', mines: [7, 12, 19] });
      expect(p.balance()).toBe(99);
    }
    // Соседи мин и «перепутанные» индексы (до сортировки c[0..2] = 12, 19, 7; j = 12, 19, 7) — безопасны.
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 1, {});
    const safe = [6, 8, 11, 13, 18, 20, 2, 17];
    safe.forEach((cell, i) => {
      const v = p.action(r0.roundId, R(cell));
      expect(v.status, `клетка ${cell}`).toBe('open');
      expect((v.view as any).revealed).toEqual(safe.slice(0, i + 1));
    });
  });

  it('SC-4: границы rng — 0, 0, 0 даёт мины 0, 1, 2; 0.9999 ×3 даёт мины 0, 1, 24', () => {
    const p = platform([0, 0, 0, 0.9999, 0.9999, 0.9999]);

    const a = p.startRound('mines', 1, {});
    expect(a.balance).toBe(99);
    const a1 = p.action(a.roundId, R(3));
    expect(a1.status).toBe('open');
    expect(a1.view).toEqual({ mineCount: 3, revealed: [3], multiplier: 1.11, nextMultiplier: 1.27 });
    const a2 = p.action(a.roundId, R(2));
    expect(a2.status).toBe('closed');
    expect(a2.payout).toBe(0);
    expect(a2.balance).toBe(99);
    expect(a2.view).toEqual({
      mineCount: 3,
      revealed: [3],
      multiplier: 1.11,
      nextMultiplier: null,
      mines: [0, 1, 2],
      hit: 2,
      outcome: 'mine',
    });

    const b = p.startRound('mines', 1, {});
    expect(b.status).toBe('open');
    expect(b.balance).toBe(98);
    const b1 = p.action(b.roundId, R(2));
    expect(b1.status).toBe('open');
    expect(b1.view).toMatchObject({ revealed: [2], multiplier: 1.11 });
    const b2 = p.action(b.roundId, R(23));
    expect(b2.status).toBe('open');
    expect(b2.view).toEqual({ mineCount: 3, revealed: [2, 23], multiplier: 1.27, nextMultiplier: 1.46 });
    const b3 = p.action(b.roundId, R(24));
    expect(b3.status).toBe('closed');
    expect(b3.payout).toBe(0);
    expect(b3.balance).toBe(98);
    expect(b3.view).toEqual({
      mineCount: 3,
      revealed: [2, 23],
      multiplier: 1.27,
      nextMultiplier: null,
      mines: [0, 1, 24],
      hit: 24,
      outcome: 'mine',
    });

    expect(txList(p)).toEqual([
      ['bet', 1, 99],
      ['payout', 0, 99],
      ['bet', 1, 98],
      ['payout', 0, 98],
    ]);
  });

  it('SC-5: открыты все 22 безопасные клетки — раунд закрывается сам с выплатой 1 × 2254', () => {
    const p = platform([0, 0, 0]); // мины 0, 1, 2
    const r0 = p.startRound('mines', 1, {});
    let last = r0;
    for (let cell = 3; cell <= 23; cell++) {
      last = p.action(r0.roundId, R(cell));
      expect(last.status, `после клетки ${cell}`).toBe('open');
      expect(last.payout).toBeNull();
      expectHidden(last.view);
    }
    expect(last.view).toEqual({
      mineCount: 3,
      revealed: Array.from({ length: 21 }, (_, i) => i + 3),
      multiplier: 563.5,
      nextMultiplier: 2254,
    });
    expect(last.balance).toBe(99);
    expect(p.transactions()).toHaveLength(1);

    const fin = p.action(r0.roundId, R(24));
    expect(fin.status).toBe('closed');
    expect(fin.payout).toBe(2254);
    expect(fin.balance).toBe(2353);
    expect(fin.view).toEqual({
      mineCount: 3,
      revealed: Array.from({ length: 22 }, (_, i) => i + 3),
      multiplier: 2254,
      nextMultiplier: null,
      mines: [0, 1, 2],
      hit: null,
      outcome: 'cleared',
    });
    expect(p.balance()).toBe(2353);
    expect(txList(p)).toEqual([
      ['bet', 1, 99],
      ['payout', 2254, 2353],
    ]);
    expect(p.open('mines').activeRound).toBeNull();
    expect(codeOf(() => p.action(r0.roundId, CO))).toBe('ROUND_CLOSED');
  });

  it('SC-5: cashout на 21-й клетке платит M(21) = 563.5', () => {
    const p = platform([0, 0, 0]);
    const r0 = p.startRound('mines', 2, {});
    for (let cell = 3; cell <= 23; cell++) p.action(r0.roundId, R(cell));
    const out = p.action(r0.roundId, CO);
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(1127);
    expect(out.balance).toBe(1225);
    expect(out.view).toMatchObject({ multiplier: 563.5, outcome: 'cashout', hit: null });
  });

  it('SC-6: округление выплаты — 3.33 × 1.27 = 4.2291 → 4.23', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 3.33, {});
    expect(r0.balance).toBe(96.67);
    p.action(r0.roundId, R(0));
    const r2 = p.action(r0.roundId, R(1));
    expect(r2.view).toMatchObject({ revealed: [0, 1], multiplier: 1.27 });
    const out = p.action(r0.roundId, CO);
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(4.23);
    expect(out.balance).toBe(100.9);
    expect(p.balance()).toBe(100.9);
    expect(txList(p)).toEqual([
      ['bet', 3.33, 96.67],
      ['payout', 4.23, 100.9],
    ]);
  });

  it('SC-7: недопустимые ходы бросают INVALID_ACTION и не меняют раунд', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 2, {});
    p.action(r0.roundId, R(0));
    expect(p.balance()).toBe(98);

    const bad: unknown[] = [
      { type: 'reveal', cell: 0 },
      { type: 'reveal', cell: 25 },
      { type: 'reveal', cell: -1 },
      { type: 'reveal', cell: 2.5 },
      { type: 'reveal', cell: '7' },
      { type: 'reveal' },
      { type: 'flag', cell: 3 },
      'cashout',
      null,
    ];
    for (const a of bad) {
      expect(codeOf(() => p.action(r0.roundId, a)), `action = ${JSON.stringify(a)}`).toBe('INVALID_ACTION');
      expect(p.balance()).toBe(98);
      expect(p.transactions()).toHaveLength(1);
    }

    const o = p.open('mines');
    expect(o.activeRound?.roundId).toBe(r0.roundId);
    expect(o.activeRound?.view).toEqual({ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 });

    const r = p.action(r0.roundId, R(1));
    expect(r.status).toBe('open');
    expect(r.view).toEqual({ mineCount: 3, revealed: [0, 1], multiplier: 1.27, nextMultiplier: 1.46 });
    expect(r.balance).toBe(98);
    expect(txList(p)).toEqual([['bet', 2, 98]]);
  });

  it('SC-7: «"7"» не открывает мину 7 — строка отклоняется, а не приводится к числу', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 2, {});
    expect(codeOf(() => p.action(r0.roundId, { type: 'reveal', cell: '7' }))).toBe('INVALID_ACTION');
    const o = p.open('mines');
    expect(o.activeRound?.status).toBe('open');
    expect(o.activeRound?.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
    expect(p.balance()).toBe(98);
  });

  it('SC-8: cashout до первой клетки запрещён, после первой — 2 × 1.11 = 2.22', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 2, {});
    expect(codeOf(() => p.action(r0.roundId, CO))).toBe('INVALID_ACTION');
    expect(p.balance()).toBe(98);
    expect(txList(p)).toEqual([['bet', 2, 98]]);
    const o = p.open('mines');
    expect(o.activeRound?.roundId).toBe(r0.roundId);
    expect(o.activeRound?.status).toBe('open');

    p.action(r0.roundId, R(0));
    const out = p.action(r0.roundId, CO);
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(2.22);
    expect(out.balance).toBe(100.22);
    expect(out.view).toEqual({
      mineCount: 3,
      revealed: [0],
      multiplier: 1.11,
      nextMultiplier: null,
      mines: [7, 12, 19],
      hit: null,
      outcome: 'cashout',
    });
    expect(txList(p)).toEqual([
      ['bet', 2, 98],
      ['payout', 2.22, 100.22],
    ]);
  });

  it('SC-9: ход в закрытом раунде — ROUND_CLOSED, новый раунд открывается', () => {
    const p = platform([0.5, 0.75, 0.25, 0, 0, 0]);
    const r0 = p.startRound('mines', 5, {});
    p.action(r0.roundId, R(0));
    const lost = p.action(r0.roundId, R(12));
    expect(lost.status).toBe('closed');
    expect(p.balance()).toBe(95);

    expect(codeOf(() => p.action(r0.roundId, R(1)))).toBe('ROUND_CLOSED');
    expect(codeOf(() => p.action(r0.roundId, CO))).toBe('ROUND_CLOSED');
    expect(p.balance()).toBe(95);
    expect(p.transactions()).toHaveLength(2);

    const r1 = p.startRound('mines', 1, {});
    expect(r1.roundId).not.toBe(r0.roundId);
    expect(r1.status).toBe('open');
    expect(r1.balance).toBe(94);
    expect(r1.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
    // Новый раунд на числах 0, 0, 0: клетка 0 — мина.
    const r2 = p.action(r1.roundId, R(0));
    expect(r2.status).toBe('closed');
    expect(r2.view).toMatchObject({ mines: [0, 1, 2], hit: 0 });
    expect(r2.balance).toBe(94);
  });

  it('SC-9: после cashout ход тоже даёт ROUND_CLOSED, повторной выплаты нет', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 2, {});
    p.action(r0.roundId, R(0));
    p.action(r0.roundId, CO);
    expect(p.balance()).toBe(100.22);
    expect(codeOf(() => p.action(r0.roundId, CO))).toBe('ROUND_CLOSED');
    expect(codeOf(() => p.action(r0.roundId, R(1)))).toBe('ROUND_CLOSED');
    expect(p.balance()).toBe(100.22);
    expect(p.transactions()).toHaveLength(2);
  });

  it('SC-10: неверные params (в том числе mines вне 1…24 и не целое число) отклоняются до списания и не расходуют rng', () => {
    const p = platform([0.5, 0.75, 0.25]);
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
    for (const params of bad) {
      expect(codeOf(() => p.startRound('mines', 1, params)), `params = ${JSON.stringify(params)}`).toBe('INVALID_PARAMS');
      expect(p.transactions()).toEqual([]);
      expect(p.balance()).toBe(100);
    }
    expect(p.open('mines').activeRound).toBeNull();

    // Объект без mines — значение по умолчанию 3, лишние поля отброшены; rng не тронут: мины 7, 12, 19.
    const r = p.startRound('mines', 1, { extra: 1 });
    expect(r.status).toBe('open');
    expect(r.balance).toBe(99);
    expect(r.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
    const out = p.action(r.roundId, R(7));
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(0);
    expect(out.view).toMatchObject({ mineCount: 3, mines: [7, 12, 19], hit: 7, outcome: 'mine' });
    expect(out.balance).toBe(99);
    expect(txList(p)).toEqual([
      ['bet', 1, 99],
      ['payout', 0, 99],
    ]);
  });

  it('SC-10: startRound без params — 3 мины по умолчанию', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r = p.startRound('mines', 1);
    expect(r.status).toBe('open');
    expect(r.balance).toBe(99);
    expect(r.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
  });

  it('SC-10: явное { mines: 3 } — тот же раунд, что по умолчанию', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r = p.startRound('mines', 1, { mines: 3 });
    expect(r.status).toBe('open');
    expect(r.balance).toBe(99);
    expect(r.view).toEqual({ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 });
    const out = p.action(r.roundId, R(19));
    expect(out.view).toMatchObject({ mines: [7, 12, 19], hit: 19, outcome: 'mine' });
  });

  it('SC-11: ставка вне лимитов отклоняется до списания', () => {
    const p = platform([0.5, 0.75, 0.25]);
    expect(codeOf(() => p.startRound('mines', 0.5, {}))).toBe('BET_OUT_OF_LIMITS');
    expect(codeOf(() => p.startRound('mines', 10.01, {}))).toBe('BET_OUT_OF_LIMITS');
    expect(p.transactions()).toEqual([]);
    expect(p.balance()).toBe(100);
    expect(p.open('mines').activeRound).toBeNull();
  });

  it('SC-12: недостаточно средств — ставка не списана, раунд не создан', () => {
    const p = platform([0.5, 0.75, 0.25], 5);
    expect(codeOf(() => p.startRound('mines', 6, {}))).toBe('INSUFFICIENT_FUNDS');
    expect(p.transactions()).toEqual([]);
    expect(p.balance()).toBe(5);
    const o = p.open('mines');
    expect(o.activeRound).toBeNull();
    expect(o.balance).toBe(5);

    // rng не потрачен: следующий доступный по деньгам раунд получает мины 7, 12, 19.
    const r = p.startRound('mines', 5, {});
    expect(r.status).toBe('open');
    expect(r.balance).toBe(0);
    const out = p.action(r.roundId, R(12));
    expect(out.view).toMatchObject({ mines: [7, 12, 19], hit: 12 });
  });

  it('SC-13: обновление страницы посреди раунда — тот же раунд без раскрытия мин, игру можно продолжить', () => {
    const p = platform([0.5, 0.75, 0.25]);
    const r0 = p.startRound('mines', 2, {});
    p.action(r0.roundId, R(0));

    const o = p.open('mines');
    expect(o.gameId).toBe('mines');
    expect(o.limits).toEqual({ min: 1, max: 10 });
    expect(o.balance).toBe(98);
    expect(o.activeRound).not.toBeNull();
    expect(o.activeRound!.roundId).toBe(r0.roundId);
    expect(o.activeRound!.status).toBe('open');
    expect(o.activeRound!.bet).toBe(2);
    expect(o.activeRound!.payout).toBeNull();
    expect(o.activeRound!.view).toEqual({ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 });
    expect(JSON.stringify(o.activeRound!.view)).not.toMatch(/mines"|hit|outcome/);

    expect(codeOf(() => p.startRound('mines', 2, {}))).toBe('ROUND_ALREADY_OPEN');
    expect(p.balance()).toBe(98);
    expect(p.transactions()).toHaveLength(1);

    const r1 = p.action(r0.roundId, R(6));
    expect(r1.status).toBe('open');
    expect(r1.view).toEqual({ mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 });
    const out = p.action(r0.roundId, CO);
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(2.54);
    expect(out.balance).toBe(100.54);
    expect(txList(p)).toEqual([
      ['bet', 2, 98],
      ['payout', 2.54, 100.54],
    ]);
  });

  it('SC-16: игра с 5 минами — множитель от m = 5, cashout 2 × 1.55 = 3.1', () => {
    const p = platform([0.5, 0.75, 0.25, 0, 0]); // мины 3, 4, 7, 12, 19 — ровно 5 вызовов rng
    const r0 = p.startRound('mines', 2, { mines: 5 });
    expect(r0.status).toBe('open');
    expect(r0.balance).toBe(98);
    // 98 × 25 / 20 = 122.5 → 1.23 (половина цента вверх)
    expect(r0.view).toEqual({ mineCount: 5, revealed: [], multiplier: 1, nextMultiplier: 1.23 });
    expectHidden(r0.view);

    const r1 = p.action(r0.roundId, R(0));
    expect(r1.status).toBe('open');
    expect(r1.view).toEqual({ mineCount: 5, revealed: [0], multiplier: 1.23, nextMultiplier: 1.55 });

    const r2 = p.action(r0.roundId, R(1));
    expect(r2.status).toBe('open');
    expect(r2.view).toEqual({ mineCount: 5, revealed: [0, 1], multiplier: 1.55, nextMultiplier: 1.98 });
    expect(r2.balance).toBe(98);

    const out = p.action(r0.roundId, CO);
    expect(out.status).toBe('closed');
    expect(out.payout).toBe(3.1);
    expect(out.balance).toBe(101.1);
    expect(out.view).toEqual({
      mineCount: 5,
      revealed: [0, 1],
      multiplier: 1.55,
      nextMultiplier: null,
      mines: [3, 4, 7, 12, 19],
      hit: null,
      outcome: 'cashout',
    });
    expect(p.balance()).toBe(101.1);
    expect(txList(p)).toEqual([
      ['bet', 2, 98],
      ['payout', 3.1, 101.1],
    ]);
  });

  it('SC-16: при 5 минах клетки 3 и 4 — мины (расставлены 4-м и 5-м вызовом rng)', () => {
    for (const mine of [3, 4]) {
      const p = platform([0.5, 0.75, 0.25, 0, 0]);
      const r0 = p.startRound('mines', 2, { mines: 5, extra: 1 });
      p.action(r0.roundId, R(0));
      const r = p.action(r0.roundId, R(mine));
      expect(r.status, `клетка ${mine}`).toBe('closed');
      expect(r.payout).toBe(0);
      expect(r.balance).toBe(98);
      expect(r.view).toEqual({
        mineCount: 5,
        revealed: [0],
        multiplier: 1.23,
        nextMultiplier: null,
        mines: [3, 4, 7, 12, 19],
        hit: mine,
        outcome: 'mine',
      });
    }
  });

  it('SC-17: одна мина — все 24 безопасные клетки, раунд закрывается сам с выплатой 1 × 24.5', () => {
    const p = platform([0.5]); // мина 12, ровно 1 вызов rng
    const r0 = p.startRound('mines', 1, { mines: 1 });
    expect(r0.status).toBe('open');
    expect(r0.balance).toBe(99);
    expect(r0.view).toEqual({ mineCount: 1, revealed: [], multiplier: 1, nextMultiplier: 1.02 });

    const a = p.action(r0.roundId, R(0));
    expect(a.view).toEqual({ mineCount: 1, revealed: [0], multiplier: 1.02, nextMultiplier: 1.07 });
    const b = p.action(r0.roundId, R(1));
    expect(b.view).toEqual({ mineCount: 1, revealed: [0, 1], multiplier: 1.07, nextMultiplier: 1.11 });

    const rest = [...Array.from({ length: 10 }, (_, i) => i + 2), ...Array.from({ length: 11 }, (_, i) => i + 13)]; // 2…11, 13…23
    let last = b;
    for (const cell of rest) {
      last = p.action(r0.roundId, R(cell));
      // На 22-й клетке раунд с одной миной ещё открыт (безопасных 24, а не 22).
      expect(last.status, `после клетки ${cell}`).toBe('open');
      expect(last.payout).toBeNull();
      expectHidden(last.view);
    }
    expect(last.view).toEqual({
      mineCount: 1,
      revealed: [0, 1, ...rest],
      multiplier: 12.25,
      nextMultiplier: 24.5,
    });
    expect(last.balance).toBe(99);
    expect(p.transactions()).toHaveLength(1);

    const fin = p.action(r0.roundId, R(24));
    expect(fin.status).toBe('closed');
    expect(fin.payout).toBe(24.5);
    expect(fin.balance).toBe(123.5);
    expect(fin.view).toEqual({
      mineCount: 1,
      revealed: [0, 1, ...rest, 24],
      multiplier: 24.5,
      nextMultiplier: null,
      mines: [12],
      hit: null,
      outcome: 'cleared',
    });
    expect((fin.view as any).revealed).toHaveLength(24);
    expect(txList(p)).toEqual([
      ['bet', 1, 99],
      ['payout', 24.5, 123.5],
    ]);
    expect(p.open('mines').activeRound).toBeNull();
    expect(codeOf(() => p.action(r0.roundId, R(12)))).toBe('ROUND_CLOSED');
    expect(p.balance()).toBe(123.5);
  });

  it('SC-18: 24 мины — cashout невозможен, единственная безопасная клетка платит 3 × 24.5, мина — 0', () => {
    const p = platform([...Array(24).fill(0.9999), ...Array(24).fill(0)]);
    const minesA = [...Array.from({ length: 23 }, (_, i) => i), 24]; // 0…22, 24
    const minesB = Array.from({ length: 24 }, (_, i) => i); // 0…23

    const a = p.startRound('mines', 3, { mines: 24 });
    expect(a.status).toBe('open');
    expect(a.balance).toBe(97);
    expect(a.view).toEqual({ mineCount: 24, revealed: [], multiplier: 1, nextMultiplier: 24.5 });
    expectHidden(a.view);

    expect(codeOf(() => p.action(a.roundId, CO))).toBe('INVALID_ACTION');
    expect(p.balance()).toBe(97);
    expect(p.transactions()).toHaveLength(1);
    expect(p.open('mines').activeRound?.roundId).toBe(a.roundId);

    const a1 = p.action(a.roundId, R(23));
    expect(a1.status).toBe('closed');
    expect(a1.payout).toBe(73.5);
    expect(a1.balance).toBe(170.5);
    expect(a1.view).toEqual({
      mineCount: 24,
      revealed: [23],
      multiplier: 24.5,
      nextMultiplier: null,
      mines: minesA,
      hit: null,
      outcome: 'cleared',
    });

    // Первый раунд израсходовал ровно 24 числа: второй идёт на 24 нулях.
    const b = p.startRound('mines', 1, { mines: 24 });
    expect(b.status).toBe('open');
    expect(b.balance).toBe(169.5);
    const b1 = p.action(b.roundId, R(0));
    expect(b1.status).toBe('closed');
    expect(b1.payout).toBe(0);
    expect(b1.balance).toBe(169.5);
    expect(b1.view).toEqual({
      mineCount: 24,
      revealed: [],
      multiplier: 1,
      nextMultiplier: null,
      mines: minesB,
      hit: 0,
      outcome: 'mine',
    });

    expect(txList(p)).toEqual([
      ['bet', 3, 97],
      ['payout', 73.5, 170.5],
      ['bet', 1, 169.5],
      ['payout', 0, 169.5],
    ]);
  });
});
