---
id: GAME-003
status: done
rounds:
  triage: 1
  spec_update: 1
  tests_update: 2
  implement: 2
  review: 1
  docs: 1
  learn: 1
runs:
  - r-007-GAME-003
type: feedback
pipeline: feedback
scope: mines
title: Доработка mines по замечаниям
phase: END
parent: GAME-002
---
# GAME-003: Доработка mines по замечаниям

## Описание

Замечания (`feedback/mines-01.md`):

# Замечания к «Минам»

1. Интерфейс: после окончания раунда показать все мины на поле, а клетку, на которой игрок подорвался, выделить красным. Открытые безопасные клетки — зелёным.
2. Интерфейс: на кнопке «Забрать» показывать сумму, которую игрок получит прямо сейчас, например «Забрать $3.92».
3. Интерфейс: при открытии клетки — короткая анимация переворота (до 300 мс).
4. Правила: перед ставкой игрок выбирает число мин от 1 до 24 (по умолчанию 3). Множитель считается от выбранного числа мин.

## Ссылки

- Родительская задача: [[local-jira/GAME-002-mines-new-game|GAME-002]]
- Спецификация: [[games/mines/spec]]
- Решения: [[decisions/mines]]

## Журнал
- 17:56 запуск [[runs/r-007-GAME-003/report|r-007-GAME-003]] (auto)
- 17:56 triage → behavior (20s)
- 18:00 spec_update: новые допущения D-019, D-020, D-021, D-022, D-023, D-024, D-025, D-026, D-027, D-028 → [[decisions/mines]]
- 18:00 spec_update → done (3m38s)
- 18:05 tests_update: новые допущения D-029, D-030, D-031, D-032, D-033, D-034 → [[decisions/mines]]
- 18:05 tests_update → done (5m25s)
- 18:05 coverage_check → fail (1s)
- 18:06 tests_update: новые допущения D-035, D-036 → [[decisions/mines]]
- 18:06 tests_update → done (39s)
- 18:06 coverage_check → pass (1s)
- 18:06 lock_tests → pass (0s)
- 18:09 implement: новые допущения D-037, D-038, D-039, D-040, D-041 → [[decisions/mines]]
- 18:09 implement → done (2m49s)
- 18:09 verify → fail (2s)
- 18:10 implement: новые допущения D-042 → [[decisions/mines]]
- 18:10 implement → done (1m17s)
- 18:10 verify → pass (2s)
- 18:11 review → pass (1m03s)
- 18:13 docs → done (1m46s)
- 18:13 docs_check → pass (2s)
- 18:14 learn → done (46s)
