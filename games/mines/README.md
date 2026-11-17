# Мины
Спецификация: [[games/mines/spec]] · Решения: [[decisions/mines]] · Платформа: [[platform/spec]] ([[platform/README]]) · Задачи: [[local-jira/GAME-002-mines-new-game]], доработка [[local-jira/GAME-003-mines-feedback]]

Поле 5 × 5. Перед ставкой игрок выбирает число мин `m` от 1 до 24 (по умолчанию 3). Затем он по одной открывает клетки, и каждая безопасная клетка увеличивает множитель. Выигрыш можно забрать после первой безопасной клетки. Мина означает проигрыш.

## Устройство
| Файл | За что отвечает |
|---|---|
| `manifest.json` | `{ id: "mines", title, server, ui }`: по нему платформа находит модуль и интерфейс. |
| `server/index.ts` | `export default` — `GameModule` (`id`, `validateParams`, `start`, `action`, `publicView`). Также экспортирует константы `CELL_COUNT = 25`, `MIN_MINES = 1`, `MAX_MINES = 24`, `DEFAULT_MINES = 3`, `RTP_PERCENT = 98` ([[decisions/mines#D-037]]), функцию `multiplier(k, mineCount = 3)` и типы `MinesParams`, `MinesState`, `MinesAction`, `MinesOutcome`, `MinesView`. Внутренние функции: `parseParams` и `isMineCount` (проверка params), `placeMines` (расстановка мин), `parseAction` (проверка хода), `binom` (целый `C(n, k)`). |
| `ui/index.html` | Интерфейс: один файл с инлайновыми стилями и скриптом. Работает только через `window.PlatformSDK` (`/sdk.js`). |
| `tests/` | Приёмочные тесты SC-1…SC-20: `rounds.test.ts` (раунды через testkit), `module.test.ts` (контракт модуля), `ui.test.ts` (интерфейс в happy-dom). |

Игра импортирует из платформы только `platform/sdk/types.ts` (`GameModule`, `Rng`, `Step`, `GameError`). О балансе она не знает: ставку списывает, а `payout` из `Step` зачисляет и округляет до центов платформа.

## Параметры раунда
`params = { mines: m }` ([[decisions/mines#D-019]]). Проверку делает `parseParams`, её вызывают и `validateParams`, и `start` (до первого `rng.next()`):

- `undefined` или объект без собственного поля `mines` → `{ mines: 3 }`;
- `mines` — целое число (`typeof === 'number'`, `Number.isInteger`) от 1 до 24 → `{ mines }`, лишние поля отбрасываются;
- `GameError('INVALID_PARAMS')`: `null`, массив, строка или число вместо объекта, а также `mines`, равное `0`, `25`, `2.5`, `"5"`, `null` или `undefined`. Наличие поля определяется через `hasOwnProperty`, поэтому `{ mines: undefined }` даёт ошибку, а не значение по умолчанию ([[decisions/mines#D-038]]).

## Состояние раунда
`MinesState` — простой JSON-объект:

```ts
{ mines: number[]; revealed: number[]; hit: number | null; outcome: 'mine' | 'cashout' | 'cleared' | null }
```

- `mines` — клетки с минами по возрастанию, `m = mines.length`. Задаются в `start` и дальше не меняются. Число мин `action` и `publicView` берут только отсюда, `params` не читают ([[decisions/mines#D-022]]).
- `revealed` — открытые безопасные клетки в порядке открытия, `k = revealed.length`.
- `hit` — клетка с миной, на которой игрок проиграл, иначе `null`.
- `outcome` — `null`, пока раунд открыт.

Клетки нумеруются `0…24` построчно: `cell = row × 5 + col` ([[decisions/mines#D-002]]).

Ходы ([[decisions/mines#D-007]]). `action` не меняет переданный `state`, а возвращает новый (массивы копируются):

| Ход | Условие | Результат |
|---|---|---|
| `{ type: 'reveal', cell }`, безопасная клетка | `k + 1 < 25 − m` | `continue`, клетка добавляется в `revealed` |
| `{ type: 'reveal', cell }`, последняя безопасная клетка | `k + 1 = 25 − m` | `finished`, `outcome: 'cleared'`, `payout = bet × M(25 − m)` ([[decisions/mines#D-023]]) |
| `{ type: 'reveal', cell }`, мина | — | `finished`, `outcome: 'mine'`, `hit = cell`, `payout = 0` |
| `{ type: 'cashout' }` | `k ≥ 1` | `finished`, `outcome: 'cashout'`, `payout = bet × M(k)` ([[decisions/mines#D-005]]) |

При `m = 24` первая же безопасная клетка завершает раунд, поэтому `cashout` в таком раунде невозможен.

`parseAction` проверяет ход до любых изменений и бросает `GameError('INVALID_ACTION')`, если ход не объект (в том числе `"cashout"` и `null`), `type` неизвестен, `cell` не целое число из `0…24` или уже открыта, `cashout` запрошен при `k = 0`. Состояние и баланс при этом не меняются.

Раунд завершается на мине, на `cashout` или на безопасной клетке номер `25 − m`. Ход в закрытом раунде до игры не доходит: платформа отвечает `ROUND_CLOSED`. `action` сам не проверяет `state.outcome` и полагается на этот контракт платформы ([[platform/spec]]).

## Как определяется результат
**Расстановка мин** — в `start`, ровно `m` вызовов `rng.next()`, частичная тасовка Фишера — Йетса ([[decisions/mines#D-020]], обобщение [[decisions/mines#D-003]]). Берётся `c = [0, 1, …, 24]`, для `i = 0 … m − 1` вычисляется `j = i + floor(rᵢ × (25 − i))`, и `c[i]` меняется местами с `c[j]`. Мины — `c[0..m−1]` по возрастанию. Первые три шага не зависят от `m`, поэтому при `m = 3` расстановка прежняя. Примеры:

| m | rng | мины |
|---|---|---|
| 3 | `[0.5, 0.75, 0.25]` | `[7, 12, 19]` |
| 1 | `[0.5]` | `[12]` |
| 5 | `[0.5, 0.75, 0.25, 0, 0]` | `[3, 4, 7, 12, 19]` |
| 24 | 24 раза `0` | `[0, 1, …, 23]` |

- Исход фиксируется до первого хода. `action` к `rng` не обращается, поэтому подстроить мины под ходы игрока нельзя.
- `start` проверяет `params` до обращения к `rng`. После вызовов `rng` исключений нет (контракт `platform/sdk/types.ts`).
- `placeMines` рассчитывает на то, что `rng.next()` возвращает число в `[0, 1)`, иначе `j` вышел бы за пределы массива. Это гарантирует обёртка `rng` в ядре платформы: число вне `[0, 1)` даёт `INTERNAL_ERROR` ([[decisions/platform#D-047]], [[platform/README]]). Своей проверки в игре нет: бросать исключение после обращения к `rng` контракт запрещает.

**Множитель** ([[decisions/mines#D-021]], обобщение [[decisions/mines#D-004]]) считает `multiplier(k, m)`:

```
M(0) = 1                                              (только для отображения)
M(k) = Math.round(98 × C(25, k) / C(25 − m, k)) / 100  при 1 ≤ k ≤ 25 − m
```

Это честный множитель для `m` мин, умноженный на 0.98 (house edge 2 % при любом `m`) и округлённый до сотых. `98` — это `RTP_PERCENT`: целочисленная форма округляет половину цента вверх без ошибки плавающей точки (`m = 5, k = 1`: 98 × 25 / 20 = 122.5 → 1.23). `C(n, k)` считает `binom`, промежуточные результаты у неё целые.

| m \ k | 1 | 2 | 3 | 4 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.02 | 1.07 | 1.11 | | | | | | 12.25 | 24.5 |
| 3 | 1.11 | 1.27 | 1.46 | 1.69 | | | 563.5 | 2254 | — | — |
| 5 | 1.23 | 1.55 | 1.98 | 2.56 | 8677.9 | 52067.4 | — | — | — | — |
| 24 | 24.5 | — | — | — | — | — | — | — | — | — |

**Выплата:** `payout = bet × M(k)` от округлённого множителя. До центов её округляет платформа: 3.33 × 1.27 = 4.2291 → 4.23. На мине `payout = 0`. Верхнего предела выигрыша нет: при `m = 5, k = 20` ставка 10 даёт 520 674 (замечание R-4 ревью, отдельный вопрос к спецификации).

## Интерфейс
`publicView(state, finished)` ([[decisions/mines#D-009]]):

- раунд открыт: `{ mineCount: m, revealed, multiplier: M(k), nextMultiplier: M(k + 1) }`, без `mines`, `hit` и `outcome`, поэтому расположение мин не раскрывается;
- раунд завершён: `{ mineCount: m, revealed, multiplier: M(k), nextMultiplier: null, mines, hit, outcome }`.

`ui/index.html` ([[decisions/mines#D-010]], доработка GAME-003):

- Корень `data-testid="game"`, у него `data-state`: `idle` (раунда нет), `playing` (раунд открыт), `won` (`cashout` или `cleared`), `lost` (мина).
- `data-testid`: `balance`, `bet-input` (по умолчанию 1; `min` и `max` берутся из `open().limits`), `mines-input`, `play`, `cashout`, `multiplier`, `next-multiplier`, `payout`, `error`, клетки `cell-0` … `cell-24` с `data-cell-state` = `hidden | safe | mine | hit`.
- `mines-input` — `<select>` с вариантами `1…24`, по умолчанию `3` ([[decisions/mines#D-024]]). `play` вызывает `sdk.startRound(bet, { mines: m })`, где `m` — число (`parseInt`). При восстановлении раунда и после хода `mines-input` получает `view.mineCount`.
- В `idle` клетки и `cashout` заблокированы. В `playing` заблокированы `play`, `bet-input` ([[decisions/mines#D-017]]), `mines-input` и открытые клетки, `cashout` доступна при `k ≥ 1`. Пока идёт запрос к платформе, заблокировано всё.
- `cashout` в `playing` при `k ≥ 1` показывает `Забрать $X`, где `X = (Math.round(roundBet × view.multiplier × 100) / 100).toFixed(2)`. `roundBet` — ставка из ответа `startRound` или из `activeRound`, а не из поля ввода. В остальных случаях текст — `Забрать` ([[decisions/mines#D-025]]).
- `multiplier` показывает `×M(k)`, `next-multiplier` — `×M(k+1)` или «—». Без раунда в обоих полях «—» ([[decisions/mines#D-018]]). Блок «Мин на поле» (`#mine-count`) показывает `view.mineCount`, а без раунда — значение `mines-input`. После конца раунда он показывает число мин прошедшего раунда до следующей игры, даже если выбор уже изменён (замечание R-2 ревью, логику этап документации не меняет).
- Клетки ([[decisions/mines#D-026]], [[decisions/mines#D-041]]): клетки из `revealed` — `safe` (зелёный фон, значок ◆), клетка `hit` — `hit` (красный фон, ✹), остальные клетки из `view.mines` — `mine` (серый фон через `--neutral`, ✹), прочие — `hidden`. `data-cell-state` выставляется в `render()` сразу по ответу платформы.
- Анимация ([[decisions/mines#D-027]], [[decisions/mines#D-039]]): клетка, которая при отрисовке переходит из `hidden` в другое состояние, получает класс `flip` — `rotateY` за 250 мс. Класс снимается по `animationend`, при `prefers-reduced-motion` анимации нет. Состояние и следующий клик анимацию не ждут.
- При загрузке вызывается `sdk.open()`. Если есть `activeRound`, раунд восстанавливается и игру можно продолжить.
- Ошибки ([[decisions/mines#D-028]], [[decisions/mines#D-042]]): код показывается в `error` как `КОД: пояснение`. Если для кода нет русского текста, берётся `message`. Коды из `SHOW_ONLY_CODES` (`BET_OUT_OF_LIMITS`, `INSUFFICIENT_FUNDS`, `INVALID_PARAMS`, `INVALID_ACTION`, `NETWORK_ERROR`) только показываются: состояние экрана не меняется, клетка с отклонённым ходом остаётся `hidden` ([[decisions/mines#D-013]]). После любого другого кода (`ROUND_CLOSED`, `ROUND_NOT_FOUND`, `WALLET_UNAVAILABLE`, `INTERNAL_ERROR` и неизвестных) `resync()` заново вызывает `sdk.open()` без перезагрузки страницы: обновляет баланс и применяет `activeRound`, а если раунда нет, переходит в `idle`. Если упал и этот `open()`, экран не меняется, а к ошибке через « · » дописывается второй код ([[decisions/mines#D-040]]). Список инвертирован относительно спеки (там закрытый список для пересинхронизации): так обойдена проверка границ, которая ловит подстроку `wallet` в коде игры (D-042, замечание R-1 ревью).

## Проверка
```
pnpm exec vitest run games/mines/tests
pnpm exec tsc --noEmit -p tsconfig.json
```
