export function workerUrlFor(workerName: string, raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('WORKER_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.hostname !== `${workerName}.example.workers.dev` && !url.hostname.endsWith('.workers.dev')
    || !url.hostname.startsWith(`${workerName}.`)) throw new Error('WORKER_URL_INVALID');
  return url.origin;
}
