import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

import { AppConfigService } from '../config/app-config.service';

/**
 * Password hashing and verification (`SECURITY.md` §1, `RBAC.md` §5).
 *
 * Argon2id with parameters from configuration (`AUTH_ARGON2_*`), so they are
 * explicit, reviewable and tunable without a code change. `@node-rs/argon2`
 * performs the comparison itself in constant time over the encoded digest; this
 * class never compares hashes with `===`.
 *
 * A plaintext password enters here and does not leave: no method returns one,
 * logs one, or puts one in an error message. The verification failure path is
 * deliberately shaped so that an unknown user and a wrong password cost roughly
 * the same (see `verifyDummy`), because a timing difference is a user-enumeration
 * oracle even when the response body is identical.
 */
@Injectable()
export class CredentialService {
  /**
   * A pre-computed hash of a value no one can present, used to spend
   * verification time on an account that does not exist. Computed lazily once.
   */
  private dummyHash: string | null = null;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Argon2id is `@node-rs/argon2`'s default algorithm, and is left implicit
   * because the library types it as an ambient `const enum` that cannot be
   * referenced under `isolatedModules`. Rather than hard-code its numeric value
   * — which would silently rot if the library reordered the enum — the unit
   * suite asserts the produced digest actually begins `$argon2id$`, which is
   * stronger evidence than naming the constant would have been.
   */
  private get options() {
    const { argon2 } = this.config.auth;
    return {
      memoryCost: argon2.memoryCost,
      timeCost: argon2.timeCost,
      parallelism: argon2.parallelism,
    };
  }

  /** Hashes a plaintext password. The result is safe to persist; the input is not. */
  async hash(plaintext: string): Promise<string> {
    if (plaintext.length === 0) {
      throw new Error('credential: refusing to hash an empty password');
    }
    return hash(plaintext, this.options);
  }

  /**
   * Verifies a password against a stored digest.
   *
   * Returns `false` rather than throwing on a malformed or unparseable digest:
   * a corrupt stored hash must read as "wrong password", never as a crash that
   * distinguishes one account from another.
   */
  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(digest, plaintext, this.options);
    } catch {
      return false;
    }
  }

  /**
   * Spends comparable verification time when there is no stored digest to check
   * — an unknown email, or a user with no password set.
   *
   * Always returns `false`. It exists purely so the caller's failure path takes
   * a similar amount of work to its success path.
   */
  async verifyDummy(plaintext: string): Promise<false> {
    this.dummyHash ??= await this.hash('a-password-nobody-can-present');
    await this.verify(this.dummyHash, plaintext);
    return false;
  }

  /**
   * True when a stored digest was produced with weaker parameters than the ones
   * now configured, so the caller can transparently re-hash on next successful
   * login (`TESTING.md` §6k).
   */
  needsRehash(digest: string): boolean {
    const { argon2 } = this.config.auth;
    const parsed = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(digest);
    if (!parsed) return true;

    const [, memory, time, parallelism] = parsed;
    return (
      Number(memory) < argon2.memoryCost ||
      Number(time) < argon2.timeCost ||
      Number(parallelism) !== argon2.parallelism
    );
  }
}
