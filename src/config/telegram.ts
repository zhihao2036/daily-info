export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*:[A-Za-z0-9_-]{20,}$/.test(value);
}

export function isTelegramPrivateChatId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}
