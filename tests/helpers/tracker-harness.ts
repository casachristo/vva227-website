import { runInNewContext } from 'node:vm';

/**
 * Runs the tracker's emitted text — `'use strict'; (function tracker…)(cfg);`,
 * exactly what /b.js serves — inside a fresh V8 context whose only globals are
 * the browser stubs built here, and records everything it does.
 *
 * WHY A FRESH CONTEXT. src/lib/tracker.ts may reference nothing outside its
 * own body except `cfg` and browser globals (see its header). Running the text
 * with new Function() in this process would hand it Node's globals: Node has
 * its own fetch, crypto, navigator and setInterval, so a tracker that leaned
 * on any of them by accident, or on `process`, would pass here and fail in a
 * browser. A vm context has the language built-ins (JSON, Math, Uint8Array)
 * and nothing else, so a reference to anything not stubbed below throws a
 * ReferenceError, which is the failure the tests need to see.
 *
 * Stubs are minimal on purpose. A browser API the tracker starts using
 * without a stub here throws, which is the point: a silent dependency on an
 * API is what works on one machine and not on a visitor's.
 */

export interface SentRequest {
  transport: 'beacon' | 'fetch';
  url: string;
  /** The exact JSON text that would go over the wire. */
  raw: string;
  body: Record<string, unknown>;
  /** The Blob's type, for sendBeacon. */
  blobType?: string;
  /** fetch()'s init, minus its body. */
  init?: Record<string, unknown>;
}

export interface TrackerRunOptions {
  pathname?: string;
  search?: string;
  hash?: string;
  referrer?: string;
  visibility?: 'visible' | 'hidden';
  innerWidth?: number;
  innerHeight?: number;
  /** Extra navigator properties, e.g. globalPrivacyControl or doNotTrack. */
  navigator?: Record<string, unknown>;
  /** Extra window properties, e.g. the old window.doNotTrack. */
  window?: Record<string, unknown>;
  /** Replace sendBeacon. null removes it, as on an engine without one. */
  sendBeacon?: ((url: string, data: unknown) => boolean) | null;
  /** Replace fetch. It still receives the recorded call first. */
  fetch?: (url: string, init: Record<string, unknown>) => unknown;
  /** null leaves crypto out of the context entirely. */
  crypto?: { getRandomValues(a: Uint8Array): Uint8Array } | null;
  /** Starting value of Date.now(). */
  now?: number;
}

export interface Listener {
  target: 'document' | 'window';
  type: string;
  fn: (event?: unknown) => void;
}

export interface TrackerRun {
  sent: SentRequest[];
  listeners: Listener[];
  intervals: Array<{ fn: () => void; ms: number }>;
  /** Every storage or cookie API the tracker touched. Must stay empty. */
  storageTouched: string[];
  /** How many times crypto.getRandomValues was called. */
  randomCalls: number;
  /** Move the clock to an absolute time. */
  at(ms: number): void;
  setVisibility(v: 'visible' | 'hidden'): void;
  /** Replace location.pathname, or make reading it throw. */
  setPathname(p: string | (() => string)): void;
  /** Dispatch an event to every listener the tracker registered for it. */
  fire(target: 'document' | 'window', type: string): void;
  /** Run every interval callback once, as the heartbeat would. */
  tick(): void;
  /** Bodies of every request, parsed. */
  bodies(): Array<Record<string, unknown>>;
}

/** Thrown error from inside the context, normalised: its constructor is from another realm. */
export function errorName(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { name?: string }).name ?? 'unknown';
  }
}

export function runTracker(source: string, options: TrackerRunOptions = {}): TrackerRun {
  let now = options.now ?? 1_000_000;
  let pathname: string | (() => string) = options.pathname ?? '/about';
  let visibility = options.visibility ?? 'visible';
  const sent: SentRequest[] = [];
  const listeners: Listener[] = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const storageTouched: string[] = [];
  let randomCalls = 0;

  const trap = (obj: object, names: string[]) => {
    for (const name of names) {
      Object.defineProperty(obj, name, {
        get() {
          storageTouched.push(name);
          return undefined;
        },
        set() {
          storageTouched.push(name);
        },
      });
    }
  };

  const documentStub = {
    get visibilityState() {
      return visibility;
    },
    referrer: options.referrer ?? '',
    addEventListener(type: string, fn: Listener['fn']) {
      listeners.push({ target: 'document', type, fn });
    },
  };
  trap(documentStub, ['cookie']);

  // Extras are copied by descriptor, not spread, so a getter that throws
  // stays a getter that throws.
  const extend = (target: object, extra: object | undefined) =>
    extra ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(extra)) : target;

  const windowStub: Record<string, unknown> = {
    // `in`, not ??, so a test can pass undefined on purpose.
    innerWidth: 'innerWidth' in options ? options.innerWidth : 1280,
    innerHeight: 'innerHeight' in options ? options.innerHeight : 800,
    addEventListener(type: string, fn: Listener['fn']) {
      listeners.push({ target: 'window', type, fn });
    },
  };
  extend(windowStub, options.window);
  trap(windowStub, ['localStorage', 'sessionStorage', 'indexedDB']);

  const defaultBeacon = (url: string, data: unknown) => {
    const blob = data as { parts: string[]; type: string };
    const raw = blob.parts.join('');
    sent.push({ transport: 'beacon', url, raw, body: JSON.parse(raw), blobType: blob.type });
    return true;
  };

  const navigatorStub: Record<string, unknown> =
    options.sendBeacon === null ? {} : { sendBeacon: options.sendBeacon ?? defaultBeacon };
  extend(navigatorStub, options.navigator);

  const fetchStub = (url: string, init: Record<string, unknown>) => {
    const { body, ...rest } = init;
    sent.push({ transport: 'fetch', url, raw: String(body), body: JSON.parse(String(body)), init: rest });
    if (options.fetch) return options.fetch(url, init);
    return Promise.resolve({ status: 204 });
  };

  // A Blob stand-in that keeps its parts readable. A real Blob is opaque, and
  // what matters is the JSON the collector will receive.
  class BlobStub {
    parts: string[];
    type: string;
    constructor(parts: string[], opts?: { type?: string }) {
      this.parts = parts;
      this.type = opts?.type ?? '';
    }
  }

  const cryptoStub =
    options.crypto === null
      ? undefined
      : (options.crypto ?? {
          getRandomValues(arr: Uint8Array) {
            randomCalls++;
            for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff;
            return arr;
          },
        });

  const context: Record<string, unknown> = {
    document: documentStub,
    window: windowStub,
    navigator: navigatorStub,
    location: {
      get pathname() {
        return typeof pathname === 'function' ? pathname() : pathname;
      },
      search: options.search ?? '',
      hash: options.hash ?? '',
      get href() {
        return `https://vva227.org${this.pathname}${this.search}${this.hash}`;
      },
    },
    fetch: fetchStub,
    Blob: BlobStub,
    setInterval(fn: () => void, ms: number) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    // Shadows the context's own Date, so the tests own the clock.
    Date: { now: () => now },
  };
  if (cryptoStub) context.crypto = cryptoStub;

  runInNewContext(source, context, { filename: 'b.js' });

  return {
    sent,
    listeners,
    intervals,
    storageTouched,
    get randomCalls() {
      return randomCalls;
    },
    at(ms) {
      now = ms;
    },
    setVisibility(v) {
      visibility = v;
    },
    setPathname(p) {
      pathname = p;
    },
    fire(target, type) {
      const matching = listeners.filter((l) => l.target === target && l.type === type);
      if (!matching.length) throw new Error(`the tracker registered no ${target} listener for ${type}`);
      for (const l of matching) l.fn({ type });
    },
    tick() {
      for (const i of intervals) i.fn();
    },
    bodies: () => sent.map((s) => s.body),
  };
}

/** The `{...}` config JSON at the end of an emitted script, parsed. */
export function emittedConfig(source: string): Record<string, unknown> {
  const match = source.match(/\}\)\((\{[^()]*\})\);\s*$/);
  if (!match) throw new Error('no trailing (cfg) call found in the emitted script');
  return JSON.parse(match[1]);
}
