/**
 * Every decision tools/setup-analytics.mjs makes, with none of its I/O.
 *
 * The setup script talks to the Cloudflare API on the chapter's live account,
 * once, run by a person who will not read its source. So everything that
 * decides WHAT it does (which account is the right one, what counts as
 * already done, what goes in each request body, which hostnames Access can
 * cover, what an API error means in plain words) lives here as pure
 * functions, tested directly by tests/unit/setup-analytics-plan.test.ts. The
 * script beside it only fetches, prints and sequences.
 *
 * API shapes are the ones recorded, from Cloudflare's docs and from wrangler's
 * own source, in docs/analytics.md.
 */

/** @typedef {{ type?: string, value?: string }} EnvVar */
/** @typedef {{ d1_databases?: Record<string, { id?: string }>, env_vars?: Record<string, EnvVar | null>, compatibility_date?: string }} DeploymentConfig */

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/** The chapter's Cloudflare account, "Ch 227". The Pages project lives here. */
export const ACCOUNT = 'd4afcdf7502fa80e6443dbb67ecd1d5f';
/** The Pages project that serves vva227.org. */
export const PROJECT = 'vva227-refresh';
/** The D1 database the collector writes to. */
export const DATABASE = 'vva227-beacon';
/** The site's zone. The account that owns it is the account Access must be set up in. */
export const ZONE = 'vva227.org';
/** The Access application and its reusable policy, found again by these names on a rerun. */
export const APP = 'vva227 stats';
export const POLICY = 'vva227 stats owners';

/** The path Access protects. tests/contracts/setup-analytics.test.ts holds it to STATS_PATH in src/data/analytics.ts. */
export const STATS_PATH = '/stats';

/** What functions/ reads from the Pages project. The contract tier proves each name is the one the code reads. */
export const BINDING = 'BEACON';
export const SALT_VAR = 'BEACON_SALT';
export const TEAM_VAR = 'ACCESS_TEAM_DOMAIN';
export const AUD_VAR = 'ACCESS_AUD';

/** How long one sign-in lasts: how long a borrowed or stolen browser stays in. */
export const SESSION_DURATION = '24h';

/** The branch `npm run deploy` publishes to. A deploy to any other branch is a preview, with no production settings. */
export const DEPLOY_BRANCH = 'main';

/** The gitignored file the token may be kept in, at the repo root. */
export const TOKEN_FILE = '.cf-api-token';

/** wrangler's own bookkeeping table, so `wrangler d1 migrations list` agrees with what this script applied. */
export const MIGRATIONS_TABLE = 'd1_migrations';
export const CREATE_MIGRATIONS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
export const MIGRATIONS_TABLE_EXISTS_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'";
export const APPLIED_MIGRATIONS_SQL = 'SELECT name FROM d1_migrations ORDER BY id';

/** The token permissions, by the names the dashboard's custom-token form uses. */
export const TOKEN_PERMISSIONS = [
  'Account › Cloudflare Pages › Edit',
  'Account › D1 › Edit',
  'Account › Access: Apps and Policies › Edit',
  'Account › Access: Organizations, Identity Providers, and Groups › Read',
  'Zone › Zone › Read',
];

export const USAGE = `Usage: npm run setup:analytics -- --email you@example.com [--email someone@example.com] [--dry-run] [--end-sign-ins]

  --email         Who may open /stats. Repeat it for each person. Required:
                  this list is the whole list, so include everyone every time.
                  Leaving someone out ends every open /stats sign-in.
  --dry-run       Look, print what would change, and change nothing.
  --end-sign-ins  End every open /stats sign-in even when this run takes
                  nobody's access away: for finishing a run that stopped
                  before it could end them.

The Cloudflare API token is read from the CF_API_TOKEN environment variable,
or from a file named ${TOKEN_FILE} at the top of this repository that only you
can read (chmod 600 ${TOKEN_FILE}).`;

/** A stop the script makes on purpose, with a message written for the person running it. */
export class StopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StopError';
  }
}

// ---------------------------------------------------------------------------
// Arguments and token
// ---------------------------------------------------------------------------

/**
 * A usable email address, or null. Deliberately plain: one @, something on
 * both sides, a dot in the domain, and nothing a JSON body or a shell could
 * misread. Access itself is the authority on deliverability.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

/**
 * @returns {{ emails: string[], dryRun: boolean, endSignIns: boolean, help: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  const emails = [];
  let dryRun = false;
  let endSignIns = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--end-sign-ins') endSignIns = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--email' || arg.startsWith('--email=')) {
      const value = arg === '--email' ? argv[++i] : arg.slice('--email='.length);
      if (value === undefined || value.startsWith('--')) return { error: '--email needs an address after it.' };
      const email = normalizeEmail(value);
      if (!email) return { error: `"${value}" is not an email address.` };
      if (!emails.includes(email)) emails.push(email);
    } else return { error: `Unknown option "${arg}".` };
  }
  if (help) return { emails, dryRun, endSignIns, help };
  if (!emails.length) {
    return { error: 'Say who may open /stats with --email (repeat it for each person). Nobody is added by default.' };
  }
  return { emails, dryRun, endSignIns, help };
}

/** The token from the environment, else from the file's text, trimmed; '' when there is none. */
export function resolveToken(envValue, fileText) {
  const fromEnv = typeof envValue === 'string' ? envValue.trim() : '';
  if (fromEnv) return fromEnv;
  return typeof fileText === 'string' ? fileText.trim() : '';
}

export function noTokenMessage() {
  return [
    'No Cloudflare API token found.',
    '',
    'Sign in to Cloudflare with a login that belongs to the chapter\'s "Ch 227" account (not a personal one),',
    `then create one at https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token, with:`,
    ...TOKEN_PERMISSIONS.map((p) => `  - ${p}`),
    `Account resources: the "Ch 227" account (and, if vva227.org is in a different Cloudflare account, that one too).`,
    `Zone resources: vva227.org.`,
    '',
    `Then save it in a file named ${TOKEN_FILE} at the top of this repository (it is gitignored), and make`,
    `that file readable by you alone:  chmod 600 ${TOKEN_FILE}`,
    'Or set CF_API_TOKEN instead.',
  ].join('\n');
}

/**
 * Can an account other than the file's owner read (or reach) it? The token
 * can deploy the live site and change who may read its visitors, so a file
 * readable by the group or by everyone is refused. Mode bits only; Windows,
 * which has none, is not checked by the caller.
 */
export function tokenFileOpenToOthers(mode) {
  return (mode & 0o077) !== 0;
}

export function tokenFileOpenMessage() {
  return [
    `${TOKEN_FILE} can be read by other accounts on this computer, so this script will not use it.`,
    `Make it readable by you alone, then run this again:  chmod 600 ${TOKEN_FILE}`,
    'Or set CF_API_TOKEN instead, for example where chmod has no effect, such as a Windows drive opened under WSL.',
    'Nothing was changed.',
  ].join('\n');
}

/** Removes every occurrence of the token from text that is about to be printed. */
export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join('[token]') : s;
}

// ---------------------------------------------------------------------------
// The Pages project
// ---------------------------------------------------------------------------

export function projectNotFoundMessage() {
  return [
    `There is no Pages project named "${PROJECT}" in account ${ACCOUNT} ("Ch 227").`,
    'Either the token is for a different Cloudflare account, or the project has been renamed. Nothing was changed.',
  ].join('\n');
}

/** Cloudflare's answer for a project that does not exist. */
export function isProjectMissing({ status, body }) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return status === 404 || errors.some((e) => e?.code === 8000007);
}

/**
 * Said under the production compatibility date in step 1. The local runtime
 * tests cannot always run on production's date: the workerd the installed
 * wrangler brings refuses dates newer than itself, so
 * RUNTIME_COMPATIBILITY_DATE is the nearest one it accepts.
 */
export const RUNTIME_DATE_NOTE = '(the local runtime tests run on the nearest date the installed wrangler supports; see tests/helpers/pages-runtime.ts)';

/**
 * Is this the project that serves vva227.org, in the right account?
 *
 * The guard exists because the wrong-account accident already happened once:
 * wrangler's cached account id created a project in the wrong account. A
 * project named vva227-refresh that does not serve vva227.org is somebody's
 * copy, and writing production settings to it would change nothing live.
 */
export function checkProject(project) {
  if (!project || typeof project !== 'object') {
    throw new StopError(`Cloudflare returned no project for ${PROJECT}. Nothing was changed.`);
  }
  const domains = Array.isArray(project.domains) ? project.domains : [];
  if (!domains.includes(ZONE)) {
    throw new StopError(
      [
        `The Pages project "${PROJECT}" in account ${ACCOUNT} does not serve ${ZONE}`,
        `(its domains: ${domains.length ? domains.join(', ') : 'none'}).`,
        'That is not the live site, so nothing was changed. Check that the token is for the "Ch 227" account.',
      ].join('\n'),
    );
  }
  const warnings = [];
  const productionBranch = typeof project.production_branch === 'string' ? project.production_branch : '';
  if (productionBranch !== DEPLOY_BRANCH) {
    warnings.push(
      [
        `WARNING: the project's production branch is "${productionBranch || '(not set)'}", not "${DEPLOY_BRANCH}".`,
        `\`npm run deploy\` publishes to "${DEPLOY_BRANCH}", so with this setting its deploys are PREVIEWS:`,
        'they get none of the settings below, and visits would not be counted.',
        'Ask whoever deploys the site which branch they publish to before deploying this. The settings',
        'below are still written to production, so they are ready whichever way that is resolved.',
      ].join('\n'),
    );
  }
  const subdomain = typeof project.subdomain === 'string' && /^[a-z0-9-]+\.pages\.dev$/.test(project.subdomain) ? project.subdomain : null;
  return {
    productionBranch,
    compatibilityDate: project.deployment_configs?.production?.compatibility_date ?? null,
    subdomain,
    production: project.deployment_configs?.production ?? {},
    warnings,
  };
}

/**
 * What step (c) must send so production has the binding and a salt.
 *
 * Production ONLY: the body never has a `preview` key, so preview settings are
 * untouched. Never an empty map: a key appears only with something in it.
 * Never a deletion. The salt is created only when no secret salt exists;
 * replacing one would silently re-key every visitor id, so an existing secret
 * is never compared, read or overwritten.
 *
 * @param {DeploymentConfig} production the current production config, from GET
 * @param {{ databaseId: string | null, newSalt: () => string }} want  null only on a dry run, before the database exists
 * @returns {{ body: object | null, changes: { did: string, would: string }[], notes: string[] }}
 *   each change worded for a real run (`did`) and for a dry run's "A real run would:" (`would`)
 */
export function planBindings(production, { databaseId, newSalt }) {
  const prod = production ?? {};
  const changes = [];
  const notes = [];
  const d1 = {};
  const vars = {};

  const bound = prod.d1_databases?.[BINDING]?.id;
  if (bound && bound !== databaseId) {
    throw new StopError(
      [
        `${BINDING} is already bound to a different D1 database (${bound}), not ${DATABASE}${databaseId ? ` (${databaseId})` : ', which a real run would create'}.`,
        'This script will not move it: the visits recorded so far live in that database.',
        `If it should be replaced, remove the ${BINDING} binding in the dashboard (Workers & Pages -> ${PROJECT} -> Settings -> Bindings) and run this again.`,
        'Nothing else was changed in the project.',
      ].join('\n'),
    );
  }
  if (bound === databaseId) notes.push(`${BINDING} is already bound to ${DATABASE}.`);
  else {
    d1[BINDING] = { id: databaseId };
    changes.push({ did: `bound ${BINDING} to the ${DATABASE} database`, would: `bind ${BINDING} to the ${DATABASE} database` });
  }

  const salt = prod.env_vars?.[SALT_VAR];
  if (salt?.type === 'secret_text') notes.push(`${SALT_VAR} already exists, encrypted; it is kept as it is.`);
  else if (salt) {
    notes.push(
      [
        `${SALT_VAR} exists as a plain-text variable. It is left alone, because replacing it would reset every visitor id.`,
        'It works as it is, but anyone with dashboard access can read it. To make it secret, delete it in the dashboard and run this again.',
      ].join('\n'),
    );
  } else {
    vars[SALT_VAR] = { type: 'secret_text', value: newSalt() };
    changes.push({ did: `created ${SALT_VAR}, a new random secret, encrypted`, would: `create ${SALT_VAR}, a new random secret, encrypted` });
  }

  const production_ = {};
  if (Object.keys(d1).length) production_.d1_databases = d1;
  if (Object.keys(vars).length) production_.env_vars = vars;
  const body = Object.keys(production_).length ? { deployment_configs: { production: production_ } } : null;
  return { body, changes, notes };
}

/** Step (e): the two Access settings, always written, so they always match the application. */
export function accessSettingsBody(teamDomain, aud) {
  return {
    deployment_configs: {
      production: {
        env_vars: {
          [TEAM_VAR]: { type: 'secret_text', value: teamDomain },
          [AUD_VAR]: { type: 'secret_text', value: aud },
        },
      },
    },
  };
}

/**
 * What must be true of production after a write. Returns the problems, if any.
 *
 * @param {DeploymentConfig} production
 */
export function verifyProduction(production, { databaseId, access }) {
  const prod = production ?? {};
  const problems = [];
  if (prod.d1_databases?.[BINDING]?.id !== databaseId) problems.push(`${BINDING} is not bound to ${DATABASE} (${databaseId})`);
  if (!prod.env_vars?.[SALT_VAR]) problems.push(`${SALT_VAR} is missing`);
  if (access) {
    for (const name of [TEAM_VAR, AUD_VAR]) {
      if (prod.env_vars?.[name]?.type !== 'secret_text') problems.push(`${name} is missing`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/**
 * The one item whose name is exactly `name`, or null.
 *
 * Cloudflare's name filters are not documented as exact, so every lookup is
 * matched here. Two exact matches is a state this script did not create and
 * will not guess about.
 */
export function findByName(items, name, what) {
  const matches = (Array.isArray(items) ? items : []).filter((item) => item && item.name === name);
  if (matches.length > 1) {
    const plural = what.endsWith('y') ? `${what.slice(0, -1)}ies` : `${what}s`;
    throw new StopError(`There are ${matches.length} ${plural} named "${name}". Delete the extra one in the dashboard and run this again. Nothing further was changed.`);
  }
  return matches[0] ?? null;
}

/**
 * Migration files in the order wrangler applies them: by numeric prefix, then
 * by name. Refuses a name that could not be written into the bookkeeping
 * INSERT as a plain literal.
 */
export function migrationOrder(fileNames) {
  const files = fileNames.filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    if (!/^\d+_[A-Za-z0-9_-]+\.sql$/.test(f)) throw new StopError(`Unexpected migration file name "${f}". Nothing was applied.`);
  }
  return files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || (a < b ? -1 : a > b ? 1 : 0));
}

export function pendingMigrations(ordered, applied) {
  const done = new Set(applied);
  return ordered.filter((name) => !done.has(name));
}

/** The file's SQL and its bookkeeping row, in one request, as wrangler sends them. */
export function migrationRequestSql(name, sql) {
  if (!/^\d+_[A-Za-z0-9_-]+\.sql$/.test(name)) throw new StopError(`Unexpected migration file name "${name}".`);
  return `${sql.trimEnd()}\nINSERT INTO ${MIGRATIONS_TABLE} (name) values ('${name}');`;
}

/** Rows from the first statement of a D1 query response. */
export function queryRows(result) {
  const first = Array.isArray(result) ? result[0] : null;
  return Array.isArray(first?.results) ? first.results : [];
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** A name from Cloudflare, about to be printed, without the control characters it could carry; '' when there is none. */
function printable(text) {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
}

/**
 * The account that owns the zone, from GET /zones?name=, as { id, name }.
 * Null when the token cannot see it. The name is null when Cloudflare gives none.
 */
export function zoneAccount(zones) {
  const zone = findByName(zones, ZONE, 'zone');
  const id = zone?.account?.id;
  if (typeof id !== 'string' || !id) return null;
  return { id, name: printable(zone.account.name) || null };
}

/** An account the way the person running this can find it in the dashboard: its name, then its id. */
export function accountLabel({ id, name }) {
  if (id === ACCOUNT) return `"Ch 227" (${ACCOUNT})`;
  return name ? `"${name}" (${id})` : id;
}

export function zoneNotVisibleMessage() {
  return [
    `The token cannot see the ${ZONE} zone, so this script cannot tell which Cloudflare account Access belongs in.`,
    `Give the token "Zone › Zone › Read" for ${ZONE}. If ${ZONE} lives in a different Cloudflare account from "Ch 227",`,
    'the token must include that account too. Then run this again; what is already done will be skipped.',
    `If you cannot select ${ZONE} in the token form, the zone is in an account your login is not a member of:`,
    "ask that account's administrator to add you, or to run this script, before /stats can be opened.",
  ].join('\n');
}

/** The team domain from GET /access/organizations, or null when Zero Trust is not set up. */
export function teamDomainFrom(organization) {
  const org = Array.isArray(organization) ? organization[0] : organization;
  const domain = typeof org?.auth_domain === 'string' ? org.auth_domain.trim() : '';
  return domain || null;
}

/** The login method that signs a person in with a code emailed to their address, as the API types it. */
export const ONE_TIME_PIN = 'onetimepin';

/** Where One-time PIN is turned on, as Cloudflare's docs name the dashboard path (October 2026). */
const ONE_TIME_PIN_PATH = 'Zero Trust -> Integrations -> Identity providers';

/**
 * What step 4 says about the team's login methods (GET
 * /access/identity_providers), or null when One-time PIN is among them.
 *
 * Access's sign-in page offers only the methods the team has turned on.
 * Without One-time PIN, the people on the list cannot sign in with their own
 * address: the page signs them in some other way, as someone not on the
 * list, and Access answers "That account does not have access". That is
 * what the first live run met. The token can only read login methods, and
 * another method might still sign the listed people in, so this is a
 * warning and never a stop. Anything but a list counts as no methods.
 */
export function loginMethodWarning(methods) {
  const list = Array.isArray(methods) ? methods : [];
  if (list.some((m) => m?.type === ONE_TIME_PIN)) return null;
  const types = list.map((m) => m?.type).filter((t) => typeof t === 'string' && t);
  return [
    'WARNING: One-time PIN is not turned on for this Zero Trust team.',
    `Login methods turned on now: ${types.length ? types.join(', ') : 'none'}.`,
    `Until it is on, the people on the list cannot sign in to ${STATS_PATH} with a code emailed to them, and`,
    'anyone the sign-in page lets in with an address not on the list sees "That account does not have access".',
    `Turn it on in the dashboard: ${ONE_TIME_PIN_PATH} -> Add new identity provider`,
    '-> One-time PIN (in older dashboards: Settings -> Authentication -> Login methods -> Add new -> One-time PIN).',
    'This script does not need to run again for it.',
  ].join('\n');
}

/** One line, when the login methods could not be read; the run carries on. */
export function loginMethodsUnreadableNote(detail) {
  const first = String(detail ?? '').split('\n')[0];
  return `Could not read the login methods (${first}); check that One-time PIN is turned on: ${ONE_TIME_PIN_PATH}.`;
}

/** @param {{ id: string, name: string | null }} account the account that owns the zone */
export function zeroTrustInstructions(account) {
  return [
    `Cloudflare Zero Trust is not turned on for the account ${accountLabel(account)}, which owns ${ZONE}.`,
    'This has to be done once, by hand, in the dashboard:',
    '  1. Open https://one.dash.cloudflare.com and pick that account.',
    '  2. Choose a team name (it becomes <team>.cloudflareaccess.com; anything short works).',
    '  3. Choose the Free plan. Cloudflare asks for card details even on the Free plan; it does not charge them.',
    '  4. Turn on One-time PIN, so the people on the list sign in with a code emailed to them:',
    `     ${ONE_TIME_PIN_PATH} -> Add new identity provider -> One-time PIN.`,
    'Then run this command again. Everything already done above will be skipped.',
    'Nothing after this point was changed.',
  ].join('\n');
}

/**
 * A copy of what a GET returned, without the keys Cloudflare keeps itself.
 * An update of an Access application or policy is a PUT, which replaces it
 * whole, so the body starts from everything it already has.
 */
function editable(existing, serverKeys) {
  const copy = { ...existing };
  for (const key of serverKeys) delete copy[key];
  return copy;
}

/** What Cloudflare sets on a reusable policy itself. */
const POLICY_SERVER_KEYS = ['id', 'created_at', 'updated_at', 'app_count', 'reusable'];

/**
 * The reusable policy: an allow, whose include list is exactly these
 * addresses, nothing broader.
 *
 * An update starts from everything the existing policy has, so it keeps
 * what somebody set in the dashboard (its session length, exclude and require
 * rules, approval, purpose justification, MFA, isolation) and replaces only
 * the decision and the include list. A new policy signs people in for
 * SESSION_DURATION.
 */
export function policyBody(emails, existing = null) {
  const body = {
    name: POLICY,
    session_duration: SESSION_DURATION,
    ...(existing ? editable(existing, POLICY_SERVER_KEYS) : {}),
    decision: 'allow',
    include: emails.map((email) => ({ email: { email } })),
  };
  // An empty rule list means the same as none, and is left out.
  for (const key of ['exclude', 'require']) {
    if (!(Array.isArray(body[key]) && body[key].length)) delete body[key];
  }
  return body;
}

/** The address a single-address include rule admits, lower-cased; null for any wider rule. */
function ruleEmail(rule) {
  const email = typeof rule?.email?.email === 'string' ? rule.email.email.trim().toLowerCase() : null;
  return email && Object.keys(rule).length === 1 ? email : null;
}

/**
 * Does the existing policy admit exactly these addresses, and nothing else?
 * Any include rule that is not a single email (everyone, a whole domain, a
 * group) counts as a difference, so it gets replaced by the explicit list.
 */
export function policyMatches(policy, emails) {
  if (policy?.decision !== 'allow') return false;
  const include = Array.isArray(policy?.include) ? policy.include : [];
  const have = [];
  for (const rule of include) {
    const email = ruleEmail(rule);
    if (!email) return false;
    have.push(email);
  }
  const want = [...new Set(emails)].sort();
  return JSON.stringify([...new Set(have)].sort()) === JSON.stringify(want);
}

/**
 * Does replacing this policy's include list with `emails` take access away
 * from anyone? True when it let in an address the new list leaves out, or
 * anyone by a wider rule (everyone, a domain, a group). A deny let nobody in.
 * Access checks a changed policy only at each person's next sign-in, so
 * whoever this is true for may still be signed in.
 */
export function policyNarrows(policy, emails) {
  if (!policy || policy.decision === 'deny') return false;
  const keep = new Set(emails);
  return (Array.isArray(policy.include) ? policy.include : []).some((rule) => !keep.has(ruleEmail(rule)));
}

/**
 * Which hostnames the Access application covers.
 *
 * An Access application may only name hostnames in a zone of its own account,
 * plus that account's own *.pages.dev. So the pages.dev names are included
 * only when the zone's account is the Pages project's account. When they are
 * not covered, /stats there is still closed: Access issues no token on a host
 * it does not cover, and the Function refuses a request with no token. A
 * valid token copied from vva227.org and sent there by hand is accepted until
 * it expires (Known gaps in tests/BUSINESS_RULES.md), so the messages below
 * speak of someone browsing there, not of everyone.
 */
export function destinationsFor({ accessAccount, subdomain }) {
  const hosts = [ZONE, `www.${ZONE}`];
  let skipped = null;
  if (accessAccount.id !== ACCOUNT) {
    skipped = `${ZONE} is in a different Cloudflare account, ${accountLabel(accessAccount)}, from the Pages project, and Access can only cover hostnames in its own account, so the pages.dev address is not covered. /stats there stays a plain "Not found" to anyone who browses to it; use https://${ZONE}${STATS_PATH}.`;
  } else if (!subdomain) {
    skipped = `The project reported no pages.dev address, so only ${ZONE} is covered. /stats elsewhere stays a plain "Not found" to anyone who browses to it.`;
  } else {
    hosts.push(subdomain, `*.${subdomain}`);
  }
  return { destinations: hosts.map((host) => ({ type: 'public', uri: `${host}${STATS_PATH}` })), skipped };
}

const uris = (app) => (Array.isArray(app?.destinations) ? app.destinations : []).map((d) => d?.uri).filter((u) => typeof u === 'string');
/** The policies on an application, as objects: Cloudflare may give one as a bare id. */
const policiesOn = (app) =>
  (Array.isArray(app?.policies) ? app.policies : []).map((p) => (typeof p === 'string' ? { id: p } : p)).filter((p) => p && typeof p.id === 'string');

/**
 * What Cloudflare sets on an application itself. self_hosted_domains is the
 * deprecated twin of destinations, derived from it: sending both can conflict.
 */
const APP_SERVER_KEYS = ['id', 'uid', 'aud', 'created_at', 'updated_at', 'self_hosted_domains'];

/**
 * The application body: the full desired state for a new application, or, for
 * an existing one, what it has plus what is missing.
 *
 * The application named "vva227 stats" is this script's, and this script's
 * policy alone decides who opens /stats (rule A13): an update sends that one
 * policy, by id, and no other, so a policy someone attached in the dashboard
 * is taken off (the script names it as it does). Everything else starts from
 * what the application already has: every destination, and every setting the
 * owner chose (session length, launcher visibility, identity providers, cookie
 * and other hardening), and only this script's missing destinations are added.
 */
export function appBody({ policyId, destinations, existing = null }) {
  const policies = [{ id: policyId, precedence: 1 }];
  if (!existing) {
    return {
      type: 'self_hosted',
      name: APP,
      domain: destinations[0].uri,
      destinations,
      session_duration: SESSION_DURATION,
      app_launcher_visible: false,
      policies,
    };
  }
  const have = uris(existing);
  const merged = [
    ...(Array.isArray(existing.destinations) ? existing.destinations.filter((d) => typeof d?.uri === 'string') : []),
    ...destinations.filter((d) => !have.includes(d.uri)),
  ];
  return {
    type: 'self_hosted',
    name: APP,
    session_duration: SESSION_DURATION,
    app_launcher_visible: false,
    ...editable(existing, APP_SERVER_KEYS),
    domain: typeof existing.domain === 'string' && existing.domain ? existing.domain : destinations[0].uri,
    destinations: merged,
    policies,
  };
}

/** Does the existing application already cover every destination, with this script's policy as its only one? */
export function appMatches(app, { policyId, destinations }) {
  const have = uris(app);
  const ids = policiesOn(app).map((p) => p.id);
  return destinations.every((d) => have.includes(d.uri)) && ids.length === 1 && ids[0] === policyId;
}

/**
 * Every policy on the application but this script's, as { id, name, decision }:
 * what an update takes off. The application's own answer usually carries each
 * policy's name and decision; when it does not, the account's list does.
 */
export function otherPolicies(app, policyId, listed = []) {
  const known = Array.isArray(listed) ? listed : [];
  return policiesOn(app)
    .filter((p) => p.id !== policyId)
    .map((p) => {
      const fromList = known.find((x) => x?.id === p.id);
      return { id: p.id, name: printable(p.name ?? fromList?.name) || null, decision: printable(p.decision ?? fromList?.decision) || null };
    });
}

/** A policy the way the dashboard shows it: its name and its decision. */
export function policyLabel({ id, name, decision }) {
  return `${name ? `"${name}"` : id} (decision: ${decision ?? 'not given'})`;
}

/** How long the policy's sign-ins last: its own session length, else the one a new policy gets. */
function sessionLength(policy) {
  return typeof policy?.session_duration === 'string' && policy.session_duration ? policy.session_duration : SESSION_DURATION;
}

/**
 * What a run says last about who can open /stats. It is the --email list,
 * because the application carries this one policy, the policy admits exactly
 * that list, and a run that took anyone's access away ended the sign-ins
 * already open. Two things qualify it, and then it says so: require or
 * exclude rules someone set on the policy in the dashboard, which are kept
 * and narrow it further; and, when sign-ins were ended but the pages.dev
 * address is not covered by Access, a copied sign-in still working there.
 *
 * @param {{ endedWherePagesDevUncovered?: boolean }} [options]
 */
export function whoCanOpen(emails, existing = null, { endedWherePagesDevUncovered = false } = {}) {
  const lines = [`Who can open ${STATS_PATH}: ${emails.join(', ')}`];
  const kept = ['require', 'exclude'].filter((key) => Array.isArray(existing?.[key]) && existing[key].length);
  if (kept.length) lines.push(`(only while they also meet the policy's ${kept.join(' and ')} rules, which were set in the dashboard and are kept)`);
  if (endedWherePagesDevUncovered) {
    lines.push(
      `(Access cannot end a sign-in at the pages.dev address, which it does not cover here: someone just removed who kept a copy of theirs can use it there until it runs out, at most ${sessionLength(existing)}.)`,
    );
  }
  return lines;
}

/**
 * What a run says when it stops after taking access away from someone (or
 * after --end-sign-ins asked) and before the sign-ins already open were
 * ended. Cloudflare keeps no record that an end is owed, so a rerun of the
 * same command finds the policy already right and ends nothing: the owner
 * has to ask for it.
 *
 * @param {object | null} [existing] the policy as the run found it, for how long its sign-ins last
 */
export function signInsNotEndedMessage(existing = null) {
  return [
    `Sign-ins already open to ${STATS_PATH} were NOT ended. Anyone taken off the list can still open it`,
    `until their sign-in runs out, at most ${sessionLength(existing)}.`,
    'Running the same command again will not end them: it finds nothing left to change. To end them,',
    'once the problem above is fixed, run the same command with --end-sign-ins added, or',
    `open the application "${APP}" in the Zero Trust dashboard and revoke its existing tokens.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Errors and the closing message
// ---------------------------------------------------------------------------

/** The token permission a request path needs, by the dashboard's name for it. */
export function permissionFor(path) {
  if (path.includes('/pages/projects')) return TOKEN_PERMISSIONS[0];
  if (path.includes('/d1/')) return TOKEN_PERMISSIONS[1];
  if (path.includes('/access/apps') || path.includes('/access/policies')) return TOKEN_PERMISSIONS[2];
  if (path.includes('/access/organizations')) return TOKEN_PERMISSIONS[3];
  if (path.startsWith('/zones')) return TOKEN_PERMISSIONS[4];
  return null;
}

const AUTH_CODES = new Set([9106, 9109, 10000, 10001]);

/** Did Cloudflare refuse the token itself, rather than the request? */
export function isAuthRefusal({ status, body }) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return status === 401 || status === 403 || errors.some((e) => AUTH_CODES.has(e?.code));
}

/**
 * A failed API call, in words the person running the script can act on.
 *
 * Cloudflare's own codes and messages are always included: they are what a
 * search or a support ticket needs. A refusal of the token adds which
 * permission and which account the call needed.
 *
 * @param {{ method: string, path: string, status: number, body: unknown, text?: string }} failure
 * @param {{ id: string, name: string | null } | null} [zoneOwner] the zone's account, once known, to name it
 */
export function describeApiError({ method, path, status, body, text = '' }, zoneOwner = null) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const detail = errors.length
    ? errors
        .slice(0, 5)
        .map((e) => `${e?.code ?? '?'}: ${e?.message ?? 'no message'}`)
        .join('; ')
    : body
      ? 'no error detail in the response'
      : `the response was not JSON: ${String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty)'}`;
  const lines = [`Cloudflare refused ${method} ${path} (HTTP ${status}): ${detail}`];

  if (isAuthRefusal({ status, body })) {
    const permission = permissionFor(path);
    const account = /^\/accounts\/([0-9a-f]{32})/.exec(path)?.[1];
    lines.push(`The token was not allowed to do this.${permission ? ` It needs "${permission}".` : ''}`);
    if (account && account !== ACCOUNT) {
      lines.push(
        `This call is in account ${zoneOwner?.id === account ? accountLabel(zoneOwner) : account}, which owns ${ZONE} but is not the "Ch 227" account (${ACCOUNT}). ` +
          'The token must include BOTH accounts: edit it, add the second account under Account Resources, and run this again.',
      );
    } else if (account) {
      lines.push(`The token must include the "Ch 227" account (${ACCOUNT}).`);
    }
  }
  lines.push('Everything this run reported as done above stays done; run the command again after fixing this.');
  return lines.join('\n');
}

/** What the person does next. Nothing in this script deploys. */
export function nextSteps() {
  return [
    'NEXT STEP. Nothing has been deployed, and nothing on the live site has changed yet.',
    'These settings take effect on the NEXT production deploy of the site. That deploy must be made',
    "from a copy of the code that has BOTH the chapter volunteer's latest changes AND this analytics",
    'branch merged together: deploying either one on its own undoes the other.',
    'From that merged copy, deploy with the same API token this setup used:',
    `  CLOUDFLARE_API_TOKEN="$(cat ${TOKEN_FILE})" CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} npm run deploy`,
    '(it publishes to the main branch, which is production). The token and the account id send the',
    'deploy to the chapter\'s "Ch 227" account, whatever Cloudflare login this computer has and whatever',
    'account wrangler remembers. If you gave the token as CF_API_TOKEN, use CLOUDFLARE_API_TOKEN="$CF_API_TOKEN".',
    'On Windows, set both variables first. In PowerShell:',
    `  $env:CLOUDFLARE_API_TOKEN=(Get-Content ${TOKEN_FILE} -Raw).Trim(); $env:CLOUDFLARE_ACCOUNT_ID='${ACCOUNT}'; npm run deploy`,
    'In the Command Prompt, as three commands:',
    `  set /p CLOUDFLARE_API_TOKEN=<${TOKEN_FILE}`,
    `  set CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`,
    '  npm run deploy',
    'The folder you deploy from must contain no wrangler.toml, wrangler.json or wrangler.jsonc.',
    `Then open https://${ZONE}${STATS_PATH} and sign in with one of the allowed email addresses.`,
    'Signing in shows only that the lock works. To check that visits are being recorded: in a normal',
    `browser window without Global Privacy Control, open https://${ZONE}/ and one other page, then`,
    `reload https://${ZONE}${STATS_PATH}. Your visit and your city should be at the top of Recent visitors.`,
  ].join('\n');
}
