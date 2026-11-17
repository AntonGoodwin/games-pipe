# docs: done

Написал документацию для coin, логику не менял. Прогнать tsc и vitest не смог: в этом запуске Bash запрещён (режим don't ask), поэтому правки проверены только чтением, а сами проверки остаются за оркестратором. Обе правки в коде — только комментарии.

Что сделано:
- games/coin/README.md: устройство (manifest, server, ui, tests), состояние раунда, как определяется результат, интерфейс, проверка. Вики-ссылки ведут на games/coin/spec, decisions/coin (в том числе с якорями #D-001…#D-015), platform/spec и local-jira/GAME-001-coin-new-game. Все эти файлы есть (проверил при просмотре каталогов). Замечания ревью R-1 и R-2 отмечены как известные мелочи.
- games/coin/server/index.ts: расширил TSDoc над объектом game — описаны все четыре метода (validateParams, start, action, publicView): что принимают, что возвращают, какие GameError бросают. Добавил TSDoc над `export default game`. У остальных экспортов (Side, CoinParams, CoinState, PAYOUT_MULTIPLIER) комментарии уже были.

Ссылка [[runs/r-005-GAME-001/report]] в файле задачи и в decisions сейчас не битая: runs/r-005-GAME-001/report.md уже есть, поэтому KB-005 применять не понадобилось.
