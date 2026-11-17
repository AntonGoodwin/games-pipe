/** Мелкие помощники для HTTP-сервисов на `node:http`. */
import http from 'node:http';
import { PlatformError } from './errors.ts';

/** Запущенный HTTP-сервис. */
export interface RunningServer {
  /** Фактический адрес, например `http://127.0.0.1:4000`. */
  url: string;
  /** Останавливает сервис и закрывает соединения. */
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

/** Читает JSON-тело запроса. Пустое тело — `undefined`, битый JSON — `PlatformError('INVALID_REQUEST')`. */
export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new PlatformError('INVALID_REQUEST', 'Слишком большое тело запроса');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformError('INVALID_REQUEST', 'Тело запроса — не JSON');
  }
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/**
 * Защита от DNS rebinding: заголовок `Host` должен быть локальным именем (`localhost`, `127.0.0.1`, `[::1]`
 * или адрес прослушивания `bindHost`) на фактическом порту сервиса. Иначе — `403 FORBIDDEN`.
 */
export function checkLocalHost(req: http.IncomingMessage, bindHost: string): void {
  const port = req.socket.localPort;
  const host = String(req.headers.host ?? '').toLowerCase();
  const names = ['localhost', '127.0.0.1', '[::1]'];
  if (!WILDCARD_HOSTS.has(bindHost)) names.push((bindHost.includes(':') ? `[${bindHost}]` : bindHost).toLowerCase());
  const allowed = names.flatMap((n) => (port === 80 ? [`${n}:80`, n] : [`${n}:${port}`]));
  if (!allowed.includes(host)) throw new PlatformError('FORBIDDEN', 'Недопустимый заголовок Host');
}

/**
 * Непустое тело запроса должно иметь тип `application/json` — такой запрос браузер не отправит
 * с чужого сайта без preflight. Иначе — `415 UNSUPPORTED_MEDIA_TYPE`.
 */
export function checkJsonBody(req: http.IncomingMessage): void {
  const length = Number(req.headers['content-length'] ?? 0);
  const hasBody = req.headers['transfer-encoding'] !== undefined || length > 0;
  const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (hasBody && type !== 'application/json') throw new PlatformError('UNSUPPORTED_MEDIA_TYPE');
}

/** Отправляет JSON-ответ. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

/** Отправляет ошибку в формате `{ error: { code, message } }`; неизвестная ошибка — 500 `INTERNAL_ERROR`. */
export function sendError(res: http.ServerResponse, e: unknown, extra: Record<string, unknown> = {}): void {
  const err = e instanceof PlatformError ? e : new PlatformError('INTERNAL_ERROR');
  if (!(e instanceof PlatformError)) console.error(e);
  else if (err.detail !== undefined) console.error(`${err.code}: ${err.detail}`);
  sendJson(res, err.status, { error: { code: err.code, message: err.message }, ...extra });
}

/** Запускает сервер на `host:port` (`port: 0` — свободный порт) и возвращает `RunningServer`. */
export function listen(server: http.Server, port: number, host: string): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      const urlHost = host.includes(':') ? `[${host}]` : host;
      resolve({
        url: `http://${urlHost}:${actual}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
