# Мины
Задача: [[local-jira/GAME-002-mines-new-game]], доработка [[local-jira/GAME-003-mines-feedback]] · Решения: [[decisions/mines]] · Платформа: [[platform/spec]]

## Правила
- Поле 5 × 5, клетки пронумерованы `0…24` построчно: `cell = row × 5 + col` (левая верхняя — 0, правая нижняя — 24) (допущение, см. журнал решений).
- Перед ставкой игрок выбирает число мин `m` от 1 до 24, по умолчанию 3 (GAME-003). Безопасных клеток на поле `25 − m`.
- Игрок делает ставку, затем по одной открывает клетки. Безопасная клетка увеличивает множитель, мина завершает раунд с выплатой 0.
- Забрать выигрыш (`cashout`) можно после любой открытой безопасной клетки. До первой открытой клетки забрать нельзя (допущение, см. журнал решений).
- Если открыты все `25 − m` безопасные клетки, раунд завершается сам с выплатой по максимальному множителю (допущение, см. журнал решений).
- House edge — 2 % при любом `m`, как в «Монетке» (допущение, см. журнал решений).
- Лимиты ставки, списание, выплата, округление до центов, коды ошибок и правило «один открытый раунд на игру» работают по [[platform/spec]]. Игра о кошельке не знает: она возвращает `payout` в `Step`.
- Порядок по контракту `platform/sdk/types.ts`: всё, что может упасть, проверяется до обращения к `rng`. `rng.next()` вызывается только в `start`, ровно `m` раз. После этих вызовов исключений нет. `action` к `rng` не обращается. Состояние — простой JSON-объект. `action` не меняет переданный `state`, а возвращает новый. `Math.random` не используется.

## Параметры раунда и ходы
- `params = { mines: m }`. `validateParams` (допущение, см. журнал решений):
  - `undefined` → `{ mines: 3 }`; объект без поля `mines` → `{ mines: 3 }`;
  - `mines` — целое число (`typeof === "number"`, `Number.isInteger`) от 1 до 24 → `{ mines }`. Лишние поля отбрасываются;
  - `GameError('INVALID_PARAMS')` дают: `null`, массив, строка, число вместо объекта, а также `mines` = `0`, `25`, `-3`, `2.5`, `"5"`, `null`.
  - Платформа вызывает `validateParams` до списания ставки ([[platform/spec]]). `start` повторяет проверку до первого `rng.next()`.
- `start` расставляет `m` мин и возвращает `continue` (0 открытых клеток).
- Число мин в раунде берётся только из `state.mines.length`. `action` и `publicView` не читают `params`.
- Действия (`action`, объект JSON) (допущение, см. журнал решений):
  - `{ type: "reveal", cell }` — открыть клетку. `cell` — целое число `0…24`, ещё не открытое. Лишние поля игнорируются.
  - `{ type: "cashout" }` — забрать выигрыш, допустимо при `k ≥ 1` (`k` — число открытых безопасных клеток).
- `GameError('INVALID_ACTION')` вызывают: действие не объект (в том числе строка `"cashout"` и `null`), неизвестный `type`, `cell` вне `0…24`, не целое число или не число (`2.5`, `"7"`, нет поля), уже открытая клетка, `cashout` при `k = 0`. Состояние раунда и баланс при этом не меняются.
- Раунд завершается так:
  - мина → `finished`, `payout = 0`;
  - `cashout` → `finished`, `payout = bet × M(k)`;
  - открыта безопасная клетка номер `25 − m` → `finished`, `payout = bet × M(25 − m)`, `outcome = "cleared"`. При `m = 24` это первая же безопасная клетка, поэтому `cashout` в таком раунде невозможен.
- Ход после завершения до игры не доходит: платформа отвечает `ROUND_CLOSED`.

## Результат и выплата
**Расстановка мин (в `start`, `m` вызовов rng: r₀ … r₍ₘ₋₁₎).** Частичная тасовка Фишера — Йетса: массив `c = [0, 1, …, 24]`. Для `i = 0 … m − 1`: `j = i + floor(rᵢ × (25 − i))`, затем `c[i]` и `c[j]` меняются местами. Мины — `c[0] … c[m − 1]`. В состоянии они хранятся отсортированными по возрастанию. Первые три шага те же, что раньше, поэтому при `m = 3` расстановка не меняется.

| m | rng | мины |
|---|---|---|
| 3 | `[0.5, 0.75, 0.25]` | `[7, 12, 19]` |
| 3 | `[0, 0, 0]` | `[0, 1, 2]` |
| 3 | `[0.9999, 0.9999, 0.9999]` | `[0, 1, 24]` (j = 24, 24, 24, после обменов c = 24, 0, 1) |
| 1 | `[0.5]` | `[12]` |
| 5 | `[0.5, 0.75, 0.25, 0, 0]` | `[3, 4, 7, 12, 19]` |
| 24 | 24 раза `0` | `[0, 1, …, 23]` (безопасна только 24) |
| 24 | 24 раза `0.9999` | `[0, 1, …, 22, 24]` (безопасна только 23; на каждом шаге j = 24) |

**Множитель.** `M(0) = 1` (только для отображения). При `1 ≤ k ≤ 25 − m`: `M(k) = Math.round(98 × C(25, k) / C(25 − m, k)) / 100`. `C(n, k)` — целые биномиальные коэффициенты. Математически это `round2(0.98 × C(25,k)/C(25−m,k))`: честный множитель для `m` мин, умноженный на 0.98. Целочисленная форма нужна, чтобы половина цента всегда округлялась вверх без ошибки плавающей точки: при `m = 5, k = 1` получается 122.5 → 1.23. Множитель округляется до центов, выплата считается от округлённого значения (допущение, см. журнал решений).

| m \ k | 1 | 2 | 3 | 4 | 5 | 6 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.02 | 1.07 | 1.11 | | | | | | | | 12.25 | 24.5 |
| 3 | 1.11 | 1.27 | 1.46 | 1.69 | 1.98 | 2.33 | | | 563.5 | 2254 | — | — |
| 5 | 1.23 | 1.55 | 1.98 | 2.56 | | | 8677.9 | 52067.4 | — | — | — | — |
| 24 | 24.5 | — | — | — | — | — | — | — | — | — | — | — |

Реализация считает `M(k)` по формуле, таблица дана для проверки. **Выплата:** `payout = bet × M(k)`. До центов её округляет платформа. Примеры: 2 × 1.46 = 2.92; 3.33 × 1.27 = 4.2291 → 4.23; 2 × 1.55 = 3.1; 3 × 24.5 = 73.5.

**Состояние:** `{ mines: number[m], revealed: number[], hit: number | null, outcome: "mine" | "cashout" | "cleared" | null }`. `revealed` содержит только безопасные клетки в порядке открытия.

## Что видит игрок
- `publicView(state, false)`, пока раунд открыт: `{ mineCount: m, revealed, multiplier: M(k), nextMultiplier: M(k + 1) }`. Полей `mines`, `hit`, `outcome` нет, расположение мин не раскрывается никак.
- `publicView(state, true)` после завершения: `{ mineCount: m, revealed, multiplier: M(k), nextMultiplier: null, mines, hit, outcome }`. `hit` — клетка с миной, на которой игрок проиграл, иначе `null`.
- После обновления страницы `open("mines").activeRound` возвращает открытый раунд с тем же `view`, и игру можно продолжить ([[platform/spec]], PL-21).
- Интерфейс (`ui/index.html`, только через `window.PlatformSDK`) (допущение, см. журнал решений):
  - `data-testid`: `balance`, `bet-input` (по умолчанию 1), `mines-input`, `play` (новая игра), `cashout`, `multiplier`, `next-multiplier`, `payout`, `error` (код ошибки платформы), клетки `cell-0` … `cell-24` с `data-cell-state` = `hidden | safe | mine | hit`.
  - `mines-input` — `<select>` с вариантами `1…24`, по умолчанию `3`. `play` вызывает `sdk.startRound(bet, { mines: m })`, где `m` — число из выбранного значения. В `playing` выбор заблокирован. При восстановлении раунда `mines-input` получает `view.mineCount`. После конца раунда выбор снова доступен и сохраняет значение.
  - Корень `data-testid="game"` с `data-state`: `idle` (раунда нет), `playing` (раунд открыт), `won` (`cashout` или `cleared`), `lost` (мина).
  - В `idle` клетки и `cashout` заблокированы. В `playing` заблокированы `play` и уже открытые клетки, `cashout` доступна при `k ≥ 1`.
  - Кнопка `cashout` (GAME-003): в `playing` при `k ≥ 1` показывает текст `Забрать $X`, где `X = (Math.round(bet × view.multiplier × 100) / 100).toFixed(2)`. Здесь `bet` — ставка раунда из ответа `startRound` или `activeRound`, а не значение из поля ввода. Пример: 2 × 1.11 → `Забрать $2.22`, 3.33 × 1.27 → `Забрать $4.23`. В остальных случаях кнопка показывает текст `Забрать`.
  - Конец раунда (GAME-003): все клетки из `view.mines` получают `mine`, клетка `view.hit` получает `hit`, клетки из `view.revealed` получают `safe`, остальные остаются `hidden`. Цвета: `safe` — зелёный фон, `hit` — красный фон, `mine` — нейтральный (не красный и не зелёный) фон со значком мины (текстовый символ, без графики). Пока раунд открыт, `safe` тоже зелёная.
  - Анимация (GAME-003): открытая ходом клетка переворачивается CSS-анимацией (`transform: rotateY`) длительностью не больше 300 мс. `data-cell-state` выставляется сразу по ответу платформы, без таймеров. Анимация не задерживает ни состояние, ни следующий клик. Ни одна `animation-duration` или `transition-duration` в стилях страницы не превышает 300 мс (допущение, см. журнал решений).
  - Ошибки хода (допущение, см. журнал решений): при `ROUND_CLOSED`, `ROUND_NOT_FOUND` и `WALLET_UNAVAILABLE` код показывается в `error`, и интерфейс пересинхронизируется без перезагрузки страницы. Он заново вызывает `sdk.open()`, обновляет `balance` и применяет `activeRound`, если раунд есть, а если раунда нет, переходит в `idle` со всеми клетками `hidden`. Остальные коды, например `INVALID_ACTION`, только показываются в `error`, состояние не меняется. Клетка, ход на которую отклонён, исход не получает.

## Сценарии приёмки
Через `createTestPlatform({ games: [mines], rng, startBalance })` из `platform/testkit`. Стартовый баланс 100, если не указано иное. `R(c)` означает `action(roundId, { type: "reveal", cell: c })`, `CO` — `action(roundId, { type: "cashout" })`. `params = {}` даёт 3 мины, поэтому SC-1…SC-9, SC-11…SC-13 не меняются.

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

**SC-10: параметры раунда** (изменён в GAME-003)
Дано `fixedRng([0.5, 0.75, 0.25])`, баланс 100
Когда `startRound("mines", 1, p)` для каждого `p` из: `null`, `[]`, `"x"`, `5`, `{ mines: 0 }`, `{ mines: 25 }`, `{ mines: -3 }`, `{ mines: 2.5 }`, `{ mines: "5" }`, `{ mines: null }`
Тогда каждый вызов бросает `INVALID_PARAMS`, `transactions()` пуст, баланс 100, rng не расходуется
Когда `startRound("mines", 1, { extra: 1 })` и `R(7)`
Тогда действует значение по умолчанию: клетка 7 — мина, `view.mineCount: 3`, `view.mines: [7, 12, 19]`, `balance: 99`
Когда в новой платформе с `fixedRng([0.5, 0.75, 0.25])` вызван `startRound("mines", 1)` без params
Тогда `status: "open"`, `view.mineCount: 3`, `balance: 99`
Когда в новой платформе с `fixedRng([0.5, 0.75, 0.25])` вызван `startRound("mines", 1, { mines: 3 })`
Тогда `view` = `{ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 }`, `balance: 99`

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

**SC-14: контракт модуля игры** (изменён в GAME-003)
Дано серверный модуль `games/mines/server/index.ts`
Тогда `id` = `"mines"`, `validateParams({ mines: 5, extra: 1 })` = `{ mines: 5 }`, `validateParams(undefined)` = `{ mines: 3 }`, `validateParams({})` = `{ mines: 3 }`, `validateParams({ mines: 1 })` = `{ mines: 1 }`, `validateParams({ mines: 24 })` = `{ mines: 24 }`
И `validateParams(null)`, `validateParams({ mines: 25 })` и `validateParams({ mines: 2.5 })` бросают `GameError` с кодом `INVALID_PARAMS`
Когда вызван `start({ bet: 2, params: { mines: 3 }, rng })` с rng, который отдаёт 0.5, 0.75, 0.25 и бросает при 4-м вызове
Тогда `status: "continue"`, rng вызван ровно 3 раза, `state` = `{ mines: [7, 12, 19], revealed: [], hit: null, outcome: null }`, `JSON.parse(JSON.stringify(state))` равен `state`
И `publicView(state, false)` = `{ mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 }`
Когда вызван `action` с этим `state` и rng, который бросает при любом вызове, для `{ type: "reveal", cell: 0 }`
Тогда `{ status: "continue", state: { mines: [7, 12, 19], revealed: [0], hit: null, outcome: null } }`, rng не вызван, исходный `state` не изменён
Когда вызван `action` с `{ type: "reveal", cell: 30 }`
Тогда бросается `GameError` с кодом `INVALID_ACTION`, rng не вызван, `state` не изменён
Когда вызван `action` с `state.revealed = [0]` и `{ type: "cashout" }`
Тогда `{ status: "finished", payout: 2.22 }`, `state.outcome: "cashout"`
Когда вызван `start({ bet: 1, params: { mines: 1 }, rng })` с rng, который отдаёт 0.5 и бросает при 2-м вызове
Тогда rng вызван ровно 1 раз, `state.mines` = `[12]`, `publicView(state, false)` = `{ mineCount: 1, revealed: [], multiplier: 1, nextMultiplier: 1.02 }`
Когда вызван `start({ bet: 1, params: { mines: 24 }, rng })` с rng, который всегда отдаёт 0
Тогда rng вызван ровно 24 раза, `state.mines` = `[0, 1, …, 23]`
Когда вызван `start` с `params` `{ mines: 0 }` или `{ mines: 30 }` в обход `validateParams`
Тогда бросается `GameError` с кодом `INVALID_PARAMS`, rng не вызван
Когда вызван `action` с `state = { mines: [12], revealed: [], hit: null, outcome: null }`, `params: { mines: 3 }` и `{ type: "reveal", cell: 0 }`
Тогда `status: "continue"`, а `publicView` нового состояния = `{ mineCount: 1, revealed: [0], multiplier: 1.02, nextMultiplier: 1.07 }` (число мин берётся из `state`, а не из `params`)

**SC-15: интерфейс** (изменён в GAME-003)
Дано `ui/index.html` в happy-dom, `window.PlatformSDK` подменён:
`open()` → `{ balance: 100, limits: { min: 1, max: 10 }, activeRound: null }`
`startRound(2, { mines: 3 })` → `{ roundId: "r1", status: "open", bet: 2, payout: null, balance: 98, view: { mineCount: 3, revealed: [], multiplier: 1, nextMultiplier: 1.11 } }`
`action({ type: "reveal", cell: 0 })` → `{ status: "open", balance: 98, payout: null, view: { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 } }`
`action({ type: "cashout" })` → `{ status: "closed", balance: 100.22, payout: 2.22, view: { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: null, mines: [7, 12, 19], hit: null, outcome: "cashout" } }`
Когда страница загружена
Тогда `data-state="idle"`, `balance` показывает 100, `cell-0` заблокирована, `mines-input` имеет значение `3` и 24 варианта `1…24`
Когда в `bet-input` введено 2 и нажата `play`
Тогда `startRound` вызван с `(2, { mines: 3 })`, `data-state="playing"`, `balance` показывает 98, `cashout` заблокирована и показывает `Забрать`, `mines-input` заблокирован
Когда нажата `cell-0`
Тогда `action` вызван с `{ type: "reveal", cell: 0 }`, `cell-0` имеет `data-cell-state="safe"` сразу после ответа (без продвижения таймеров), `multiplier` содержит 1.11, `next-multiplier` содержит 1.27, `cashout` доступна и показывает `Забрать $2.22`
Когда нажата `cashout`
Тогда `data-state="won"`, `payout` содержит 2.22, `balance` показывает 100.22, у `cell-7`, `cell-12` и `cell-19` `data-cell-state="mine"`, `cell-0` — `safe`, `cell-1` — `hidden`, ни одна клетка не `hit`, `cashout` показывает `Забрать`, `mines-input` доступен
Когда страница загружена заново, и `open()` возвращает `activeRound` = `{ roundId: "r1", status: "open", bet: 2, payout: null, view: { mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 } }`
Тогда `data-state="playing"`, `cell-0` и `cell-6` имеют `data-cell-state="safe"`, `mines-input` имеет значение `3`, `cashout` показывает `Забрать $2.54`
Когда `action` отклоняется с `{ code: "ROUND_CLOSED" }`
Тогда `error` содержит `ROUND_CLOSED` (пересинхронизация — SC-20)

**SC-16: игра с 5 минами** (новый, GAME-003)
Дано `fixedRng([0.5, 0.75, 0.25, 0, 0])` (мины 3, 4, 7, 12, 19), баланс 100
Когда `startRound("mines", 2, { mines: 5 })`
Тогда `status: "open"`, `balance: 98`, `view` = `{ mineCount: 5, revealed: [], multiplier: 1, nextMultiplier: 1.23 }` (98 × 25 / 20 = 122.5 → 1.23)
Когда `R(0)`
Тогда `view` = `{ mineCount: 5, revealed: [0], multiplier: 1.23, nextMultiplier: 1.55 }`
Когда `R(1)`
Тогда `multiplier: 1.55`, `nextMultiplier: 1.98`
Когда `CO`
Тогда `status: "closed"`, `payout: 3.1`, `balance: 101.1`, `view` = `{ mineCount: 5, revealed: [0, 1], multiplier: 1.55, nextMultiplier: null, mines: [3, 4, 7, 12, 19], hit: null, outcome: "cashout" }`
И `transactions()` = `[{ type: "bet", amount: 2, balanceAfter: 98 }, { type: "payout", amount: 3.1, balanceAfter: 101.1 }]`

**SC-17: одна мина — все 24 безопасные клетки** (новый, GAME-003)
Дано `fixedRng([0.5])` (мина 12), баланс 100
Когда `startRound("mines", 1, { mines: 1 })`
Тогда `balance: 99`, `view` = `{ mineCount: 1, revealed: [], multiplier: 1, nextMultiplier: 1.02 }`
Когда `R(0)`, затем `R(1)`
Тогда `multiplier: 1.07`, `nextMultiplier: 1.11`
Когда по очереди открыты остальные клетки `2…11`, `13…23` (всего открыто 23)
Тогда `status: "open"`, `multiplier: 12.25`, `nextMultiplier: 24.5`, `balance: 99`
Когда `R(24)`
Тогда `status: "closed"`, `payout: 24.5`, `balance: 123.5`, `view.outcome: "cleared"`, `view.hit: null`, `view.mines: [12]`, в `view.revealed` 24 клетки

**SC-18: 24 мины — одна безопасная клетка** (новый, GAME-003)
Дано `fixedRng` с 24 значениями `0.9999` и следом 24 значениями `0`, баланс 100
Когда `startRound("mines", 3, { mines: 24 })` (безопасна только 23)
Тогда `balance: 97`, `view` = `{ mineCount: 24, revealed: [], multiplier: 1, nextMultiplier: 24.5 }`
Когда `CO`
Тогда бросается `INVALID_ACTION`, баланс 97
Когда `R(23)`
Тогда `status: "closed"`, `payout: 73.5`, `balance: 170.5`, `view.outcome: "cleared"`, `view.revealed: [23]`, `view.mines` = `[0, 1, …, 22, 24]`
Когда `startRound("mines", 1, { mines: 24 })` (мины 0…23), затем `R(0)`
Тогда `status: "closed"`, `payout: 0`, `balance: 169.5`, `view.hit: 0`, `view.outcome: "mine"`, `view.mines` = `[0, 1, …, 23]`

**SC-19: интерфейс — выбор числа мин и конец раунда на мине** (новый, GAME-003)
Дано `ui/index.html` в happy-dom, `window.PlatformSDK` подменён:
`open()` → `{ balance: 100, limits: { min: 1, max: 10 }, activeRound: null }`
`startRound(1, { mines: 5 })` → `{ roundId: "r2", status: "open", bet: 1, payout: null, balance: 99, view: { mineCount: 5, revealed: [], multiplier: 1, nextMultiplier: 1.23 } }`
`action({ type: "reveal", cell: 0 })` → `{ status: "open", balance: 99, payout: null, view: { mineCount: 5, revealed: [0], multiplier: 1.23, nextMultiplier: 1.55 } }`
`action({ type: "reveal", cell: 3 })` → `{ status: "closed", balance: 99, payout: 0, view: { mineCount: 5, revealed: [0], multiplier: 1.23, nextMultiplier: null, mines: [3, 4, 7, 12, 19], hit: 3, outcome: "mine" } }`
Когда в `mines-input` выбрано 5, в `bet-input` введено 1 и нажата `play`
Тогда `startRound` вызван с `(1, { mines: 5 })` (число, не строка), `data-state="playing"`, `mines-input` заблокирован
Когда нажата `cell-0`
Тогда `cell-0` — `safe`, `cashout` показывает `Забрать $1.23`
Когда нажата `cell-3`
Тогда `data-state="lost"`, `cell-3` — `hit`, `cell-4`, `cell-7`, `cell-12`, `cell-19` — `mine`, `cell-0` — `safe`, `cell-1` — `hidden`, `cashout` заблокирована и показывает `Забрать`, `mines-input` доступен со значением `5`, `balance` показывает 99
И в стилях страницы есть правила для `[data-cell-state="safe"]` и `[data-cell-state="hit"]`, есть анимация переворота, и ни одна `animation-duration` или `transition-duration` не больше 300 мс

**SC-20: интерфейс — пересинхронизация после ошибки хода** (новый)
Дано `ui/index.html` в happy-dom, `open()` при загрузке → `{ balance: 98, limits: { min: 1, max: 10 }, activeRound: { roundId: "r1", status: "open", bet: 2, payout: null, view: { mineCount: 3, revealed: [0], multiplier: 1.11, nextMultiplier: 1.27 } } }`, `data-state="playing"`
Когда `action({ type: "reveal", cell: 6 })` отклоняется с `{ code: "ROUND_CLOSED" }`, а повторный `open()` → `{ balance: 100.22, limits: { min: 1, max: 10 }, activeRound: null }`
Тогда `open` вызван второй раз, `error` содержит `ROUND_CLOSED`, `data-state="idle"`, `balance` показывает 100.22, все клетки `hidden`, страница не перезагружалась
Когда (новая загрузка с тем же `activeRound`) `action({ type: "reveal", cell: 6 })` отклоняется с `{ code: "WALLET_UNAVAILABLE" }`, а повторный `open()` возвращает `activeRound` с `view: { mineCount: 3, revealed: [0, 6], multiplier: 1.27, nextMultiplier: 1.46 }` и `balance: 98`
Тогда `error` содержит `WALLET_UNAVAILABLE`, `data-state="playing"`, `cell-0` и `cell-6` — `safe`, `cashout` показывает `Забрать $2.54`
Когда (новая загрузка) `action` отклоняется с `{ code: "ROUND_NOT_FOUND" }`, а повторный `open()` → `activeRound: null`
Тогда `data-state="idle"`, `error` содержит `ROUND_NOT_FOUND`
Когда (новая загрузка) `action({ type: "reveal", cell: 6 })` отклоняется с `{ code: "INVALID_ACTION" }`
Тогда `open` повторно не вызывается, `error` содержит `INVALID_ACTION`, `data-state="playing"`, `cell-6` — `hidden`
