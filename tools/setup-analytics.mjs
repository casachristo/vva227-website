#!/usr/bin/env node
/**
 * `npm run setup:analytics -- --email you@example.com`
 *
 * The one-time Cloudflare setup for visit analytics, as one command the
 * site's owner runs once (and may safely run again). In the chapter's
 * "Ch 227" account it:
 *
 *   1. checks the Pages project vva227-refresh is the one serving vva227.org;
 *   2. creates the D1 database vva227-beacon if it is missing, and applies
 *      migrations/ to it, recorded the way wrangler records them;
 *   3. binds it to production as BEACON, and creates the BEACON_SALT secret
 *      if there is none (an existing one is never replaced);
 *   4. sets up Cloudflare Access for vva227.org/stats in the account that owns
 *      the vva227.org zone: a reusable policy admitting exactly the --email
 *      addresses, and the application, with that policy as its only one;
 *      when a rerun takes anyone's access away, it ends the sign-ins already
 *      open;
 *   5. writes ACCESS_TEAM_DOMAIN and ACCESS_AUD to production, so the Function
 *      checks tokens against that application.
 *
 * It never deploys, and changes only production settings, never preview ones.
 * Nothing it sets reaches the live site until the next production deploy.
 *
 * The API token comes from CF_API_TOKEN or from .cf-api-token at the repo
 * root (gitignored, and refused unless only its owner can read it).
 * docs/analytics.md lists the permissions it needs.
 *
 * --dry-run looks without changing anything.
 */
import { runSetup } from './lib/setup-analytics.mjs';

process.exitCode = await runSetup({ argv: process.argv.slice(2), env: process.env });
