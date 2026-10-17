import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const directories: string[] = [];
const script = resolve('scripts/configure.ts');
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daily-info-configure-'));
  directories.push(dir);
  for (const file of ['wrangler.example.jsonc', '.env.example', '.dev.vars.example']) {
    copyFileSync(resolve(file), join(dir, file));
  }
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('first-deployment configuration', () => {
  it('generates private random credentials without printing them and keeps cloud calls disabled', () => {
    const cwd = sandbox();
    const output = execFileSync(process.execPath, ['--experimental-strip-types', script], { cwd, encoding: 'utf8' });
    const env = readFileSync(join(cwd, '.env'), 'utf8');
    const token = env.match(/^ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
    expect(token).toBeTruthy();
    expect(output).not.toContain(token);
    expect(readFileSync(join(cwd, '.dev.vars'), 'utf8')).toContain(`ADMIN_TOKEN=${token}`);
    expect(statSync(join(cwd, '.env')).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(join(cwd, 'wrangler.production.jsonc'), 'utf8'));
    expect(config.vars.SEND_ENABLED).toBe('false');
    expect(config.triggers.crons).toEqual([]);
    expect(config.vars.APP_CONFIG.budget.dayMicrousd).toBe(0);
  });

  it('never overwrites existing personal config or credentials', () => {
    const cwd = sandbox();
    for (const file of ['wrangler.production.jsonc', '.env', '.dev.vars']) writeFileSync(join(cwd, file), 'existing private configuration');
    execFileSync(process.execPath, ['--experimental-strip-types', script], { cwd, stdio: 'pipe' });
    for (const file of ['wrangler.production.jsonc', '.env', '.dev.vars']) {
      expect(readFileSync(join(cwd, file), 'utf8')).toBe('existing private configuration');
    }
  });
});
