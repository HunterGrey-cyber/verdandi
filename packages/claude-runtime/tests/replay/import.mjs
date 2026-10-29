import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const read = (path) => {
  const text = readFileSync(path, 'utf8');
  if (text.includes('/home/')) throw new Error(`unscrubbed home path: ${path}`);
  const value = JSON.parse(text);
  if (JSON.stringify(value).includes('/home/')) throw new Error(`unscrubbed home path: ${path}`);
  return value;
};
function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const path = join(prefix, name);
    return statSync(join(root, path)).isDirectory() ? files(root, path) : [path];
  });
}
const segment = /^[a-zA-Z0-9_-]+$/;
/** The fixture name of a staged run: its path under the staging root, joined with dots. */
export function fixtureName(rel) {
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length === 0 || !parts.every(p => segment.test(p))) throw new Error('invalid fixture name');
  return parts.join('.');
}
/** Every staged run directory (one holding a manifest.json) under `root`, as paths relative to `root`. */
export function stagedRuns(root) {
  const runs = [];
  const visit = (path) => {
    if (readdirSync(path).includes('manifest.json')) { runs.push(relative(root, path)); return; }
    for (const entry of readdirSync(path)) if (statSync(join(path, entry)).isDirectory()) visit(join(path, entry));
  };
  visit(root);
  return runs;
}
export function convert(root, variant) {
  const manifest = read(join(root, 'manifest.json'));
  const allowed = new Set(['manifest.json', ...manifest.files]);
  for (const path of files(root)) {
    if (!allowed.has(path)) throw new Error(`unlisted staged file: ${path}`);
  }
  const entries = ['stdin', 'stdout'].flatMap(direction => {
    const path = join(root, `cli-${direction}.jsonl`);
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
      if (line.includes('/home/')) throw new Error(`unscrubbed home path: ${path}`);
      const entry = JSON.parse(line);
      const message = typeof entry.line === 'string' ? JSON.parse(entry.line) : entry.line;
      if (JSON.stringify(message).includes('/home/')) throw new Error(`unscrubbed home path: ${path}`);
      return { ...entry, direction, message };
    });
  });
  const shared = new Set(entries.map(e => e.index)).size === entries.length;
  for (const e of entries) {
    if (typeof (shared ? e.index : e.time) !== 'number') throw new Error('tap arrival order unavailable');
  }
  entries.sort((a, b) => shared ? a.index - b.index : a.time - b.time);
  // `i` is the tap's shared arrival index; when the tap numbered each direction on its own it is the merged position.
  entries.forEach((e, position) => { e.i = shared ? e.index : position; });
  const questionIds = new Set(entries.filter(e => e.message.type === 'control_request' && e.message.request?.tool_name === 'AskUserQuestion').map(e => e.message.request_id));
  const exchanges = [];
  const lines = [];
  let initialize = null;
  let droppedControls = 0;
  const uses = new Set();
  for (const e of entries) {
    const m = e.message;
    const from = e.direction === 'stdin' ? 'host' : 'cli';
    if (m.type === 'control_request' || m.type === 'control_response') {
      if (questionIds.has(m.request_id ?? m.response?.request_id)) {
        exchanges.push({ i: e.i, from, message: m });
        if (m.request?.tool_use_id) uses.add(m.request.tool_use_id);
      } else if (e.direction === 'stdin' && ['interrupt', 'stop_task'].includes(m.request?.subtype)) {
        lines.push({ i: e.i, from, message: m });
      } else if (e.direction === 'stdin' && m.request?.subtype === 'initialize' && !initialize) {
        initialize = { i: e.i, from, message: m };
      } else droppedControls++;
    } else if (e.direction === 'stdout' || m.type === 'user') {
      lines.push({ i: e.i, from, message: m });
      for (const block of m.message?.content ?? []) {
        if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') uses.add(block.id);
      }
    }
  }
  const results = {};
  // Request bodies are numbered by arrival; the first result for an id is its model-visible answer.
  for (const path of manifest.files.filter(p => /^body_\d+\.json$/.test(p)).sort((a,b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))) {
    const body = read(join(root, path));
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'tool_result' && uses.has(value.tool_use_id) && !(value.tool_use_id in results)) results[value.tool_use_id] = value;
      for (const v of Object.values(value)) visit(v);
    };
    visit(body);
  }
  const copied = Object.fromEntries(['scenario', 'run', 'cli_version', 'sdk_version', 'verdandi_revision', 'env_names']
    .filter(k => manifest[k] !== undefined).map(k => [k, manifest[k]]));
  const users = lines.filter(e => e.from === 'host' && e.message.type === 'user');
  const stamped = manifest.stamped ?? (users.length > 0 && users.every(e => typeof e.message.uuid === 'string' && e.message.uuid !== ''));
  return {
    messages: { manifest: { ...copied, variant: variant ?? null, stamped }, lines },
    // Only a run that went through AskUserQuestion has a control file.
    control: exchanges.length > 0 ? { initialize, exchanges, tool_results: results, dropped_controls: droppedControls } : null,
  };
}
export function importRuns({ from, out, variant, only, scan }) {
  if (!scan) throw new Error('--scan is required');
  if (variant && !segment.test(variant)) throw new Error('invalid fixture name');
  mkdirSync(out, { recursive: true });
  const root = resolve(from);
  for (const rel of stagedRuns(root)) {
    if (rel === '') throw new Error('--from must be the staging root that holds the run directories, not a run directory');
    const name = fixtureName(rel);
    // A run that was not asked for is not read, so a broken or half-staged one cannot stop a selective import.
    if (only && !only.includes(name) && !only.includes(name.split('.')[0])) continue;
    const result = convert(join(root, rel), variant);
    const base = join(out, `${name}${variant ? `.${variant}` : ''}`);
    writeFileSync(`${base}.messages.json`, JSON.stringify(result.messages, null, 2) + '\n');
    if (result.control) writeFileSync(`${base}.control.json`, JSON.stringify(result.control, null, 2) + '\n');
  }
  const scanned = spawnSync('bash', [resolve(scan), resolve(out)], { encoding: 'utf8' });
  if (scanned.status !== 0) throw new Error(`scan failed: ${scanned.stdout}${scanned.stderr}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!args.from) throw new Error('--from is required');
  importRuns({ ...args, only: args.only?.split(','), out: args.out ?? resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/cli-turns') });
}
