# Сводка по запускам

Обновляется оркестратором после каждого запуска.

| Запуск | Задача | Конвейер | Кто запустил | Итог | Время | Итерации AI-этапов | Токены in/out | Стоимость* |
|---|---|---|---|---|---|---|---|---|
| [[runs/r-001-PLAT-001/report\|r-001-PLAT-001]] | PLAT-001 | platform | auto | in-progress | 2m13s | spec×1 | 222.7k / 14.6k | $0.73 |
| [[runs/r-002-PLAT-001/report\|r-002-PLAT-001]] | PLAT-001 | platform | auto | in-progress | 30m06s | tests×1 implement×4 review×3 | 9134.8k / 189.3k | $11.76 |
| [[runs/r-003-PLAT-001/report\|r-003-PLAT-001]] | PLAT-001 | platform | auto | stopped | 4m18s | review×1 docs×2 | 1822.0k / 21.2k | $2.37 |
| [[runs/r-004-PLAT-001/report\|r-004-PLAT-001]] | PLAT-001 | platform | auto | done | 51s | docs×1 | 372.2k / 3.6k | $0.51 |
| [[runs/r-005-GAME-001/report\|r-005-GAME-001]] | GAME-001 | new-game | auto | done | 8m04s | spec×1 tests×1 implement×1 review×1 docs×1 | 2566.4k / 46.1k | $3.60 |
| [[runs/r-006-GAME-002/report\|r-006-GAME-002]] | GAME-002 | new-game | auto | done | 11m39s | spec×1 tests×1 implement×1 review×1 docs×1 | 3134.0k / 71.7k | $4.92 |
| [[runs/r-007-GAME-003/report\|r-007-GAME-003]] | GAME-003 | feedback | auto | done | 17m53s | spec_update×1 tests_update×2 implement×2 review×1 docs×1 | 5128.3k / 115.2k | $7.49 |

\* условная стоимость по прайсу API; при работе через подписку не списывается.
