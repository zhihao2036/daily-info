import process from 'node:process';

const baseUrl = process.env.WORKER_URL;
const token = process.env.ADMIN_TOKEN;
if (!baseUrl || !token) throw new Error('WORKER_URL and ADMIN_TOKEN are required');
const date = process.argv[2];
const body = date === undefined ? {} : { date };
const response = await fetch(new URL('/api/preview', baseUrl), {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': `preview-${date ?? 'today'}-${crypto.randomUUID()}`.slice(0, 128),
  },
  body: JSON.stringify(body),
});
const output = await response.text();
console.log(`${response.status} ${output}`);
if (!response.ok) {
  process.exitCode = 1;
} else {
  const accepted = JSON.parse(output) as { statusUrl?: unknown };
  if (typeof accepted.statusUrl !== 'string') throw new Error('Preview response is missing statusUrl');
  const timeoutMs = Number(process.env.PREVIEW_TIMEOUT_MS ?? 300_000);
  const intervalMs = Number(process.env.PREVIEW_POLL_INTERVAL_MS ?? 2_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const statusResponse = await fetch(new URL(accepted.statusUrl, baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    const statusText = await statusResponse.text();
    if (!statusResponse.ok) throw new Error(`Preview status failed: ${statusResponse.status} ${statusText}`);
    const status = JSON.parse(statusText) as { state?: unknown; resultUrl?: unknown };
    console.log(`run ${String(status.state)}`);
    if (['completed', 'failed', 'expired', 'cancelled'].includes(String(status.state))) {
      if (status.state === 'completed' && typeof status.resultUrl === 'string') {
        const digestResponse = await fetch(new URL(status.resultUrl, baseUrl), {
          headers: { authorization: `Bearer ${token}` },
        });
        const digestText = await digestResponse.text();
        if (digestResponse.ok) {
          const digest = JSON.parse(digestText) as { renderedText?: unknown };
          console.log(typeof digest.renderedText === 'string' ? digest.renderedText : digestText);
        } else {
          console.log(`${digestResponse.status} ${digestText}`);
        }
        if (!digestResponse.ok) process.exitCode = 1;
      } else if (status.state !== 'completed') {
        process.exitCode = 1;
      }
      break;
    }
    if (Date.now() >= deadline) throw new Error('Preview polling timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
