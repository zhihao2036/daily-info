import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '') {
  throw new Error('Commit reviewed changes before exporting a public release.');
}
execFileSync('pnpm', ['run', 'check:public'], { stdio: 'inherit' });
const destination = resolve('.private/public-release');
if (existsSync(destination)) throw new Error('PUBLIC_RELEASE_ALREADY_EXISTS: existing export will not be overwritten');
mkdirSync(destination, { recursive: true, mode: 0o700 });
const archive = execFileSync('git', ['archive', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
const git = (args: string[]) => execFileSync('git', ['-C', destination, ...args], { encoding: 'utf8' });
git(['init', '--initial-branch=main']);
const name = execFileSync('git', ['log', '-1', '--format=%an'], { encoding: 'utf8' }).trim();
const email = execFileSync('git', ['log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim();
git(['add', '--all']);
git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', 'Initial open-source release']);
if (git(['rev-list', '--count', 'HEAD']).trim() !== '1' || git(['remote']).trim() !== '') {
  throw new Error('PUBLIC_RELEASE_HISTORY_INVALID');
}
console.log(`Clean public repository prepared at ${destination}; no remote or publishing action was configured.`);
