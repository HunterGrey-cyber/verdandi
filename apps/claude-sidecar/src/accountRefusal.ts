import { StartupRefusal, type RefusalCode, type ReportDetails } from './startupReport.js';

/**
 * Names the refusal an unusable account configuration is, for the startup report.
 *
 * The account is resolved by two modules that throw plain errors with texts a host and a person read
 * (`legacyAccountName.ts` for the name-to-directory layout, `packages/claude-runtime/src/account.ts`
 * for the explicit-directory mechanism), and those texts must not change. So the code is read off the
 * text, here, in one table; `tests/startupReport.test.ts` triggers every row through the real
 * resolver, which is what keeps a reworded message from quietly becoming `STARTUP_FAILED`.
 *
 * Each row: the message it recognises, where that message is thrown, and the code. A message that
 * matches no row is `STARTUP_FAILED` with the text unchanged (the one such text today: an account at an
 * explicit directory given no Anthropic directory, which the legacy layout never produces).
 */
const ROWS: ReadonlyArray<{ code: RefusalCode; match: RegExp; variable?: string }> = [
  // legacyAccountName.resolveAccountSpec: "VERDANDI_CLAUDE_ACCOUNT must be a single path-safe segment matching ..."
  // account.explicitAccount: "an account label must be a non-empty single line, got ..."
  { code: 'ACCOUNT_INVALID_NAME', match: /^(?:VERDANDI_CLAUDE_ACCOUNT must be a single path-safe segment|an account label must be a non-empty single line)/, variable: 'VERDANDI_CLAUDE_ACCOUNT' },
  // legacyAccountName.requireHome: "VERDANDI_CLAUDE_ACCOUNT is set but HOME is not, so <variable> cannot be derived; ..."
  // legacyAccountName.requireHome via requireAbsolute: "HOME must be an absolute path, got ..."
  // account.explicitAccount: "HOME is not set to an absolute path, so the CLI default location cannot be derived"
  { code: 'ACCOUNT_NO_HOME', match: /^(?:VERDANDI_CLAUDE_ACCOUNT is set but HOME is not|HOME must be an absolute path|HOME is not set to an absolute path)/ },
  // legacyAccountName.requireAbsolute / account.explicitAccount: "<variable> must be an absolute path, got ..."
  { code: 'ACCOUNT_RELATIVE_OVERRIDE', match: /^VERDANDI_CLAUDE_(?:ANTHROPIC_)?CONFIG_DIR must be an absolute path/ },
  // legacyAccountName.resolveAccountSpec: "VERDANDI_CLAUDE_ACCOUNT=default names the CLI's default location, but VERDANDI_CLAUDE_CONFIG_DIR=... names another; ..."
  // legacyAccountName.resolveAccountSpec / account.explicitAccount: "VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location: ..."
  { code: 'ACCOUNT_DEFAULT_CONFLICT', match: /^(?:VERDANDI_CLAUDE_ACCOUNT=default names the CLI's default location|VERDANDI_CLAUDE_ANTHROPIC_CONFIG_DIR cannot be combined with an account at the CLI's default location)/ },
  // account.assertAccountUsable: "claude account "<name>" is pinned but its config directory <dir> does not exist (or is not a directory)"
  { code: 'ACCOUNT_DIR_MISSING', match: /^claude account ".*" is pinned but its config directory .* does not exist/s },
  // account.assertAccountUsable: "claude account "<name>" is not logged in: <dir>/.credentials.json is missing and ANTHROPIC_API_KEY is unset"
  { code: 'ACCOUNT_NOT_LOGGED_IN', match: /^claude account ".*" is not logged in: /s },
  // account.assertDefaultLocationIntact: "... is at the CLI default location but <path> is a symlink; credentials and identity could then belong to different logins"
  { code: 'ACCOUNT_DEFAULT_LOCATION_SYMLINK', match: /^claude account ".*" is at the CLI default location but .* is a symlink; /s },
  // account.assertDefaultLocationIntact: "... but <path> is missing, so the login has no recorded identity",
  //   "...: <path> is not readable JSON (...)", "... but <path> records no oauthAccount.emailAddress, so the login has no recorded identity"
  { code: 'ACCOUNT_NO_RECORDED_IDENTITY', match: /^claude account ".*"(?: is at the CLI default location but .* (?:is missing|records no oauthAccount\.emailAddress), so the login has no recorded identity|: .* is not readable JSON)/s },
];

/** The text a host has always seen for an unusable account, in front of the resolver's own words. */
const PREFIX = 'claude account configuration is unusable: ';

/** The label inside `claude account "<label>"`, when the text has one. */
function accountOf(message: string): string | undefined {
  const quoted = /^claude account ("(?:[^"\\]|\\.)*")/.exec(message);
  if (quoted === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(quoted[1]);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function accountRefusal(error: unknown): StartupRefusal {
  const message = error instanceof Error ? error.message : String(error);
  const row = ROWS.find((candidate) => candidate.match.test(message));
  const details: ReportDetails = {};
  // The variable the message blames: the one it says is wrong ("..., but X=... names another"), else the one it starts with.
  const variable = row?.variable ?? /\bbut (VERDANDI_CLAUDE_[A-Z_]*[A-Z])=/.exec(message)?.[1] ?? /^(VERDANDI_CLAUDE_(?:ANTHROPIC_)?CONFIG_DIR)\b/.exec(message)?.[1];
  if (variable !== undefined) {
    details.variable = variable;
  }
  const account = accountOf(message);
  if (account !== undefined) {
    details.account = account;
  }
  return new StartupRefusal(row?.code ?? 'STARTUP_FAILED', `${PREFIX}${message}`, details, `${PREFIX}${withoutParserText(error, message)}`);
}

/**
 * The resolver's message for the report file. JSON.parse's own message quotes the file it failed on
 * (all of a short one, else the text around the fault), and `$HOME/.claude.json` holds the login's
 * email, account ids and more, so a parse failure is recorded by the error's name only. stderr keeps
 * the whole text, as it always has.
 */
function withoutParserText(error: unknown, message: string): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof SyntaxError)) {
    return message;
  }
  const quoted = ` (${cause.message})`;
  if (!message.endsWith(quoted)) {
    return message;
  }
  return `${message.slice(0, -quoted.length)} (${cause.name}; the parser's text quotes the file, so it is left out)`;
}
