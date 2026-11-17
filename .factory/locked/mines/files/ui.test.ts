// @vitest-environment happy-dom
// Интерфейс «Мин» (games/mines/spec.md, SC-15): ui/index.html с подменённым window.PlatformSDK.
// Внешний /sdk.js не загружается; инлайновые скрипты страницы выполняются в глобальной области, как обычный <script>.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Строка import.meta.url, а не new URL(): в happy-dom глобальный URL принадлежит окну, а не Node.
const HTML_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/index.html');

/** Ждёт выполнения условия, прокручивая очередь задач. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - started > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const $ = (id: string): HTMLElement => {
  const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`нет элемента data-testid="${id}"`);
  return el;
};

/** Первое число в тексте элемента (запятая как десятичный разделитель допускается). */
const numberIn = (id: string): number => {
  const m = ($(id).textContent ?? '').replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

const isDisabled = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

const state = () => $('game').getAttribute('data-state');
const cellState = (i: number) => $(`cell-${i}`).getAttribute('data-cell-state');

// Слушатели, которые страница повесила на document/window: снимаются перед повторной «загрузкой»,
// чтобы скрипт прошлой загрузки не реагировал на события новой.
const tracked: Array<{ target: EventTarget; type: string; fn: any; opts: any }> = [];
let patched = false;
function trackListeners(): void {
  if (patched) return;
  patched = true;
  const g = globalThis as any;
  for (const target of [g.document, g.window] as EventTarget[]) {
    const orig = target.addEventListener.bind(target);
    (target as any).addEventListener = (type: string, fn: any, opts?: any) => {
      tracked.push({ target, type, fn, opts });
      return orig(type, fn, opts);
    };
  }
}
function dropListeners(): void {
  for (const l of tracked.splice(0)) l.target.removeEventListener(l.type, l.fn, l.opts);
}

/** «Открывает» страницу: разметка без <script>, затем подмена SDK, затем инлайновые скрипты. */
function loadPage(sdk: unknown): void {
  trackListeners();
  dropListeners();
  const html = readFileSync(HTML_PATH, 'utf8');
  const scripts: string[] = [];
  const stripped = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs: string, code: string) => {
    if (!/\bsrc\s*=/.test(attrs) && code.trim()) scripts.push(code);
    return '';
  });
  const doc = new DOMParser().parseFromString(stripped, 'text/html');
  for (const a of Array.from(doc.documentElement.attributes)) document.documentElement.setAttribute(a.name, a.value);
  for (const a of Array.from(doc.body.attributes)) document.body.setAttribute(a.name, a.value);
  document.head.innerHTML = doc.head.innerHTML;
  document.body.innerHTML = doc.body.innerHTML;

  const g = globalThis as any;
  g.window.PlatformSDK = sdk;
  g.PlatformSDK = sdk;
  const indirectEval: (code: string) => unknown = g.eval;
  for (const code of scripts) indirectEval(code);
  document.dispatchEvent(new g.Event('DOMContentLoaded'));
  g.window.dispatchEvent(new g.Event('load'));
}

const OPEN_VIEW_0 = { mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 };
const OPEN_VIEW_1 = { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 };

describe('Мины: интерфейс', () => {
  it('SC-15: idle → playing → открытие клетки → cashout → won, мины показаны', async () => {
    const sdk = {
      open: vi.fn(async () => ({ gameId: 'mines', balance: 100, limits: { min: 1, max: 10 }, activeRound: null })),
      startRound: vi.fn(async (_bet: unknown, _params: unknown) => ({
        roundId: 'r1',
        gameId: 'mines',
        status: 'open',
        bet: 2,
        payout: null,
        balance: 98,
        view: OPEN_VIEW_0,
      })),
      action: vi.fn(async (a: any) => {
        if (a && a.type === 'reveal' && a.cell === 0) {
          return { roundId: 'r1', gameId: 'mines', bet: 2, status: 'open', balance: 98, payout: null, view: OPEN_VIEW_1 };
        }
        if (a && a.type === 'cashout') {
          return {
            roundId: 'r1',
            gameId: 'mines',
            bet: 2,
            status: 'closed',
            balance: 100.22,
            payout: 2.22,
            view: {
              mineCount: 3,
              revealed: [0],
              multiplier: 1.11,
              nextMultiplier: null,
              mines: [7, 12, 19],
              hit: null,
              outcome: 'cashout',
            },
          };
        }
        throw { code: 'INVALID_ACTION', message: 'неожиданный ход в тесте' };
      }),
    };
    loadPage(sdk);

    // Загрузка: idle, баланс из open(), клетки и cashout заблокированы, ставка по умолчанию 1.
    await waitFor(() => sdk.open.mock.calls.length > 0 && numberIn('balance') === 100, 'баланс 100 после open()');
    expect(state()).toBe('idle');
    expect(Number(($('bet-input') as HTMLInputElement).value)).toBe(1);
    for (let i = 0; i < 25; i++) expect(isDisabled($(`cell-${i}`)), `cell-${i} в idle`).toBe(true);
    expect(isDisabled($('cashout'))).toBe(true);

    // Ставка 2 и новая игра.
    const input = $('bet-input') as HTMLInputElement;
    input.value = '2';
    input.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
    input.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true }));
    $('play').click();
    await waitFor(() => sdk.startRound.mock.calls.length === 1, 'вызов startRound');
    expect(sdk.startRound).toHaveBeenCalledWith(2, {});
    await waitFor(() => state() === 'playing' && numberIn('balance') === 98, 'playing и баланс 98');
    expect(isDisabled($('play'))).toBe(true);
    expect(isDisabled($('cashout'))).toBe(true);
    for (let i = 0; i < 25; i++) {
      expect(cellState(i), `cell-${i} скрыта`).toBe('hidden');
      expect(isDisabled($(`cell-${i}`)), `cell-${i} доступна в playing`).toBe(false);
    }
    expect(sdk.action).not.toHaveBeenCalled();

    // Открытие клетки 0.
    $('cell-0').click();
    await waitFor(() => sdk.action.mock.calls.length === 1, 'вызов action');
    expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 0 });
    await waitFor(() => cellState(0) === 'safe', 'cell-0 safe');
    await waitFor(() => numberIn('multiplier') === 1.11, 'множитель 1.11');
    expect(numberIn('next-multiplier')).toBe(1.27);
    await waitFor(() => !isDisabled($('cashout')), 'cashout доступна при k = 1');
    expect(state()).toBe('playing');
    expect(isDisabled($('cell-0'))).toBe(true);
    expect(isDisabled($('play'))).toBe(true);
    for (let i = 1; i < 25; i++) expect(cellState(i), `cell-${i} всё ещё скрыта`).toBe('hidden');
    expect(numberIn('balance')).toBe(98);

    // Cashout.
    $('cashout').click();
    await waitFor(() => sdk.action.mock.calls.length === 2, 'вызов action cashout');
    expect(sdk.action).toHaveBeenLastCalledWith({ type: 'cashout' });
    await waitFor(() => state() === 'won', 'data-state=won');
    expect(numberIn('payout')).toBe(2.22);
    expect(numberIn('balance')).toBe(100.22);
    for (const m of [7, 12, 19]) expect(cellState(m), `cell-${m} — мина`).toBe('mine');
    expect(cellState(0)).toBe('safe');
    for (const i of [1, 6, 8, 13, 18, 20, 24]) expect(cellState(i), `cell-${i} не мина`).not.toBe('mine');
  });

  it('SC-15: обновление страницы восстанавливает открытый раунд, ошибка платформы показывается кодом', async () => {
    const sdk = {
      open: vi.fn(async () => ({
        gameId: 'mines',
        balance: 98,
        limits: { min: 1, max: 10 },
        activeRound: {
          roundId: 'r1',
          gameId: 'mines',
          bet: 2,
          status: 'open',
          payout: null,
          balance: 98,
          view: { mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 },
        },
      })),
      startRound: vi.fn(async () => {
        throw { code: 'ROUND_ALREADY_OPEN', message: 'раунд уже открыт' };
      }),
      action: vi.fn(async () => {
        throw { code: 'ROUND_CLOSED', message: 'раунд закрыт' };
      }),
    };
    loadPage(sdk);

    await waitFor(() => sdk.open.mock.calls.length > 0 && state() === 'playing', 'data-state=playing после open()');
    await waitFor(() => cellState(0) === 'safe' && cellState(6) === 'safe', 'cell-0 и cell-6 safe');
    expect(numberIn('balance')).toBe(98);
    expect(isDisabled($('play'))).toBe(true);
    expect(isDisabled($('cell-0'))).toBe(true);
    expect(isDisabled($('cell-6'))).toBe(true);
    expect(isDisabled($('cell-1'))).toBe(false);
    expect(isDisabled($('cashout'))).toBe(false);
    for (const i of [1, 7, 12, 19, 24]) expect(cellState(i), `cell-${i} скрыта`).toBe('hidden');
    expect(sdk.startRound).not.toHaveBeenCalled();

    $('cell-1').click();
    await waitFor(() => sdk.action.mock.calls.length === 1, 'вызов action');
    expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 1 });
    await waitFor(() => ($('error').textContent ?? '').includes('ROUND_CLOSED'), 'код ошибки в error');
    expect(numberIn('balance')).toBe(98);
    expect(cellState(1)).not.toBe('safe');
    expect(cellState(1)).not.toBe('mine');
  });
});
