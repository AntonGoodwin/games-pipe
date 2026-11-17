# Монетка
Задача: [[local-jira/GAME-001-coin-new-game]], изменение [[local-jira/GAME-004-coin-decision]] · Решения: [[decisions/coin]] · Платформа: [[platform/spec]]

## Правила
- Игрок выбирает сторону монеты — орёл (`heads`) или решка (`tails`) — и делает ставку. Угадал — получает выплату, не угадал — теряет ставку.
- Лимиты ставки, списание, выплата, округление до центов и коды ошибок — по [[platform/spec]]. Игра о кошельке не знает: она только возвращает `payout` в `Step`.
- Коэффициент выплаты при угадывании — **1.9** (решение человека D-001, задача GAME-004; заменяет прежнее допущение 1.96). Форма `params`, `state` и `view` не меняется, меняются только числа выплат.
- Раунд состоит из одного броска: исход определяется в `start`, раунд сразу завершается. Ходов внутри раунда нет (допущение, см. журнал решений).
- Ребра у монеты нет: исходов ровно два (допущение, см. журнал решений).
- Порядок в `start` — по контракту `platform/sdk/types.ts`: всё, что может упасть, проверяется до обращения к `rng`. `rng.next()` вызывается ровно один раз, после него исключений нет. Состояние раунда — простой JSON-объект. `Math.random` не используется.

## Параметры раунда и ходы
- `params = { side: "heads" | "tails" }`. Строго эти строки в нижнем регистре.
- `validateParams` бросает `GameError('INVALID_PARAMS')`, если `params` — не объект (в том числе `null`, массив), если `side` нет или его значение иное (`"edge"`, `"HEADS"`, `1`). Лишние поля игнорируются; нормализованный результат — `{ side }` (допущение, см. журнал решений).
- `start` возвращает `{ status: "finished", state, payout }`. Раунд закрывается в том же запросе.
- `action` с любым действием бросает `GameError('INVALID_ACTION')`. Через платформу до игры такой вызов не доходит: раунд уже закрыт, и платформа отвечает `ROUND_CLOSED`.

## Результат и выплата
- Исход по одному числу rng `r ∈ [0, 1)`: `r < 0.5` → `heads`, `r ≥ 0.5` → `tails`. Граница: `0.4999 → heads`, `0.5 → tails`.
- `win = (outcome === side)`.
- `payout = win ? bet × 1.9 : 0`. Округление до центов делает платформа (`Math.round(x × 100) / 100`).
- Примеры: ставка 1 → 1.9; ставка 2 → 3.8; ставка 3.33 → 6.327 → 6.33; ставка 4 → 7.6; ставка 10 → 19.
- `state = { side, outcome, win }`.

## Что видит игрок
- `publicView(state, finished)` = `{ side, outcome, win }`. Скрытого нет: исход появляется в ответе одновременно с закрытием раунда, открытым раунд не бывает.
- После обновления страницы `open("coin")` возвращает `activeRound: null` и актуальный баланс.
- Интерфейс (`ui/index.html`, только через `window.PlatformSDK`; допущение, см. журнал решений):
  - `data-testid`: `balance`, `bet-input` (по умолчанию 1), `side-heads`, `side-tails` (выбранная кнопка помечена `aria-pressed="true"`, по умолчанию `heads`), `play` (бросок), `outcome` (текст «Орёл»/«Решка»), `payout`, `error` (код ошибки платформы).
  - Корневой элемент `data-testid="game"` с `data-state`: `idle` до первого броска, `playing` пока запрос в пути (кнопка `play` заблокирована), затем `won` или `lost`.

## Сценарии приёмки
Через `createTestPlatform({ games: [coin], rng, startBalance })` из `platform/testkit`, стартовый баланс 100, если не указано иное.

**SC-1: выигрыш на орле**
Дано `fixedRng([0.3])`, баланс 100
Когда `startRound("coin", 1, { side: "heads" })`
Тогда `status: "closed"`, `bet: 1`, `payout: 1.9`, `balance: 100.9`, `view: { side: "heads", outcome: "heads", win: true }`
И `transactions()` = `[{ type: "bet", amount: 1, balanceAfter: 99 }, { type: "payout", amount: 1.9, balanceAfter: 100.9 }]`

**SC-2: выигрыш на решке, граница 0.5 и максимальная ставка**
Дано `fixedRng([0.5])`, баланс 100
Когда `startRound("coin", 10, { side: "tails" })`
Тогда `status: "closed"`, `payout: 19`, `balance: 109`, `view: { side: "tails", outcome: "tails", win: true }`

**SC-3: проигрыш**
Дано `fixedRng([0.7])`, баланс 100
Когда `startRound("coin", 5, { side: "heads" })`
Тогда `status: "closed"`, `payout: 0`, `balance: 95`, `view: { side: "heads", outcome: "tails", win: false }`
И в `transactions()` есть `payout` с `amount: 0` и `balanceAfter: 95`

**SC-4: проигрыш у границы**
Дано `fixedRng([0.4999])`, баланс 100
Когда `startRound("coin", 2, { side: "tails" })`
Тогда `outcome: "heads"`, `win: false`, `payout: 0`, `balance: 98`

**SC-5: округление выплаты**
Дано `fixedRng([0])`, баланс 100
Когда `startRound("coin", 3.33, { side: "heads" })`
Тогда `payout: 6.33` (3.33 × 1.9 = 6.327), `balance: 103`

**SC-6: неверные параметры отклоняются до списания и до rng**
Дано `fixedRng([0.3])`, баланс 100
Когда `startRound("coin", 1, p)` для каждого `p` из: `{ side: "edge" }`, `{ side: "HEADS" }`, `{ side: 1 }`, `{}`, `null`, `"heads"`
Тогда каждый вызов бросает `INVALID_PARAMS`, `transactions()` пуст, баланс 100
Когда затем `startRound("coin", 1, { side: "heads", extra: 42 })`
Тогда раунд проходит на том же rng 0.3: `outcome: "heads"`, `payout: 1.9`, `balance: 100.9`, `view` не содержит `extra`

**SC-7: лимиты ставки**
Когда `startRound("coin", 0.5, { side: "heads" })` и `startRound("coin", 10.01, { side: "heads" })`
Тогда оба бросают `BET_OUT_OF_LIMITS`, `transactions()` пуст, баланс 100

**SC-8: недостаточно средств**
Дано `startBalance: 5`
Когда `startRound("coin", 6, { side: "heads" })`
Тогда бросается `INSUFFICIENT_FUNDS`, `transactions()` пуст, баланс 5, `open("coin").activeRound` = `null`

**SC-9: серия бросков, раунд не остаётся открытым**
Дано `fixedRng([0.1, 0.9])`, баланс 100
Когда `startRound("coin", 2, { side: "heads" })`
Тогда `payout: 3.8`, `balance: 101.8`
Когда `action(roundId, "flip")` для этого раунда
Тогда бросается `ROUND_CLOSED`, баланс 101.8
Когда `startRound("coin", 2, { side: "heads" })`
Тогда `outcome: "tails"`, `payout: 0`, `balance: 99.8`
И `open("coin")` = `{ gameId: "coin", limits: { min: 1, max: 10 }, balance: 99.8, activeRound: null }`, в `transactions()` 4 записи

**SC-10: контракт модуля игры**
Дано серверный модуль `games/coin/server/index.ts`
Тогда `id` = `"coin"`, `validateParams({ side: "tails", x: 1 })` = `{ side: "tails" }`
Когда `start({ bet: 4, params: { side: "tails" }, rng })` с rng, который отдаёт одно число 0.75 и бросает при втором вызове
Тогда результат `{ status: "finished", state: { side: "tails", outcome: "tails", win: true }, payout: 7.6 }` (4 × 1.9; сравнение с точностью до центов), rng вызван ровно 1 раз, `JSON.parse(JSON.stringify(state))` равен `state`
И `publicView(state, true)` = `{ side: "tails", outcome: "tails", win: true }`
И `action({ bet: 4, params, state, action: "flip", rng })` бросает `GameError` с кодом `INVALID_ACTION`, не вызывая rng

**SC-11: интерфейс**
Дано `ui/index.html` в happy-dom, `window.PlatformSDK` подменён: `open()` → `{ balance: 100, limits: { min: 1, max: 10 }, activeRound: null }`, `startRound(1, { side: "tails" })` → `{ status: "closed", payout: 1.9, balance: 100.9, view: { side: "tails", outcome: "tails", win: true } }`
Когда страница загружена
Тогда `data-state="idle"`, `balance` показывает 100
Когда нажаты `side-tails`, затем `play`
Тогда `startRound` вызван с `(1, { side: "tails" })`, `data-state="won"`, `outcome` содержит «Решка», `payout` содержит 1.9, `balance` показывает 100.9
Когда `startRound` отклоняется с `{ code: "INSUFFICIENT_FUNDS" }`
Тогда `error` содержит `INSUFFICIENT_FUNDS`, `balance` не меняется, кнопка `play` снова доступна
