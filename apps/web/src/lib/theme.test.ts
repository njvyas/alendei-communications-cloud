import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  THEME_PRE_PAINT_SCRIPT,
  parseResolvedTheme,
  parseThemePreference,
  readCookie,
  resolveTheme,
  serverResolvedTheme,
  themeCookie,
} from './theme';

/** Runs the real pre-paint script against a simulated document. */
function runPrePaint(cookie: string, osDark: boolean, protocol = 'http:') {
  const classes = new Set<string>();
  const written: string[] = [];
  const document = {
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      written.push(value);
    },
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) =>
          force ? classes.add(name) : classes.delete(name),
      },
    },
  };
  const window = {
    matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && osDark }),
  };
  vm.runInNewContext(THEME_PRE_PAINT_SCRIPT, { document, window, location: { protocol } });
  return { dark: classes.has('dark'), written };
}

describe('U15.1 theme preference model', () => {
  it('preference: only exact light/dark are explicit; anything else is system', () => {
    assert.equal(parseThemePreference('light'), 'light');
    assert.equal(parseThemePreference('dark'), 'dark');
    for (const v of ['system', undefined, '', 'DARK', 'blue', null, 1])
      assert.equal(parseThemePreference(v), 'system');
    assert.equal(parseResolvedTheme('dark'), 'dark');
    assert.equal(parseResolvedTheme('system'), null);
  });

  it('resolution: system follows the OS, explicit choices ignore it', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
  });

  it('server rendering: explicit preference wins; system uses the cached resolved theme, else light', () => {
    assert.equal(serverResolvedTheme('dark', 'light'), 'dark');
    assert.equal(serverResolvedTheme('light', 'dark'), 'light');
    assert.equal(serverResolvedTheme('system', 'dark'), 'dark');
    assert.equal(serverResolvedTheme(undefined, 'dark'), 'dark');
    assert.equal(serverResolvedTheme(undefined, undefined), 'light');
    assert.equal(serverResolvedTheme('bogus', 'bogus'), 'light');
  });

  it('cookies: one year, path /, SameSite=Lax, Secure on https; reading tolerates spacing', () => {
    assert.equal(
      themeCookie('acc_theme_preference', 'dark'),
      'acc_theme_preference=dark; Path=/; Max-Age=31536000; SameSite=Lax',
    );
    assert.match(themeCookie('x', 'y', true), /; Secure$/);
    assert.equal(
      readCookie('a=1; acc_theme_preference=light; b=2', 'acc_theme_preference'),
      'light',
    );
    assert.equal(readCookie('acc_theme_preference=dark', 'acc_theme_preference'), 'dark');
    assert.equal(readCookie('xacc_theme_preference=dark', 'acc_theme_preference'), undefined);
  });

  it('pre-paint script: every preference × OS combination resolves like resolveTheme and caches the result', () => {
    const cases: Array<[string, boolean, boolean]> = [
      ['', true, true], // cold visit, OS dark
      ['', false, false], // cold visit, OS light
      ['acc_theme_preference=system', true, true],
      ['acc_theme_preference=light', true, false],
      ['acc_theme_preference=dark', false, true],
      ['acc_theme_preference=garbage', true, true],
      ['other=1; acc_theme_preference=dark; more=2', false, true],
    ];
    for (const [cookie, osDark, expectDark] of cases) {
      const { dark, written } = runPrePaint(cookie, osDark);
      assert.equal(dark, expectDark, `cookie="${cookie}" osDark=${osDark}`);
      assert.deepEqual(written, [
        `acc_resolved_theme=${expectDark ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Lax`,
      ]);
    }
    assert.match(runPrePaint('', true, 'https:').written[0] ?? '', /; Secure$/);
  });

  it('pre-paint script: a failure leaves the page as server-rendered (no throw)', () => {
    assert.doesNotThrow(() =>
      vm.runInNewContext(THEME_PRE_PAINT_SCRIPT, { document: {}, window: {}, location: {} }),
    );
  });
});
