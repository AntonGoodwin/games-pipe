// @vitest-environment happy-dom
// Интерфейс «Монетки» (games/coin/spec.md, SC-11): ui/index.html с подменённым window.PlatformSDK.
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
  while (!cond()) {
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** «Открывает» страницу: разметка без <script>, затем подмена SDK, затем инлайновые скрипты. */
function loadPage(sdk: unknown): void {
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

describe('Монетка: интерфейс', () => {
  it('SC-11: idle → playing → won, затем отказ платформы показывается без смены баланса', async () => {
    const pending = deferred<any>();
    const sdk = {
      open: vi.fn(async () => ({ gameId: 'coin', balance: 100, limits: { min: 1, max: 10 }, activeRound: null })),
      startRound: vi.fn((_bet: unknown, _params: unknown) => pending.promise),
      action: vi.fn(async () => {
        throw { code: 'ROUND_NOT_FOUND', message: 'нет раунда' };
      }),
    };
    loadPage(sdk);

    // Загрузка: idle, баланс из open(), ставка по умолчанию 1, выбран орёл.
    await waitFor(() => sdk.open.mock.calls.length > 0 && numberIn('balance') === 100, 'баланс 100 после open()');
    expect($('game').getAttribute('data-state')).toBe('idle');
    expect(Number(($('bet-input') as HTMLInputElement).value)).toBe(1);
    expect($('side-heads').getAttribute('aria-pressed')).toBe('true');
    expect($('side-tails').getAttribute('aria-pressed')).not.toBe('true');

    // Выбор решки.
    $('side-tails').click();
    expect($('side-tails').getAttribute('aria-pressed')).toBe('true');
    expect($('side-heads').getAttribute('aria-pressed')).not.toBe('true');

    // Бросок: пока запрос в пути — playing, кнопка заблокирована.
    $('play').click();
    await waitFor(() => sdk.startRound.mock.calls.length === 1, 'вызов startRound');
    expect(sdk.startRound).toHaveBeenCalledWith(1, { side: 'tails' });
    await waitFor(() => $('game').getAttribute('data-state') === 'playing', 'data-state=playing');
    expect(isDisabled($('play'))).toBe(true);
    // Пока ответа нет, исход и выплата не показаны.
    expect($('outcome').textContent ?? '').not.toMatch(/Решка|Орёл/);

    pending.resolve({
      roundId: 'round-1',
      gameId: 'coin',
      bet: 1,
      status: 'closed',
      payout: 1.96,
      balance: 100.96,
      view: { side: 'tails', outcome: 'tails', win: true },
    });
    await waitFor(() => $('game').getAttribute('data-state') === 'won', 'data-state=won');
    expect($('outcome').textContent).toContain('Решка');
    expect(numberIn('payout')).toBe(1.96);
    expect(numberIn('balance')).toBe(100.96);
    await waitFor(() => !isDisabled($('play')), 'кнопка play доступна после броска');

    // Отказ платформы: код в error, баланс прежний, кнопка снова доступна.
    sdk.startRound.mockImplementation(() => Promise.reject({ code: 'INSUFFICIENT_FUNDS', message: 'мало денег' }));
    $('play').click();
    await waitFor(() => sdk.startRound.mock.calls.length === 2, 'второй вызов startRound');
    await waitFor(() => ($('error').textContent ?? '').includes('INSUFFICIENT_FUNDS'), 'код ошибки в error');
    expect(numberIn('balance')).toBe(100.96);
    await waitFor(() => !isDisabled($('play')), 'кнопка play доступна после ошибки');
    expect(sdk.action).not.toHaveBeenCalled();
  });
});
