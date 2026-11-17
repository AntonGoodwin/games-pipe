/** Ошибки платформы: код, HTTP-статус и сообщение для игрока. */

/** HTTP-статус для каждого кода ошибки платформы. Неизвестный код — 500. */
export const ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  BET_OUT_OF_LIMITS: 400,
  INVALID_PARAMS: 400,
  INVALID_ACTION: 400,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  INSUFFICIENT_FUNDS: 402,
  FORBIDDEN: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  GAME_NOT_FOUND: 404,
  ROUND_NOT_FOUND: 404,
  NOT_FOUND: 404,
  ROUND_ALREADY_OPEN: 409,
  ROUND_CLOSED: 409,
  INTERNAL_ERROR: 500,
  WALLET_UNAVAILABLE: 502,
});

const DEFAULT_MESSAGES: Readonly<Record<string, string>> = {
  BET_OUT_OF_LIMITS: 'Ставка должна быть от $1 до $10',
  INVALID_PARAMS: 'Неверные параметры раунда',
  INVALID_ACTION: 'Это действие сейчас недоступно',
  INVALID_REQUEST: 'Некорректный запрос',
  INSUFFICIENT_FUNDS: 'Недостаточно средств',
  UNAUTHORIZED: 'Нужен верный токен доступа',
  FORBIDDEN: 'Запрос с чужого сайта отклонён',
  UNSUPPORTED_MEDIA_TYPE: 'Тело запроса должно быть application/json',
  GAME_NOT_FOUND: 'Игра не найдена',
  ROUND_NOT_FOUND: 'Раунд не найден',
  NOT_FOUND: 'Не найдено',
  ROUND_ALREADY_OPEN: 'В этой игре уже есть незавершённый раунд',
  ROUND_CLOSED: 'Раунд уже завершён',
  INTERNAL_ERROR: 'Внутренняя ошибка',
  WALLET_UNAVAILABLE: 'Кошелёк временно недоступен',
};

/** Ошибка платформы. Testkit бросает её как есть, HTTP API отдаёт как `{ error: { code, message } }`. */
export class PlatformError extends Error {
  /** Код ошибки, например `BET_OUT_OF_LIMITS`. */
  code: string;
  /** HTTP-статус ответа. */
  status: number;
  /** Подробности для серверного лога. Клиенту не отдаются: в них может быть скрытое состояние игры. */
  detail?: string;

  /**
   * @param code код ошибки
   * @param message сообщение; по умолчанию — стандартный текст для кода
   * @param detail подробности только для серверного лога
   */
  constructor(code: string, message?: string, detail?: string) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = 'PlatformError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Текст ошибки любого типа для логов и сообщений. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
