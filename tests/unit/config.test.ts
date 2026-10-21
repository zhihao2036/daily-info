import { describe, expect, it } from 'vitest';
import appExample from '../../reference/app.config.example.json';
import sourcesExample from '../../reference/sources.example.json';
import { assertDeliveryConfiguration, parseSendEnabled, validateAdminToken, validateConfig, validateHttpsEndpoint } from '../../src/config/load';
import { validateSourcesConfig } from '../../src/config/schema';

describe('configuration validation', () => {
  it('expands opt-in official presets without bypassing verification or host validation', () => {
    const registry = { schemaVersion: 1, sources: [{ preset: 'minimax-blog' }, { preset: 'cursor-changelog' }] };
    expect(validateSourcesConfig(registry).sources.map(source => [source.id, source.enabled]))
      .toEqual([['minimax-blog', false], ['cursor-changelog', false]]);
    expect(() => validateSourcesConfig({ ...registry, sources: [{ preset: 'missing' }] })).toThrow('SOURCE_PRESET');
    expect(() => validateSourcesConfig({ ...registry, sources: [{ preset: 'minimax-blog', enabled: true }] })).toThrow();
    expect(() => validateSourcesConfig({ ...registry, sources: [{ preset: 'minimax-blog', url: 'https://attacker.test/' }] })).toThrow();
    expect(validateSourcesConfig({ ...registry, sources: [{ preset: 'minimax-blog', enabled: true, verification: 'worker_verified' }] }).sources[0]?.enabled).toBe(true);
    expect(validateSourcesConfig({ ...registry, defaults: { kind: 'rss', enabled: true, verification: 'worker_verified' } }).sources
      .map(source => source.kind)).toEqual(['html_list', 'html_list']);
  });
  it('expands shared defaults but still validates each source and forbids shared host allowlists', () => {
    const source = structuredClone(sourcesExample.sources[0]!);
    const { enabled, verification, ...specific } = source;
    const registry = { schemaVersion: 1, defaults: { enabled, verification }, sources: [specific] };
    expect(validateSourcesConfig(registry).sources[0]).toMatchObject(source);
    expect(() => validateSourcesConfig({ ...registry, defaults: { enabled: true, verification: 'discovered' } })).toThrow();
    expect(() => validateSourcesConfig({ ...registry, sources: [{ ...specific, allowedHosts: ['attacker.test'] }] })).toThrow();
    expect(() => validateSourcesConfig({ ...registry, defaults: { allowedHosts: ['example.com'] } })).toThrow();
  });

  it('treats only literal false as disabled and rejects ambiguous values', () => {
    expect(parseSendEnabled('false')).toBe(false);
    expect(parseSendEnabled('true')).toBe(true);
    expect(() => parseSendEnabled('1')).toThrow('CONFIG_INVALID:SEND_ENABLED');
    expect(() => parseSendEnabled('TRUE')).toThrow('CONFIG_INVALID:SEND_ENABLED');
  });

  it('requires an admin token with at least 32 bytes', () => {
    expect(() => validateAdminToken('short-token')).toThrow('CONFIG_INVALID:ADMIN_TOKEN');
    expect(validateAdminToken('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('rejects unsafe doctor endpoints before an API key could be sent', () => {
    expect(validateHttpsEndpoint('https://llm.example.com/v1')).toBe('https://llm.example.com/v1');
    expect(() => validateHttpsEndpoint('http://llm.example.com/v1')).toThrow('CONFIG_INVALID:HTTPS_ENDPOINT');
    expect(() => validateHttpsEndpoint('https://user:pass@llm.example.com/v1')).toThrow('CONFIG_INVALID:HTTPS_ENDPOINT');
  });

  it('accepts the fail-closed application example', () => {
    const config = validateConfig(appExample);
    expect(config.delivery.channel).toBe('dummy');
    expect(config.llm.inputMicrousdPerMillionTokens).toBeNull();
  });

  it('accepts Telegram as a configured channel but requires private-chat secrets before enabling sends', () => {
    const telegram = structuredClone(appExample);
    telegram.delivery.channel = 'telegram' as typeof telegram.delivery.channel;
    const config = validateConfig(telegram);
    expect(config.delivery.channel).toBe('telegram');
    expect(() => assertDeliveryConfiguration({ config, appEnv: 'production', sendEnabled: true,
      emailBinding: undefined, telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '987654321' }))
      .not.toThrow();
    expect(() => assertDeliveryConfiguration({ config, appEnv: 'production', sendEnabled: true,
      emailBinding: undefined, telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '-100123' }))
      .toThrow('CONFIG_INVALID:DELIVERY');
    expect(() => assertDeliveryConfiguration({ config, appEnv: 'production', sendEnabled: true,
      emailBinding: undefined, telegramChatId: '987654321' })).toThrow('CONFIG_INVALID:DELIVERY');
  });

  it('rejects an unsupported timezone instead of applying a fixed offset', () => {
    expect(() => validateConfig({ ...appExample, timezone: 'UTC' })).toThrow();
  });

  it('validates the source registry and refuses hosts outside the allowlist', () => {
    expect(validateSourcesConfig(sourcesExample).sources).toHaveLength(24);
    const bad = structuredClone(sourcesExample);
    bad.sources[0]!.url = 'https://attacker.test/feed.xml';
    expect(() => validateSourcesConfig(bad)).toThrow();
  });

  it('does not allow a discovered source to be enabled', () => {
    const unverified = structuredClone(sourcesExample);
    unverified.sources[0]!.enabled = true;
    expect(() => validateSourcesConfig(unverified)).toThrow();
  });

  it('allows an explicit disabled browser fallback for renderable sources but rejects it for GitHub releases', () => {
    const html = structuredClone(sourcesExample);
    html.sources[1]!.browserFallbackEnabled = false;
    expect(validateSourcesConfig(html).sources[1]?.browserFallbackEnabled).toBe(false);

    const github = structuredClone(sourcesExample);
    github.sources.find((source) => source.kind === 'github_releases')!.browserFallbackEnabled = true;
    expect(() => validateSourcesConfig(github)).toThrow();
  });
});
