---
id: GAME-001
status: done
rounds:
  spec: 1
  tests: 1
  implement: 1
  review: 1
  docs: 1
  learn: 1
runs:
  - r-005-GAME-001
type: new-game
pipeline: new-game
scope: coin
title: Монетка
phase: END
---
# GAME-001: Монетка

## Описание

# Монетка

Игрок выбирает сторону и делает ставку, при угадывании получает выплату.

## Ссылки

- Входное описание: `specs/coin.md`
- Спецификация: [[games/coin/spec]]
- Решения: [[decisions/coin]]
- Документация: [[games/coin/README]]

## Журнал
- 17:06 запуск [[runs/r-005-GAME-001/report|r-005-GAME-001]] (auto)
- 17:06 scaffold → pass (0s)
- 17:07 spec: новые допущения D-001, D-002, D-003, D-004, D-005, D-006, D-007 → [[decisions/coin]]
- 17:07 spec → done (1m23s)
- 17:10 tests: новые допущения D-008, D-009, D-010, D-011, D-012 → [[decisions/coin]]
- 17:10 tests → done (2m57s)
- 17:10 red_check → pass (5s)
- 17:10 lock_tests → pass (0s)
- 17:12 implement: новые допущения D-013, D-014, D-015 → [[decisions/coin]]
- 17:12 implement → done (1m26s)
- 17:12 verify → pass (2s)
- 17:13 review → pass (44s)
- 17:13 docs → done (53s)
- 17:13 docs_check → pass (2s)
- 17:14 learn → done (33s)
