/**
 * Parsers for two files Cloudflare Pages reads from the deployed directory:
 * _redirects, and the Content-Security-Policy line in _headers.
 *
 * One copy, shared by the vitest tiers and the Playwright runtime spec, so it
 * imports no test runner and reports a malformed file by throwing.
 */

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
}

const contentLines = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));

/** Every rule in a _redirects file. A rule with no status is a 302, as Pages treats it. */
export function redirectRules(text: string): RedirectRule[] {
  return contentLines(text).map((line) => {
    const [from, to, status] = line.trim().split(/\s+/);
    if (!from || !to) throw new Error(`_redirects: a rule needs a source and a target: "${line.trim()}"`);
    return { from, to, status: status ? Number(status) : 302 };
  });
}

/**
 * The Content-Security-Policy a _headers file sets, which must be exactly one,
 * on the /* block. A second policy on a narrower path would not replace this
 * one: the browser enforces both, so a page under it would be held to rules
 * no test here reads.
 */
export function headersPolicy(text: string): string {
  let block = '';
  const found: Array<{ block: string; policy: string }> = [];
  for (const line of contentLines(text)) {
    if (!/^\s/.test(line)) block = line.trim();
    else if (/^\s+Content-Security-Policy:/i.test(line)) {
      found.push({ block, policy: line.slice(line.indexOf(':') + 1).trim() });
    }
  }
  if (found.length !== 1 || found[0].block !== '/*') {
    throw new Error(`_headers must set one Content-Security-Policy, on /*; found ${JSON.stringify(found.map((f) => f.block))}`);
  }
  return found[0].policy;
}

/** A policy as directive -> sources, in the order written. */
export function cspDirectives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name, sources];
      }),
  );
}
