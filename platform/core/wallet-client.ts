/** Клиент кошелька для ядра: выполняет операции движка (`WalletOp`) по HTTP через `node:http`. */
import http from 'node:http';
import { PlatformError, messageOf } from '../shared/errors.ts';
import type { WalletOp } from './engine.ts';

// Ссылка взята при загрузке ядра, до подключения игр: подмена `http.request` из кода игры
// не перехватит токен кошелька и суммы операций.
const request = http.request;
const TIMEOUT_MS = 5000;
/** Заголовок с общим секретом кошелька (как `WALLET_TOKEN_HEADER` в `platform/wallet`). */
const TOKEN_HEADER = 'x-wallet-token';

/**
 * Создаёт исполнитель операций кошелька по адресу `walletUrl`; `token`, если задан, уходит в заголовке `x-wallet-token`.
 * `402` → `INSUFFICIENT_FUNDS`; сеть, таймаут, `5xx` → `WALLET_UNAVAILABLE`; прочие отказы → `INTERNAL_ERROR`.
 */
export function walletExecutor(walletUrl: string, token?: string): (op: WalletOp) => Promise<number> {
  return async (op) => {
    const res =
      op.kind === 'balance'
        ? await call(walletUrl, token, 'GET', '/balance')
        : await call(walletUrl, token, 'POST', `/${op.kind}`, { txId: op.txId, roundId: op.roundId, amount: op.amount });
    const body = res.body as { balance?: unknown; error?: { code?: unknown } } | undefined;
    if (res.status === 200 && typeof body?.balance === 'number') return body.balance;
    if (res.status === 402) throw new PlatformError('INSUFFICIENT_FUNDS');
    if (res.status >= 500 || res.status === 200) throw new PlatformError('WALLET_UNAVAILABLE');
    throw new PlatformError('INTERNAL_ERROR', `Кошелёк отклонил операцию: ${String(body?.error?.code ?? res.status)}`);
  };
}

function call(base: string, token: string | undefined, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const fail = (e: unknown): void => reject(new PlatformError('WALLET_UNAVAILABLE', `Кошелёк недоступен: ${messageOf(e)}`));
    const req = request(
      new URL(urlPath, base),
      {
        method,
        timeout: TIMEOUT_MS,
        headers: {
          ...(token === undefined ? {} : { [TOKEN_HEADER]: token }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
