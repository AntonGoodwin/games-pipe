// Тестовая игра t-flip (фикстура приёмочных тестов платформы, см. platform/spec.md «Тестовые игры»).
// Файл .js, чтобы tsc не проверял его до появления platform/sdk/types.ts.
import { GameError } from '../../../../sdk/types.ts';

/** Один ход: rng < 0.5 → heads, иначе tails; совпадение — bet × 1.96, иначе 0. */
const game = {
  id: 't-flip',
  validateParams(params) {
    if (!params || typeof params !== 'object' || (params.side !== 'heads' && params.side !== 'tails')) {
      throw new GameError('INVALID_PARAMS');
    }
    return { side: params.side };
  },
  start({ bet, params, rng }) {
    const outcome = rng.next() < 0.5 ? 'heads' : 'tails';
    const payout = outcome === params.side ? bet * 1.96 : 0;
    return { status: 'finished', state: { side: params.side, outcome }, payout };
  },
  action() {
    throw new GameError('INVALID_ACTION');
  },
  publicView(state) {
    return { side: state.side, outcome: state.outcome };
  },
};

export default game;
