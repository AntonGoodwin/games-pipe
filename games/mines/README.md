# Мины
Спецификация: [[games/mines/spec]] · Решения: [[decisions/mines]] · Платформа: [[platform/spec]] ([[platform/README]]) · Задача: [[local-jira/GAME-002-mines-new-game]]

Поле 5 × 5 с тремя скрытыми минами. Игрок делает ставку и по одной открывает клетки. Каждая безопасная клетка увеличивает множитель. Выигрыш можно забрать после первой безопасной клетки, мина означает проигрыш.

## Устройство
| Файл | За что отвечает |
|---|---|
| `manifest.json` | `{ id: "mines", title, server, ui }`: по нему платформа находит модуль и интерфейс. |
| `server/index.ts` | `export default` — `GameModule` (`id`, `validateParams`, `start`, `action`, `publicView`). Плюс экспортированные константы (`CELL_COUNT = 25`, `MINE_COUNT = 3`, `SAFE_COUNT = 22`, `RTP = 0.98`), функция `multiplier(k)` и типы `MinesParams`, `MinesState`, `MinesAction`, `MinesOutcome`, `MinesView`. Внутренние функции: `placeMines` (расстановка мин), `parseAction` (проверка хода), `binom`, `round2`. |
| `ui/index.html` | Интерфейс: один файл с инлайновыми стилями и скриптом. Работает только через `window.PlatformSDK` (`/sdk.js`). |
| `tests/` | Приёмочные тесты SC-1…SC-15: `rounds.test.ts` (раунды через testkit), `module.test.ts` (контракт модуля), `ui.test.ts` (интерфейс в happy-dom). |

Игра импортирует из платформы только `platform/sdk/types.ts` (`GameModule`, `Rng`, `Step`, `GameError`). О кошельке и балансе она не знает: ставку списывает, а `payout` из `Step` зачисляет и округляет до центов платформа.

## Состояние раунда
`MinesState` — простой JSON-объект:

```ts
{ mines: number[3]; revealed: number[]; hit: number | null; outcome: 'mine' | 'cashout' | 'cleared' | null }
```

- `mines` — клетки с минами по возрастанию. Задаются в `start` и дальше не меняются.
- `revealed` — открытые безопасные клетки в порядке открытия, `k = revealed.length`.
- `hit` — клетка с миной, на которой игрок проиграл, иначе `null`.
- `outcome` — `null`, пока раунд открыт.

Клетки нумеруются `0…24` построчно: `cell = row × 5 + col` ([[decisions/mines#D-002]]).

Параметров у игры нет: `validateParams` возвращает `{}` для объекта или `undefined` и отбрасывает лишние поля, в том числе `mines`. `null`, массив, строка и число дают `GameError('INVALID_PARAMS')` ([[decisions/mines#D-008]]).

Ходы ([[decisions/mines#D-007]]). `action` не меняет переданный `state`, а возвращает новый:

| Ход | Условие | Результат |
|---|---|---|
| `{ type: 'reveal', cell }`, безопасная клетка | `k + 1 < 22` | `continue`, клетка добавляется в `revealed` |
| `{ type: 'reveal', cell }`, 22-я безопасная клетка | `k + 1 = 22` | `finished`, `outcome: 'cleared'`, `payout = bet × M(22)` ([[decisions/mines#D-006]]) |
| `{ type: 'reveal', cell }`, мина | — | `finished`, `outcome: 'mine'`, `hit = cell`, `payout = 0` |
| `{ type: 'cashout' }` | `k ≥ 1` | `finished`, `outcome: 'cashout'`, `payout = bet × M(k)` ([[decisions/mines#D-005]]) |

`parseAction` проверяет ход до любых изменений и бросает `GameError('INVALID_ACTION')`, если: ход не объект (в том числе `"cashout"` и `null`), `type` неизвестен, `cell` не целое число из `0…24` или уже открыта, `cashout` запрошен при `k = 0`. Состояние и баланс при этом не меняются.

Раунд завершается на мине, на `cashout` или на 22-й безопасной клетке. Ход в закрытом раунде до игры не доходит: платформа отвечает `ROUND_CLOSED`. `action` сам не проверяет `state.outcome` и полагается на этот контракт платформы ([[platform/spec]]).

## Как определяется результат
**Расстановка мин** — в `start`, ровно 3 вызова `rng.next()`, частичная тасовка Фишера — Йетса ([[decisions/mines#D-003]]). Берётся `c = [0, 1, …, 24]`, для `i = 0, 1, 2` вычисляется `j = i + floor(rᵢ × (25 − i))` и `c[i]` меняется местами с `c[j]`. Мины — `c[0..2]` по возрастанию. Например, `fixedRng([0.5, 0.75, 0.25])` даёт мины `[7, 12, 19]`.

- Исход фиксируется до первого хода. `action` к `rng` не обращается, поэтому подстроить мины под ходы игрока нельзя.
- `validateParams` вызывается в `start` до обращения к `rng`. После вызовов `rng` исключений нет (контракт `platform/sdk/types.ts`).
- `placeMines` рассчитывает на то, что `rng.next()` возвращает число в `[0, 1)`. Иначе `j` вышел бы за пределы массива. Это гарантирует обёртка `rng` в ядре платформы: число вне `[0, 1)` даёт `INTERNAL_ERROR` ([[decisions/platform#D-047]], [[platform/README]]). Своей проверки в игре нет: бросать исключение после обращения к `rng` контракт запрещает.

**Множитель** ([[decisions/mines#D-004]]): `M(0) = 1` (только для отображения), при `k ≥ 1` `M(k) = round2(0.98 × C(25, k) / C(22, k))`, где `round2(x) = Math.round(x × 100) / 100`. Это честный множитель для 3 мин с house edge 2 % (`RTP = 0.98`). Множитель считается функцией `multiplier(k)`, а `C(n, k)` — функцией `binom`.

| k | 1 | 2 | 3 | 4 | 5 | 6 | 21 | 22 |
|---|---|---|---|---|---|---|---|---|
| M(k) | 1.11 | 1.27 | 1.46 | 1.69 | 1.98 | 2.33 | 563.5 | 2254 |

**Выплата:** `payout = bet × M(k)` от округлённого множителя. До центов её округляет платформа: 3.33 × 1.27 = 4.2291 → 4.23. На мине `payout = 0`.

## Интерфейс
`publicView(state, finished)` ([[decisions/mines#D-009]]):

- раунд открыт: `{ mineCount: 3, revealed, multiplier: M(k), nextMultiplier: M(k + 1) }`, без `mines`, `hit` и `outcome`, поэтому расположение мин не раскрывается;
- раунд завершён: `{ mineCount: 3, revealed, multiplier: M(k), nextMultiplier: null, mines, hit, outcome }`.

`ui/index.html` ([[decisions/mines#D-010]]):

- Корень `data-testid="game"`, у него `data-state`: `idle` (раунда нет), `playing` (раунд открыт), `won` (`cashout` или `cleared`), `lost` (мина).
- `data-testid`: `balance`, `bet-input` (по умолчанию 1; `min` и `max` берутся из `open().limits`), `play`, `cashout`, `multiplier`, `next-multiplier`, `payout`, `error`, клетки `cell-0` … `cell-24` с `data-cell-state` = `hidden | safe | mine`.
- В `idle` клетки и `cashout` заблокированы. В `playing` заблокированы `play`, `bet-input` ([[decisions/mines#D-017]]) и открытые клетки, `cashout` доступна при `k ≥ 1`. Пока идёт запрос к платформе, заблокировано всё.
- `multiplier` показывает `×M(k)`, `next-multiplier` — `×M(k+1)` или «—». Без раунда в обоих полях «—» ([[decisions/mines#D-018]]).
- После завершения мины показываются как `mine`, клетка `hit` обведена.
- При загрузке вызывается `sdk.open()`. Если есть `activeRound`, раунд восстанавливается и игру можно продолжить.
- Ошибка платформы показывается в `error` как `КОД: пояснение`. Если для кода нет русского текста, берётся `message`. `data-state`, клетки и баланс не меняются, состояние через `open()` заново не запрашивается ([[decisions/mines#D-013]], [[decisions/mines#D-016]]). Например, после `ROUND_CLOSED` из другой вкладки интерфейс остаётся в `playing` до перезагрузки страницы.

## Проверка
```
pnpm exec vitest run games/mines/tests
pnpm exec tsc --noEmit -p tsconfig.json
```
