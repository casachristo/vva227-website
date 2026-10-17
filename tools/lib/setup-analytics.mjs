/**
 * The setup sequence behind `npm run setup:analytics`: the I/O half.
 *
 * Every decision is made in ./setup-analytics-plan.mjs; this file asks
 * Cloudflare, hands the answers to those functions, sends what they return,
 * and prints what happened. Its inputs (arguments, environment, fetch, the
 * printer, the salt generator and where files live) are parameters, so
 * tests/feature/setup-analytics.test.ts runs the whole sequence against a
 * scripted Cloudflare and checks every request it made.
 *
 * IT NEVER DEPLOYS. Bindings and secrets reach the site on its next
 * production deploy, and that deploy has to come from a tree carrying both the
 * chapter volunteer's latest work and this branch, which only a person can
 * put together. The script ends by saying so.
 *
 * Idempotent: everything is looked up before it is created, so a second run,
 * or a run after a stop, only does what is still missing.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plan from './setup-analytics-plan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A Cloudflare API call that did not succeed. Its words come from plan.describeApiError. */
class ApiError extends Error {
  constructor(failure) {
    super(`${failure.method} ${failure.path} -> HTTP ${failure.status}`);
    this.name = 'ApiError';
    this.failure = failure;
  }
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.print]
 * @param {string} [options.tokenFile]
 * @param {string} [options.migrationsDir]
 * @param {() => string} [options.randomHex] 32 random bytes as hex, for the salt
 * @returns {Promise<number>} the exit code: 0 done, 1 stopped, 2 bad arguments
 */
export async function runSetup({
  argv = [],
  env = {},
  fetchImpl = (...args) => fetch(...args),
  print = (line) => console.log(line),
  tokenFile = join(REPO_ROOT, plan.TOKEN_FILE),
  migrationsDir = join(REPO_ROOT, 'migrations'),
  randomHex = () => randomBytes(32).toString('hex'),
} = {}) {
  const args = plan.parseArgs(argv);
  if ('error' in args) {
    print(`${args.error}\n\n${plan.USAGE}`);
    return 2;
  }
  if (args.help) {
    print(plan.USAGE);
    return 0;
  }

  // The file is read only when CF_API_TOKEN is not set, and only once no
  // other account on this computer can read it.
  let fileText;
  if (!plan.resolveToken(env.CF_API_TOKEN) && existsSync(tokenFile)) {
    if (process.platform !== 'win32' && plan.tokenFileOpenToOthers(statSync(tokenFile).mode)) {
      print(plan.tokenFileOpenMessage());
      return 1;
    }
    fileText = readFileSync(tokenFile, 'utf8');
  }
  const token = plan.resolveToken(env.CF_API_TOKEN, fileText);
  if (!token) {
    print(plan.noTokenMessage());
    return 1;
  }
  // Every line goes through here, so the token cannot reach the terminal even
  // if an error message were ever to carry it.
  const say = (text = '') => print(plan.redact(text, token));
  const { emails, dryRun } = args;

  async function api(method, path, body) {
    // Belt and braces: the sequence below never writes in a dry run, and this
    // makes a mistake there a crash rather than a change.
    if (dryRun && method !== 'GET') throw new Error(`a dry run tried to ${method} ${path}`);
    const res = await fetchImpl(`${plan.API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Reported below with the text itself.
    }
    if (!res.ok || !json || json.success !== true) throw new ApiError({ method, path, status: res.status, body: json, text });
    return json;
  }

  /** Every item of a paged list. */
  async function listAll(path) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const res = await api('GET', `${path}?page=${page}&per_page=50`);
      const items = Array.isArray(res.result) ? res.result : [];
      out.push(...items);
      const pages = res.result_info?.total_pages;
      if (!items.length || (Number.isInteger(pages) ? page >= pages : items.length < 50)) break;
    }
    return out;
  }

  const projectPath = `/accounts/${plan.ACCOUNT}/pages/projects/${plan.PROJECT}`;
  const done = [];
  const wouldDo = [];
  const act = (what) => (dryRun ? wouldDo : done).push(what);

  async function verify(databaseId, access) {
    const after = (await api('GET', projectPath)).result;
    const problems = plan.verifyProduction(after?.deployment_configs?.production, { databaseId, access });
    if (problems.length) {
      throw new plan.StopError(
        `Cloudflare accepted the change, but reading the project back shows: ${problems.join('; ')}.\nCheck Workers & Pages -> ${plan.PROJECT} -> Settings in the dashboard, then run this again.`,
      );
    }
  }

  // The account that owns the zone, once step (d) has asked; it names that
  // account in an error.
  let accessAccount = null;

  try {
    if (dryRun) say('DRY RUN: looking only. Nothing will be changed.\n');

    // (a) The project, and the guard against the wrong account.
    say(`1. The Pages project "${plan.PROJECT}" in the "Ch 227" account`);
    let project;
    try {
      project = (await api('GET', projectPath)).result;
    } catch (err) {
      if (err instanceof ApiError && plan.isProjectMissing(err.failure) && !plan.isAuthRefusal(err.failure)) {
        throw new plan.StopError(plan.projectNotFoundMessage());
      }
      throw err;
    }
    const checked = plan.checkProject(project);
    say(`   serves ${plan.ZONE}: yes`);
    say(`   production branch: ${checked.productionBranch || '(not set)'}`);
    say(`   production compatibility date: ${checked.compatibilityDate ?? '(not set)'}`);
    say('   (the local runtime tests guess a date in tests/helpers/pages-runtime.ts; make RUNTIME_COMPATIBILITY_DATE match this)');
    for (const warning of checked.warnings) say(`\n${warning}\n`);

    // (b) The database and its schema.
    say(`\n2. The D1 database "${plan.DATABASE}"`);
    const listed = await api('GET', `/accounts/${plan.ACCOUNT}/d1/database?name=${encodeURIComponent(plan.DATABASE)}&per_page=100`);
    const existingDb = plan.findByName(listed.result, plan.DATABASE, 'D1 database');
    let databaseId = existingDb?.uuid ?? null;
    if (existingDb) say(`   exists (${databaseId})`);
    else if (dryRun) act(`create the D1 database ${plan.DATABASE}`);
    else {
      const created = (await api('POST', `/accounts/${plan.ACCOUNT}/d1/database`, { name: plan.DATABASE })).result;
      databaseId = typeof created?.uuid === 'string' && created.uuid ? created.uuid : null;
      if (!databaseId) throw new plan.StopError('Cloudflare created the database but did not say its id. Run this again; it will find it by name.');
      act(`created the D1 database ${plan.DATABASE} (${databaseId})`);
    }

    const ordered = plan.migrationOrder(readdirSync(migrationsDir));
    if (dryRun) {
      // Reading the bookkeeping table is a query, which is a POST; a dry run
      // makes none.
      act(`apply whichever of ${ordered.join(', ')} the database has not recorded (a dry run cannot query it)`);
    } else {
      const query = (sql) => api('POST', `/accounts/${plan.ACCOUNT}/d1/database/${databaseId}/query`, { sql });
      const tracked = plan.queryRows((await query(plan.MIGRATIONS_TABLE_EXISTS_SQL)).result).length > 0;
      const applied = tracked ? plan.queryRows((await query(plan.APPLIED_MIGRATIONS_SQL)).result).map((row) => row.name) : [];
      const pending = plan.pendingMigrations(ordered, applied);
      if (pending.length && !tracked) await query(plan.CREATE_MIGRATIONS_TABLE_SQL);
      for (const name of pending) {
        await query(plan.migrationRequestSql(name, readFileSync(join(migrationsDir, name), 'utf8')));
        act(`applied migration ${name}`);
      }
      if (!pending.length) say(`   migrations already applied: ${applied.join(', ')}`);
    }

    // (c) Production bindings: the database and the salt.
    say(`\n3. Production settings for the visit collector`);
    const bindings = plan.planBindings(checked.production, { databaseId: databaseId ?? '(the new database)', newSalt: randomHex });
    for (const note of bindings.notes) say(`   ${note}`);
    if (bindings.body) {
      if (dryRun) bindings.changes.forEach(act);
      else {
        await api('PATCH', projectPath, bindings.body);
        await verify(databaseId, false);
        bindings.changes.forEach(act);
      }
    }

    // (d) Access: which account, its team, the policy, the application.
    say(`\n4. Cloudflare Access for ${plan.ZONE}${plan.STATS_PATH}`);
    accessAccount = plan.zoneAccount((await api('GET', `/zones?name=${encodeURIComponent(plan.ZONE)}`)).result);
    if (!accessAccount) throw new plan.StopError(plan.zoneNotVisibleMessage());
    const elsewhere = accessAccount.id !== plan.ACCOUNT;
    say(
      elsewhere
        ? `   ${plan.ZONE} is in a different Cloudflare account, ${plan.accountLabel(accessAccount)}; Access is set up there`
        : `   ${plan.ZONE} is in the "Ch 227" account`,
    );
    // Said in every change made there, so the summary names the account too.
    const there = elsewhere ? ` in the account ${plan.accountLabel(accessAccount)}` : '';

    let organization;
    try {
      organization = (await api('GET', `/accounts/${accessAccount.id}/access/organizations`)).result;
    } catch (err) {
      if (err instanceof ApiError && !plan.isAuthRefusal(err.failure)) {
        throw new plan.StopError(`${plan.zeroTrustInstructions(accessAccount)}\n(Cloudflare said: ${plan.describeApiError(err.failure).split('\n')[0]})`);
      }
      throw err;
    }
    const teamDomain = plan.teamDomainFrom(organization);
    if (!teamDomain) throw new plan.StopError(plan.zeroTrustInstructions(accessAccount));
    say(`   Zero Trust team: ${teamDomain}`);

    const policiesPath = `/accounts/${accessAccount.id}/access/policies`;
    const listedPolicies = await listAll(policiesPath);
    const found = plan.findByName(listedPolicies, plan.POLICY, 'Access policy');
    // The list may abbreviate a policy; its own GET has the rules.
    const existingPolicy = found ? (await api('GET', `${policiesPath}/${found.id}`)).result : null;
    let policyId = existingPolicy?.id ?? null;
    if (!existingPolicy) {
      if (dryRun) act(`create the Access policy "${plan.POLICY}"${there} admitting ${emails.join(', ')}`);
      else {
        policyId = (await api('POST', policiesPath, plan.policyBody(emails))).result?.id ?? null;
        if (!policyId) throw new plan.StopError('Cloudflare created the policy but did not say its id. Run this again; it will find it by name.');
        act(`created the Access policy "${plan.POLICY}"${there} admitting ${emails.join(', ')}`);
      }
    } else if (!plan.policyMatches(existingPolicy, emails)) {
      if (dryRun) act(`change the Access policy "${plan.POLICY}"${there} to admit exactly ${emails.join(', ')}`);
      else {
        await api('PUT', `${policiesPath}/${policyId}`, plan.policyBody(emails, existingPolicy));
        act(`changed the Access policy "${plan.POLICY}"${there} to admit exactly ${emails.join(', ')}`);
      }
    } else say(`   policy "${plan.POLICY}" already admits exactly ${emails.join(', ')}`);

    const { destinations, skipped } = plan.destinationsFor({ accessAccount, subdomain: checked.subdomain });
    if (skipped) say(`   ${skipped}`);
    const appsPath = `/accounts/${accessAccount.id}/access/apps`;
    const foundApp = plan.findByName(
      (await api('GET', `${appsPath}?name=${encodeURIComponent(plan.APP)}&exact=true`)).result,
      plan.APP,
      'Access application',
    );
    const existingApp = foundApp ? (await api('GET', `${appsPath}/${foundApp.id}`)).result : null;
    // Any other policy on it comes off: this script's alone decides who opens /stats.
    const removed = existingApp ? plan.otherPolicies(existingApp, policyId, listedPolicies) : [];
    const covers = destinations.map((d) => d.uri).join(', ');
    let aud = existingApp?.aud ?? null;
    if (!existingApp) {
      if (dryRun) act(`create the Access application "${plan.APP}"${there} covering ${covers}`);
      else {
        aud = (await api('POST', appsPath, plan.appBody({ policyId, destinations }))).result?.aud ?? null;
        act(`created the Access application "${plan.APP}"${there} covering ${covers}`);
      }
    } else if (!plan.appMatches(existingApp, { policyId, destinations })) {
      if (dryRun) {
        for (const p of removed) say(`   would remove the policy ${plan.policyLabel(p)} from the application, so that "${plan.POLICY}" alone decides who can open ${plan.STATS_PATH}`);
        act(`update the Access application "${plan.APP}"${there} to cover ${covers}, with "${plan.POLICY}" as its only policy`);
        for (const p of removed) act(`remove the policy ${plan.policyLabel(p)} from the Access application "${plan.APP}"`);
      } else {
        aud = (await api('PUT', `${appsPath}/${existingApp.id}`, plan.appBody({ policyId, destinations, existing: existingApp }))).result?.aud ?? aud;
        act(`updated the Access application "${plan.APP}"${there} to cover ${covers}`);
        for (const p of removed) act(`removed the policy ${plan.policyLabel(p)} from the Access application "${plan.APP}"`);
      }
    } else say(`   application "${plan.APP}" already covers ${covers}, with "${plan.POLICY}" as its only policy`);

    // Access checks a changed policy only at each person's next sign-in. So
    // when this run takes access away from anyone (an address left out, a
    // wider rule put back, another policy taken off), the sign-ins already
    // open are ended as well, after those changes. Adding someone ends none.
    let endedSignIns = false;
    if (existingApp && (plan.policyNarrows(existingPolicy, emails) || removed.length)) {
      if (dryRun) {
        say(`   would end existing sign-ins to ${plan.STATS_PATH}, because this run takes access away from someone`);
        act(`end every existing sign-in to ${plan.STATS_PATH} (the people still on the list sign in again)`);
      } else {
        await api('POST', `${appsPath}/${existingApp.id}/revoke_tokens`);
        endedSignIns = true;
        act(`ended every existing sign-in to ${plan.STATS_PATH}, because this run took access away from someone; the people still on the list sign in again`);
      }
    }

    // (e) The two settings the Function checks tokens against. Always
    // written, so a rerun repairs a pasted or stale value.
    say(`\n5. Production settings for the /stats lock`);
    if (dryRun) act(`set ${plan.TEAM_VAR} to ${teamDomain} and ${plan.AUD_VAR} to the application's AUD tag`);
    else {
      if (typeof aud !== 'string' || !aud) throw new plan.StopError(`Cloudflare did not return the AUD tag of "${plan.APP}". Run this again.`);
      await api('PATCH', projectPath, plan.accessSettingsBody(teamDomain, aud));
      await verify(databaseId, true);
      act(`set ${plan.TEAM_VAR} (${teamDomain}) and ${plan.AUD_VAR} (${aud}), encrypted`);
    }

    // (f) What happened, and the step that is not this script's to take.
    say('');
    if (dryRun) {
      say('DRY RUN. Nothing was changed. A real run would:');
      for (const line of wouldDo) say(`  - ${line}`);
      say('\nRun the same command without --dry-run to do it.');
    } else {
      say('Done. What changed in this run:');
      for (const line of done) say(`  - ${line}`);
      say('');
      for (const line of plan.whoCanOpen(emails, existingPolicy, { endedWherePagesDevUncovered: endedSignIns && skipped !== null })) say(line);
      say(`\n${plan.nextSteps()}`);
    }
    return 0;
  } catch (err) {
    say('');
    if (err instanceof plan.StopError) say(err.message);
    else if (err instanceof ApiError) say(plan.describeApiError(err.failure, accessAccount));
    else say(`Stopped: ${err instanceof Error ? err.message : String(err)}\n(If this says "fetch failed", Cloudflare could not be reached; check the connection and run this again.)`);
    if (done.length) {
      say('\nAlready done in this run, and kept:');
      for (const line of done) say(`  - ${line}`);
    }
    return 1;
  }
}
