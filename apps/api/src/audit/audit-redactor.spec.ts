import { REDACTED, isSensitiveKey, redact } from './audit-redactor';

describe('audit redactor', () => {
  describe('exact credential fields', () => {
    it.each([
      'password',
      'password_hash',
      'key_hash',
      'refresh_token_hash',
      'mfa_secret_ref',
      'ticket_hash',
    ])('removes %s', (field) => {
      const result = redact({ [field]: 'the-actual-credential', keep: 'visible' }) as Record<
        string,
        unknown
      >;
      expect(result[field]).toBe(REDACTED);
      expect(result.keep).toBe('visible');
    });

    it('removes them however they are spelled', () => {
      const result = redact({
        passwordHash: 'a',
        'Password-Hash': 'b',
        PASSWORD_HASH: 'c',
        refreshTokenHash: 'd',
        mfaSecretRef: 'e',
        ticketHash: 'f',
      }) as Record<string, unknown>;
      for (const value of Object.values(result)) {
        expect(value).toBe(REDACTED);
      }
    });
  });

  describe('the secret/token catch-all', () => {
    it.each([
      'secret',
      'clientSecret',
      'signing_secret_ref',
      'token',
      'access_token',
      'refreshToken',
      'tokenFamily',
      'API_SECRET',
      'webhookSecretRef',
    ])('removes %s', (field) => {
      const result = redact({ [field]: 'value' }) as Record<string, unknown>;
      expect(result[field]).toBe(REDACTED);
    });

    it('over-redacts names that merely resemble credentials, deliberately', () => {
      // A false positive costs one field of audit detail; a false negative
      // writes a credential into a row that can never be edited afterwards.
      expect(redact({ tokenizer: 'x', secretary: 'x', passwordless: true })).toEqual({
        tokenizer: REDACTED,
        secretary: REDACTED,
        passwordless: REDACTED,
      });
    });

    it('catches plausible credential names an exact-match list would miss', () => {
      const result = redact({
        newPassword: 'a',
        oldPassword: 'b',
        userPassword: 'c',
        passwordConfirmation: 'd',
        apiKeyHash: 'e',
        wsTicketHash: 'f',
        bearerToken: 'g',
        totpSecret: 'h',
      }) as Record<string, unknown>;

      for (const [field, value] of Object.entries(result)) {
        expect([field, value]).toEqual([field, REDACTED]);
      }
    });
  });

  describe('recursion', () => {
    it('redacts nested objects', () => {
      const result = redact({
        user: { email: 'a@b.test', password_hash: 'argon2id$...' },
        session: { id: 's1', nested: { refresh_token_hash: 'deep' } },
      }) as Record<string, Record<string, unknown>>;

      expect(result.user!.email).toBe('a@b.test');
      expect(result.user!.password_hash).toBe(REDACTED);
      expect((result.session!.nested as Record<string, unknown>).refresh_token_hash).toBe(REDACTED);
    });

    it('redacts inside arrays', () => {
      const result = redact({
        keys: [
          { id: 'k1', key_hash: 'h1' },
          { id: 'k2', key_hash: 'h2' },
        ],
      }) as { keys: Record<string, unknown>[] };

      expect(result.keys.map((k) => k.id)).toEqual(['k1', 'k2']);
      expect(result.keys.every((k) => k.key_hash === REDACTED)).toBe(true);
    });

    it('redacts through mixed array/object nesting', () => {
      const result = redact({
        orgs: [
          {
            workspaces: [
              { credentials: [{ password: 'the-secret', label: 'keep' }] },
              { credentials: [{ apiSecret: 'also-secret', label: 'keep-too' }] },
            ],
          },
        ],
      });

      // Asserting on the serialized form: the structure is deep enough that
      // index-by-index navigation would obscure what is actually being claimed,
      // which is simply that no secret survives anywhere in the payload.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('the-secret');
      expect(serialized).not.toContain('also-secret');
      expect(serialized).toContain('keep');
      expect(serialized).toContain('keep-too');
      expect(serialized.match(/\[redacted\]/g)).toHaveLength(2);
    });

    it('redacts an array of bare strings without descending into characters', () => {
      const result = redact({ scopes: ['users.read', 'users.invite'] }) as {
        scopes: string[];
      };
      expect(result.scopes).toEqual(['users.read', 'users.invite']);
    });

    it('survives a circular payload rather than throwing', () => {
      const node: Record<string, unknown> = { name: 'root', password: 'p' };
      node.self = node;

      const result = redact(node) as Record<string, unknown>;
      expect(result.password).toBe(REDACTED);
      expect(result.self).toBe('[circular]');
    });
  });

  describe('caller safety', () => {
    it('does not mutate the original object', () => {
      const original = {
        email: 'a@b.test',
        password_hash: 'argon2id$secret',
        nested: { token: 'tok' },
        list: [{ key_hash: 'kh' }],
      };
      const snapshot = JSON.stringify(original);

      redact(original);

      expect(JSON.stringify(original)).toBe(snapshot);
      expect(original.password_hash).toBe('argon2id$secret');
      expect(original.nested.token).toBe('tok');
      expect(original.list[0]!.key_hash).toBe('kh');
    });

    it('passes primitives and null through unchanged', () => {
      expect(redact(null)).toBeNull();
      expect(redact('plain')).toBe('plain');
      expect(redact(42)).toBe(42);
      expect(redact(true)).toBe(true);
    });

    it('stringifies non-plain objects rather than descending into them', () => {
      const date = new Date('2026-09-13T00:00:00.000Z');
      const result = redact({ at: date }) as Record<string, unknown>;
      expect(typeof result.at).toBe('string');
    });
  });

  describe('isSensitiveKey', () => {
    it('is the single predicate both branches use', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('PasswordHash')).toBe(true);
      expect(isSensitiveKey('client_secret')).toBe(true);
      expect(isSensitiveKey('email')).toBe(false);
      expect(isSensitiveKey('org_id')).toBe(false);
      expect(isSensitiveKey('status')).toBe(false);
    });
  });
});
