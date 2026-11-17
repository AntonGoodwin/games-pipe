// Клиентский SDK платформы. Раздаётся ядром как /sdk.js и даёт интерфейсу игры window.PlatformSDK.
//
//   PlatformSDK.open()                 → POST /api/games/<id>/open   (id игры — из адреса /games/<id>/…)
//   PlatformSDK.startRound(bet, params)→ POST /api/games/<id>/rounds
//   PlatformSDK.action(action)         → POST /api/rounds/<roundId>/actions
//
// Методы возвращают Promise с телом ответа API. Ошибка — отказ объектом { code, message }.
// SDK запоминает roundId из open() (activeRound) и из startRound(); без раунда action()
// отклоняется с { code: "ROUND_NOT_FOUND" } без запроса к серверу.
(function () {
  'use strict';

  var match = /^\/games\/([^/]+)/.exec(window.location.pathname);
  var gameId = match ? decodeURIComponent(match[1]) : null;
  var roundId = null;

  function fail(code, message) {
    return Promise.reject({ code: code, message: message || code });
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    }).then(
      function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          if (res.ok) return data;
          var err = data && data.error;
          return fail((err && err.code) || 'HTTP_' + res.status, (err && err.message) || res.statusText);
        });
      },
      function (e) {
        return fail('NETWORK_ERROR', e && e.message ? e.message : 'Нет связи с сервером');
      },
    );
  }

  function remember(round) {
    roundId = round && round.roundId ? round.roundId : null;
    return round;
  }

  window.PlatformSDK = {
    /** Идентификатор игры из адреса страницы. */
    gameId: gameId,

    /** Открывает игру: { gameId, limits, balance, activeRound }. */
    open: function () {
      if (!gameId) return fail('GAME_NOT_FOUND', 'Страница не относится к игре');
      return post('/api/games/' + encodeURIComponent(gameId) + '/open').then(function (res) {
        remember(res && res.activeRound);
        return res;
      });
    },

    /** Начинает раунд со ставкой bet и параметрами игры → RoundView. */
    startRound: function (bet, params) {
      if (!gameId) return fail('GAME_NOT_FOUND', 'Страница не относится к игре');
      return post('/api/games/' + encodeURIComponent(gameId) + '/rounds', { bet: bet, params: params }).then(remember);
    },

    /** Ход в текущем раунде → RoundView. */
    action: function (action) {
      if (!roundId) return fail('ROUND_NOT_FOUND', 'Нет открытого раунда');
      return post('/api/rounds/' + encodeURIComponent(roundId) + '/actions', { action: action });
    },
  };
})();
