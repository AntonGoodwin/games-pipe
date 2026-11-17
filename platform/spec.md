# Платформа
Задача: [[local-jira/PLAT-001-platform-platform]] · Решения: [[decisions/platform]] · Входное описание: `specs/platform.md`

Контракт (API, типы `platform/sdk/types.ts`, testkit, порты, файлы данных) зафиксирован во входном описании и в задаче. Здесь он не пересказывается целиком. Спека добавляет к нему только то, чего там нет: порядок проверок, HTTP-статусы, округление, поведение на краях. Все такие пункты помечены «(допущение)». Номера решений присвоит оркестратор в [[decisions/platform]].

## Правила

### Кошелёк (порт 4001, `data/wallet.json`)
- Если файла нет, баланс `player-1` равен 100.00. Файл записывается после каждой операции, которая изменила журнал.
- Транзакция `bet`/`payout` определяется полями `{ type, roundId, amount }`. Повтор того же `txId` с теми же полями возвращает сохранённый ответ (тот же статус и тело), и баланс не меняется. Тот же `txId` с любым отличием в полях даёт `409 { error: { code: "TX_CONFLICT" } }`.
- Отказ из-за недостатка средств (`402`) тоже записывается в журнал по `txId`: повтор вернёт тот же `402` (допущение).
- `amount` должен быть конечным числом: для `bet` больше 0, для `payout` не меньше 0. Иначе `400 INVALID_AMOUNT`, журнал не меняется (допущение). Суммы округляются до центов.

### Ядро (порт 4000, `data/rounds.json`)
- Деньги округляются до центов по правилу `Math.round(x * 100) / 100` (половина центов округляется вверх: 1.955 → 1.96) (допущение). Ставка сначала округляется, потом проверяется по лимитам: 0.999 → 1.00, ставка принимается (допущение).
- Ставка, которая не является конечным числом (строка, `null`, `NaN`), даёт `BET_OUT_OF_LIMITS` (допущение).
- Порядок проверок в `POST /api/games/:gameId/rounds` (допущение). Первая же проверка, которая не прошла, возвращает ошибку. Кошелёк до неё не вызывается, раунд не создаётся:
  1. игра существует → иначе `GAME_NOT_FOUND`;
  2. ставка в лимитах [1, 10] → `BET_OUT_OF_LIMITS`;
  3. `validateParams(params)` → `INVALID_PARAMS`;
  4. у игры нет открытого раунда → `ROUND_ALREADY_OPEN`;
  5. списание `<roundId>:bet` в кошельке → `INSUFFICIENT_FUNDS` (раунд не создаётся и не сохраняется);
  6. `start()`: если вернул `finished`, в том же запросе идёт выплата `<roundId>:payout` и раунд закрывается.
- `POST /api/rounds/:roundId/actions`: неизвестный раунд → `ROUND_NOT_FOUND`, закрытый → `ROUND_CLOSED`. Если игра бросила `GameError('INVALID_ACTION')`, возвращается `INVALID_ACTION`, а состояние раунда и баланс не меняются.
- Если `Step.finished` содержит `payout` < 0 или не конечное число, это ошибка игры: `500 INTERNAL_ERROR`, раунд остаётся открытым в прежнем состоянии (допущение).
- Если кошелёк недоступен, ответ `502 WALLET_UNAVAILABLE` (допущение). При списании раунд не создаётся. При выплате раунд сохраняется как завершённый игрой, но ещё открытый (`status: "open"`, внутренняя отметка «ждёт выплаты»). Выплата с тем же `txId` повторяется при следующем `open` этой игры (допущение).
- Открытый раунд разрешён один на пару (игрок, игра). Раунды разных игр друг от друга не зависят (допущение).
- `roundId` — непрозрачная уникальная строка. Тесты не должны опираться на её формат (допущение).
- HTTP-статусы ошибок (допущение): `400` — `BET_OUT_OF_LIMITS`, `INVALID_PARAMS`, `INVALID_ACTION`; `402` — `INSUFFICIENT_FUNDS`; `404` — `GAME_NOT_FOUND`, `ROUND_NOT_FOUND`; `409` — `ROUND_ALREADY_OPEN`, `ROUND_CLOSED`; `500` — `INTERNAL_ERROR`; `502` — `WALLET_UNAVAILABLE`.
- `GET /api/games` возвращает игры, отсортированные по `id` (допущение). Если манифест некорректен или модуль не загрузился, игра пропускается с записью в лог, и ядро продолжает старт (допущение).
- В продакшене rng построен на `crypto.randomInt`/`crypto.getRandomValues` и даёт число в [0, 1) (допущение).

### SDK (`/sdk.js` → `window.PlatformSDK`)
- `open()` берёт id игры из адреса `/games/<id>/…`. Методы возвращают Promise с телом ответа API. При ошибке Promise отклоняется объектом `{ code, message }`.
- SDK запоминает `roundId` из `open()` (`activeRound`) и из `startRound()`. Если текущего раунда нет, `action()` отклоняется с `{ code: "ROUND_NOT_FOUND" }` без запроса к серверу (допущение).

### Testkit
- `startBalance` по умолчанию 100. Без `rng` используется `seededRng(1)` (допущение).
- Порядок проверок, коды и ответы такие же, как у HTTP API. `PlatformError` содержит `code` и `message`.
- `transactions()` → `[{ txId, type: "bet" | "payout", roundId, amount, balanceAfter }]` в порядке выполнения. Отклонённые операции в список не попадают (допущение).
- `fixedRng(values)`: когда значения кончились, `next()` бросает `Error('fixedRng exhausted')` (допущение). Значения вне [0, 1) отклоняются при создании (допущение).
- `seededRng(seed)` при одинаковом `seed` даёт одинаковую последовательность в [0, 1).

## Тестовые игры (фикстуры для PL-сценариев)
Живут в `platform/tests/fixtures/`, в `games/` не попадают (допущение).
- **`t-flip`**, один ход. `params = { side: "heads" | "tails" }`, иначе `INVALID_PARAMS`. В `start` исход: `rng < 0.5 → heads`, иначе `tails`. При совпадении со стороной игрока `payout = bet × 1.96`, иначе 0. Раунд сразу `finished`. `view = { side, outcome }`.
- **`t-steps`**, несколько ходов. `params = {}`. `start` даёт `continue`, `state = { step: 0, secret: rng }`. Действие `"next"`: `step + 1`, `continue`. Действие `"cashout"`: `finished`, `payout = bet × (1 + step / 3)`. Любое другое действие — `INVALID_ACTION`. `publicView`: пока раунд открыт — `{ step }`, после закрытия — `{ step, secret }`.

## Сценарии приёмки

### Кошелёк (HTTP, чистый `data/`)

**PL-1: начальный баланс**
Дано кошелёк без `data/wallet.json`
Когда `GET /balance`
Тогда `200 { balance: 100 }`

**PL-2: списание и зачисление**
Дано баланс 100
Когда `POST /bet { txId: "a:bet", roundId: "a", amount: 2.5 }`
Тогда `{ balance: 97.5 }`
Когда `POST /payout { txId: "a:payout", roundId: "a", amount: 4.9 }`
Тогда `{ balance: 102.4 }`

**PL-3: недостаточно средств**
Дано баланс 100
Когда `POST /bet { txId: "b:bet", roundId: "b", amount: 150 }`
Тогда `402 { error: { code: "INSUFFICIENT_FUNDS" }, balance: 100 }`, и `GET /balance` возвращает 100

**PL-4: идемпотентность по txId**
Дано выполнен `POST /bet { txId: "a:bet", roundId: "a", amount: 2.5 }`, баланс 97.5
Когда тот же запрос отправлен повторно
Тогда ответ `{ balance: 97.5 }`, и `GET /balance` возвращает 97.5

**PL-5: конфликт txId**
Дано выполнен `POST /bet { txId: "a:bet", roundId: "a", amount: 2.5 }`, баланс 97.5
Когда `POST /bet { txId: "a:bet", roundId: "a", amount: 3 }`
Тогда `409 { error: { code: "TX_CONFLICT" } }`, баланс 97.5

**PL-6: баланс переживает перезапуск**
Дано баланс 97.5 после списания 2.5
Когда сервис кошелька перезапущен
Тогда `GET /balance` возвращает 97.5, а повтор `"a:bet"` по-прежнему не списывает второй раз

### Раунды (testkit, игры `t-flip` и `t-steps`, стартовый баланс 100)

**PL-7: открытие игры**
Когда `open("t-flip")`
Тогда `{ gameId: "t-flip", limits: { min: 1, max: 10 }, balance: 100, activeRound: null }`

**PL-8: выигрыш в один ход**
Дано `fixedRng([0.3])`
Когда `startRound("t-flip", 1, { side: "heads" })`
Тогда `status: "closed"`, `payout: 1.96`, `balance: 100.96`, `view: { side: "heads", outcome: "heads" }`
И `transactions()` = `[{ txId: "<roundId>:bet", type: "bet", amount: 1, balanceAfter: 99 }, { txId: "<roundId>:payout", type: "payout", amount: 1.96, balanceAfter: 100.96 }]`

**PL-9: проигрыш закрывается выплатой 0**
Дано `fixedRng([0.7])`
Когда `startRound("t-flip", 5, { side: "heads" })`
Тогда `status: "closed"`, `payout: 0`, `balance: 95`
И в `transactions()` есть `payout` с `amount: 0` и `balanceAfter: 95`

**PL-10: лимиты ставки проверяются до кошелька**
Когда `startRound("t-flip", 0.5, { side: "heads" })` и `startRound("t-flip", 10.01, { side: "heads" })`
Тогда оба вызова бросают `BET_OUT_OF_LIMITS`, `transactions()` пуст, баланс 100
Когда в новой платформе с `fixedRng([0.7, 0.7])` по очереди ставят 1 и 10
Тогда обе приняты, баланс 100 → 99 → 89

**PL-11: недостаточно средств**
Дано `startBalance: 5`
Когда `startRound("t-flip", 6, { side: "heads" })`
Тогда бросается `INSUFFICIENT_FUNDS`, `transactions()` пуст, баланс 5, `open("t-flip").activeRound` = `null`

**PL-12: неверные параметры**
Когда `startRound("t-flip", 1, { side: "edge" })`
Тогда бросается `INVALID_PARAMS`, `transactions()` пуст, баланс 100

**PL-13: раунд из нескольких ходов, скрытое не раскрывается**
Дано `fixedRng([0.42])`
Когда `startRound("t-steps", 3, {})`
Тогда `status: "open"`, `payout: null`, `balance: 97`, `view` = `{ step: 0 }` (без `secret`)
Когда `action(roundId, "next")`
Тогда `status: "open"`, `view: { step: 1 }`, `balance: 97`
Когда `action(roundId, "cashout")`
Тогда `status: "closed"`, `payout: 4`, `balance: 101`, `view: { step: 1, secret: 0.42 }`

**PL-14: округление выплаты до центов**
Дано `fixedRng([0.1, 0.2])`
Когда `startRound("t-steps", 1, {})`, затем `action "next"`, затем `action "cashout"` (1 × 4/3 = 1.3333…)
Тогда `payout: 1.33`, `balance: 100.33`
Когда `startRound("t-steps", 1.006, {})`, а затем сразу `cashout`
Тогда `bet: 1.01`, `balance: 99.32`, затем `payout: 1.01`, `balance: 100.33`

**PL-15: недопустимое действие**
Дано открыт раунд `t-steps` со ставкой 2, `view: { step: 0 }`, баланс 98
Когда `action(roundId, "jump")`
Тогда бросается `INVALID_ACTION`
И после `action(roundId, "next")` получаем `view: { step: 1 }` (состояние не испорчено), баланс 98

**PL-16: только один открытый раунд в игре**
Дано `fixedRng([0.5, 0.3])`, открыт раунд `t-steps` со ставкой 2, баланс 98
Когда `startRound("t-steps", 2, {})`
Тогда бросается `ROUND_ALREADY_OPEN`, баланс 98, в `transactions()` одно списание, rng не расходуется
Когда `startRound("t-flip", 1, { side: "heads" })` (rng 0.3 → heads)
Тогда раунд другой игры проходит, баланс 98.96

**PL-17: закрытый и неизвестный раунд**
Дано раунд `t-flip` закрыт (PL-8)
Когда `action(roundId, "next")`
Тогда бросается `ROUND_CLOSED`, баланс 100.96
Когда `action("no-such-round", "next")`
Тогда бросается `ROUND_NOT_FOUND`

**PL-18: неизвестная игра**
Когда `open("nope")` или `startRound("nope", 1, {})`
Тогда бросается `GAME_NOT_FOUND`, баланс 100

**PL-19: ошибочная выплата игры**
Дано тестовая игра, у которой `start` возвращает `finished` с `payout: -1`
Когда `startRound(<игра>, 1, {})`
Тогда бросается `INTERNAL_ERROR`, выплаты нет, баланс 99, раунд остаётся открытым

**PL-20: генераторы testkit**
Когда два `seededRng(42)` выдают по 5 чисел
Тогда последовательности совпадают, и все числа лежат в [0, 1)
Когда `fixedRng([0.1])` вызывается второй раз
Тогда бросается ошибка `fixedRng exhausted`

### Ядро по HTTP (порты 4000/4001, чистый `data/`)

**PL-21: обновление страницы и перезапуск не теряют раунд**
Дано `POST /api/games/t-steps/rounds { bet: 2, params: {} }`, раунд открыт, баланс 98
Когда ядро и кошелёк перезапущены и вызван `POST /api/games/t-steps/open`
Тогда `activeRound` — тот же `roundId`, `status: "open"`, `view: { step: 0 }`, `payout: null`, `balance: 98`

**PL-22: ошибки HTTP**
Когда ставка 11 → `400 { error: { code: "BET_OUT_OF_LIMITS", message } }`. Ставка 6 при балансе 5 → `402 INSUFFICIENT_FUNDS`. Игра `nope` → `404 GAME_NOT_FOUND`. Повторный старт при открытом раунде → `409 ROUND_ALREADY_OPEN`
Тогда во всех случаях баланс в кошельке не изменился

**PL-23: автоподключение игр и раздача**
Дано в `games/` лежат манифесты `a-game` и `b-game` (`{ id, title, server, ui }`), а также один битый манифест
Когда ядро стартует
Тогда `GET /api/games` = `[{ id: "a-game", title }, { id: "b-game", title }]`, ядро запущено
И `GET /games/a-game/` отдаёт `ui/index.html` игры, `GET /` отдаёт оболочку со списком игр и балансом, `GET /sdk.js` отдаёт JavaScript

**PL-24: клиентский SDK**
Дано страница `/games/t-flip/` с подключённым `/sdk.js`, баланс 100
Когда `PlatformSDK.open()`
Тогда запрос уходит на `POST /api/games/t-flip/open`, ответ содержит `limits: { min: 1, max: 10 }`
Когда `PlatformSDK.startRound(20, { side: "heads" })`
Тогда Promise отклоняется с `{ code: "BET_OUT_OF_LIMITS" }`
Когда `PlatformSDK.action("next")` вызывается без открытого раунда
Тогда Promise отклоняется с `{ code: "ROUND_NOT_FOUND" }`
