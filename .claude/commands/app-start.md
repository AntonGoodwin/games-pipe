---
description: Запустить приложение (кошелёк + платформа + все игры) на http://localhost:4000
---

Запусти приложение: `pnpm start` через Bash **в фоне** (`run_in_background: true`). Через пару секунд проверь `curl -s localhost:4000/api/games` и дай человеку ссылку http://localhost:4000 и список игр.

Если платформа ещё не создана (`platform/start.ts` нет) — скажи, что сначала нужен `/platform-build`.
