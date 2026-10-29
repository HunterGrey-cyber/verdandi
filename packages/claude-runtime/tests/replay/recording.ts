import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testedVersionsFor } from '../../src/cliCompatibility/index.js';

// These are scrubbed wire objects, including fields newer than the installed SDK declarations.
export type Wire = Record<string, any>;
/** One wire line; `i` is the tap's arrival index in the staged run (hand-built files number their lines themselves). */
export type Line = { i?: number; from: 'host' | 'cli'; message: Wire };
export type Manifest = {
  scenario: string; run?: string; cli_version: string; sdk_version: string; verdandi_revision: string;
  env_names: string[]; variant: string | null; stamped: boolean; handbuilt?: boolean; source?: string;
};
export type Recording = { messages: Line[]; manifest: Manifest; directory: string; cleanup(): void };
export const fixtureRoot = new URL('../../../tests/fixtures/cli-turns/', import.meta.url);
export function mapStrings<T>(value: T, replace: (text: string) => string): T {
  if (typeof value === 'string') return replace(value) as T;
  if (Array.isArray(value)) return value.map(v => mapStrings(v, replace)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, replace)])) as T;
  return value;
}
export function loadRecording(name: string, root = fixtureRoot): Recording {
  if (!/^[\w.-]+$/.test(name)) throw new Error('invalid fixture name');
  const file: { manifest: Manifest; lines: Line[] } = JSON.parse(readFileSync(new URL(`${name}.messages.json`, root), 'utf8'));
  const manifest = file.manifest;
  if (!testedVersionsFor('sdk').includes(manifest.cli_version)) throw new Error(`fixture recorded on CLI ${manifest.cli_version}: re-record`);
  const directory = mkdtempSync(join(tmpdir(), 'verdandi-replay-'));
  try {
    const messages = mapStrings<Line[]>(file.lines, text => text.replaceAll('$RUN', directory));
    return { messages, manifest, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
