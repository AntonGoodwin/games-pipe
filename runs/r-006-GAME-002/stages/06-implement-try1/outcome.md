# implement: done

Игра «Мины» готова, все 31 тест проходят (module 10, rounds 19, ui 2), tsc без ошибок. Оба прогона запускал сам.

Сервер, games/mines/server/index.ts:
- validateParams возвращает {} для объекта или undefined. На null, массив, строку и число бросает INVALID_PARAMS.
- start расставляет мины частичной тасовкой Фишера — Йетса: ровно 3 вызова rng, мины хранятся по возрастанию.
- action проверяет ход целиком до любых изменений. Он не меняет переданный state, возвращает новый и не обращается к rng.
- Множитель: M(k) = round2(0.98 × C(25,k)/C(22,k)), биномиальные коэффициенты считаются целыми числами.
- Выплата = bet × M(k), до центов её округляет платформа.
- Раунд завершается тремя способами: мина (выплата 0), cashout, открытие 22-й безопасной клетки (outcome cleared).
- publicView до конца раунда не показывает mines, hit и outcome.

Интерфейс, games/mines/ui/index.html:
- Работает только через window.PlatformSDK, без библиотек; стиль как у «Монетки».
- Поле 5 × 5 строится скриптом: cell-0…cell-24 с data-cell-state = hidden | safe | mine.
- На корне data-state = idle | playing | won | lost. Элементы: balance, bet-input, play, cashout, multiplier, next-multiplier, payout, error.
- Незавершённый раунд из open().activeRound восстанавливается после обновления страницы.
- Ошибки платформы показываются в error как код и пояснение.

manifest.json не менял.
