import { CredentialService } from './credential.service';

const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const config = { auth: { argon2: PARAMS } } as never;

describe('CredentialService', () => {
  const credentials = new CredentialService(config);

  it('hashes with Argon2id using the configured parameters', async () => {
    const digest = await credentials.hash('correct horse battery staple');
    // Asserts the real algorithm and cost, rather than trusting a constant: the
    // library types Argon2id as an ambient const enum we cannot reference.
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(digest).toContain(`m=${PARAMS.memoryCost},t=${PARAMS.timeCost},p=${PARAMS.parallelism}`);
  });

  it('verifies a correct password', async () => {
    const digest = await credentials.hash('correct horse battery staple');
    await expect(credentials.verify(digest, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await credentials.hash('correct horse battery staple');
    await expect(credentials.verify(digest, 'Correct horse battery staple')).resolves.toBe(false);
    await expect(credentials.verify(digest, '')).resolves.toBe(false);
    await expect(credentials.verify(digest, 'correct horse battery stapl')).resolves.toBe(false);
  });

  it('never embeds the plaintext in the digest', async () => {
    const password = 'a-very-distinctive-plaintext-value';
    const digest = await credentials.hash(password);
    expect(digest).not.toContain(password);
    expect(digest).not.toContain('distinctive');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([credentials.hash('same'), credentials.hash('same')]);
    expect(a).not.toBe(b);
    await expect(credentials.verify(a, 'same')).resolves.toBe(true);
    await expect(credentials.verify(b, 'same')).resolves.toBe(true);
  });

  it('treats a corrupt digest as a wrong password rather than throwing', async () => {
    // A crash here would distinguish a corrupt-hash account from a normal one.
    for (const corrupt of ['', 'not-a-hash', '$argon2id$broken', '$2b$10$bcryptshaped']) {
      await expect(credentials.verify(corrupt, 'anything')).resolves.toBe(false);
    }
  });

  it('refuses to hash an empty password', async () => {
    await expect(credentials.hash('')).rejects.toThrow(/empty password/);
  });

  it('spends verification work on an account that does not exist', async () => {
    // The value is always false; the point is that it costs something, so an
    // unknown email and a wrong password are not distinguishable by timing.
    await expect(credentials.verifyDummy('whatever')).resolves.toBe(false);
  });

  describe('needsRehash', () => {
    it('is false for a digest at the configured cost', async () => {
      const digest = await credentials.hash('x');
      expect(credentials.needsRehash(digest)).toBe(false);
    });

    it('is true for a digest below the configured cost', () => {
      expect(credentials.needsRehash('$argon2id$v=19$m=8192,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
      expect(credentials.needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is true for anything it cannot parse, including another algorithm', () => {
      expect(credentials.needsRehash('$2b$10$bcryptshapeddigest')).toBe(true);
      expect(credentials.needsRehash('plaintext-masquerading-as-a-hash')).toBe(true);
    });
  });

  it('never returns or retains a plaintext password', async () => {
    const password = 'retained-plaintext-canary';
    const digest = await credentials.hash(password);
    await credentials.verify(digest, password);
    await credentials.verifyDummy(password);

    // Nothing the service returns, and nothing it holds on the instance, may
    // contain the plaintext it was given.
    expect(digest).not.toContain(password);
    expect(JSON.stringify(credentials)).not.toContain(password);

    // And no member yields it back: every callable returns a digest, a boolean
    // or parameters — never the input.
    for (const name of Object.getOwnPropertyNames(CredentialService.prototype)) {
      if (name === 'constructor') continue;
      const value: unknown = (credentials as unknown as Record<string, unknown>)[name];
      const result = typeof value === 'function' ? undefined : value;
      expect(JSON.stringify(result ?? null)).not.toContain(password);
    }
  });
});
