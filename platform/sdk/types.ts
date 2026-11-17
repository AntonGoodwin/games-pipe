/**
 * Контракт между платформой и играми. Имена фиксированы: на них опираются все игры.
 * Игра импортирует из платформы только `platform/sdk/*`.
 */

/**
 * Генератор случайных чисел. `next()` возвращает число в [0, 1). Передаётся игре платформой.
 * На каждый вызов `start`/`action` игра получает отдельный замороженный объект; сохранять его между вызовами нельзя.
 */
export interface Rng {
  next(): number;
}

/**
 * Результат шага игры.
 * - `continue` — раунд продолжается, нужен следующий ход;
 * - `finished` — раунд окончен, `payout` — полная сумма к зачислению (0 при проигрыше).
 */
export type Step<S> =
  | { status: 'continue'; state: S }
  | { status: 'finished'; state: S; payout: number };

/**
 * Серверный модуль игры. Платформа вызывает его внутри раунда: списывает ставку до `start`
 * и зачисляет `payout` после шага со статусом `finished`. Игра не знает о кошельке и балансе.
 *
 * Состояние `S` и параметры `P` должны сериализоваться в JSON: платформа хранит их на диске.
 *
 * Порядок внутри `start`/`action`: сначала проверить `action` (бросить `INVALID_ACTION`) и всё, что может упасть,
 * и только потом обращаться к `rng`. После первого `rng.next()` исключения запрещены, а шаг должен быть корректным:
 * иначе повтор хода давал бы новый исход. Если игра всё же упала после `rng.next()`, платформа не возвращает
 * ставку и не даёт повторить ход: раунд блокируется для ручного разбора, клиент получает `INTERNAL_ERROR`.
 * Если игра упала в `start` до обращения к `rng`, раунд аннулируется, ставка возвращается.
 *
 * Серверный модуль работает в процессе ядра. Кроме `platform/sdk/*`, ему запрещены `process`, `globalThis`,
 * `require`, динамический `import()`, `fetch`, `eval`/`Function` и модули `node:*`: игра — чистая функция от
 * `ctx` и состояния.
 */
export interface GameModule<P = any, S = any, A = any> {
  /** Идентификатор игры, совпадает с `id` в `manifest.json`. */
  id: string;
  /** Проверяет и нормализует параметры раунда. Бросает `GameError('INVALID_PARAMS')`. */
  validateParams(params: unknown): P;
  /** Начинает раунд (ставка уже списана). */
  start(ctx: { bet: number; params: P; rng: Rng }): Step<S>;
  /** Ход игрока. Бросает `GameError('INVALID_ACTION')` на недопустимое действие. */
  action(ctx: { bet: number; params: P; state: S; action: A; rng: Rng }): Step<S>;
  /** Что можно показать клиенту. До конца раунда (`finished = false`) скрытое не раскрывается. */
  publicView(state: S, finished: boolean): unknown;
}

/** Ошибка игры с кодом (`INVALID_PARAMS`, `INVALID_ACTION`). Платформа передаёт код клиенту. */
export class GameError extends Error {
  /** Код ошибки. */
  code: string;

  /**
   * @param code код ошибки, например `INVALID_PARAMS`
   * @param message необязательное пояснение для игрока
   */
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'GameError';
    this.code = code;
  }
}
