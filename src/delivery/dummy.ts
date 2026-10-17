import type { Sender } from '../domain/contracts';

export function createDummySender(): Sender {
  return { async send() { return { kind: 'suppressed', reason: 'dummy' }; } };
}
