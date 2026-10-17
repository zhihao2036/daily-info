const encoder = new TextEncoder();

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function isAuthorized(request: Request, adminToken: string): boolean {
  const value = request.headers.get('authorization');
  if (value === null || !value.startsWith('Bearer ')) return false;
  return constantTimeEqual(value.slice('Bearer '.length), adminToken);
}
