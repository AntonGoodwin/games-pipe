// Кошелёк партнёра по HTTP (platform/spec.md, PL-1…PL-6). Каждый тест — чистый каталог данных.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTmp, closeAll, loadWallet, request, tmpDir, type RunningServer } from './helpers.ts';

describe('кошелёк (HTTP)', () => {
  let dataDir: string;
  const servers: RunningServer[] = [];

  async function startWallet(): Promise<RunningServer> {
    const { startWallet } = await loadWallet();
    const s = await startWallet({ port: 0, dataDir });
    servers.push(s);
    return s;
  }

  const balanceOf = async (w: RunningServer): Promise<number> => {
    const r = await request(w.url, 'GET', '/balance');
    expect(r.status).toBe(200);
    return r.body.balance;
  };

  beforeEach(() => {
    dataDir = tmpDir('wallet-');
  });

  afterEach(async () => {
    await closeAll(servers);
    cleanupTmp();
  });

  it('PL-1: без data/wallet.json начальный баланс 100', async () => {
    expect(fs.existsSync(path.join(dataDir, 'wallet.json'))).toBe(false);
    const w = await startWallet();
    const r = await request(w.url, 'GET', '/balance');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ balance: 100 });
  });

  it('PL-2: списание 2.5 даёт 97.5, зачисление 4.9 даёт 102.4', async () => {
    const w = await startWallet();
    const bet = await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'a', amount: 2.5 });
    expect(bet.status).toBe(200);
    expect(bet.body).toEqual({ balance: 97.5 });
    expect(await balanceOf(w)).toBe(97.5);

    const payout = await request(w.url, 'POST', '/payout', { txId: 'a:payout', roundId: 'a', amount: 4.9 });
    expect(payout.status).toBe(200);
    expect(payout.body).toEqual({ balance: 102.4 });
    expect(await balanceOf(w)).toBe(102.4);
  });

  it('PL-2: выплата 0 принимается и не меняет баланс', async () => {
    const w = await startWallet();
    await request(w.url, 'POST', '/bet', { txId: 'z:bet', roundId: 'z', amount: 5 });
    const payout = await request(w.url, 'POST', '/payout', { txId: 'z:payout', roundId: 'z', amount: 0 });
    expect(payout.status).toBe(200);
    expect(payout.body).toEqual({ balance: 95 });
  });

  it('PL-3: ставка больше баланса — 402 INSUFFICIENT_FUNDS, баланс 100', async () => {
    const w = await startWallet();
    const r = await request(w.url, 'POST', '/bet', { txId: 'b:bet', roundId: 'b', amount: 150 });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(r.body.balance).toBe(100);
    expect(await balanceOf(w)).toBe(100);
  });

  it('PL-3: ставка ровно на весь баланс проходит, следующая — 402', async () => {
    const w = await startWallet();
    const all = await request(w.url, 'POST', '/bet', { txId: 'c:bet', roundId: 'c', amount: 100 });
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ balance: 0 });
    const more = await request(w.url, 'POST', '/bet', { txId: 'd:bet', roundId: 'd', amount: 0.01 });
    expect(more.status).toBe(402);
    expect(more.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(more.body.balance).toBe(0);
  });

  it('PL-4: повтор того же txId не списывает второй раз и возвращает тот же ответ', async () => {
    const w = await startWallet();
    const tx = { txId: 'a:bet', roundId: 'a', amount: 2.5 };
    const first = await request(w.url, 'POST', '/bet', tx);
    const second = await request(w.url, 'POST', '/bet', tx);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ balance: 97.5 });
    expect(second.body).toEqual(first.body);
    expect(await balanceOf(w)).toBe(97.5);
  });

  it('PL-4: повтор выплаты с тем же txId не зачисляет второй раз', async () => {
    const w = await startWallet();
    await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'a', amount: 2.5 });
    const tx = { txId: 'a:payout', roundId: 'a', amount: 4.9 };
    await request(w.url, 'POST', '/payout', tx);
    // после первой выплаты баланс меняется другой операцией — повтор должен вернуть сохранённый ответ
    await request(w.url, 'POST', '/bet', { txId: 'e:bet', roundId: 'e', amount: 1 });
    const again = await request(w.url, 'POST', '/payout', tx);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ balance: 102.4 });
    expect(await balanceOf(w)).toBe(101.4);
  });

  it('PL-5: тот же txId с другой суммой — 409 TX_CONFLICT, баланс 97.5', async () => {
    const w = await startWallet();
    await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'a', amount: 2.5 });
    const r = await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'a', amount: 3 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('TX_CONFLICT');
    expect(await balanceOf(w)).toBe(97.5);
  });

  it('PL-5: тот же txId с другим roundId или другим типом операции — 409 TX_CONFLICT', async () => {
    const w = await startWallet();
    await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'a', amount: 2.5 });
    const otherRound = await request(w.url, 'POST', '/bet', { txId: 'a:bet', roundId: 'x', amount: 2.5 });
    expect(otherRound.status).toBe(409);
    expect(otherRound.body.error.code).toBe('TX_CONFLICT');
    const otherType = await request(w.url, 'POST', '/payout', { txId: 'a:bet', roundId: 'a', amount: 2.5 });
    expect(otherType.status).toBe(409);
    expect(otherType.body.error.code).toBe('TX_CONFLICT');
    expect(await balanceOf(w)).toBe(97.5);
  });

  it('PL-6: баланс и журнал txId переживают перезапуск', async () => {
    const w1 = await startWallet();
    const tx = { txId: 'a:bet', roundId: 'a', amount: 2.5 };
    await request(w1.url, 'POST', '/bet', tx);
    expect(fs.existsSync(path.join(dataDir, 'wallet.json'))).toBe(true);
    await closeAll(servers);

    const w2 = await startWallet();
    expect(await balanceOf(w2)).toBe(97.5);
    const again = await request(w2.url, 'POST', '/bet', tx);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ balance: 97.5 });
    expect(await balanceOf(w2)).toBe(97.5);
    const conflict = await request(w2.url, 'POST', '/bet', { ...tx, amount: 3 });
    expect(conflict.status).toBe(409);
  });
});
