// @vitest-environment happy-dom
// Интерфейс «Мин» (games/mines/spec.md, SC-15, SC-19, SC-20): ui/index.html с подменённым window.PlatformSDK.
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

/**
 * Прокручивает только очередь микрозадач (разрешение промисов), без таймеров и кадров анимации.
 * Подменённый SDK отвечает разрешённым промисом, поэтому всё, что интерфейс делает «сразу по ответу», успевает здесь.
 */
async function flushMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
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

/** Текст элемента без лишних пробелов. */
const textOf = (id: string): string => ($(id).textContent ?? '').replace(/\s+/g, ' ').trim();

const isDisabled = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

const state = () => $('game').getAttribute('data-state');
const cellState = (i: number) => $(`cell-${i}`).getAttribute('data-cell-state');
const minesSelect = () => $('mines-input') as HTMLSelectElement;

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

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
  el.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true }));
}

/** Стили страницы: содержимое всех <style> и атрибутов style из ui/index.html. */
function pageStyles(): string {
  const html = readFileSync(HTML_PATH, 'utf8');
  const parts: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(m[1] ?? '');
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) parts.push(m[1] ?? '');
  for (const m of html.matchAll(/\sstyle\s*=\s*'([^']*)'/gi)) parts.push(m[1] ?? '');
  return parts.join('\n');
}

/** Время CSS в миллисекундах. */
const toMs = (num: string, unit: string): number => (unit.toLowerCase() === 's' ? Number(num) * 1000 : Number(num));

/** Все длительности animation/transition (лонгхенды целиком, у шортхендов — первое время в каждом элементе списка). */
function durationsMs(rawCss: string): number[] {
  // Подставляем значения CSS-переменных (--flip: 250ms → var(--flip)), чтобы длительность через var() тоже проверялась.
  const vars = new Map<string, string>();
  for (const m of rawCss.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) vars.set(m[1]!, m[2]!.trim());
  const css = rawCss.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (_m, name: string, fallback?: string) =>
    vars.get(name) ?? (fallback ?? '').trim(),
  );
  const out: number[] = [];
  const re = /(?:^|[;{\s])(animation|transition)(-duration)?\s*:\s*([^;}]+)/gi;
  for (const m of css.matchAll(re)) {
    const longhand = Boolean(m[2]);
    for (const item of (m[3] ?? '').split(',')) {
      const times = [...item.matchAll(/(-?\d*\.?\d+)(ms|s)\b/gi)].map((t) => toMs(t[1]!, t[2]!));
      if (times.length === 0) continue;
      if (longhand) out.push(...times);
      else out.push(times[0]!);
    }
  }
  return out;
}

const OPEN_VIEW_0 = { mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 };
const OPEN_VIEW_1 = { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 };

const activeRound = (view: unknown, bet = 2) => ({
  roundId: 'r1',
  gameId: 'mines',
  bet,
  status: 'open',
  payout: null,
  balance: 98,
  view,
});

describe('Мины: интерфейс', () => {
  it('SC-15: idle → playing → открытие клетки → cashout → won, сумма на кнопке, мины показаны', async () => {
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

    // Загрузка: idle, баланс из open(), клетки и cashout заблокированы, ставка 1, мин 3 из вариантов 1…24.
    await waitFor(() => sdk.open.mock.calls.length > 0 && numberIn('balance') === 100, 'баланс 100 после open()');
    expect(state()).toBe('idle');
    expect(Number(($('bet-input') as HTMLInputElement).value)).toBe(1);
    expect(minesSelect().tagName).toBe('SELECT');
    expect(minesSelect().value).toBe('3');
    expect(Array.from(minesSelect().options).map((o) => o.value)).toEqual(Array.from({ length: 24 }, (_, i) => String(i + 1)));
    expect(isDisabled(minesSelect())).toBe(false);
    for (let i = 0; i < 25; i++) expect(isDisabled($(`cell-${i}`)), `cell-${i} в idle`).toBe(true);
    expect(isDisabled($('cashout'))).toBe(true);
    expect(textOf('cashout')).toBe('Забрать');

    // Ставка 2 и новая игра.
    setValue($('bet-input') as HTMLInputElement, '2');
    $('play').click();
    await waitFor(() => sdk.startRound.mock.calls.length === 1, 'вызов startRound');
    expect(sdk.startRound).toHaveBeenCalledWith(2, { mines: 3 });
    await waitFor(() => state() === 'playing' && numberIn('balance') === 98, 'playing и баланс 98');
    expect(isDisabled($('play'))).toBe(true);
    expect(isDisabled($('cashout'))).toBe(true);
    expect(textOf('cashout')).toBe('Забрать');
    expect(isDisabled(minesSelect())).toBe(true);
    for (let i = 0; i < 25; i++) {
      expect(cellState(i), `cell-${i} скрыта`).toBe('hidden');
      expect(isDisabled($(`cell-${i}`)), `cell-${i} доступна в playing`).toBe(false);
    }
    expect(sdk.action).not.toHaveBeenCalled();

    // Открытие клетки 0: состояние клетки — сразу по ответу, без таймеров.
    $('cell-0').click();
    await flushMicrotasks();
    expect(sdk.action).toHaveBeenCalledTimes(1);
    expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 0 });
    expect(cellState(0), 'cell-0 safe без продвижения таймеров').toBe('safe');
    expect(numberIn('multiplier')).toBe(1.11);
    expect(numberIn('next-multiplier')).toBe(1.27);
    expect(isDisabled($('cashout'))).toBe(false);
    expect(textOf('cashout')).toBe('Забрать $2.22');
    expect(state()).toBe('playing');
    expect(isDisabled($('cell-0'))).toBe(true);
    expect(isDisabled($('play'))).toBe(true);
    expect(isDisabled(minesSelect())).toBe(true);
    for (let i = 1; i < 25; i++) expect(cellState(i), `cell-${i} всё ещё скрыта`).toBe('hidden');
    expect(numberIn('balance')).toBe(98);

    // Cashout: все мины показаны, клетки подрыва нет.
    $('cashout').click();
    await waitFor(() => sdk.action.mock.calls.length === 2, 'вызов action cashout');
    expect(sdk.action).toHaveBeenLastCalledWith({ type: 'cashout' });
    await waitFor(() => state() === 'won', 'data-state=won');
    expect(numberIn('payout')).toBe(2.22);
    expect(numberIn('balance')).toBe(100.22);
    for (const m of [7, 12, 19]) expect(cellState(m), `cell-${m} — мина`).toBe('mine');
    expect(cellState(0)).toBe('safe');
    expect(cellState(1)).toBe('hidden');
    for (let i = 0; i < 25; i++) expect(cellState(i), `cell-${i} не hit`).not.toBe('hit');
    for (const i of [1, 6, 8, 13, 18, 20, 24]) expect(cellState(i), `cell-${i} скрыта`).toBe('hidden');
    expect(textOf('cashout')).toBe('Забрать');
    expect(isDisabled(minesSelect())).toBe(false);
    expect(minesSelect().value).toBe('3');
  });

  it('SC-15: обновление страницы восстанавливает раунд, сумма на кнопке от ставки раунда, ошибка показывается кодом', async () => {
    const sdk = {
      open: vi.fn(async () => ({
        gameId: 'mines',
        balance: 98,
        limits: { min: 1, max: 10 },
        activeRound: activeRound({ mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 }),
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
    // Ставка раунда 2, а в поле ввода по умолчанию 1: 2 × 1.27 = 2.54.
    expect(textOf('cashout')).toBe('Забрать $2.54');
    expect(minesSelect().value).toBe('3');
    expect(isDisabled(minesSelect())).toBe(true);
    for (const i of [1, 7, 12, 19, 24]) expect(cellState(i), `cell-${i} скрыта`).toBe('hidden');
    expect(sdk.startRound).not.toHaveBeenCalled();

    $('cell-1').click();
    await waitFor(() => sdk.action.mock.calls.length === 1, 'вызов action');
    expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 1 });
    await waitFor(() => ($('error').textContent ?? '').includes('ROUND_CLOSED'), 'код ошибки в error');
    await waitFor(() => sdk.open.mock.calls.length >= 2, 'пересинхронизация через open()');
    await flushMicrotasks();
    expect(numberIn('balance')).toBe(98);
    expect(cellState(1)).toBe('hidden');
  });

  it('SC-15: при восстановлении раунда mines-input получает view.mineCount, сумма — bet × multiplier с округлением', async () => {
    const sdk = {
      open: vi.fn(async () => ({
        gameId: 'mines',
        balance: 96.67,
        limits: { min: 1, max: 10 },
        activeRound: activeRound({ mineCount: 5, revealed: [0, 1], multiplier: 1.55, nextMultiplier: 1.98 }, 3.33),
      })),
      startRound: vi.fn(),
      action: vi.fn(),
    };
    loadPage(sdk);
    await waitFor(() => state() === 'playing' && cellState(1) === 'safe', 'раунд восстановлен');
    expect(minesSelect().value).toBe('5');
    expect(isDisabled(minesSelect())).toBe(true);
    // 3.33 × 1.55 = 5.1615 → 5.16
    expect(textOf('cashout')).toBe('Забрать $5.16');
  });

  it('SC-19: выбор 5 мин, клетка подрыва — hit, остальные мины показаны, стили и анимация ≤ 300 мс', async () => {
    const sdk = {
      open: vi.fn(async () => ({ gameId: 'mines', balance: 100, limits: { min: 1, max: 10 }, activeRound: null })),
      startRound: vi.fn(async (_bet: unknown, _params: unknown) => ({
        roundId: 'r2',
        gameId: 'mines',
        status: 'open',
        bet: 1,
        payout: null,
        balance: 99,
        view: { mineCount: 5, revealed: [], multiplier: 1, nextMultiplier: 1.23 },
      })),
      action: vi.fn(async (a: any) => {
        if (a && a.type === 'reveal' && a.cell === 0) {
          return {
            roundId: 'r2',
            gameId: 'mines',
            bet: 1,
            status: 'open',
            balance: 99,
            payout: null,
            view: { mineCount: 5, revealed: [0], multiplier: 1.23, nextMultiplier: 1.55 },
          };
        }
        if (a && a.type === 'reveal' && a.cell === 3) {
          return {
            roundId: 'r2',
            gameId: 'mines',
            bet: 1,
            status: 'closed',
            balance: 99,
            payout: 0,
            view: {
              mineCount: 5,
              revealed: [0],
              multiplier: 1.23,
              nextMultiplier: null,
              mines: [3, 4, 7, 12, 19],
              hit: 3,
              outcome: 'mine',
            },
          };
        }
        throw { code: 'INVALID_ACTION', message: 'неожиданный ход в тесте' };
      }),
    };
    loadPage(sdk);
    await waitFor(() => sdk.open.mock.calls.length > 0 && numberIn('balance') === 100, 'баланс 100 после open()');

    setValue(minesSelect(), '5');
    setValue($('bet-input') as HTMLInputElement, '1');
    $('play').click();
    await waitFor(() => sdk.startRound.mock.calls.length === 1, 'вызов startRound');
    expect(sdk.startRound).toHaveBeenCalledWith(1, { mines: 5 });
    expect(typeof (sdk.startRound.mock.calls[0]![1] as any).mines).toBe('number');
    await waitFor(() => state() === 'playing', 'data-state=playing');
    expect(isDisabled(minesSelect())).toBe(true);
    expect(textOf('cashout')).toBe('Забрать');

    $('cell-0').click();
    await flushMicrotasks();
    expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 0 });
    expect(cellState(0)).toBe('safe');
    expect(textOf('cashout')).toBe('Забрать $1.23');
    expect(numberIn('multiplier')).toBe(1.23);
    expect(numberIn('next-multiplier')).toBe(1.55);

    // Следующий клик не ждёт окончания анимации.
    $('cell-3').click();
    await flushMicrotasks();
    expect(sdk.action).toHaveBeenCalledTimes(2);
    expect(sdk.action).toHaveBeenLastCalledWith({ type: 'reveal', cell: 3 });
    expect(state()).toBe('lost');
    expect(cellState(3)).toBe('hit');
    for (const m of [4, 7, 12, 19]) expect(cellState(m), `cell-${m} — мина`).toBe('mine');
    expect(cellState(0)).toBe('safe');
    expect(cellState(1)).toBe('hidden');
    const hits = Array.from({ length: 25 }, (_, i) => i).filter((i) => cellState(i) === 'hit');
    expect(hits).toEqual([3]);
    const mines = Array.from({ length: 25 }, (_, i) => i).filter((i) => cellState(i) === 'mine');
    expect(mines).toEqual([4, 7, 12, 19]);
    expect(isDisabled($('cashout'))).toBe(true);
    expect(textOf('cashout')).toBe('Забрать');
    expect(isDisabled(minesSelect())).toBe(false);
    expect(minesSelect().value).toBe('5');
    expect(numberIn('balance')).toBe(99);

    // Стили: правила для safe и hit, анимация переворота rotateY, длительности не больше 300 мс.
    const css = pageStyles();
    expect(css).toMatch(/\[data-cell-state\s*=\s*["']?safe["']?\s*\]/);
    expect(css).toMatch(/\[data-cell-state\s*=\s*["']?hit["']?\s*\]/);
    expect(css).toMatch(/rotateY\s*\(/);
    const durations = durationsMs(css);
    expect(durations.some((d) => d > 0), 'есть анимация или переход с ненулевой длительностью').toBe(true);
    for (const d of durations) expect(d, 'длительность анимации/перехода, мс').toBeLessThanOrEqual(300);
  });

  describe('SC-20: пересинхронизация после ошибки хода', () => {
    const ROUND_VIEW = { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 };

    /** SDK: первый open() — раунд с открытой клеткой 0, повторный — resync; action отклоняется с code. */
    function sdkWith(code: string, resync: unknown) {
      let opens = 0;
      return {
        open: vi.fn(async () => {
          opens += 1;
          if (opens === 1) {
            return { gameId: 'mines', balance: 98, limits: { min: 1, max: 10 }, activeRound: activeRound(ROUND_VIEW) };
          }
          return resync;
        }),
        startRound: vi.fn(),
        action: vi.fn(async () => {
          throw { code, message: code };
        }),
      };
    }

    async function loadPlaying(sdk: ReturnType<typeof sdkWith>): Promise<void> {
      loadPage(sdk);
      await waitFor(() => state() === 'playing' && cellState(0) === 'safe', 'раунд восстановлен');
      expect(sdk.open).toHaveBeenCalledTimes(1);
    }

    it('SC-20: ROUND_CLOSED — повторный open(), раунда нет → idle, баланс обновлён, все клетки hidden', async () => {
      const sdk = sdkWith('ROUND_CLOSED', { gameId: 'mines', balance: 100.22, limits: { min: 1, max: 10 }, activeRound: null });
      await loadPlaying(sdk);
      const href = window.location.href;
      const reload = vi.fn();
      let reloadSpied = false;
      try {
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true, writable: true });
        reloadSpied = (window.location as any).reload === reload;
      } catch {
        reloadSpied = false;
      }

      $('cell-6').click();
      expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 6 });
      await waitFor(() => sdk.open.mock.calls.length === 2, 'повторный open()');
      await waitFor(() => state() === 'idle' && numberIn('balance') === 100.22, 'idle и баланс 100.22');
      expect(($('error').textContent ?? '')).toContain('ROUND_CLOSED');
      for (let i = 0; i < 25; i++) expect(cellState(i), `cell-${i} hidden`).toBe('hidden');
      expect(textOf('cashout')).toBe('Забрать');
      expect(isDisabled($('cashout'))).toBe(true);
      expect(isDisabled(minesSelect())).toBe(false);
      // Страница не перезагружалась: reload не вызывался, адрес тот же, состояние пришло из повторного open().
      if (reloadSpied) expect(reload).not.toHaveBeenCalled();
      expect(window.location.href).toBe(href);
      expect(sdk.open).toHaveBeenCalledTimes(2);
    });

    it('SC-20: WALLET_UNAVAILABLE — повторный open() возвращает раунд, его view применяется', async () => {
      const sdk = sdkWith('WALLET_UNAVAILABLE', {
        gameId: 'mines',
        balance: 98,
        limits: { min: 1, max: 10 },
        activeRound: activeRound({ mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 }),
      });
      await loadPlaying(sdk);

      $('cell-6').click();
      await waitFor(() => sdk.open.mock.calls.length === 2, 'повторный open()');
      await waitFor(() => cellState(6) === 'safe', 'cell-6 safe из activeRound');
      expect(($('error').textContent ?? '')).toContain('WALLET_UNAVAILABLE');
      expect(state()).toBe('playing');
      expect(cellState(0)).toBe('safe');
      expect(textOf('cashout')).toBe('Забрать $2.54');
      expect(numberIn('multiplier')).toBe(1.27);
      expect(numberIn('balance')).toBe(98);
      for (const i of [1, 7, 12, 19]) expect(cellState(i), `cell-${i} hidden`).toBe('hidden');
    });

    it('SC-20: ROUND_NOT_FOUND — повторный open() без раунда → idle', async () => {
      const sdk = sdkWith('ROUND_NOT_FOUND', { gameId: 'mines', balance: 98, limits: { min: 1, max: 10 }, activeRound: null });
      await loadPlaying(sdk);

      $('cell-6').click();
      await waitFor(() => sdk.open.mock.calls.length === 2, 'повторный open()');
      await waitFor(() => state() === 'idle', 'data-state=idle');
      expect(($('error').textContent ?? '')).toContain('ROUND_NOT_FOUND');
      for (let i = 0; i < 25; i++) expect(cellState(i), `cell-${i} hidden`).toBe('hidden');
    });

    it('SC-20: INVALID_ACTION — только код в error, open() повторно не вызывается, состояние не меняется', async () => {
      const sdk = sdkWith('INVALID_ACTION', { gameId: 'mines', balance: 0, limits: { min: 1, max: 10 }, activeRound: null });
      await loadPlaying(sdk);

      $('cell-6').click();
      expect(sdk.action).toHaveBeenCalledWith({ type: 'reveal', cell: 6 });
      await waitFor(() => ($('error').textContent ?? '').includes('INVALID_ACTION'), 'код ошибки в error');
      // Даём время на возможный (ошибочный) повторный open().
      await new Promise((r) => setTimeout(r, 30));
      await flushMicrotasks();
      expect(sdk.open).toHaveBeenCalledTimes(1);
      expect(state()).toBe('playing');
      expect(cellState(6)).toBe('hidden');
      expect(cellState(0)).toBe('safe');
      expect(numberIn('balance')).toBe(98);
      expect(textOf('cashout')).toBe('Забрать $2.22');
    });
  });
});
