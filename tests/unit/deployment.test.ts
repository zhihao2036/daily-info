import { describe, expect, it } from 'vitest';
import { workerUrlFor } from '../../src/deployment/worker-url';
import { ciProductionConfig } from '../../src/deployment/ci-config';

describe('Workers deployment URL', () => {
  it('accepts only the configured Worker name on a workers.dev hostname', () => {
    expect(workerUrlFor('daily-info-production', 'https://daily-info-production.example.workers.dev'))
      .toBe('https://daily-info-production.example.workers.dev');
    expect(() => workerUrlFor('daily-info-production', 'https://other.example.workers.dev')).toThrow('WORKER_URL_INVALID');
    expect(() => workerUrlFor('daily-info-production', 'https://daily-info-production.example.com')).toThrow('WORKER_URL_INVALID');
  });
});

describe('private CI deployment configuration', () => {
  const config = () => ({ name:'example-production',workers_dev:false,
    vars:{APP_ENV:'production',SEND_ENABLED:'false'},
    d1_databases:[{binding:'DB',database_id:'11111111-1111-1111-1111-111111111111'}] });

  it('restores production resource configuration without requiring runtime credentials in GitHub', () => {
    const restored = ciProductionConfig(JSON.stringify(config()));
    expect(JSON.parse(restored)).toEqual(config());
  });

  it.each([undefined,'not JSON','{"secret":"do-not-print"',JSON.stringify({vars:{APP_ENV:'test'}})])
    ('rejects malformed or non-production input without disclosing its contents', raw => {
      expect(() => ciProductionConfig(raw)).toThrow(/^CI_CONFIG_INVALID:/);
      try { ciProductionConfig(raw); } catch (error) { expect(String(error)).not.toContain('do-not-print'); }
    });

  it('rejects template database IDs and inline runtime credentials', () => {
    const placeholder = config(); placeholder.d1_databases[0]!.database_id = '00000000-0000-0000-0000-000000000000';
    expect(() => ciProductionConfig(JSON.stringify(placeholder))).toThrow('CI_CONFIG_INVALID');
    expect(() => ciProductionConfig(JSON.stringify({ ...config(),vars:{...config().vars,TELEGRAM_BOT_TOKEN:'do-not-print'} })))
      .toThrow('CI_CONFIG_INVALID');
  });
});
