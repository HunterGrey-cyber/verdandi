import type { ClaudeRuntimeEvent, SessionNoticePayload } from './types.js';

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Raw : undefined;

/** Only the CLI's text and explicitly named scalars cross this boundary. Unknown fields, including
 * retracted message ids, cannot become part of the event by object spreading. */
export function sessionNoticeOf(raw: Raw, diagnostic?: (line: string) => void): ClaudeRuntimeEvent[] | undefined {
  let dropped = 0;
  const string = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    dropped++; return undefined;
  };
  const number = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    dropped++; return undefined;
  };
  const fields = <T extends object>(values: T): T => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as T;
  const finish = (event: ClaudeRuntimeEvent): ClaudeRuntimeEvent[] => {
    if (dropped) diagnostic?.(`dropped ${dropped} malformed session notice fields`);
    return [event];
  };
  const notice = (payload: Omit<SessionNoticePayload, 'level'> & { level?: SessionNoticePayload['level'] }) =>
    finish({ type: 'session_notice', level: 'notice', ...payload });
  if (raw.type === 'conversation_reset') {
    const id = string(raw.new_conversation_id);
    const trigger = string(raw.trigger);
    if (id !== undefined) return finish({ type: 'conversation_reset', newConversationId: id, ...fields({ trigger }) });
    return finish({ type: 'provider_notice', kind: raw.type as string, subtype: null, raw });
  }
  if (raw.type === 'peer_message_hold' || raw.type === 'system' && raw.subtype === 'peer_message_hold') {
    if (raw.state !== 'held' && raw.state !== 'released' && raw.state !== 'dropped') {
      dropped++;
      return finish({ type: 'provider_notice', kind: raw.type as string, subtype: raw.type === 'system' ? 'peer_message_hold' : null, raw });
    }
    return notice({ kind: 'peer_hold', holdState: raw.state, ...fields({ peerName: string(raw.peer_name) }) });
  }
  if (raw.type === 'rate_limit_event') {
    const info = record(raw.rate_limit_info);
    if (!info) dropped++;
    const status = info?.status;
    const rateStatus = status === 'allowed' || status === 'allowed_warning' || status === 'rejected' ? status : undefined;
    if (status !== undefined && rateStatus === undefined) dropped++;
    const resetsAt = number(info?.resetsAt);
    // Older CLI timestamps have no declared unit; epoch seconds and milliseconds are disjoint here.
    return notice({ kind: 'rate_limit', ...fields({ rateStatus, resetsAtMs: resetsAt === undefined ? undefined : resetsAt < 1e11 ? resetsAt * 1000 : resetsAt, utilization: number(info?.utilization) }) });
  }
  if (raw.type !== 'system') return undefined;
  switch (raw.subtype) {
    case 'api_retry':
      return notice({ kind: 'api_retry', ...fields({ attempt: number(raw.attempt), maxRetries: number(raw.max_retries), retryDelayMs: number(raw.retry_delay_ms), errorStatus: number(raw.error_status), errorKind: string(raw.error) }) });
    case 'model_refusal_fallback':
    case 'model_fallback':
      return notice({ kind: 'model_fallback', ...fields({ fromModel: string(raw.original_model), toModel: string(raw.fallback_model), fallbackScope: string(raw.scope) ?? 'session', content: string(raw.content) }) });
    case 'model_refusal_no_fallback':
      return notice({ kind: 'model_refusal', level: 'warning', ...fields({ fromModel: string(raw.original_model), content: string(raw.content) }) });
    case 'status':
      return raw.status === 'compacting' ? notice({ kind: 'compacting' }) : undefined;
    case 'compact_boundary': {
      const metadata = record(raw.compact_metadata);
      if (!metadata) dropped++;
      return notice({ kind: 'compact_boundary', ...fields({ preTokens: number(metadata?.pre_tokens), postTokens: number(metadata?.post_tokens), trigger: string(metadata?.trigger) }) });
    }
    case 'informational': {
      const level = raw.level;
      const valid = level === 'info' || level === 'notice' || level === 'suggestion' || level === 'warning';
      if (level !== undefined && !valid) dropped++;
      return notice({ kind: 'informational', level: valid ? level : 'notice', ...fields({ content: string(raw.content) }) });
    }
    case 'notification':
      return notice({ kind: 'notification', ...fields({ content: string(raw.text) }) });
    default:
      return undefined;
  }
}
