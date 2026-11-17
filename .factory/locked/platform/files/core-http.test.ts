// Ядро по HTTP вместе с кошельком (platform/spec.md, PL-21…PL-23). Чистый каталог данных на каждый тест.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTmp, closeAll, FIXTURES_DIR, loadCore, loadWallet, request, tmpDir, type RunningServer } from './helpers.ts';

describe('ядро (HTTP)', () => {
  let dataDir: string;
  const servers: RunningServer[] = [];

  async function startStack(gamesDir = FIXTURES_DIR): Promise<{ wallet: RunningServer; core: RunningServer }> {
    const { startWallet } = await loadWallet();
    const { startCore } = await loadCore();
    const wallet = await startWallet({ port: 0, dataDir });
    servers.push(wallet);
    const core = await startCore({ port: 0, dataDir, gamesDir, walletUrl: wallet.url });
    servers.push(core);
    return { wallet, core };
  }

  const walletBalance = async (wallet: RunningServer): Promise<number> => {
    const r = await request(wallet.url, 'GET', '/balance');
    expect(r.status).toBe(200);
    return r.body.balance;
  };

  beforeEach(() => {
    dataDir = tmpDir('core-');
  });

  afterEach(async () => {
    // ядро первым, потом кошелёк
    await closeAll(servers.reverse());
    cleanupTmp();
  });

  it('PL-21: после перезапуска ядра и кошелька open возвращает тот же открытый раунд', async () => {
    const first = await startStack();
    const started = await request(first.core.url, 'POST', '/api/games/t-steps/rounds', { bet: 2, params: {} });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ gameId: 't-steps', bet: 2, status: 'open', view: { step: 0 }, payout: null, balance: 98 });
    expect(started.body.view).not.toHaveProperty('secret');
    const roundId: string = started.body.roundId;
    expect(typeof roundId).toBe('string');
    expect(await walletBalance(first.wallet)).toBe(98);
    expect(fs.existsSync(path.join(dataDir, 'rounds.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'wallet.json'))).toBe(true);

    await closeAll(servers.reverse());

    const second = await startStack();
    const opened = await request(second.core.url, 'POST', '/api/games/t-steps/open');
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({
      gameId: 't-steps',
      limits: { min: 1, max: 10 },
      balance: 98,
      activeRound: { roundId, gameId: 't-steps', bet: 2, status: 'open', view: { step: 0 }, payout: null, balance: 98 },
    });

    // раунд продолжается после перезапуска: next, затем cashout 2 × (1 + 1/3) = 2.67
    const next = await request(second.core.url, 'POST', `/api/rounds/${roundId}/actions`, { action: 'next' });
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ roundId, status: 'open', view: { step: 1 }, payout: null, balance: 98 });
    const end = await request(second.core.url, 'POST', `/api/rounds/${roundId}/actions`, { action: 'cashout' });
    expect(end.status).toBe(200);
    expect(end.body).toMatchObject({ roundId, status: 'closed', payout: 2.67, balance: 100.67 });
    expect(typeof end.body.view.secret).toBe('number');
    expect(await walletBalance(second.wallet)).toBe(100.67);
  });

  it('PL-21: однократный раунд по HTTP — списание и выплата идут через кошелёк', async () => {
    const { core, wallet } = await startStack();
    const opened = await request(core.url, 'POST', '/api/games/t-flip/open');
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ gameId: 't-flip', limits: { min: 1, max: 10 }, balance: 100, activeRound: null });
    const r = await request(core.url, 'POST', '/api/games/t-flip/rounds', { bet: 4, params: { side: 'heads' } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('closed');
    const payout = r.body.view.outcome === 'heads' ? 7.84 : 0;
    expect(r.body.payout).toBe(payout);
    expect(r.body.balance).toBe(Math.round((96 + payout) * 100) / 100);
    expect(await walletBalance(wallet)).toBe(r.body.balance);
    // транзакции раунда записаны в кошельке с идентификаторами <roundId>:bet и <roundId>:payout
    const replayBet = await request(wallet.url, 'POST', '/bet', { txId: `${r.body.roundId}:bet`, roundId: r.body.roundId, amount: 4 });
    expect(replayBet.status).toBe(200);
    const replayPayout = await request(wallet.url, 'POST', '/payout', { txId: `${r.body.roundId}:payout`, roundId: r.body.roundId, amount: payout });
    expect(replayPayout.status).toBe(200);
    expect(await walletBalance(wallet)).toBe(r.body.balance);
  });

  it('PL-22: ошибки HTTP — статусы, коды и неизменный баланс кошелька', async () => {
    const { core, wallet } = await startStack();

    const outOfLimits = await request(core.url, 'POST', '/api/games/t-flip/rounds', { bet: 11, params: { side: 'heads' } });
    expect(outOfLimits.status).toBe(400);
    expect(outOfLimits.body.error.code).toBe('BET_OUT_OF_LIMITS');
    expect(typeof outOfLimits.body.error.message).toBe('string');
    expect(await walletBalance(wallet)).toBe(100);

    const badParams = await request(core.url, 'POST', '/api/games/t-flip/rounds', { bet: 1, params: { side: 'edge' } });
    expect(badParams.status).toBe(400);
    expect(badParams.body.error.code).toBe('INVALID_PARAMS');

    const noGame = await request(core.url, 'POST', '/api/games/nope/rounds', { bet: 1, params: {} });
    expect(noGame.status).toBe(404);
    expect(noGame.body.error.code).toBe('GAME_NOT_FOUND');
    const noGameOpen = await request(core.url, 'POST', '/api/games/nope/open');
    expect(noGameOpen.status).toBe(404);
    expect(noGameOpen.body.error.code).toBe('GAME_NOT_FOUND');
    expect(await walletBalance(wallet)).toBe(100);

    // баланс 5: списываем 95 напрямую в кошельке
    const seed = await request(wallet.url, 'POST', '/bet', { txId: 'seed:bet', roundId: 'seed', amount: 95 });
    expect(seed.body).toEqual({ balance: 5 });

    const poor = await request(core.url, 'POST', '/api/games/t-flip/rounds', { bet: 6, params: { side: 'heads' } });
    expect(poor.status).toBe(402);
    expect(poor.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(wallet)).toBe(5);
    const afterPoor = await request(core.url, 'POST', '/api/games/t-flip/open');
    expect(afterPoor.body.activeRound).toBeNull();
    expect(afterPoor.body.balance).toBe(5);

    const open = await request(core.url, 'POST', '/api/games/t-steps/rounds', { bet: 2, params: {} });
    expect(open.status).toBe(200);
    expect(open.body.balance).toBe(3);
    const again = await request(core.url, 'POST', '/api/games/t-steps/rounds', { bet: 2, params: {} });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ROUND_ALREADY_OPEN');
    expect(await walletBalance(wallet)).toBe(3);

    const badAction = await request(core.url, 'POST', `/api/rounds/${open.body.roundId}/actions`, { action: 'jump' });
    expect(badAction.status).toBe(400);
    expect(badAction.body.error.code).toBe('INVALID_ACTION');

    const noRound = await request(core.url, 'POST', '/api/rounds/no-such-round/actions', { action: 'next' });
    expect(noRound.status).toBe(404);
    expect(noRound.body.error.code).toBe('ROUND_NOT_FOUND');

    const cashout = await request(core.url, 'POST', `/api/rounds/${open.body.roundId}/actions`, { action: 'cashout' });
    expect(cashout.status).toBe(200);
    expect(cashout.body).toMatchObject({ status: 'closed', payout: 2, balance: 5 });
    const closed = await request(core.url, 'POST', `/api/rounds/${open.body.roundId}/actions`, { action: 'cashout' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('ROUND_CLOSED');
    expect(await walletBalance(wallet)).toBe(5);
  });

  it('PL-23: игры подключаются из games/*/manifest.json, битый манифест пропускается, раздаются UI, оболочка и SDK', async () => {
    const gamesDir = tmpDir('games-');
    const mkGame = (id: string, title: string) => {
      const dir = path.join(gamesDir, id);
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, title, server: 'server/index.js', ui: 'ui/index.html' }));
      fs.writeFileSync(
        path.join(dir, 'server', 'index.js'),
        `export default {
  id: ${JSON.stringify(id)},
  validateParams: (p) => p ?? {},
  start: () => ({ status: 'finished', state: {}, payout: 0 }),
  action: () => { throw Object.assign(new Error('INVALID_ACTION'), { code: 'INVALID_ACTION' }); },
  publicView: () => ({}),
};
`,
      );
      fs.writeFileSync(path.join(dir, 'ui', 'index.html'), `<!doctype html><title>${title}</title><p>UI-MARKER-${id}</p>`);
    };
    // создаём в обратном порядке, чтобы проверить сортировку по id
    mkGame('b-game', 'B Game');
    mkGame('a-game', 'A Game');
    fs.mkdirSync(path.join(gamesDir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(gamesDir, 'broken', 'manifest.json'), '{ this is not json');

    const { core } = await startStack(gamesDir);

    const list = await request(core.url, 'GET', '/api/games');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      { id: 'a-game', title: 'A Game' },
      { id: 'b-game', title: 'B Game' },
    ]);

    const ui = await request(core.url, 'GET', '/games/a-game/');
    expect(ui.status).toBe(200);
    expect(String(ui.headers['content-type'])).toContain('text/html');
    expect(ui.text).toContain('UI-MARKER-a-game');
    const uiB = await request(core.url, 'GET', '/games/b-game/');
    expect(uiB.text).toContain('UI-MARKER-b-game');

    const shell = await request(core.url, 'GET', '/');
    expect(shell.status).toBe(200);
    expect(String(shell.headers['content-type'])).toContain('text/html');
    expect(shell.text.toLowerCase()).toContain('<html');

    const sdk = await request(core.url, 'GET', '/sdk.js');
    expect(sdk.status).toBe(200);
    expect(String(sdk.headers['content-type'])).toMatch(/javascript/);
    expect(sdk.text).toContain('PlatformSDK');

    // подключённая игра работает через API, битая — нет
    const opened = await request(core.url, 'POST', '/api/games/a-game/open');
    expect(opened.status).toBe(200);
    expect(opened.body.gameId).toBe('a-game');
    const broken = await request(core.url, 'POST', '/api/games/broken/open');
    expect(broken.status).toBe(404);
    expect(broken.body.error.code).toBe('GAME_NOT_FOUND');
  });
});
