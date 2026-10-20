import { Readable } from 'node:stream';

import { parseArguments, readPassword } from './activate-user';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from './user-activation';

const SECRET = 'correct-horse-battery-staple';
const BASE = ['--operator', 'op@x.test', '--organization', 'acme', '--email', 'u@x.test'];

describe('user activation command (MVP)', () => {
  describe('arguments', () => {
    it('requires every target flag and --password-stdin', () => {
      expect(parseArguments([...BASE, '--password-stdin'])).toEqual({
        '--operator': 'op@x.test',
        '--organization': 'acme',
        '--email': 'u@x.test',
      });
      expect(() => parseArguments(BASE)).toThrow(/--password-stdin is required/);
      expect(() => parseArguments(['--password-stdin', '--operator', 'op@x.test'])).toThrow(
        /--organization is required/,
      );
    });

    it('refuses a password passed as an argument, without repeating it', () => {
      const attempt = () => parseArguments([...BASE, '--password-stdin', '--password', SECRET]);
      expect(attempt).toThrow(/unexpected argument --password/);
      expect(() => parseArguments([...BASE, '--password-stdin', SECRET])).toThrow(
        /unexpected argument \(value withheld\)/,
      );
      try {
        parseArguments([...BASE, '--password-stdin', SECRET]);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('password input', () => {
    it('reads stdin to its end and drops exactly one trailing line ending', async () => {
      expect(await readPassword(Readable.from([`${SECRET}\n`]))).toBe(SECRET);
      expect(await readPassword(Readable.from([`${SECRET}\r\n`]))).toBe(SECRET);
      expect(await readPassword(Readable.from(['pass', 'word-in-chunks']))).toBe(
        'password-in-chunks',
      );
    });

    it('refuses an interactive terminal', async () => {
      const tty = Object.assign(Readable.from([]), { isTTY: true });
      await expect(readPassword(tty)).rejects.toThrow(/pipe the password on stdin/);
    });
  });

  describe('password rule', () => {
    it(`accepts ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters without surrounding whitespace`, () => {
      expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
      expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
      expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
      expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most/);
      expect(passwordProblem(` ${SECRET}`)).toMatch(/whitespace/);
      expect(passwordProblem(`${SECRET}\t`)).toMatch(/whitespace/);
    });

    it('never repeats the password in its reason', () => {
      for (const candidate of ['short', ` ${SECRET} `, 'x'.repeat(PASSWORD_MAX_LENGTH + 1)]) {
        expect(passwordProblem(candidate)).not.toContain(candidate.trim());
      }
    });
  });
});
