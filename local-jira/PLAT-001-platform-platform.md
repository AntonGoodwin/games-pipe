---
id: PLAT-001
status: done
rounds:
  docs: 1
  learn: 1
runs:
  - r-001-PLAT-001
  - r-002-PLAT-001
  - r-003-PLAT-001
  - r-004-PLAT-001
type: platform
pipeline: platform
scope: platform
title: Платформа
phase: END
stopped_at: docs
---
# PLAT-001: Платформа

## Описание

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

## Ссылки

- Входное описание: `specs/platform.md`
- Спецификация: [[platform/spec]]
- Решения: [[decisions/platform]]

## Журнал
- 15:58 запуск [[runs/r-001-PLAT-001/report|r-001-PLAT-001]] (auto)
- 16:00 spec: новые допущения D-001, D-002, D-003, D-004, D-005, D-006, D-007, D-008, D-009, D-010, D-011, D-012, D-013, D-014 → [[decisions/platform]]
- 16:00 spec → done (2m13s)
- 16:26 запуск [[runs/r-002-PLAT-001/report|r-002-PLAT-001]] (auto) с этапа tests
- 16:33 tests: новые допущения D-015, D-016, D-017, D-018, D-019, D-020 → [[decisions/platform]]
- 16:33 tests → done (6m41s)
- 16:33 coverage_check → pass (1s)
- 16:33 lock_tests → pass (0s)
- 16:40 implement: новые допущения D-021, D-022, D-023, D-024, D-025, D-026, D-027, D-028, D-029, D-030, D-031, D-032, D-033 → [[decisions/platform]]
- 16:40 implement → done (6m46s)
- 16:40 verify → pass (2s)
- 16:41 review → fail (1m24s)
- 16:45 implement: новые допущения D-034, D-035, D-036, D-037, D-038, D-039, D-040, D-041, D-042 → [[decisions/platform]]
- 16:45 implement → done (3m58s)
- 16:45 verify → pass (2s)
- 16:47 review → fail (2m05s)
- 16:50 implement: новые допущения D-043, D-044, D-045 → [[decisions/platform]]
- 16:50 implement → done (3m03s)
- 16:50 verify → pass (7s)
- 16:52 review → fail (2m07s)
- 16:55 implement: новые допущения D-046, D-047, D-048, D-049 → [[decisions/platform]]
- 16:55 implement → done (3m07s)
- 16:56 verify → pass (2s)
- 16:56 ⛔ остановлено: лимит попыток этапа «review» исчерпан (3). Последняя проблема:
- 16:56 learn → done (41s)
- 16:58 запуск [[runs/r-003-PLAT-001/report|r-003-PLAT-001]] (auto) с этапа review
- 16:58 review → pass (50s)
- 17:01 docs → done (2m17s)
- 17:01 docs_check → fail (2s)
- 17:01 docs → done (39s)
- 17:01 docs_check → fail (2s)
- 17:01 ⛔ остановлено: лимит попыток этапа «docs» исчерпан (2). Последний результат этапа «docs»:
- 17:02 learn → done (28s)
- 17:02 запуск [[runs/r-004-PLAT-001/report|r-004-PLAT-001]] (auto) с этапа docs
- 17:03 docs → done (42s)
- 17:03 docs_check → pass (2s)
- 17:03 freeze_platform → pass (0s)
- 17:03 learn → done (7s)
