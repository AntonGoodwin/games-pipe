// Движок раундов через testkit (platform/spec.md, PL-7…PL-20). Игры — фикстуры t-flip и t-steps.
import { beforeAll, describe, expect, it } from 'vitest';
import { caught, codeOf, loadFixtureGames, loadTestkit, type TestkitModule, type Rng } from './helpers.ts';

let kit: TestkitModule;
let tFlip: any;
let tSteps: any;

beforeAll(async () => {
  kit = await loadTestkit();
  ({ tFlip, tSteps } = await loadFixtureGames());
});

const platform = (opts: { rng?: Rng; startBalance?: number; games?: any[] } = {}) =>
  kit.createTestPlatform({ games: opts.games ?? [tFlip, tSteps], rng: opts.rng, startBalance: opts.startBalance });

describe('раунды (testkit)', () => {
  it('PL-7: открытие игры возвращает лимиты, баланс и отсутствие раунда', async () => {
    const p = platform({ rng: kit.fixedRng([0.5]) });
    expect(await p.open('t-flip')).toEqual({ gameId: 't-flip', limits: { min: 1, max: 10 }, balance: 100, activeRound: null });
  });

  it('PL-7: startBalance задаёт стартовый баланс, по умолчанию 100', async () => {
    const p = kit.createTestPlatform({ games: [tFlip], startBalance: 42.5 });
    expect((await p.open('t-flip')).balance).toBe(42.5);
    expect(await p.balance()).toBe(42.5);
    const d = kit.createTestPlatform({ games: [tFlip] });
    expect(await d.balance()).toBe(100);
  });

  it('PL-8: выигрыш в один ход — выплата 1.96, баланс 100.96, две транзакции', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    const r = await p.startRound('t-flip', 1, { side: 'heads' });
    expect(r).toEqual({
      roundId: expect.any(String),
      gameId: 't-flip',
      bet: 1,
      status: 'closed',
      view: { side: 'heads', outcome: 'heads' },
      payout: 1.96,
      balance: 100.96,
    });
    expect(await p.balance()).toBe(100.96);
    expect(await p.transactions()).toEqual([
      { txId: `${r.roundId}:bet`, type: 'bet', roundId: r.roundId, amount: 1, balanceAfter: 99 },
      { txId: `${r.roundId}:payout`, type: 'payout', roundId: r.roundId, amount: 1.96, balanceAfter: 100.96 },
    ]);
    // закрытый раунд не возвращается как активный
    expect((await p.open('t-flip')).activeRound).toBeNull();
  });

  it('PL-8: выигрыш на tails со ставкой 10 — выплата 19.6', async () => {
    const p = platform({ rng: kit.fixedRng([0.5]) });
    const r = await p.startRound('t-flip', 10, { side: 'tails' });
    expect(r.view).toEqual({ side: 'tails', outcome: 'tails' });
    expect(r.payout).toBe(19.6);
    expect(r.balance).toBe(109.6);
  });

  it('PL-9: проигрыш закрывается выплатой 0, баланс 95', async () => {
    const p = platform({ rng: kit.fixedRng([0.7]) });
    const r = await p.startRound('t-flip', 5, { side: 'heads' });
    expect(r.status).toBe('closed');
    expect(r.payout).toBe(0);
    expect(r.balance).toBe(95);
    expect(r.view).toEqual({ side: 'heads', outcome: 'tails' });
    expect(await p.balance()).toBe(95);
    expect(await p.transactions()).toEqual([
      { txId: `${r.roundId}:bet`, type: 'bet', roundId: r.roundId, amount: 5, balanceAfter: 95 },
      { txId: `${r.roundId}:payout`, type: 'payout', roundId: r.roundId, amount: 0, balanceAfter: 95 },
    ]);
  });

  it('PL-10: ставки 0.5 и 10.01 отклоняются BET_OUT_OF_LIMITS до кошелька', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    expect(await codeOf(() => p.startRound('t-flip', 0.5, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    expect(await codeOf(() => p.startRound('t-flip', 10.01, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    expect(await p.transactions()).toEqual([]);
    expect(await p.balance()).toBe(100);
    expect((await p.open('t-flip')).activeRound).toBeNull();
  });

  it('PL-10: ставки 1 и 10 на границах принимаются, баланс 100 → 99 → 89', async () => {
    const p = platform({ rng: kit.fixedRng([0.7, 0.7]) });
    const a = await p.startRound('t-flip', 1, { side: 'heads' });
    expect(a.bet).toBe(1);
    expect(a.balance).toBe(99);
    const b = await p.startRound('t-flip', 10, { side: 'heads' });
    expect(b.bet).toBe(10);
    expect(b.balance).toBe(89);
    expect(await p.balance()).toBe(89);
    expect((await p.transactions()).length).toBe(4);
  });

  it('PL-10: ставка округляется до центов до проверки лимитов, не число — BET_OUT_OF_LIMITS', async () => {
    const p = platform({ rng: kit.fixedRng([0.7, 0.7]) });
    const low = await p.startRound('t-flip', 0.999, { side: 'heads' });
    expect(low.bet).toBe(1);
    expect(low.balance).toBe(99);
    const high = await p.startRound('t-flip', 10.004, { side: 'heads' });
    expect(high.bet).toBe(10);
    expect(high.balance).toBe(89);
    expect(await codeOf(() => p.startRound('t-flip', 0.994, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    expect(await codeOf(() => p.startRound('t-flip', 10.006, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    for (const bad of ['5', null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(await codeOf(() => p.startRound('t-flip', bad, { side: 'heads' }))).toBe('BET_OUT_OF_LIMITS');
    }
    expect(await p.balance()).toBe(89);
    expect((await p.transactions()).length).toBe(4);
  });

  it('PL-11: недостаточно средств — INSUFFICIENT_FUNDS, без транзакций и раунда', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]), startBalance: 5 });
    expect(await codeOf(() => p.startRound('t-flip', 6, { side: 'heads' }))).toBe('INSUFFICIENT_FUNDS');
    expect(await p.transactions()).toEqual([]);
    expect(await p.balance()).toBe(5);
    expect((await p.open('t-flip')).activeRound).toBeNull();
    // игра не запускалась: rng не израсходован, следующая ставка на весь баланс выигрывает на 0.3
    const r = await p.startRound('t-flip', 5, { side: 'heads' });
    expect(r.payout).toBe(9.8);
    expect(r.balance).toBe(9.8);
  });

  it('PL-11: в многоходовой игре отказ по средствам не оставляет открытого раунда', async () => {
    const p = platform({ rng: kit.fixedRng([0.2]), startBalance: 1.5 });
    expect(await codeOf(() => p.startRound('t-steps', 2, {}))).toBe('INSUFFICIENT_FUNDS');
    expect((await p.open('t-steps')).activeRound).toBeNull();
    const r = await p.startRound('t-steps', 1.5, {});
    expect(r.status).toBe('open');
    expect(r.balance).toBe(0);
  });

  it('PL-12: неверные параметры — INVALID_PARAMS, без транзакций, баланс 100', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    expect(await codeOf(() => p.startRound('t-flip', 1, { side: 'edge' }))).toBe('INVALID_PARAMS');
    expect(await codeOf(() => p.startRound('t-flip', 1, null))).toBe('INVALID_PARAMS');
    expect(await p.transactions()).toEqual([]);
    expect(await p.balance()).toBe(100);
    expect((await p.open('t-flip')).activeRound).toBeNull();
  });

  it('PL-12: лимиты проверяются раньше параметров', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    expect(await codeOf(() => p.startRound('t-flip', 50, { side: 'edge' }))).toBe('BET_OUT_OF_LIMITS');
  });

  it('PL-13: многоходовой раунд, secret скрыт до закрытия, выплата 4', async () => {
    const p = platform({ rng: kit.fixedRng([0.42]) });
    const r0 = await p.startRound('t-steps', 3, {});
    expect(r0).toEqual({ roundId: expect.any(String), gameId: 't-steps', bet: 3, status: 'open', view: { step: 0 }, payout: null, balance: 97 });
    expect(r0.view).not.toHaveProperty('secret');
    expect(await p.transactions()).toEqual([{ txId: `${r0.roundId}:bet`, type: 'bet', roundId: r0.roundId, amount: 3, balanceAfter: 97 }]);

    const opened = await p.open('t-steps');
    expect(opened.balance).toBe(97);
    expect(opened.activeRound).toEqual(r0);
    expect(opened.activeRound?.view).not.toHaveProperty('secret');

    const r1 = await p.action(r0.roundId, 'next');
    expect(r1).toEqual({ ...r0, view: { step: 1 } });
    expect(r1.view).not.toHaveProperty('secret');

    const r2 = await p.action(r0.roundId, 'cashout');
    expect(r2).toEqual({ ...r0, status: 'closed', view: { step: 1, secret: 0.42 }, payout: 4, balance: 101 });
    expect(await p.balance()).toBe(101);
    expect(await p.transactions()).toEqual([
      { txId: `${r0.roundId}:bet`, type: 'bet', roundId: r0.roundId, amount: 3, balanceAfter: 97 },
      { txId: `${r0.roundId}:payout`, type: 'payout', roundId: r0.roundId, amount: 4, balanceAfter: 101 },
    ]);
    expect((await p.open('t-steps')).activeRound).toBeNull();
  });

  it('PL-14: выплата округляется до центов: 1 × 4/3 → 1.33; ставка 1.006 → 1.01', async () => {
    const p = platform({ rng: kit.fixedRng([0.1, 0.2]) });
    const a = await p.startRound('t-steps', 1, {});
    await p.action(a.roundId, 'next');
    const aEnd = await p.action(a.roundId, 'cashout');
    expect(aEnd.payout).toBe(1.33);
    expect(aEnd.balance).toBe(100.33);

    const b = await p.startRound('t-steps', 1.006, {});
    expect(b.bet).toBe(1.01);
    expect(b.balance).toBe(99.32);
    const bEnd = await p.action(b.roundId, 'cashout');
    expect(bEnd.bet).toBe(1.01);
    expect(bEnd.payout).toBe(1.01);
    expect(bEnd.balance).toBe(100.33);

    const txs = await p.transactions();
    expect(txs.map((t) => [t.type, t.amount, t.balanceAfter])).toEqual([
      ['bet', 1, 99],
      ['payout', 1.33, 100.33],
      ['bet', 1.01, 99.32],
      ['payout', 1.01, 100.33],
    ]);
  });

  it('PL-14: выплата округляется к ближайшему центу (не вниз и не вверх)', async () => {
    const p = platform({ rng: kit.fixedRng([0.1, 0.2]) });
    // 1.07 × 4/3 = 1.42666… → 1.43 (отбрасывание дало бы 1.42)
    const a = await p.startRound('t-steps', 1.07, {});
    await p.action(a.roundId, 'next');
    const aEnd = await p.action(a.roundId, 'cashout');
    expect(aEnd.payout).toBe(1.43);
    expect(aEnd.balance).toBe(100.36);
    // 1.03 × 4/3 = 1.37333… → 1.37 (округление вверх дало бы 1.38)
    const b = await p.startRound('t-steps', 1.03, {});
    await p.action(b.roundId, 'next');
    const bEnd = await p.action(b.roundId, 'cashout');
    expect(bEnd.payout).toBe(1.37);
    expect(bEnd.balance).toBe(100.7);
  });

  it('PL-15: недопустимое действие — INVALID_ACTION, состояние и баланс не меняются', async () => {
    const p = platform({ rng: kit.fixedRng([0.6]) });
    const r = await p.startRound('t-steps', 2, {});
    expect(r.view).toEqual({ step: 0 });
    expect(r.balance).toBe(98);
    expect(await codeOf(() => p.action(r.roundId, 'jump'))).toBe('INVALID_ACTION');
    const after = await p.open('t-steps');
    expect(after.activeRound?.status).toBe('open');
    expect(after.activeRound?.view).toEqual({ step: 0 });
    const next = await p.action(r.roundId, 'next');
    expect(next.view).toEqual({ step: 1 });
    expect(next.balance).toBe(98);
    expect(await p.balance()).toBe(98);
    expect((await p.transactions()).length).toBe(1);
    // раунд по-прежнему можно закрыть с верной выплатой: 2 × (1 + 1/3) = 2.666… → 2.67
    const end = await p.action(r.roundId, 'cashout');
    expect(end.payout).toBe(2.67);
    expect(end.balance).toBe(100.67);
  });

  it('PL-16: второй раунд в той же игре — ROUND_ALREADY_OPEN; другая игра независима', async () => {
    const p = platform({ rng: kit.fixedRng([0.5, 0.3]) });
    const steps = await p.startRound('t-steps', 2, {});
    expect(steps.balance).toBe(98);
    expect(await codeOf(() => p.startRound('t-steps', 2, {}))).toBe('ROUND_ALREADY_OPEN');
    expect(await p.balance()).toBe(98);
    const txs = await p.transactions();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ type: 'bet', roundId: steps.roundId, amount: 2 });

    // rng не израсходован отказом: t-flip получает 0.3 → heads → выигрыш 1.96
    const flip = await p.startRound('t-flip', 1, { side: 'heads' });
    expect(flip.view).toEqual({ side: 'heads', outcome: 'heads' });
    expect(flip.payout).toBe(1.96);
    expect(flip.balance).toBe(98.96);
    expect(flip.roundId).not.toBe(steps.roundId);

    // раунд t-steps всё ещё открыт и тот же
    expect((await p.open('t-steps')).activeRound?.roundId).toBe(steps.roundId);
  });

  it('PL-16: после закрытия раунда в игре можно открыть новый', async () => {
    const p = platform({ rng: kit.fixedRng([0.5, 0.6]) });
    const a = await p.startRound('t-steps', 2, {});
    await p.action(a.roundId, 'cashout');
    const b = await p.startRound('t-steps', 2, {});
    expect(b.status).toBe('open');
    expect(b.roundId).not.toBe(a.roundId);
    expect(b.balance).toBe(98);
  });

  it('PL-17: действие в закрытом раунде — ROUND_CLOSED; неизвестный раунд — ROUND_NOT_FOUND', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    const r = await p.startRound('t-flip', 1, { side: 'heads' });
    expect(r.status).toBe('closed');
    expect(await codeOf(() => p.action(r.roundId, 'next'))).toBe('ROUND_CLOSED');
    expect(await p.balance()).toBe(100.96);
    expect((await p.transactions()).length).toBe(2);
    expect(await codeOf(() => p.action('no-such-round', 'next'))).toBe('ROUND_NOT_FOUND');
  });

  it('PL-17: cashout в уже закрытом многоходовом раунде не платит второй раз', async () => {
    const p = platform({ rng: kit.fixedRng([0.5]) });
    const r = await p.startRound('t-steps', 3, {});
    await p.action(r.roundId, 'cashout');
    expect(await p.balance()).toBe(100);
    expect(await codeOf(() => p.action(r.roundId, 'cashout'))).toBe('ROUND_CLOSED');
    expect(await p.balance()).toBe(100);
    expect((await p.transactions()).length).toBe(2);
  });

  it('PL-18: неизвестная игра — GAME_NOT_FOUND, баланс 100', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    expect(await codeOf(() => p.open('nope'))).toBe('GAME_NOT_FOUND');
    expect(await codeOf(() => p.startRound('nope', 1, {}))).toBe('GAME_NOT_FOUND');
    // игра проверяется раньше лимитов
    expect(await codeOf(() => p.startRound('nope', 500, {}))).toBe('GAME_NOT_FOUND');
    expect(await p.balance()).toBe(100);
    expect(await p.transactions()).toEqual([]);
  });

  it('PL-18: ошибка платформы содержит code и message', async () => {
    const p = platform({ rng: kit.fixedRng([0.3]) });
    const e = await caught(() => p.open('nope'));
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('GAME_NOT_FOUND');
    expect(typeof e.message).toBe('string');
  });

  it('PL-19: отрицательная выплата игры — INTERNAL_ERROR, выплаты нет, баланс 99, раунд открыт', async () => {
    const broken = {
      id: 't-broken',
      validateParams: () => ({}),
      start: () => ({ status: 'finished', state: { n: 1 }, payout: -1 }),
      action: () => ({ status: 'finished', state: { n: 2 }, payout: 1 }),
      publicView: (state: { n: number }) => ({ n: state.n }),
    };
    const p = platform({ rng: kit.fixedRng([0.5]), games: [broken] });
    expect(await codeOf(() => p.startRound('t-broken', 1, {}))).toBe('INTERNAL_ERROR');
    expect(await p.balance()).toBe(99);
    const txs = await p.transactions();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ type: 'bet', amount: 1, balanceAfter: 99 });
    expect(txs.some((t) => t.type === 'payout')).toBe(false);
    const opened = await p.open('t-broken');
    expect(opened.balance).toBe(99);
    expect(opened.activeRound).not.toBeNull();
    expect(opened.activeRound?.status).toBe('open');
    expect(opened.activeRound?.payout).toBeNull();
    expect(opened.activeRound?.roundId).toBe(txs[0].roundId);
    expect(await codeOf(() => p.startRound('t-broken', 1, {}))).toBe('ROUND_ALREADY_OPEN');
  });

  it('PL-19: NaN в выплате игры при ходе — INTERNAL_ERROR, состояние раунда прежнее', async () => {
    const nanGame = {
      id: 't-nan',
      validateParams: () => ({}),
      start: () => ({ status: 'continue', state: { n: 0 } }),
      action: ({ action, state }: { action: string; state: { n: number } }) =>
        action === 'bad' ? { status: 'finished', state: { n: 99 }, payout: Number.NaN } : { status: 'finished', state: { n: state.n + 1 }, payout: 3 },
      publicView: (state: { n: number }) => ({ n: state.n }),
    };
    const p = platform({ rng: kit.fixedRng([0.5]), games: [nanGame] });
    const r = await p.startRound('t-nan', 2, {});
    expect(await codeOf(() => p.action(r.roundId, 'bad'))).toBe('INTERNAL_ERROR');
    const opened = await p.open('t-nan');
    expect(opened.activeRound?.status).toBe('open');
    expect(opened.activeRound?.view).toEqual({ n: 0 });
    expect(await p.balance()).toBe(98);
    const end = await p.action(r.roundId, 'ok');
    expect(end.payout).toBe(3);
    expect(end.view).toEqual({ n: 1 });
    expect(end.balance).toBe(101);
  });

  it('PL-20: seededRng(42) воспроизводим и лежит в [0, 1); fixedRng кончается ошибкой', async () => {
    const a = kit.seededRng(42);
    const b = kit.seededRng(42);
    const sa = Array.from({ length: 5 }, () => a.next());
    const sb = Array.from({ length: 5 }, () => b.next());
    expect(sa).toEqual(sb);
    for (const x of sa) {
      expect(typeof x).toBe('number');
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(new Set(sa).size).toBeGreaterThan(1);
    const c = kit.seededRng(43);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);

    const f = kit.fixedRng([0.1]);
    expect(f.next()).toBe(0.1);
    expect(() => f.next()).toThrow('fixedRng exhausted');
  });

  it('PL-20: fixedRng отдаёт значения по очереди и отклоняет значения вне [0, 1)', () => {
    const f = kit.fixedRng([0.25, 0, 0.99]);
    expect([f.next(), f.next(), f.next()]).toEqual([0.25, 0, 0.99]);
    expect(() => kit.fixedRng([1])).toThrow();
    expect(() => kit.fixedRng([-0.1])).toThrow();
  });

  it('PL-20: без rng testkit использует seededRng(1) — исход воспроизводим', async () => {
    const seq = kit.seededRng(1);
    const first = seq.next();
    const expected = first < 0.5 ? 'heads' : 'tails';
    const p = kit.createTestPlatform({ games: [tFlip] });
    const r = await p.startRound('t-flip', 1, { side: 'heads' });
    expect(r.view.outcome).toBe(expected);
    expect(r.payout).toBe(expected === 'heads' ? 1.96 : 0);
  });
});
