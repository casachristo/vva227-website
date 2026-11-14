import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * CONTRACT — the visit log's code against the types of the platform it calls.
 *
 * Nothing in this repo type-checks it: Astro strips the types from src/ and
 * Pages strips them from functions/, and every other test runs the code on
 * the inputs it was written for. So a value handed to an API that does not
 * accept it passes every test. One did: the Access token's signature, decoded
 * as a Uint8Array whose buffer could be a SharedArrayBuffer, went to
 * crypto.subtle.verify, which takes only a plain ArrayBuffer view.
 *
 * Checked strictly, with the ES2022 and DOM types the Functions and the
 * tracker run against. Each file's imports are checked with it.
 *
 * TIER JUSTIFICATION: a test that runs the code sees only the paths it
 * drives, and only what the runtime happens to tolerate. The type checker
 * reads every call against every signature, on every path.
 */

const ROOT = process.cwd();

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  resolveJsonModule: true,
  skipLibCheck: true,
  types: [],
};

/** Every .ts file under a directory. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? tsFiles(full) : entry.endsWith('.ts') ? [full] : [];
  });
}

/** The Functions, and the visit log's own modules in src/. */
const ANALYTICS_FILES = [
  ...tsFiles(join(ROOT, 'functions')),
  ...['access', 'beacon', 'eastern', 'runtime', 'stats', 'stats-gate', 'tracker'].map((name) => join(ROOT, 'src', 'lib', `${name}.ts`)),
  join(ROOT, 'src', 'data', 'analytics.ts'),
  join(ROOT, 'src', 'pages', 'b.js.ts'),
];

/** Every type error in these files and what they import, as `file(line): message`. */
function typeErrors(files: string[]): string[] {
  const program = ts.createProgram(files, OPTIONS);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${relative(ROOT, d.file.fileName)}(${d.file.getLineAndCharacterOfPosition(d.start).line + 1})` : '(no file)';
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('the visit log code', () => {
  it('names the files it checks, and they exist', () => {
    expect(ANALYTICS_FILES.map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining(['functions/api/e.ts', 'functions/stats.ts', 'src/lib/access.ts']));
    expect(ANALYTICS_FILES.filter((f) => !statSync(f, { throwIfNoEntry: false })?.isFile())).toEqual([]);
  });

  it('type-checks strictly, with no error', () => {
    expect(typeErrors(ANALYTICS_FILES)).toEqual([]);
  });

  it('can actually fail: a byte array crypto.subtle.verify does not take is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vva227-types-'));
    dirs.push(dir);
    const file = join(dir, 'verify.ts');
    writeFileSync(
      file,
      [
        'function loose(): Uint8Array { return new Uint8Array(4); }',
        'export const ok = (key: CryptoKey) => crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, loose(), new Uint8Array(4));',
        '',
      ].join('\n'),
    );
    const errors = typeErrors([file]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/verify\.ts\(2\): Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'BufferSource'/);
  });
});
