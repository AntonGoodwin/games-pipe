// @vitest-environment happy-dom
// Клиентский SDK /sdk.js → window.PlatformSDK (platform/spec.md, PL-24).
// SDK загружается с запущенного ядра и выполняется на странице /games/t-flip/.
// fetch на странице подменён записывающей обёрткой, которая выполняет запросы к настоящему ядру через node:http.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTmp, closeAll, FIXTURES_DIR, loadCore, loadWallet, request, tmpDir, type RunningServer } from './helpers.ts';

interface SdkCall {
  method: string;
  url: string;
  body: unknown;
}

describe('клиентский SDK', () => {
  const servers: RunningServer[] = [];
  const calls: SdkCall[] = [];
  let core: RunningServer;
  let wallet: RunningServer;
  let sdk: any;
  let sdkSource = '';

  /** «Открывает страницу» игры: меняет адрес и заново выполняет /sdk.js. */
  async function loadSdkAt(pagePath: string): Promise<any> {
    const g = globalThis as any;
    g.happyDOM.setURL(new URL(pagePath, core.url).href);
    expect(g.location.pathname).toBe(pagePath);
    g.window.PlatformSDK = undefined;
    // косвенный eval: скрипт выполняется в глобальной области страницы, как обычный <script>
    const indirectEval: (code: string) => unknown = g.eval;
    indirectEval(sdkSource);
    expect(g.window.PlatformSDK).toBeTruthy();
    return g.window.PlatformSDK;
  }

  beforeAll(async () => {
    const dataDir = tmpDir('sdk-');
    const { startWallet } = await loadWallet();
    const { startCore } = await loadCore();
    wallet = await startWallet({ port: 0, dataDir });
    servers.push(wallet);
    core = await startCore({ port: 0, dataDir, gamesDir: FIXTURES_DIR, walletUrl: wallet.url });
    servers.push(core);

    const g = globalThis as any;

    const recordingFetch = async (input: any, init: any = {}): Promise<any> => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, g.location.href);
      const method = String(init.method ?? (typeof input === 'object' && input.method) ?? 'GET').toUpperCase();
      let body: unknown = undefined;
      if (typeof init.body === 'string' && init.body.length) body = JSON.parse(init.body);
      calls.push({ method, url: url.pathname, body });
      const res = await request(core.url, method, url.pathname + url.search, body);
      return new g.Response(res.text, { status: res.status, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') } });
    };
    g.fetch = recordingFetch;

    const script = await request(core.url, 'GET', '/sdk.js');
    expect(script.status).toBe(200);
    sdkSource = script.text;
    sdk = await loadSdkAt('/games/t-flip/');
  });

  afterAll(async () => {
    await closeAll(servers.reverse());
    cleanupTmp();
  });

  const rejection = async (p: Promise<unknown>): Promise<any> => {
    try {
      const v = await p;
      throw new Error(`ожидался отказ, а Promise выполнился: ${JSON.stringify(v)}`);
    } catch (e) {
      return e;
    }
  };

  it('PL-24: open() обращается к POST /api/games/t-flip/open и возвращает лимиты', async () => {
    const before = calls.length;
    const res = await sdk.open();
    expect(calls.slice(before)).toEqual([expect.objectContaining({ method: 'POST', url: '/api/games/t-flip/open' })]);
    expect(res).toEqual({ gameId: 't-flip', limits: { min: 1, max: 10 }, balance: 100, activeRound: null });
  });

  it('PL-24: startRound(20) отклоняется объектом с code BET_OUT_OF_LIMITS, баланс не меняется', async () => {
    const before = calls.length;
    const err = await rejection(sdk.startRound(20, { side: 'heads' }));
    expect(err.code).toBe('BET_OUT_OF_LIMITS');
    const sent = calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ method: 'POST', url: '/api/games/t-flip/rounds', body: { bet: 20, params: { side: 'heads' } } });
    const bal = await request(wallet.url, 'GET', '/balance');
    expect(bal.body.balance).toBe(100);
  });

  it('PL-24: action() без открытого раунда отклоняется ROUND_NOT_FOUND без запроса к серверу', async () => {
    const before = calls.length;
    const err = await rejection(sdk.action('next'));
    expect(err.code).toBe('ROUND_NOT_FOUND');
    expect(calls.length).toBe(before);
  });

  it('PL-24: startRound запоминает roundId, action() отправляет ход в этот раунд (страница t-steps)', async () => {
    const steps = await loadSdkAt('/games/t-steps/');
    const opened = await steps.open();
    expect(opened.gameId).toBe('t-steps');
    expect(opened.activeRound).toBeNull();
    const r = await steps.startRound(2, {});
    expect(r).toMatchObject({ gameId: 't-steps', bet: 2, status: 'open', view: { step: 0 }, payout: null });
    const before = calls.length;
    const next = await steps.action('next');
    expect(calls.slice(before)).toEqual([{ method: 'POST', url: `/api/rounds/${r.roundId}/actions`, body: { action: 'next' } }]);
    expect(next).toMatchObject({ roundId: r.roundId, status: 'open', view: { step: 1 } });
  });

  it('PL-24: после перезагрузки страницы SDK берёт roundId из activeRound в open()', async () => {
    const reloaded = await loadSdkAt('/games/t-steps/');
    const opened = await reloaded.open();
    expect(opened.activeRound).toMatchObject({ status: 'open', view: { step: 1 } });
    const roundId: string = opened.activeRound.roundId;
    const before = calls.length;
    const end = await reloaded.action('cashout');
    expect(calls.slice(before)).toEqual([{ method: 'POST', url: `/api/rounds/${roundId}/actions`, body: { action: 'cashout' } }]);
    // 2 × (1 + 1/3) = 2.666… → 2.67
    expect(end).toMatchObject({ roundId, status: 'closed', payout: 2.67 });
  });
});
