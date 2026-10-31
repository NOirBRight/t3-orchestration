/**
 * Shared CLI flag parser for orchestration scripts (report / campaign-write / ticket-ref).
 * Bare `--flag` without a value is invalid (matches report.mjs).
 */

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    // Allow empty-string values (e.g. --title ''); only missing or another flag is invalid.
    if (!a.startsWith('--') || next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      throw new Error('invalid');
    }
    flags[a.slice(2)] = next;
    i++;
  }
  return flags;
}
