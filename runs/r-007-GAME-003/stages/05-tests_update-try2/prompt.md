# Этап «tests_update» · роль test-writer (update)

Задача: `local-jira/GAME-003-mines-feedback.md` (GAME-003, тип feedback). Прочитай её целиком — там описание и журнал.
Область: `games/mines/` · спецификация: `games/mines/spec.md` · журнал решений: `decisions/mines.md`
Конвенции проекта: `docs/conventions.md` (обязательно). Контракт платформы: `platform/spec.md`, `platform/sdk/types.ts`, `platform/testkit/`.

Можно писать только в: `games/mines/tests/**`. Запись в другие места техническим образом заблокирована.
Человек в этом запуске не участвует: ничего не спрашивай. Не хватает информации — прими разумное допущение и верни его в поле `decisions`.

## База знаний (уроки прошлых запусков)

### KB-001 (из запуска r-002-PLAT-001)
# Требования безопасности и целостности денег задавать до кода, а не находить на ревью

**Проблема.** Платформа прошла tests/verify с первого раза (46/46), но review упал 3 раза подряд, и запуск остановился по лимиту. Каждый раунд reviewer-integrity находил новые блокирующие уязвимости: потерю ставки при сбое игры или кошелька, CSRF и отсутствие авторизации кошелька, изменяемый общий rng, доступный игре. Ничего из этого не было в spec.md и заблокированных тестах.

**Причина.** В спецификации и сценариях не было нефункциональных требований: модель угроз, поведение денег при отказах, изоляция кода игры. Требования появлялись по одному на ревью, после блокировки тестов. Тесты менять уже нельзя, поэтому исправления оставались непокрытыми, а каждое новое исправление открывало новую поверхность для замечаний. Дополнительно: в сообщении об остановке вместо замечаний review выводится результат verify («Проверки пройдены…»), и причина остановки скрыта.

**Правило.** Analyst: в спецификации любой платформы или игры с деньгами заводи отдельные сценарии (с ID) по чек-листу. (a) Отказ, таймаут или потерянный ответ кошелька до и после списания. (b) Исключение или несериализуемое состояние игры после списания. (c) Кто может вызывать кошелёк: Origin/CSRF, Content-Type, токен. (d) Что игра может испортить через ctx: rng, общие объекты, глобальный fetch. (e) Идемпотентность txId. Test-writer: на каждый такой сценарий пиши тест отказа с проверкой баланса и числа транзакций, а не только happy path. Triage: при остановке по лимиту review показывай последние замечания ревьюера, а не вывод verify.

### KB-005 (из запуска r-003-PLAT-001)
# Проверка не должна падать на том, что агент этапа не может исправить (ссылка на отчёт текущего запуска)

**Проблема.** docs_check падал дважды подряд на ссылке [[runs/r-003-PLAT-001/report]] в local-jira/PLAT-001-platform-platform.md, и запуск остановился по лимиту попыток docs. При этом README, TSDoc и все ссылки в platform/ были в порядке, тесты прошли 46/46. Повторная попытка docs ничего не могла изменить.

**Причина.** Оркестратор при старте пишет в журнал задачи ссылку [[runs/<id>/report]] (factory/run.ts, journal), а report.md создаёт только в конце запуска (writeReport). Проверка docs (brokenWikiLinks в factory/lib/checks.ts) проверяет и файл задачи, поэтому в середине запуска эта ссылка всегда битая. Агенту docs запрещено писать в local-jira/. Оркестратор не отличает ошибку агента от ошибки в окружении или в самой проверке и тратит на неё попытки.

**Правило.** Factory/triage: проверка этапа может требовать только то, что агент этапа способен исправить в своих разрешённых путях. Файлы, которые пишет оркестратор (журнал задачи, runs/), не проверяй в проверке агента. Если всё же проверяешь, создавай заглушку runs/<id>/report.md при старте запуска или пропускай ссылку на отчёт текущего запуска. Если проверка упала на файле вне разрешённых путей этапа, не перезапускай агента, а останавливай запуск с причиной «дефект проверки или оркестратора». Docs-writer и любой агент: если неисправное место вне твоих разрешённых путей, ничего не меняй, явно назови файл, строку и причину и отметь это в decisions как дефект оркестратора. Не пытайся обойти запрет на запись.

### KB-006 (из запуска r-005-GAME-001)
# Игра с исходом от rng: шаблон спецификации и тестов, который проходит с первой попытки (однораундовые и многоходовые игры)

**Проблема.** Монетка (GAME-001) и Мины (GAME-002, многоходовая игра: reveal или cashout, поле 5×5, 3 мины) прошли весь конвейер spec → tests → red_check → implement → verify → review → docs без повторов. Этот подход стоит повторять, а не придумывать заново в каждой игре.

**Причина.** Спецификация сразу задавала однозначную функцию исхода от rng, точное число вызовов rng и конкретные числа в каждом сценарии. В Минах весь случайный исход определялся в start, а action был детерминирован. Множитель был задан формулой и таблицей контрольных значений. Лимиты, кошелёк и округление в спеке не пересказаны, а даны ссылкой на [[platform/spec]]. Поэтому тесты и реализация не расходились в толковании.

**Правило.** Analyst: задавай исход явной формулой от значений rng.next() и указывай точное число вызовов rng за раунд. В многоходовой игре определяй весь случайный исход в start: например, расставляй скрытые объекты частичной тасовкой Фишера — Йетса за фиксированное число вызовов. Запрещай action обращаться к rng и указывай, что раунд открыт, пока секрет скрыт в publicView. Если выплата зависит от шага, давай формулу множителя и таблицу контрольных значений, а для комбинаторики требуй целочисленные C(n,k). Пиши отдельные сценарии на обе границы каждого порога rng, на округление выплаты с конкретными числами, на неверные params, на недопустимый ход, на ход в закрытом раунде, на cashout без единого шага и на автозавершение при исчерпании безопасных ходов. Неверные params отклоняются до списания ставки и до rng. Лимиты, кошелёк и округление не пересказывай, а ссылайся на [[platform/spec]]: оставь по одному сценарию на лимиты и на недостаток средств. В каждом сценарии указывай ставку, значения rng, выплату и итоговый баланс. Test-writer: сценарии раундов прогоняй через createTestPlatform с fixedRng и проверяй точный баланс и журнал транзакций. Прямые вызовы модуля проверяй отдельным файлом. В нём проверяй число вызовов rng в start, то, что action не вызывает rng и не меняет переданный state, что состояние сериализуется и что при отказе rng не вызывался. Интерфейс проверяй в happy-dom с подменённым window.PlatformSDK. Developer: проверяй params и в validateParams, и в start, до rng.next(). Проверяй ход целиком до любых изменений и возвращай новый state. Math.random не используй, округление оставь платформе.

### KB-007 (из запуска r-005-GAME-001)
# Агент этапа может не иметь Bash: прогон тестов и tsc делает оркестратор, не трать попытки на обход

**Проблема.** В GAME-001 test-writer не смог сверить тесты с эталонной реализацией: запуск из scratchpad был запрещён. Docs-writer не смог прогнать tsc и vitest (Bash запрещён в режиме don't ask). Оба потратили силы на попытки и проверяли правки только чтением.

**Причина.** Права агентов на выполнение команд различаются по этапам. Агенту об этом не сообщают заранее. При этом red_check, verify и docs_check оркестратор всё равно запускает после этапа.

**Правило.** Перед тем как запускать команды, учитывай, что Bash или запись в scratchpad могут быть запрещены. Если первая команда отклонена, не пробуй обходные пути: никаких других интерпретаторов, копий в другие каталоги или запуска тестов ради чужих действий. Проверь работу чтением (импорты, типы, ссылки на существующие файлы) и запиши в decisions, что прогон остаётся за проверкой оркестратора (red_check, verify, docs_check). Test-writer без возможности прогона: сверь каждый тест с текстом сценария и контрактом platform/testkit вручную, чтобы red_check не упал из-за ошибки в самом тесте.

Если применил запись — укажи её ID в `applied_kb`.

## Что сделать

Обнови тесты в `games/mines/tests/` под изменённую спецификацию. Тесты меняешь только ты.
## Вход от предыдущего этапа

Тесты не проходят проверку типов:
games/mines/tests/module.test.ts(75,44): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(96,56): error TS2322: Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(106,54): error TS2322: Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(120,54): error TS2322: Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(129,55): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(138,41): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(142,45): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(154,54): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(157,54): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(168,45): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(189,45): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(201,45): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(213,45): error TS2322: Type '{ mines: number; }' is not assignable to type 'MinesParams'.
  Property 'mines' is incompatible with index signature.
    Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(231,55): error TS2322: Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(251,64): error TS2322: Type 'number' is not assignable to type 'never'.
games/mines/tests/module.test.ts(254,55): error TS2322: Type 'number' is not assignable to type 'never'.

