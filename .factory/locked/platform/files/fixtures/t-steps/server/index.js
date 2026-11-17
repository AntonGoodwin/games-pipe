// Тестовая игра t-steps (фикстура приёмочных тестов платформы, см. platform/spec.md «Тестовые игры»).
// Файл .js, чтобы tsc не проверял его до появления platform/sdk/types.ts.
import { GameError } from '../../../../sdk/types.ts';

/** Несколько ходов: "next" — шаг вперёд, "cashout" — выплата bet × (1 + step / 3). secret скрыт до конца раунда. */
const game = {
  id: 't-steps',
  validateParams(params) {
    if (params !== undefined && params !== null && typeof params !== 'object') throw new GameError('INVALID_PARAMS');
    return {};
  },
  start({ rng }) {
    return { status: 'continue', state: { step: 0, secret: rng.next() } };
  },
  action({ bet, state, action }) {
    if (action === 'next') return { status: 'continue', state: { ...state, step: state.step + 1 } };
    if (action === 'cashout') return { status: 'finished', state, payout: bet * (1 + state.step / 3) };
    throw new GameError('INVALID_ACTION');
  },
  publicView(state, finished) {
    return finished ? { step: state.step, secret: state.secret } : { step: state.step };
  },
};

export default game;
