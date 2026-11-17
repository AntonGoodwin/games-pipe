# Этап «learn» · роль librarian

Задача: `local-jira/PLAT-001-platform-platform.md` (PLAT-001, тип platform). Прочитай её целиком — там описание и журнал.
Область: `platform/` · спецификация: `platform/spec.md` · журнал решений: `decisions/platform.md`
Конвенции проекта: `docs/conventions.md` (обязательно). Контракт платформы: `platform/spec.md`, `platform/sdk/types.ts`, `platform/testkit/`.

Можно писать только в: никуда (этап только читает). Запись в другие места техническим образом заблокирована.
Человек в этом запуске не участвует: ничего не спрашивай. Не хватает информации — прими разумное допущение и верни его в поле `decisions`.

## База знаний (уроки прошлых запусков)

База знаний для твоей роли пока пуста.

Если применил запись — укажи её ID в `applied_kb`.

## Что сделать

Это ретроспектива запуска. Ниже события запуска. Найди проблемы, их причины и правило, которое помешает им повториться. Не дублируй существующие записи — обнови их (поле id). Пиши только то, что реально пригодится следующим запускам; пустой список — нормальный ответ.

## События запуска

Задача PLAT-001 (platform, platform), конвейер platform.
#1 review (попытка 1) → pass: ### reviewer-integrity: пройдено (4 замечаний) - R-1 [minor] platform/core/engine.ts:344 — Обёртка guardedRng продолжает работать и после возврата из start/action. Игра может сохранить ctx.rng в переменной модуля и вызывать next() позже, вне своего раунда: в обработчике другого раунда или между раундами. Контракт (sdk/types.ts:8) это запрещает, но код запрет не проверяет. С cryptoRng на исход это не влияет. С детерминированным rng (fixedRng/seededRng в testkit) такой вызов сдвигает последовательность чисел для других игр. Как исправить: добавить в обёртку флаг active и сбрасывать его в finally после вызова игры, а next() у неактивной обёртки должен бросать INTERNAL_ERROR. - R-2 [minor] platf
…[обрезано 1326 символов]
#2 docs (попытка 1) → done: Написал документацию платформы. Тесты и tsc сам не запускал: Bash в этом запуске запрещён, поэтому проверка остаётся за оркестратором. Создан `platform/README.md`. В нём: - устройство по модулям: кошелёк, ядро, движок, SDK, testkit, запуск, shared; - состояние раунда: поля RoundRecord, порядок проверок в startRound, как ходы меняют раунд и когда он завершается, досылка pendingBet/pendingPayout, таблица ошибок игры; - как определяется результат: cryptoRng, обёртка rng на каждый вызов, формула payout, round2; - интерфейс оболочки с data-testid; - известные ограничения из ревью r-003; - команды проверки. Все вики-ссылки ведут на существующие файлы: `platform/spec`, `decisions/platform` (с якоря
…[обрезано 879 символов]
#3 docs_check (попытка 0) → fail: Битые ссылки: - local-jira/PLAT-001-platform-platform.md: [[runs/r-003-PLAT-001/report]]
#4 docs (попытка 2) → done: The docs check failed on a link I'm not allowed to fix: it is in the task file, outside platform/**. Everything in platform/ is already in order, so I changed nothing. 1. The failing link [[runs/r-003-PLAT-001/report]] is in local-jira/PLAT-001-platform-platform.md, which this stage can't write to. The orchestrator adds that line to the task journal when the run starts. But factory/run.ts writes report.md only when the run ends (writeReport), while the check (brokenWikiLinks in factory/lib/checks.ts) runs during the run. So this link fails the docs check on every run, whatever the docs say: runs r-001 and r-002 have report.md, r-003 does not yet. It needs a fix in factory/: either skip the c
…[обрезано 962 символов]
#5 docs_check (попытка 0) → fail: Битые ссылки: - local-jira/PLAT-001-platform-platform.md: [[runs/r-003-PLAT-001/report]]



ЗАПУСК ОСТАНОВЛЕН: лимит попыток этапа «docs» исчерпан (2). Последний результат этапа «docs»:
The docs check failed on a link I'm not allowed to fix: it is in the task file, outside platform/**. Everything in platform/ is already in order, so I changed nothing.

1. The failing link [[runs/r-003-PLAT-001/report]] is in local-jira/PLAT-001-platform-platform.md, which this stage can't write to. The orchestrator adds that line to the task journal when the run starts. But factory/run.ts writes report.md only when the run ends (writeReport), while the check (brokenWikiLinks in factory/lib/checks.ts) runs during the run. So this link fails the docs check on every run, whatever the docs say: runs r-001 and r-002 have report.md, r-003 does not yet. It needs a fix in factory/: either skip the current run's report in the link check, or write a placeholder report.md when the run starts. Re-running docs won't help until that change is made.

2. My area: I checked with Grep, since running scripts was blocked. Every export in platform/**/*.ts outside tests/ has a /** */ comment directly above it, in wallet, core, sdk/types, testkit and shared. platform/README.md is in place and matches the code: structure, round state, how the result is determined, the interface and how to run the checks. Its wiki links (platform/spec, decisions/platform, local-jira/PLAT-001-platform-platform, docs/conventions) and the ones in spec.md lead to existing files.

I didn't edit the code or the README, so the tsc and test results shouldn't change. The last docs_check passed all 46 of 46 tests.

Assumption (decisions): I did not try to get around the write ban on local-jira/. The broken link is treated as an orchestrator defect and handed to whoever maintains factory/.