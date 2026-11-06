import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WCAG 2.2 AA contrast gate for the U15.1 tokens, computed from the actual
 * `globals.css` (not from copied numbers). Every pairing a U15.1 component renders
 * is listed, with its threshold: 4.5:1 for normal text (badges at 12px are normal
 * text), 3:1 for interactive boundaries, focus indicators and meaningful graphics.
 * Muted text is used only for disabled controls (WCAG 1.4.3 exception) and is not
 * listed here.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');

function tokens(selector: ':root' | '.dark'): Record<string, string> {
  const out: Record<string, string> = {};
  const blocks =
    CSS.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([\\s\\S]*?)\\n\\}`, 'g')) ??
    [];
  for (const block of blocks) {
    for (const m of block.matchAll(/--(acc-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g))
      out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;

/** [description, foreground token, background token, threshold] */
const PAIRS: Array<[string, string, string, number]> = [
  ['body text on canvas', 'acc-text-primary', 'acc-bg', TEXT],
  ['body text on card', 'acc-text-primary', 'acc-card', TEXT],
  [
    'body text on raised (table header, neutral badge)',
    'acc-text-primary',
    'acc-surface-raised',
    TEXT,
  ],
  ['secondary text on canvas', 'acc-text-secondary', 'acc-bg', TEXT],
  ['secondary text on card (helper, placeholder, labels)', 'acc-text-secondary', 'acc-card', TEXT],
  ['primary button text', 'acc-on-primary', 'acc-primary', TEXT],
  ['primary button text, hover', 'acc-on-primary', 'acc-primary-hover', TEXT],
  ['secondary button text', 'acc-on-accent', 'acc-accent', TEXT],
  ['secondary button text, hover', 'acc-on-accent', 'acc-accent-hover', TEXT],
  ['destructive button text', 'acc-on-destructive', 'acc-destructive', TEXT],
  ['destructive button text, hover', 'acc-on-destructive', 'acc-destructive-hover', TEXT],
  ['ghost button / link text on card', 'acc-primary', 'acc-card', TEXT],
  ['ghost button text on hover fill', 'acc-primary', 'acc-primary-subtle', TEXT],
  ['active option text', 'acc-text-primary', 'acc-primary-subtle', TEXT],
  ['badge success', 'acc-success-text', 'acc-success-subtle', TEXT],
  ['badge warning', 'acc-warning-text', 'acc-warning-subtle', TEXT],
  ['badge error', 'acc-error-text', 'acc-error-subtle', TEXT],
  ['badge accent', 'acc-text-primary', 'acc-accent-subtle', TEXT],
  ['field error message on card', 'acc-error-text', 'acc-card', TEXT],
  ['input / select / outline boundary on card', 'acc-border-input', 'acc-card', NON_TEXT],
  ['input / select / outline boundary on canvas', 'acc-border-input', 'acc-bg', NON_TEXT],
  ['invalid input boundary on card', 'acc-error', 'acc-card', NON_TEXT],
  ['focus indicator on card', 'acc-primary', 'acc-card', NON_TEXT],
  ['focus indicator on canvas', 'acc-primary', 'acc-bg', NON_TEXT],
  ['active tab indicator on card', 'acc-primary', 'acc-card', NON_TEXT],
];

for (const theme of [':root', '.dark'] as const) {
  describe(`U15.1 WCAG 2.2 AA contrast — ${theme === ':root' ? 'light' : 'dark'} theme`, () => {
    const t = tokens(theme);
    it('declares every token the components use', () => {
      for (const [, fg, bg] of PAIRS) {
        assert.ok(t[fg], `${theme} --${fg} missing`);
        assert.ok(t[bg], `${theme} --${bg} missing`);
      }
    });
    for (const [label, fg, bg, min] of PAIRS) {
      it(`${label}: --${fg} on --${bg} >= ${min}:1`, () => {
        const ratio = contrast(t[fg]!, t[bg]!);
        assert.ok(ratio >= min, `${ratio.toFixed(2)}:1 < ${min}:1 (${t[fg]} on ${t[bg]})`);
      });
    }
  });
}

describe('U15.1 approved palette preserved (specification §1)', () => {
  it('light and dark base tokens equal the approved values', () => {
    const light = tokens(':root');
    const dark = tokens('.dark');
    const approvedLight = {
      'acc-primary': '#5b5ce2',
      'acc-accent': '#20bfd0',
      'acc-bg': '#f7f8fc',
      'acc-card': '#ffffff',
      'acc-text-primary': '#171a2b',
      'acc-text-secondary': '#667085',
      'acc-border': '#e6e8f0',
      'acc-border-strong': '#d1d5e4',
      'acc-success': '#16865b',
      'acc-warning': '#c47a16',
      'acc-error': '#d6455d',
      'acc-success-text': '#13734e',
      'acc-warning-text': '#945705',
      'acc-error-text': '#b8354c',
    };
    const approvedDark = {
      'acc-primary': '#8585ff',
      'acc-accent': '#36cbd8',
      'acc-bg': '#0d1222',
      'acc-sidebar': '#11182a',
      'acc-card': '#171f33',
      'acc-text-primary': '#f3f5fc',
      'acc-text-secondary': '#a6aec3',
      'acc-border': '#29344a',
      'acc-border-strong': '#5e6d8d',
    };
    for (const [k, v] of Object.entries(approvedLight)) assert.equal(light[k], v, `light --${k}`);
    for (const [k, v] of Object.entries(approvedDark)) assert.equal(dark[k], v, `dark --${k}`);
  });

  it('the specification figures reproduce (spot check)', () => {
    assert.equal(contrast('#13734e', '#e7f5ef').toFixed(2), '5.21');
    assert.equal(contrast('#5e6d8d', '#171f33').toFixed(2), '3.16');
    assert.equal(contrast('#ffffff', '#8585ff').toFixed(2), '3.09'); // the prohibited white-on-dark-primary
  });
});
