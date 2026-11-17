# Мины
Задача: [[local-jira/GAME-002-mines-new-game]] · Решения: [[decisions/mines]] · Платформа: [[platform/spec]]

## Правила
- Поле 5 × 5, клетки пронумерованы `0…24` построчно: `cell = row × 5 + col` (левая верхняя — 0, правая нижняя — 24) (допущение, см. журнал решений).
- На поле ровно **3 мины**, игрок число мин не выбирает (допущение, см. журнал решений).
- Игрок делает ставку, затем по одной открывает клетки. Безопасная клетка увеличивает множитель, мина завершает раунд с выплатой 0.
- Забрать выигрыш (`cashout`) можно после любой открытой безопасной клетки. До первой открытой клетки забрать нельзя (допущение, см. журнал решений).
- Если открыты все 22 безопасные клетки, раунд завершается сам с выплатой по максимальному множителю (допущение, см. журнал решений).
- House edge — 2 %, как в «Монетке» (допущение, см. журнал решений).
- Лимиты ставки, списание, выплата, округление до центов, коды ошибок и «один открытый раунд на игру» работают по [[platform/spec]]. Игра о кошельке не знает: она возвращает `payout` в `Step`.
- Порядок по контракту `platform/sdk/types.ts`: всё, что может упасть, проверяется до обращения к `rng`. `rng.next()` вызывается только в `start`, ровно 3 раза. После этих вызовов исключений нет. `action` к `rng` не обращается. Состояние — простой JSON-объект. `action` не меняет переданный `state`, а возвращает новый. `Math.random` не используется.

## Параметры раунда и ходы
- `params = {}`. `validateParams` принимает объект или `undefined` (тогда считается `{}`). Лишние поля, в том числе `mines`, отбрасываются, нормализованный результат — `{}`. `null`, массив, строка и число дают `GameError('INVALID_PARAMS')` (допущение, см. журнал решений).
- `start` расставляет мины и возвращает `continue` (0 открытых клеток).
- Действия (`action`, объект JSON) (допущение, см. журнал решений):
  - `{ type: "reveal", cell }` — открыть клетку. `cell` — целое число `0…24`, ещё не открытое. Лишние поля игнорируются.
  - `{ type: "cashout" }` — забрать выигрыш, допустимо при `k ≥ 1` (`k` — число открытых безопасных клеток).
- `GameError('INVALID_ACTION')` вызывают: действие не объект (в том числе строка `"cashout"` и `null`), неизвестный `type`, `cell` вне `0…24`, не целое число или не число (`2.5`, `"7"`, нет поля), уже открытая клетка, `cashout` при `k = 0`. Состояние раунда и баланс при этом не меняются.
- Раунд завершается так:
  - мина → `finished`, `payout = 0`;
  - `cashout` → `finished`, `payout = bet × M(k)`;
  - открыта 22-я безопасная клетка → `finished`, `payout = bet × M(22)`.
- Ход после завершения до игры не доходит: платформа отвечает `ROUND_CLOSED`.

## Результат и выплата
**Расстановка мин (в `start`, 3 вызова rng: r₀, r₁, r₂).** Частичная тасовка Фишера — Йетса: массив `c = [0, 1, …, 24]`. Для `i = 0, 1, 2`: `j = i + floor(rᵢ × (25 − i))`, затем `c[i]` и `c[j]` меняются местами. Мины — `c[0], c[1], c[2]`. В состоянии они хранятся отсортированными по возрастанию.

| rng | мины |
|---|---|
| `[0.5, 0.75, 0.25]` | `[7, 12, 19]` |
| `[0, 0, 0]` | `[0, 1, 2]` |
| `[0.9999, 0.9999, 0.9999]` | `[0, 1, 24]` (j = 24, 24, 24, после обменов c = 24, 0, 1) |

**Множитель.** `M(0) = 1` (только для отображения). При `k ≥ 1`: `M(k) = round2(0.98 × C(25, k) / C(22, k))`, где `round2(x) = Math.round(x × 100) / 100`. Это честный множитель для 3 мин, умноженный на 0.98. Множитель округляется до центов, и выплата считается от округлённого значения (допущение, см. журнал решений).

| k | 1 | 2 | 3 | 4 | 5 | 6 | 21 | 22 |
|---|---|---|---|---|---|---|---|---|
| M(k) | 1.11 | 1.27 | 1.46 | 1.69 | 1.98 | 2.33 | 563.5 | 2254 |

Реализация считает `M(k)` по формуле: таблица дана для проверки. **Выплата:** `payout = bet × M(k)`. До центов её округляет платформа. Примеры: 2 × 1.46 = 2.92; 3.33 × 1.27 = 4.2291 → 4.23; 1 × 2254 = 2254.

**Состояние:** `{ mines: number[3], revealed: number[], hit: number | null, outcome: "mine" | "cashout" | "cleared" | null }`. `revealed` — только безопасные клетки в порядке открытия.

## Что видит игрок
- `publicView(state, false)`, пока раунд открыт: `{ mineCount: 3, revealed, multiplier: M(k), nextMultiplier: M(k + 1) }`. Полей `mines`, `hit`, `outcome` нет, расположение мин не раскрывается никак.
- `publicView(state, true)` после завершения: `{ mineCount: 3, revealed, multiplier: M(k), nextMultiplier: null, mines, hit, outcome }`. `hit` — клетка с миной, на которой игрок проиграл, иначе `null`.
- После обновления страницы `open("mines").activeRound` возвращает открытый раунд с тем же `view`, и игру можно продолжить ([[platform/spec]], PL-21).
- Интерфейс (`ui/index.html`, только через `window.PlatformSDK`) (допущение, см. журнал решений):
  - `data-testid`: `balance`, `bet-input` (по умолчанию 1), `play` (новая игра), `cashout`, `multiplier`, `next-multiplier`, `payout`, `error` (код ошибки платформы), клетки `cell-0` … `cell-24` с `data-cell-state` = `hidden | safe | mine`.
  - Корень `data-testid="game"` с `data-state`: `idle` (раунда нет), `playing` (раунд открыт), `won` (`cashout` или `cleared`), `lost` (мина).
  - В `idle` клетки и `cashout` заблокированы. В `playing` заблокированы `play` и уже открытые клетки, `cashout` доступна при `k ≥ 1`. Когда раунд завершён, мины показываются как `mine`.

## Сценарии приёмки
Через `createTestPlatform({ games: [mines], rng, startBalance })` из `platform/testkit`. Стартовый баланс 100, если не указано иное. `R(c)` означает `action(roundId, { type: "reveal", cell: c })`, `CO` — `action(roundId, { type: "cashout" })`.

**SC-1: три безопасные клетки и cashout**
Дано `fixedRng([0.5, 0.75, 0.25])` (мины 7, 12, 19), баланс 100
Когда `startRound("mines", 2, {})`
Тогда `status: "open"`, `bet: 2`, `payout: null`, `balance: 98`, `view` = `{ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 }`
Когда `R(0)`
Тогда `status: "open"`, `view` = `{ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 }`, `balance: 98`
Когда `R(6)`, затем `R(24)`
Тогда `view.revealed: [0, 6, 24]`, `multiplier: 1.46`, `nextMultiplier: 1.69`, `balance: 98`
Когда `CO`
Тогда `status: "closed"`, `payout: 2.92`, `balance: 100.92`, `view` = `{ mineCount: 3, revealed: [0, 6, 24], multiplier: 1.46, nextMultiplier: null, mines: [7, 12, 19], hit: null, outcome: "cashout" }`
И `transactions()` = `[{ type: "bet", amount: 2, balanceAfter: 98 }, { type: "payout", amount: 2.92, balanceAfter: 100.92 }]`

**SC-2: мина после безопасной клетки**
Дано `fixedRng([0.5, 0.75, 0.25])`, баланс 100
Когда `startRound("mines", 5, {})`, `R(0)`, затем `R(12)`
Тогда `status: "closed"`, `payout: 0`, `balance: 95`, `view` = `{ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: null, mines: [7, 12, 19], hit: 12, outcome: "mine" }`
И в `transactions()` есть `payout` с `amount: 0` и `balanceAfter: 95`

**SC-3: мина первым ходом**
Дано `fixedRng([0.5, 0.75, 0.25])`, баланс 100
Когда `startRound("mines", 1, {})`, затем `R(19)`
Тогда `status: "closed"`, `payout: 0`, `balance: 99`, `view.revealed: []`, `view.hit: 19`, `view.outcome: "mine"`

**SC-4: границы rng при расстановке**
Дано `fixedRng([0, 0, 0, 0.9999, 0.9999, 0.9999])`, баланс 100
Когда `startRound("mines", 1, {})` (мины 0, 1, 2), `R(3)`, затем `R(2)`
Тогда после `R(3)` раунд открыт, `multiplier: 1.11`. После `R(2)` `status: "closed"`, `payout: 0`, `view.mines: [0, 1, 2]`, `hit: 2`, `balance: 99`
Когда `startRound("mines", 1, {})` (мины 0, 1, 24), `R(2)`, `R(23)`, затем `R(24)`
Тогда после `R(23)` раунд открыт, `multiplier: 1.27`. После `R(24)` `status: "closed"`, `payout: 0`, `view.mines: [0, 1, 24]`, `hit: 24`, `balance: 98`

**SC-5: открыты все безопасные клетки — раунд закрывается сам**
Дано `fixedRng([0, 0, 0])` (мины 0, 1, 2), баланс 100
Когда `startRound("mines", 1, {})` и по очереди `R(3)`, `R(4)`, …, `R(23)` (21 клетка)
Тогда `status: "open"`, `multiplier: 563.5`, `nextMultiplier: 2254`, `balance: 99`
Когда `R(24)`
Тогда `status: "closed"`, `payout: 2254`, `balance: 2353`, `view.outcome: "cleared"`, `view.hit: null`, `view.revealed` содержит 22 клетки (3…24)

**SC-6: округление выплаты**
Дано `fixedRng([0.5, 0.75, 0.25])`, баланс 100
Когда `startRound("mines", 3.33, {})`, `R(0)`, `R(1)`, затем `CO`
Тогда `payout: 4.23` (3.33 × 1.27 = 4.2291), `balance: 100.9`

**SC-7: недопустимые ходы не меняют раунд**
Дано `fixedRng([0.5, 0.75, 0.25])`, `startRound("mines", 2, {})`, затем `R(0)`, баланс 98
Когда `action(roundId, a)` для каждого `a` из: `{ type: "reveal", cell: 0 }` (уже открыта), `{ type: "reveal", cell: 25 }`, `{ type: "reveal", cell: -1 }`, `{ type: "reveal", cell: 2.5 }`, `{ type: "reveal", cell: "7" }`, `{ type: "reveal" }`, `{ type: "flag", cell: 3 }`, `"cashout"`, `null`
Тогда каждый вызов бросает `INVALID_ACTION`, баланс 98, в `transactions()` одно списание
Когда `R(1)`
Тогда `status: "open"`, `view.revealed: [0, 1]`, `multiplier: 1.27` (состояние не испорчено)

**SC-8: cashout до первой клетки запрещён**
Дано `fixedRng([0.5, 0.75, 0.25])`, `startRound("mines", 2, {})`, баланс 98
Когда `CO`
Тогда бросается `INVALID_ACTION`, раунд открыт, баланс 98
Когда `R(0)`, затем `CO`
Тогда `payout: 2.22`, `balance: 100.22`

**SC-9: ход в закрытом раунде**
Дано `fixedRng([0.5, 0.75, 0.25, 0, 0, 0])`, раунд как в SC-2 закрыт миной (ставка 5, `R(0)`, `R(12)`), баланс 95
Когда `R(1)` и `CO` для этого раунда
Тогда оба бросают `ROUND_CLOSED`, баланс 95
Когда `startRound("mines", 1, {})` (rng 0, 0, 0)
Тогда раунд открывается (`status: "open"`, `balance: 94`)

**SC-10: параметры раунда**
Дано `fixedRng([0.5, 0.75, 0.25])`, баланс 100
Когда `startRound("mines", 1, p)` для каждого `p` из: `null`, `[]`, `"x"`, `5`
Тогда каждый вызов бросает `INVALID_PARAMS`, `transactions()` пуст, баланс 100, rng не расходуется
Когда `startRound("mines", 1, { mines: 10, extra: 1 })` и `R(7)`
Тогда раунд идёт на тех же числах rng: клетка 7 — мина, `view.mineCount: 3`, `view.mines: [7, 12, 19]`, `balance: 99`
Когда в новой платформе с `fixedRng([0.5, 0.75, 0.25])` вызван `startRound("mines", 1)` без params
Тогда `status: "open"`, `balance: 99`

**SC-11: лимиты ставки**
Когда `startRound("mines", 0.5, {})` и `startRound("mines", 10.01, {})`
Тогда оба бросают `BET_OUT_OF_LIMITS`, `transactions()` пуст, баланс 100

**SC-12: недостаточно средств**
Дано `startBalance: 5`
Когда `startRound("mines", 6, {})`
Тогда бросается `INSUFFICIENT_FUNDS`, `transactions()` пуст, баланс 5, `open("mines").activeRound` = `null`

**SC-13: обновление страницы посреди раунда**
Дано `fixedRng([0.5, 0.75, 0.25])`, `startRound("mines", 2, {})`, затем `R(0)`, баланс 98
Когда `open("mines")`
Тогда `balance: 98`, у `activeRound` тот же `roundId`, `status: "open"`, `view` = `{ mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 }` (без `mines`)
Когда `startRound("mines", 2, {})`
Тогда бросается `ROUND_ALREADY_OPEN`, баланс 98
Когда `R(6)`, затем `CO`
Тогда `payout: 2.54`, `balance: 100.54`

**SC-14: контракт модуля игры**
Дано серверный модуль `games/mines/server/index.ts`
Тогда `id` = `"mines"`, `validateParams({ mines: 5 })` = `{}`, `validateParams(undefined)` = `{}`, `validateParams(null)` бросает `GameError` с кодом `INVALID_PARAMS`
Когда вызван `start({ bet: 2, params: {}, rng })` с rng, который отдаёт 0.5, 0.75, 0.25 и бросает при 4-м вызове
Тогда `status: "continue"`, rng вызван ровно 3 раза, `state` = `{ mines: [7, 12, 19], revealed: [], hit: null, outcome: null }`, `JSON.parse(JSON.stringify(state))` равен `state`
И `publicView(state, false)` = `{ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 }`
Когда вызван `action` с этим `state` и rng, который бросает при любом вызове, для `{ type: "reveal", cell: 0 }`
Тогда `{ status: "continue", state: { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null } }`, rng не вызван, исходный `state` не изменён
Когда вызван `action` с `{ type: "reveal", cell: 30 }`
Тогда бросается `GameError` с кодом `INVALID_ACTION`, rng не вызван, `state` не изменён
Когда вызван `action` с `state.revealed = [0]` и `{ type: "cashout" }`
Тогда `{ status: "finished", payout: 2.22 }`, `state.outcome: "cashout"`

**SC-15: интерфейс**
Дано `ui/index.html` в happy-dom, `window.PlatformSDK` подменён:
`open()` → `{ balance: 100, limits: { min: 1, max: 10 }, activeRound: null }`
`startRound(2, {})` → `{ roundId: "r1", status: "open", bet: 2, payout: null, balance: 98, view: { mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 } }`
`action({ type: "reveal", cell: 0 })` → `{ status: "open", balance: 98, payout: null, view: { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 } }`
`action({ type: "cashout" })` → `{ status: "closed", balance: 100.22, payout: 2.22, view: { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: null, mines: [7, 12, 19], hit: null, outcome: "cashout" } }`
Когда страница загружена
Тогда `data-state="idle"`, `balance` показывает 100, `cell-0` заблокирована
Когда в `bet-input` введено 2 и нажата `play`
Тогда `startRound` вызван с `(2, {})`, `data-state="playing"`, `balance` показывает 98, `cashout` заблокирована
Когда нажата `cell-0`
Тогда `action` вызван с `{ type: "reveal", cell: 0 }`, `cell-0` имеет `data-cell-state="safe"`, `multiplier` содержит 1.11, `next-multiplier` содержит 1.27, `cashout` доступна
Когда нажата `cashout`
Тогда `data-state="won"`, `payout` содержит 2.22, `balance` показывает 100.22, у `cell-7`, `cell-12` и `cell-19` `data-cell-state="mine"`
Когда страница загружена заново, и `open()` возвращает `activeRound` с `view.revealed: [0, 6]`
Тогда `data-state="playing"`, `cell-0` и `cell-6` имеют `data-cell-state="safe"`
Когда `action` отклоняется с `{ code: "ROUND_CLOSED" }`
Тогда `error` содержит `ROUND_CLOSED`
