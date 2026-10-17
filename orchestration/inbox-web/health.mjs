// A listener counts as ours only when both configured ports and machine match.
export async function matchingHealth(config, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  if (!config.name || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return false;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${config.port}/admin/health`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    const health = await response.json();
    return Boolean(response.ok && health.ok && health.machine === config.name && health.port === config.port && health.remotePort === config.remotePort);
  } catch { return false; }
}
