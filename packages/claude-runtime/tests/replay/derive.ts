import { type Line } from './recording.js';
export function withoutLifecycle(messages: Line[]): Line[] {
  return structuredClone(messages).filter(line => line.message.type !== 'command_lifecycle').map(line => {
    const m = line.message;
    if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.capabilities)) {
      m.capabilities = m.capabilities.filter((c: unknown) => c !== 'msg_lifecycle_v1');
    }
    return line;
  });
}
/** Reproduces providers that do not echo the prompt identity in their result. */
export function c04c(messages: Line[]): Line[] {
  const hostUuids = messages.filter(line => line.from === 'host' && line.message.type === 'user').map(line => line.message.uuid);
  const promptUuid = hostUuids.at(-1);
  return structuredClone(messages).map(line => {
    if (line.from === 'cli' && line.message.type === 'result' && line.message.user_message_uuid === promptUuid) delete line.message.user_message_uuid;
    return line;
  });
}
