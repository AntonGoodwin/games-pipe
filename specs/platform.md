# Платформа

Общая часть для всех игр. Создаётся пайплайном один раз и дальше не меняется: новые игры подключаются без правок платформы.

К платформе относятся лимиты ставок, раунды, взаимодействие с партнёром (кошельком) и общий интерфейс для игр. К игре относятся механика, интерфейс и определение результата.

## Партнёр (кошелёк)

Отдельный тестовый модуль и HTTP-сервис, который владеет балансом игрока. Игрок один (`player-1`), авторизации и сессий нет.

- Начальный баланс $100.
- `GET /balance` → `{ balance }`.
- `POST /bet { txId, roundId, amount }` → `{ balance }`. При недостаточном балансе — отказ `402 { error: { code: "INSUFFICIENT_FUNDS" }, balance }`, баланс не меняется.
- `POST /payout { txId, roundId, amount }` → `{ balance }`.
- После каждой операции возвращает актуальный баланс.
- У каждой транзакции идентификатор `txId`. Повторная отправка с тем же `txId` не меняет баланс второй раз и возвращает тот же ответ. Тот же `txId` с другими данными — `409 TX_CONFLICT`.
- Баланс и журнал транзакций хранятся на диске (`data/wallet.json`): перезапуск сервиса и обновление страницы баланс не сбрасывают.
- Порт 4001.

## Ядро платформы

HTTP-сервис на порту 4000. Раздаёт оболочку, интерфейсы игр, клиентский SDK и API.

- Лимиты ставки: от $1 до $10. Игра получает их при открытии.
- Ставка вне лимитов отклоняется **до** обращения к кошельку (`400 BET_OUT_OF_LIMITS`).
- Раунд: ставка открывает раунд (списание через кошелёк), выплата его закрывает (зачисление через кошелёк, в том числе выплата 0). Раунд может состоять из одного или нескольких ходов.
- Идентификаторы транзакций раунда: `<roundId>:bet` и `<roundId>:payout`.
- У игрока может быть только один открытый раунд в игре. Открытие игры возвращает незавершённый раунд, чтобы обновление страницы его не теряло. Раунды хранятся на диске (`data/rounds.json`).
- Деньги — числа в долларах, округляются платформой до центов.

API:

- `GET /api/games` → `[{ id, title }]`
- `POST /api/games/:gameId/open` → `{ gameId, limits: { min, max }, balance, activeRound }`
- `POST /api/games/:gameId/rounds { bet, params }` → `RoundView`
- `POST /api/rounds/:roundId/actions { action }` → `RoundView`
- `RoundView = { roundId, gameId, bet, status: "open" | "closed", view, payout, balance }`, где `view` — то, что игра разрешает показать клиенту, `payout` — `null` пока раунд открыт.
- Ошибки: `4xx { error: { code, message } }`, коды: `BET_OUT_OF_LIMITS`, `INSUFFICIENT_FUNDS`, `INVALID_PARAMS`, `INVALID_ACTION`, `ROUND_ALREADY_OPEN`, `ROUND_NOT_FOUND`, `ROUND_CLOSED`, `GAME_NOT_FOUND`.

Игры подключаются автоматически: при старте ядро находит все `games/*/manifest.json` (`{ id, title, server, ui }`) и загружает серверный модуль игры. Интерфейс игры раздаётся по адресу `/games/<id>/`, оболочка `/` показывает список игр и баланс.

## Интерфейс для игр (контракт)

Игра не работает с балансом напрямую и не знает о кошельке. Она реализует серверный модуль, а платформа вызывает его внутри раунда.

`platform/sdk/types.ts` (имена фиксированы — на них опираются все игры):

```ts
export interface Rng { next(): number }                  // [0, 1)
export type Step<S> =
  | { status: 'continue'; state: S }
  | { status: 'finished'; state: S; payout: number };    // payout — полная сумма к зачислению, 0 при проигрыше
export interface GameModule<P = any, S = any, A = any> {
  id: string;
  validateParams(params: unknown): P;                    // бросает GameError('INVALID_PARAMS')
  start(ctx: { bet: number; params: P; rng: Rng }): Step<S>;
  action(ctx: { bet: number; params: P; state: S; action: A; rng: Rng }): Step<S>; // GameError('INVALID_ACTION')
  publicView(state: S, finished: boolean): unknown;      // что можно показать клиенту (скрытое не раскрывать до конца раунда)
}
export class GameError extends Error { code: string }
```

Результат определяется только на сервере. Генератор случайных чисел передаётся в модуль платформой; в тестах его можно подменить и получить управляемый исход.

Клиентский SDK раздаётся как `/sdk.js` и даёт интерфейсу игры `window.PlatformSDK`: `open()` (id игры берётся из адреса страницы), `startRound(bet, params)`, `action(action)`. Ошибки приходят как объект с `code`.

## Тестовый набор для игр

`platform/testkit/index.ts` — тот же движок раундов в памяти, без HTTP и диска, чтобы приёмочные тесты игр были быстрыми и детерминированными:

- `createTestPlatform({ games, rng?, startBalance? })` → `{ open(gameId), startRound(gameId, bet, params), action(roundId, action), balance(), transactions() }`. Ответы такие же, как у HTTP API; ошибки бросаются как `PlatformError` с полем `code`.
- `fixedRng(values)` — отдаёт заданные числа по очереди (управляемый исход), `seededRng(seed)` — воспроизводимая последовательность.

## Запуск

`pnpm start` → `platform/start.ts` поднимает кошелёк (4001) и ядро (4000). Приложение открывается на http://localhost:4000.
