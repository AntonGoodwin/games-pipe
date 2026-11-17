/**
 * Движок раундов — общий для HTTP-ядра и testkit.
 *
 * Операции движка написаны как генераторы: каждое обращение к кошельку — это `yield` операции
 * (`WalletOp`), в ответ генератор получает баланс после неё. Ошибку кошелька драйвер бросает
 * внутрь генератора. Testkit выполняет генератор синхронно с кошельком в памяти (`runSync`),
 * ядро — асинхронно с HTTP-кошельком (`runAsync`). Логика раунда при этом одна.
 *
 * Сохранность денег: раунд записывается в хранилище **до** списания ставки (признак `pendingBet`)
 * и до выплаты (поле `pendingPayout`). Если ответ кошелька не дошёл, следующая операция с этой игрой
 * досылает ту же транзакцию с тем же `txId` — кошелёк идемпотентен, поэтому повтор безопасен.
 */
import type { GameModule, Rng } from '../sdk/types.ts';
import { PlatformError, messageOf } from '../shared/errors.ts';
import { LIMITS, round2 } from '../shared/money.ts';

/** Операция с кошельком, которую запрашивает движок. Результат — баланс после операции. */
export type WalletOp =
  | { kind: 'balance' }
  | { kind: 'bet' | 'payout'; txId: string; roundId: string; amount: number };

/** Генератор операции движка: отдаёт `WalletOp`, получает баланс, возвращает `T`. */
export type EngineGen<T> = Generator<WalletOp, T, number>;

/** Раунд в хранилище. Параметры и состояние игры хранятся в виде JSON. */
export interface RoundRecord {
  roundId: string;
  gameId: string;
  bet: number;
  params: unknown;
  state: unknown;
  status: 'open' | 'closed';
  /** Выплата закрытого раунда, `null` пока раунд открыт. */
  payout: number | null;
  /** Списание ставки отправлено, но кошелёк его ещё не подтвердил. */
  pendingBet?: boolean;
  /** Игра завершила раунд, но выплата ещё не подтверждена кошельком. */
  pendingPayout: number | null;
  /** Раунд аннулирован (ошибка игры на старте или недосланная ставка): ставка возвращена, `view` = `null`. */
  voided: boolean;
  /**
   * Игра упала после того, как взяла число из rng. Раунд остаётся открытым для ручного разбора:
   * ходы отклоняются с `INTERNAL_ERROR`, автоповтора и возврата ставки нет, `view` = `null`.
   */
  broken?: boolean;
}

/** Ответ раунда — одинаковый у HTTP API и testkit. */
export interface RoundView {
  roundId: string;
  gameId: string;
  bet: number;
  status: 'open' | 'closed';
  view: unknown;
  payout: number | null;
  balance: number;
}

/** Ответ открытия игры. */
export interface OpenResult {
  gameId: string;
  limits: { min: number; max: number };
  balance: number;
  activeRound: RoundView | null;
  /**
   * Раунд, который закрылся при этом открытии: досланная выплата или аннулированный раунд с недосланной ставкой.
   * Поля нет, если ничего не досылалось.
   */
  lastRound?: RoundView;
}

/** Хранилище раундов. Методы синхронные; `get`/`findOpen` возвращают независимую копию. */
export interface RoundStore {
  get(roundId: string): RoundRecord | undefined;
  findOpen(gameId: string): RoundRecord | undefined;
  save(round: RoundRecord): void;
  /** Удаляет раунд, ставку которого кошелёк точно не списал. */
  delete(roundId: string): void;
}

/** Настройки движка. */
export interface EngineOptions {
  games: GameModule[];
  store: RoundStore;
  rng: Rng;
  newRoundId: () => string;
}

/** Движок раундов: лимиты, порядок проверок, вызовы игры, списание и выплата. */
export class RoundEngine {
  /** Подключённые игры по `id`. */
  readonly games: ReadonlyMap<string, GameModule>;
  readonly #store: RoundStore;
  readonly #rng: Rng;
  readonly #newRoundId: () => string;

  /** @param opts игры, хранилище раундов, rng и генератор идентификаторов раундов */
  constructor(opts: EngineOptions) {
    const games = new Map<string, GameModule>();
    for (const g of opts.games) {
      if (!g || typeof g.id !== 'string') throw new TypeError('game module must have a string id');
      if (games.has(g.id)) throw new TypeError(`duplicate game id: ${g.id}`);
      games.set(g.id, g);
    }
    this.games = games;
    this.#store = opts.store;
    this.#rng = opts.rng;
    this.#newRoundId = opts.newRoundId;
  }

  /**
   * Открытие игры: лимиты, баланс и незавершённый раунд.
   * Досылает недошедшие ставку или выплату; закрытый при этом раунд возвращается в `lastRound`.
   */
  *open(gameId: string): EngineGen<OpenResult> {
    this.#game(gameId);
    let last: RoundRecord | null = null;
    try {
      last = yield* this.#recover(gameId);
    } catch (e) {
      // Кошелёк окончательно отклонил досылку (не сбой связи): раунд остаётся ждать ручного разбора,
      // но open всё равно отдаёт лимиты, баланс и этот раунд с `view: null`, а не блокирует игру ошибкой.
      if (isUncertain(e)) throw e;
      const detail = e instanceof PlatformError ? `${e.code}: ${detailOf(e)}` : messageOf(e);
      console.error(`Досылка операции раунда игры ${gameId} отклонена кошельком, нужен ручной разбор: ${detail}`);
    }
    const round = this.#store.findOpen(gameId);
    const balance: number = yield { kind: 'balance' };
    const result: OpenResult = {
      gameId,
      limits: { min: LIMITS.min, max: LIMITS.max },
      balance,
      activeRound: round ? this.#view(round, balance, true) : null,
    };
    if (last) result.lastRound = this.#view(last, balance, true);
    return result;
  }

  /**
   * Новый раунд. Порядок проверок: игра → лимиты → параметры → досылка недошедших операций → открытый раунд
   * → сохранение раунда → списание → `start`. Кошелёк не вызывается, пока не пройдены все проверки без денег.
   */
  *startRound(gameId: string, bet: unknown, params: unknown): EngineGen<RoundView> {
    const game = this.#game(gameId);
    const amount = checkBet(bet);
    const p = toJson(callGame(() => game.validateParams(params), 'INVALID_PARAMS'));
    yield* this.#recover(gameId);
    if (this.#store.findOpen(gameId)) throw new PlatformError('ROUND_ALREADY_OPEN');

    const roundId = this.#newRoundId();
    const round: RoundRecord = {
      roundId,
      gameId,
      bet: amount,
      params: p,
      state: null,
      status: 'open',
      payout: null,
      pendingBet: true,
      pendingPayout: null,
      voided: false,
    };
    // Раунд записан до списания: если ответ кошелька потеряется, ставку можно будет дослать и вернуть.
    this.#store.save(round);
    let afterBet: number;
    try {
      afterBet = yield { kind: 'bet', txId: `${roundId}:bet`, roundId, amount };
    } catch (e) {
      if (!isUncertain(e)) this.#store.delete(roundId);
      throw e;
    }
    round.pendingBet = false;

    let step: unknown;
    let state: unknown;
    const rng = guardedRng(this.#rng);
    try {
      step = game.start({ bet: amount, params: toJson(p), rng: rng.rng });
      if (isValidStep(step)) state = toJson(step.state);
    } catch (e) {
      const err = internal(`Игра ${game.id} не смогла начать раунд: ${detailOf(e)}`);
      if (rng.used()) {
        // Исход уже разыгран: возврат ставки дал бы бесплатный переброс. Раунд ждёт ручного разбора.
        this.#markBroken(round, err);
        throw err;
      }
      // Игра упала до розыгрыша: состояния нет, продолжать нельзя — аннулируем и возвращаем ставку.
      round.voided = true;
      yield* this.#settle(round, amount);
      throw err;
    }
    if (!isValidStep(step)) {
      // Ставка уже списана: раунд остаётся открытым с тем, что вернула игра (PL-19, D-023).
      round.state = safeJson((step as { state?: unknown } | null)?.state);
      const err = internal(`Игра ${game.id} вернула некорректный шаг на старте`);
      // Исход уже разыгран: ходы по такому состоянию заблокированы до ручного разбора (D-046).
      if (rng.used()) this.#markBroken(round, err);
      else this.#store.save(round);
      throw err;
    }
    return yield* this.#apply(round, step, state, afterBet);
  }

  /** Ход в открытом раунде. При `INVALID_ACTION` и ошибке игры состояние раунда и баланс не меняются. */
  *action(roundId: string, action: unknown): EngineGen<RoundView> {
    const round = this.#store.get(roundId);
    if (!round) throw new PlatformError('ROUND_NOT_FOUND');
    if (round.status === 'closed') throw new PlatformError('ROUND_CLOSED');
    const game = this.games.get(round.gameId);
    if (!game) throw internal(`Игра ${round.gameId} не подключена`);
    if (round.pendingBet === true) {
      // Списание не подтверждено, игра не начиналась: досылаем ставку и аннулируем раунд.
      const closed = yield* this.#retryBet(round);
      throw new PlatformError(closed ? 'ROUND_CLOSED' : 'ROUND_NOT_FOUND');
    }
    if (round.pendingPayout !== null) {
      // Игра уже завершила раунд, ждём только выплату — досылаем её, ходить больше нельзя.
      yield* this.#settle(round, round.pendingPayout);
      throw new PlatformError('ROUND_CLOSED');
    }
    if (round.broken === true) throw internal(`Раунд ${round.roundId} игры ${game.id} ждёт ручного разбора`);
    const rng = guardedRng(this.#rng);
    let step: { status: 'continue'; state: unknown } | { status: 'finished'; state: unknown; payout: number };
    let state: unknown;
    try {
      const s = callGame(
        () => game.action({ bet: round.bet, params: round.params, state: round.state, action, rng: rng.rng }),
        'INVALID_ACTION',
      );
      if (!isValidStep(s)) throw internal(`Игра ${game.id} вернула некорректный шаг`);
      step = s;
      state = toJson(step.state);
    } catch (e) {
      // До обращения к rng ошибка безопасна: ход можно повторить. После — повтор хода дал бы новый исход,
      // поэтому раунд блокируется для ручного разбора (контракт: игра проверяет ход до rng, D-046).
      if (!rng.used()) throw e;
      const err = internal(`Игра ${game.id} упала после розыгрыша в раунде ${round.roundId}: ${detailOf(e)}`);
      this.#markBroken(round, err);
      throw err;
    }
    return yield* this.#apply(round, step, state, null);
  }

  /** Помечает раунд сломанным и пишет причину в серверный лог. */
  #markBroken(round: RoundRecord, err: PlatformError): void {
    round.broken = true;
    this.#store.save(round);
    console.error(`${err.code}: ${err.detail ?? ''} — раунд ${round.roundId} заблокирован, нужен ручной разбор`);
  }

  /** Досылает недошедшие ставку или выплату открытого раунда игры. Возвращает раунд, если он при этом закрылся. */
  *#recover(gameId: string): EngineGen<RoundRecord | null> {
    const round = this.#store.findOpen(gameId);
    if (!round) return null;
    if (round.pendingBet === true) return yield* this.#retryBet(round);
    if (round.pendingPayout !== null) {
      yield* this.#settle(round, round.pendingPayout);
      return round;
    }
    return null;
  }

  /**
   * Повторяет списание ставки с тем же `txId`. Если кошелёк его провёл — раунд аннулируется со возвратом ставки
   * (игра ещё не начиналась) и возвращается закрытым. Если кошелёк точно отказал — запись удаляется, результат `null`.
   * Если кошелёк снова не ответил — ошибка пробрасывается, раунд остаётся в ожидании.
   */
  *#retryBet(round: RoundRecord): EngineGen<RoundRecord | null> {
    try {
      yield { kind: 'bet', txId: `${round.roundId}:bet`, roundId: round.roundId, amount: round.bet };
    } catch (e) {
      if (isUncertain(e)) throw e;
      this.#store.delete(round.roundId);
      return null;
    }
    round.pendingBet = false;
    round.voided = true;
    yield* this.#settle(round, round.bet);
    return round;
  }

  /** Применяет корректный шаг игры: сохраняет состояние, а на `finished` — выплачивает и закрывает раунд. */
  *#apply(
    round: RoundRecord,
    step: { status: 'continue' } | { status: 'finished'; payout: number },
    state: unknown,
    knownBalance: number | null,
  ): EngineGen<RoundView> {
    round.state = state;
    if (step.status === 'continue') {
      this.#store.save(round);
      const balance: number = knownBalance ?? (yield { kind: 'balance' });
      return this.#view(round, balance, false);
    }
    const balance = yield* this.#settle(round, round2(step.payout));
    return this.#view(round, balance, false);
  }

  /** Выплата `<roundId>:payout` и закрытие раунда. До ответа кошелька раунд сохранён как «ждёт выплаты». */
  *#settle(round: RoundRecord, amount: number): EngineGen<number> {
    round.pendingPayout = amount;
    this.#store.save(round);
    const balance: number = yield { kind: 'payout', txId: `${round.roundId}:payout`, roundId: round.roundId, amount };
    round.status = 'closed';
    round.payout = amount;
    round.pendingPayout = null;
    this.#store.save(round);
    return balance;
  }

  /**
   * Ответ раунда. Если `publicView` игры падает, а раунд уже закрыт или ответ нужен для `open`,
   * отдаётся `view: null`, чтобы сломанное отображение не блокировало игру и не прятало итог раунда.
   */
  #view(round: RoundRecord, balance: number, safe: boolean): RoundView {
    let view: unknown = null;
    // Раунд, ждущий выплаты, игра уже завершила: ходов нет, показывать нечего до закрытия.
    if (!round.voided && round.broken !== true && round.pendingBet !== true && round.pendingPayout === null) {
      try {
        const game = this.games.get(round.gameId);
        if (!game) throw new Error(`Игра ${round.gameId} не подключена`);
        view = toJson(game.publicView(round.state, round.status === 'closed'));
      } catch (e) {
        const err = internal(`Игра ${round.gameId} не смогла показать раунд ${round.roundId}: ${detailOf(e)}`);
        if (!safe && round.status === 'open') throw err;
        console.error(`${err.code}: ${err.detail}`);
        view = null;
      }
    }
    return { roundId: round.roundId, gameId: round.gameId, bet: round.bet, status: round.status, view, payout: round.payout, balance };
  }

  #game(gameId: unknown): GameModule {
    const game = typeof gameId === 'string' ? this.games.get(gameId) : undefined;
    if (!game) throw new PlatformError('GAME_NOT_FOUND');
    return game;
  }
}

/**
 * Отдельный замороженный rng на один вызов игры. Игра не получает генератор платформы и не может подменить
 * его `next` для следующих раундов. Число вне [0, 1) — `INTERNAL_ERROR`. `used()` — брала ли игра число.
 */
function guardedRng(source: Rng): { rng: Rng; used: () => boolean } {
  let count = 0;
  const rng: Rng = Object.freeze({
    next: (): number => {
      const v = source.next();
      if (typeof v !== 'number' || !(v >= 0 && v < 1)) throw internal(`rng вернул число вне [0, 1): ${String(v)}`);
      count += 1;
      return v;
    },
  });
  return { rng, used: () => count > 0 };
}

/** Ставка: конечное число, округлённое до центов и попадающее в лимиты. Иначе `BET_OUT_OF_LIMITS`. */
function checkBet(bet: unknown): number {
  if (typeof bet !== 'number' || !Number.isFinite(bet)) throw new PlatformError('BET_OUT_OF_LIMITS');
  const amount = round2(bet);
  if (amount < LIMITS.min || amount > LIMITS.max) throw new PlatformError('BET_OUT_OF_LIMITS');
  return amount;
}

/** `INTERNAL_ERROR` со стандартным сообщением для клиента; подробности — только для серверного лога. */
function internal(detail: string): PlatformError {
  return new PlatformError('INTERNAL_ERROR', undefined, detail);
}

function detailOf(e: unknown): string {
  return e instanceof PlatformError && e.detail !== undefined ? e.detail : messageOf(e);
}

/**
 * Ошибка кошелька, после которой неизвестно, провёл ли он операцию (нет ответа, таймаут, 5xx).
 * Точные отказы (`INSUFFICIENT_FUNDS`, отклонённый запрос) неопределённости не оставляют.
 */
function isUncertain(e: unknown): boolean {
  if (!(e instanceof PlatformError)) return true;
  return e.code === 'WALLET_UNAVAILABLE';
}

/** Вызов игры: ожидаемый код (`INVALID_PARAMS`/`INVALID_ACTION`) пробрасывается, остальное — `INTERNAL_ERROR`. */
function callGame<T>(fn: () => T, expected: 'INVALID_PARAMS' | 'INVALID_ACTION'): T {
  try {
    return fn();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === expected) {
      const msg = e instanceof Error && e.message && e.message !== expected ? e.message : undefined;
      throw new PlatformError(expected, msg);
    }
    throw internal(`Ошибка игры: ${messageOf(e)}`);
  }
}

function isValidStep(step: unknown): step is { status: 'continue'; state: unknown } | { status: 'finished'; state: unknown; payout: number } {
  if (!step || typeof step !== 'object') return false;
  const s = step as { status?: unknown; payout?: unknown };
  if (s.status === 'continue') return true;
  return s.status === 'finished' && typeof s.payout === 'number' && Number.isFinite(s.payout) && s.payout >= 0;
}

/** Копия значения через JSON — так же, как оно переживёт хранение на диске. */
function toJson<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (e) {
    throw internal(`Состояние игры не сериализуется в JSON: ${messageOf(e)}`);
  }
}

function safeJson(value: unknown): unknown {
  try {
    return toJson(value);
  } catch {
    return null;
  }
}

/** Выполняет операцию движка синхронно. `exec` выполняет операцию кошелька или бросает ошибку. */
export function runSync<T>(gen: EngineGen<T>, exec: (op: WalletOp) => number): T {
  let r = gen.next();
  while (!r.done) {
    let balance: number;
    try {
      balance = exec(r.value);
    } catch (e) {
      r = gen.throw(e);
      continue;
    }
    r = gen.next(balance);
  }
  return r.value;
}

/** Выполняет операцию движка асинхронно (кошелёк по HTTP). */
export async function runAsync<T>(gen: EngineGen<T>, exec: (op: WalletOp) => Promise<number>): Promise<T> {
  let r = gen.next();
  while (!r.done) {
    let balance: number;
    try {
      balance = await exec(r.value);
    } catch (e) {
      r = gen.throw(e);
      continue;
    }
    r = gen.next(balance);
  }
  return r.value;
}
