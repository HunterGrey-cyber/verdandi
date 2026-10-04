/**
 * The shape of the M1 recordings' `manifest.json` (`tests/fixtures/m1/`). The recordings stay in this
 * package, and so does the type its readers need; the probe that wrote them lives in a private
 * workspace and imports the type from here, never the other way round.
 */

export type FailureShape = {
  observed_as: 'result' | 'provider_failure' | 'timeout' | 'none';
  subtype: string | null;
  is_error: boolean | null;
  terminal_reason: string | null;
  api_error_status: number | null;
  errors: string[];
  result_text: string | null;
  assistant_error: string | null;
  rejection: string | null;
  rate_limit_status: string | null;
};

/** How one LAN URL of the `web-lan` case ended. `rule`: every WebFetch call on it failed AND is
 * listed in permission_denials, i.e. a deny rule refused it before any packet was sent. `error`:
 * it failed, but not by a rule (the network, TLS, anything). `not_blocked`: content came back.
 * `not_attempted`: no call on it produced a tool_result. */
export type LanOutcome = { url: string; blocked_by: 'rule' | 'error' | 'not_blocked' | 'not_attempted' };

/**
 * What later plans read. `files` maps a logical name (`success_result`, `auth-invalid_messages`,
 * ...) to a file name in the same directory. Every value was redacted before it was written.
 */
export type M1FixtureManifest = {
  schema: 'verdandi.m1-fixtures/v1';
  recorded_at: string;
  host: string;
  cli_version: string;
  sdk_version: string;
  model_requested: string;
  model_resolved: string | null;
  effort_requested: string;
  carrier_tool: string | null;
  init_tools: string[];
  permission_mode: string;
  usage_shape: 'cache_dominant' | 'uncached';
  account_info_before_first_turn: 'ok' | 'timeout' | 'error' | 'not_measured';
  failure_shapes: { auth: FailureShape | null; schema_retry: FailureShape | null; quota: FailureShape | null };
  files: Record<string, string>;
  redactions: string[];
  /** The `web-tools` recording (promote-web): system/init tools of a tool-bearing completion. */
  web_init_tools?: string[];
  /** The `web-tools` recording: the Haiku models WebFetch's own call billed in that session. */
  web_haiku_models?: string[];
  /** The `web-lan` recording (promote-web): how each LAN URL ended. Recorded on a host that does
   * not restrict the network, so `rule` there can only be the WebFetch deny rule. */
  web_lan_outcomes?: LanOutcome[];
};
