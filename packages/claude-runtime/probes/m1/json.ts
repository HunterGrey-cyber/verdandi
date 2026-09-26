/**
 * Readers for SDK messages as the probe actually receives them: JSON whose shape drifts with the
 * CLI version on the host. Every accessor answers `null` (or `[]`) for a shape it does not
 * recognise instead of throwing, so an unexpected message becomes a recorded difference rather
 * than a crashed measurement.
 */
export type Json = Record<string, unknown>;

export function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : JSON.stringify(err);
}
