import { describe, expect, it } from 'vitest';
import { workerUrlFor } from '../../src/deployment/worker-url';

describe('Workers deployment URL', () => {
  it('accepts only the configured Worker name on a workers.dev hostname', () => {
    expect(workerUrlFor('daily-info-production', 'https://daily-info-production.example.workers.dev'))
      .toBe('https://daily-info-production.example.workers.dev');
    expect(() => workerUrlFor('daily-info-production', 'https://other.example.workers.dev')).toThrow('WORKER_URL_INVALID');
    expect(() => workerUrlFor('daily-info-production', 'https://daily-info-production.example.com')).toThrow('WORKER_URL_INVALID');
  });
});
