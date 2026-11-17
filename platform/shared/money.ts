/** Деньги и лимиты ставки. Суммы — числа в долларах, округлённые до центов. */

/** Лимиты ставки платформы, в долларах. */
export const LIMITS: Readonly<{ min: number; max: number }> = Object.freeze({ min: 1, max: 10 });

/**
 * Округляет сумму до центов, половина цента — вверх (1.955 → 1.96, 1.006 → 1.01).
 * Округление идёт по десятичной записи числа, поэтому не страдает от двоичной погрешности
 * (`Math.round(1.955 * 100)` дал бы 195).
 */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const abs = Math.abs(x);
  const s = String(abs);
  const r = s.includes('e') ? Math.round(abs * 100) / 100 : Number(`${Math.round(Number(`${s}e2`))}e-2`);
  if (r === 0) return 0;
  return x < 0 ? -r : r;
}
