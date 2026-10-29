import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { loadRecording, fixtureRoot, type Line, type Wire } from './replay/recording.js';

const lifecycle = (line: Line, uuid: string, state: string) => line.from === 'cli' && line.message.type === 'command_lifecycle' && line.message.command_uuid === uuid && line.message.state === state;
const content = (m: Wire) => !m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'stream_event' && ['content_block_start', 'content_block_delta'].includes(m.event?.type));
const at = (index: number) => index < 0 ? 'absent' : `line ${index + 1}`;

const required = ['c01', 'c01c', 'c02b', 'c03_bg', 'c03_fg', 'c04a', 'c04b', 'c05', 'c05w', 'c07b', 'c15a', 'c15b', 'c16', 'c16w', 'c16w_stop.run2', 'c17',
  'c04d', 'c09', 'c10', 'c12', 'c13a', 'c13b', 'c14', 'c18'];
for (const name of new Set([...readdirSync(fixtureRoot).filter(n => n.endsWith('.messages.json')).map(n => n.replace('.messages.json', '')), ...required])) {
  test(`recorded order ${name}`, t => {
    if (!existsSync(new URL(`${name}.messages.json`, fixtureRoot))) {
      assert.notEqual(process.env.VERDANDI_REPLAY_REQUIRE_ALL, '1', `${name}: fixture missing`);
      t.skip('fixture missing'); return;
    }
    const r = loadRecording(name);
    try {
      const lines = r.messages;
      const users = lines.map((line, index) => ({ line, index })).filter(e => e.line.from === 'host' && e.line.message.type === 'user');
      for (const { line, index } of users) {
        const uuid = line.message.uuid;
        const started = lines.findIndex(l => lifecycle(l, uuid, 'started'));
        const completed = lines.findIndex(l => lifecycle(l, uuid, 'completed'));
        const result = lines.findIndex(l => l.from === 'cli' && l.message.type === 'result' && l.message.user_message_uuid === uuid);
        const prompt = line.message.message?.content;
        t.diagnostic(`${name} host ${at(index)} ${JSON.stringify(prompt)}: stamped=${typeof uuid === 'string'}, started=${at(started)}, completed=${at(completed)}, result echo=${at(result)}`);
      }
      if (name === 'c04a') {
        if (!r.manifest.stamped) t.diagnostic('c04a order: not applicable: unstamped');
        else {
          const prompt = users[1];
          assert.ok(prompt, 'stamped c04a must contain the colliding prompt');
          const uuid = prompt.line.message.uuid;
          const started = lines.findIndex(l => lifecycle(l, uuid, 'started'));
          const result = lines.findIndex(l => l.message.type === 'result' && l.message.user_message_uuid === uuid);
          assert.ok(result >= 0, 'stamped c04a must identify the prompt result');
          // Work backward from the matching result, so an overlapping wake's content is excluded.
          let begin = result - 1;
          while (begin > prompt.index && lines[begin].message.type !== 'result') begin--;
          const first = lines.findIndex((l, i) => i > begin && i < result && l.from === 'cli' && content(l.message));
          assert.ok(started > prompt.index && first >= 0 && started < first, `c04a prompt started ${at(started)} must precede own content ${at(first)}`);
          t.diagnostic(`c04a prompt started ${at(started)} precedes own content ${at(first)}`);
        }
      }
      if (name === 'c01') {
        const level = lines.findIndex(l => l.message.subtype === 'background_tasks_changed');
        const started = lines.findIndex(l => l.message.subtype === 'task_started');
        const result = lines.findIndex(l => l.message.type === 'result');
        t.diagnostic(`c01 level=${at(level)}, task_started=${at(started)}, first result=${at(result)}; level before result=${level >= 0 && level < result}, task_started before result=${started >= 0 && started < result}`);
      }
      for (const [i, line] of lines.entries()) if (line.message.type === 'result') {
        const nextState = lines.findIndex((l, j) => j > i && l.message.subtype === 'session_state_changed');
        t.diagnostic(`${name} result ${at(i)} -> next session_state_changed ${at(nextState)}${nextState >= 0 ? ` (${lines[nextState].message.state})` : ''}`);
      }
      const states = lines.filter(l => l.message.subtype === 'session_state_changed');
      t.diagnostic(`${name} session_state_changed reached host: ${states.length > 0 ? `yes (${states.length})` : 'absent'}`);
      // A result with an origin identifies an autonomous cycle; inspect its preceding cycle boundary.
      for (const [i, line] of lines.entries()) if (line.message.type === 'result' && line.message.origin) {
        let previous = i - 1;
        while (previous >= 0 && lines[previous].message.type !== 'result') previous--;
        const cycle = lines.slice(previous + 1, i);
        const init = cycle.findIndex(l => l.from === 'cli' && l.message.type === 'system' && l.message.subtype === 'init');
        const firstContent = cycle.findIndex(l => l.from === 'cli' && content(l.message));
        const user = cycle.findIndex(l => l.from === 'cli' && l.message.type === 'user');
        t.diagnostic(`${name} CLI-started cycle ending ${at(i)}: system/init=${at(init < 0 ? -1 : previous + 1 + init)}, init before content=${init >= 0 && (firstContent < 0 || init < firstContent)}, woken user frame=${at(user < 0 ? -1 : previous + 1 + user)}`);
      }
    } finally { r.cleanup(); }
  });
}
