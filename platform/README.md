# Платформа

Спецификация: [[platform/spec]] · Решения: [[decisions/platform]] · Задача: [[local-jira/PLAT-001-platform-platform]] · Конвенции: [[docs/conventions]]

Общая часть для всех игр: кошелёк партнёра, лимиты ставок, раунды, контракт `GameModule`, клиентский SDK и testkit. Игра реализует только механику, интерфейс и определение результата. Деньги проводит платформа по `Step`, который вернула игра. После создания платформа заморожена.

## Устройство

```
platform/
  start.ts              pnpm start: кошелёк отдельным процессом (4001) + ядро (4000)
  wallet/index.ts       HTTP-сервис кошелька: баланс, bet/payout, идемпотентность txId, data/wallet.json
  wallet/main.ts        точка входа процесса кошелька (fork + IPC { port, dataDir, token })
  core/index.ts         HTTP-ядро: API, оболочка /, интерфейсы /games/<id>/, /sdk.js, cryptoRng
  core/engine.ts        RoundEngine — движок раундов, общий для ядра и testkit
  core/store.ts         хранилища раундов: MemoryRoundStore (testkit), FileRoundStore (data/rounds.json)
  core/games.ts         автоподключение games/*/manifest.json
  core/wallet-client.ts выполнение операций движка (WalletOp) по HTTP к кошельку
  core/shell.html       оболочка: список игр и баланс
  sdk/types.ts          контракт игры: Rng, Step, GameModule, GameError
  sdk/client.js         window.PlatformSDK для интерфейса игры
  testkit/index.ts      createTestPlatform, fixedRng, seededRng: движок в памяти для тестов игр
  shared/errors.ts      PlatformError, коды → HTTP-статусы
  shared/money.ts       LIMITS { min: 1, max: 10 }, round2 — округление до центов
  shared/http.ts        readJson, sendJson/sendError, checkLocalHost, checkJsonBody, listen
  shared/fs.ts          writeFileDurable: временный файл, fsync, rename
  tests/                приёмочные тесты PL-N и тестовые игры t-flip, t-steps
```

### Кошелёк (`wallet/`)

- `GET /balance`, `POST /bet`, `POST /payout { txId, roundId, amount }` → `{ balance }`. При нехватке средств `402 INSUFFICIENT_FUNDS` с текущим балансом. Начальный баланс — `START_BALANCE` = 100, игрок `PLAYER_ID` = `player-1`.
- Каждая транзакция записывается в журнал вместе с ответом. Повтор `txId` с теми же типом, `roundId` и суммой из запроса возвращает сохранённый ответ, а с другими данными — `409 TX_CONFLICT` ([[decisions/platform#D-040]]). Отказ 402 тоже сохраняется ([[decisions/platform#D-007]]).
- Сначала новое состояние записывается на диск (`writeFileDurable`), только потом меняется память ([[decisions/platform#D-041]], [[decisions/platform#D-048]]). Если `wallet.json` битый, кошелёк не запускается, а баланс молча не сбрасывается ([[decisions/platform#D-033]]).
- Доступ: только локальный `Host`, запрос без `Origin`, POST с телом `application/json`. Если задан `token`, нужен заголовок `x-wallet-token` ([[decisions/platform#D-043]], [[decisions/platform#D-044]]).

### Ядро (`core/`)

- `startCore({ port, dataDir, gamesDir, walletUrl, host?, rng?, walletToken? })` загружает игры (`loadGames`) и раунды (`FileRoundStore`), затем поднимает HTTP.
- API: `GET /api/games`, `GET /api/balance` (для оболочки, [[decisions/platform#D-025]]), `POST /api/games/:id/open`, `POST /api/games/:id/rounds { bet, params }`, `POST /api/rounds/:id/actions { action }`. Ошибки приходят как `{ error: { code, message } }`, статусы заданы в `shared/errors.ts` ([[decisions/platform#D-003]]).
- Все операции движка идут через одну очередь промисов, поэтому проверка «нет открытого раунда» и списание выполняются атомарно ([[decisions/platform#D-030]]).
- POST `/api/*`: `Origin`, если он есть, должен совпадать с `Host`, тело должно быть JSON ([[decisions/platform#D-039]]).
- `loadGames` пропускает некорректный манифест или модуль и пишет предупреждение в лог. Остальные игры работают ([[decisions/platform#D-010]], [[decisions/platform#D-028]]).
- `walletExecutor` переводит ответы кошелька в ошибки: `402` → `INSUFFICIENT_FUNDS`; сеть, таймаут 5 с или `5xx` → `WALLET_UNAVAILABLE` (исход неизвестен); прочие отказы → `INTERNAL_ERROR`.

### Движок (`core/engine.ts`)

Операции `open`, `startRound` и `action` написаны как генераторы. Каждое обращение к кошельку — это `yield WalletOp`, в ответ генератор получает баланс. Ядро выполняет генератор через `runAsync` с HTTP-кошельком, testkit — через `runSync` с кошельком в памяти. Логика одна, поэтому testkit ведёт себя так же, как HTTP API.

### SDK

- `sdk/types.ts` — контракт игры. Игра импортирует из платформы только `platform/sdk/*`.
- `sdk/client.js` раздаётся как `/sdk.js` и создаёт `window.PlatformSDK` с методами `open()`, `startRound(bet, params)` и `action(action)`. Id игры SDK берёт из адреса `/games/<id>/`, а `roundId` запоминает после `open().activeRound` и `startRound()`. Если раунда нет, `action()` отклоняется с `{ code: 'ROUND_NOT_FOUND' }` без запроса к серверу ([[decisions/platform#D-012]]). Сетевой сбой приходит как `{ code: 'NETWORK_ERROR' }`.

### Testkit

- `createTestPlatform({ games, rng?, startBalance? })` работает синхронно ([[decisions/platform#D-031]]): по умолчанию `rng = seededRng(1)`, баланс 100, `roundId` вида `round-N`. Методы: `open`, `startRound`, `action`, `balance()`, `transactions()`. В журнал транзакций попадают только проведённые операции.
- `fixedRng(values)` отдаёт числа по очереди. Значение вне [0, 1) даёт `RangeError` сразу, исчерпанная очередь — `Error('fixedRng exhausted')`.
- `seededRng(seed)` — mulberry32, воспроизводимая последовательность.

### Запуск (`start.ts`)

`pnpm start` создаёт секрет `walletToken`, запускает `wallet/main.ts` через `fork` и передаёт ему `{ port: 4001, dataDir, token }` по IPC. Затем поднимает ядро на 4000. Если процесс кошелька завершился, ядро тоже останавливается. По SIGINT/SIGTERM сначала останавливается ядро, потом кошелёк ([[decisions/platform#D-049]]). Данные хранятся в `data/`, игры берутся из `games/`.

## Состояние раунда

`RoundRecord` в `data/rounds.json` (`FileRoundStore` перезаписывает файл целиком после каждого изменения):

| Поле | Смысл |
|---|---|
| `roundId`, `gameId`, `bet` | идентификатор (UUID в ядре, `round-N` в testkit), игра, ставка в долларах (округлена до центов) |
| `params`, `state` | параметры после `validateParams` и состояние игры, сохраняются как JSON |
| `status` | `open` / `closed` |
| `payout` | выплата закрытого раунда, `null` пока раунд открыт |
| `pendingBet` | раунд записан, списание отправлено, но кошелёк его не подтвердил |
| `pendingPayout` | игра завершила раунд, выплата этой суммы ещё не подтверждена |
| `voided` | раунд аннулирован, ставка возвращена, `view = null` |
| `broken` | игра упала после `rng.next()`, раунд ждёт ручного разбора |

В каждой игре может быть только один открытый раунд ([[decisions/platform#D-008]]).

**`startRound(gameId, bet, params)`** проверяет по порядку ([[decisions/platform#D-002]]):

1. игра существует (`GAME_NOT_FOUND`);
2. ставка — конечное число, после `round2` попадает в [1, 10] (`BET_OUT_OF_LIMITS`, кошелёк не вызывается);
3. `validateParams` (`INVALID_PARAMS`);
4. досылка недошедших операций открытого раунда (см. ниже);
5. нет открытого раунда (`ROUND_ALREADY_OPEN`);
6. раунд сохраняется с `pendingBet: true`, затем списание `<roundId>:bet`. Точный отказ кошелька удаляет запись, неизвестный исход (`WALLET_UNAVAILABLE`) её оставляет;
7. `game.start` → шаг применяется: `continue` сохраняет состояние, `finished` выплачивает.

**`action(roundId, action)`:** `ROUND_NOT_FOUND`, если раунда нет, и `ROUND_CLOSED`, если он закрыт. При `pendingBet` ставка досылается, раунд аннулируется. При `pendingPayout` досылается выплата, ответ — `ROUND_CLOSED` ([[decisions/platform#D-024]]). Если раунд `broken`, ответ — `INTERNAL_ERROR`. В остальных случаях вызывается `game.action`. При `INVALID_ACTION` или ошибке игры до обращения к rng раунд и баланс не меняются, ход можно повторить.

**Раунд завершается**, когда игра вернула `{ status: 'finished', payout }`. Платформа ставит `pendingPayout = round2(payout)`, сохраняет раунд, отправляет `<roundId>:payout` (в том числе на 0), после подтверждения ставит `status: 'closed'` и `payout`. Ещё раунд закрывается при аннулировании: вместо выплаты возвращается ставка.

**Досылка** (`open`, `startRound`, `action` этой игры): раунд с `pendingBet` повторяет `bet` с тем же `txId`. Если списание прошло, раунд аннулируется с возвратом ставки, а если кошелёк точно отказал, запись удаляется ([[decisions/platform#D-034]]). Раунд с `pendingPayout` повторяет `payout`. Кошелёк идемпотентен, поэтому повтор безопасен. Раунд, закрытый досылкой в `open`, приходит в поле `lastRound` ([[decisions/platform#D-036]]). Если кошелёк окончательно отклонил досылку, `open` всё равно отдаёт лимиты, баланс и раунд с `view: null` и пишет ошибку в лог ([[decisions/platform#D-045]]).

**Ошибки игры:**

| Когда | Что делает платформа |
|---|---|
| `start` бросил исключение до `rng.next()` | раунд аннулируется, ставка возвращается, `INTERNAL_ERROR` ([[decisions/platform#D-022]], [[decisions/platform#D-035]]) |
| `start` вернул некорректный шаг до `rng.next()` | раунд остаётся открытым с тем состоянием, которое вернула игра, `INTERNAL_ERROR` ([[decisions/platform#D-023]]) |
| любая ошибка (исключение, некорректный шаг, состояние не в JSON) после `rng.next()` | `broken: true`, ставка не возвращается, ходы получают `INTERNAL_ERROR`, `startRound` получает `ROUND_ALREADY_OPEN` ([[decisions/platform#D-046]]) |
| `publicView` бросил исключение | в `open` и для закрытого раунда `view: null`, на открытом раунде в `startRound`/`action` — `INTERNAL_ERROR` ([[decisions/platform#D-037]]) |

Клиент получает стандартный текст `INTERNAL_ERROR`. Подробности хранятся в `PlatformError.detail` и попадают только в серверный лог ([[decisions/platform#D-038]]).

### Ручной разбор раунда с `broken`

Инструмента для разбора нет: это осознанное решение [[decisions/platform#D-046]]. Пока раунд открыт, игра для игрока заблокирована. Процедура разбора (допущение этапа docs, опирается на существующую досылку выплаты):

1. Остановить `pnpm start`.
2. Найти в `data/rounds.json` раунд с `"broken": true`. Причина записана в лог ядра (`… заблокирован, нужен ручной разбор`).
3. Определить сумму выплаты X: 0, ставка или выигрыш по правилам игры. Удалить `broken` и записать `"pendingPayout": X`.
4. Запустить приложение и открыть игру. `open` дошлёт `<roundId>:payout` на X и закроет раунд, итог придёт в `lastRound`.

## Как определяется результат

- Исход определяет только игра на сервере, через `ctx.rng`. Платформа ничего не решает за игру: она списывает ставку до `start` и зачисляет `payout` из шага `finished`. `payout` — полная сумма к зачислению, 0 при проигрыше. Она должна быть конечной и ≥ 0, иначе шаг некорректен ([[decisions/platform#D-005]]).
- Генератор в ядре — `cryptoRng`: 48 бит из `crypto.randomBytes`, делённые на 2⁴⁸, дают число в [0, 1) ([[decisions/platform#D-011]], [[decisions/platform#D-029]]). В тестах `rng` можно подменить на `fixedRng` или `seededRng`.
- На каждый вызов `start` или `action` игра получает новый замороженный объект `{ next }`. Он проверяет, что число в [0, 1) (иначе `INTERNAL_ERROR`), и считает обращения ([[decisions/platform#D-047]]). Счётчик нужен, чтобы отличить ошибку до розыгрыша (безопасно повторить) от ошибки после него (повтор дал бы бесплатный переброс).
- Деньги: `round2` округляет до центов, половина цента округляется вверх, по десятичной записи (1.955 → 1.96, [[decisions/platform#D-001]], [[decisions/platform#D-021]]). Округляются ставка перед проверкой лимитов, выплата игры и баланс.
- Транзакции раунда: `<roundId>:bet` и `<roundId>:payout`.

## Интерфейс

Оболочка `/` (`core/shell.html`) показывает баланс из `GET /api/balance` и список игр из `GET /api/games`.

| data-testid | Что это |
|---|---|
| `balance` | текущий баланс |
| `status` | строка статуса загрузки или ошибки |
| `games` | список игр |
| `game-<id>` | ссылка на `/games/<id>/` |

Интерфейс игры раздаётся по адресу `/games/<id>/` (файл `ui` из манифеста, соседние файлы — из его каталога, [[decisions/platform#D-027]]). Он работает только через `window.PlatformSDK`. Значения `data-state` (`idle | playing | won | lost | settled`) задают интерфейсы игр, оболочка их не использует.

## Известные ограничения (ревью r-003)

- После возврата из `start`/`action` объект rng продолжает работать. Если игра сохранит его и вызовет позже, это нарушит контракт (`sdk/types.ts`) и сдвинет последовательность детерминированного rng в тестах. На `cryptoRng` это не влияет.
- Защита rng на каждый вызов и пометка `broken` после `rng.next()` пока не покрыты отдельными тестами.
- Запрет для кода игры на `process`, `globalThis`, `require`, `import()`, `fetch`, `eval` и `node:*` записан только в контракте. Песочница для игр вне рамок проекта ([[docs/conventions]]).

## Проверка

```
pnpm exec vitest run platform/tests
pnpm exec tsc --noEmit -p tsconfig.json
```
