import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../../tools/lib/setup-analytics.mjs';
import type { FakeCloudflare, RecordedRequest } from './fake-cloudflare';

/**
 * Runs the setup sequence (tools/lib/setup-analytics.mjs) against a scripted
 * Cloudflare, capturing what it printed and the requests this run made.
 * Shared by the feature and security tiers.
 */

export interface SetupRunOptions {
  /** Defaults to CF_API_TOKEN set to the fake's token. */
  env?: Record<string, string | undefined>;
  /** Defaults to a path that does not exist, so no real token file is ever read. */
  tokenFile?: string;
  /** The salt generator; defaults to the script's own (real randomness). */
  randomHex?: () => string;
}

export interface SetupRun {
  code: number;
  output: string;
  /** Requests made by this run only. */
  requests: RecordedRequest[];
  /** Of those, the ones that change something. */
  writes: RecordedRequest[];
}

export const NO_TOKEN_FILE = join(tmpdir(), 'vva227-no-such-token-file');

export async function runSetupAgainst(fake: FakeCloudflare, argv: string[], options: SetupRunOptions = {}): Promise<SetupRun> {
  const lines: string[] = [];
  const from = fake.requests.length;
  const code = await runSetup({
    argv,
    env: options.env ?? { CF_API_TOKEN: fake.token },
    fetchImpl: fake.fetch as unknown as typeof fetch,
    print: (line: string) => lines.push(line),
    tokenFile: options.tokenFile ?? NO_TOKEN_FILE,
    ...(options.randomHex ? { randomHex: options.randomHex } : {}),
  });
  const requests = fake.requests.slice(from);
  const writes = fake.writes();
  return { code, output: lines.join('\n'), requests, writes: requests.filter((r) => writes.includes(r)) };
}
