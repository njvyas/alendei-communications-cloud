import { Injectable } from '@nestjs/common';
import { schema, type Transaction } from '@acc/db';
import { eq, sql } from 'drizzle-orm';

import { CredentialService } from './credential.service';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly status: 'active' | 'invited' | 'disabled';
}

/**
 * User lifecycle transitions (`DATABASE.md` §2).
 *
 * The three states are not decorative — `users_active_requires_credential`
 * enforces at the database that an `active` user holds a password or an MFA
 * secret. That constraint is what makes the lifecycle coherent:
 *
 *     invited  ──activate(password)──▶  active  ──disable()──▶  disabled
 *        ▲                                                          │
 *        └──────────────────── reinstate() ─────────────────────────┘
 *
 * An invited user has no credential and therefore cannot authenticate; there is
 * no state in which a user is both usable and credential-less.
 *
 * **What is deliberately absent**: how an invited user comes to set their
 * password. That requires either an invitation token delivered out of band or an
 * administrator setting it directly, and neither is documented. No token table
 * is invented here and no email transport is assumed — `activate` takes the
 * password directly, which is exactly what the bootstrap CLI needs, and the
 * delivery mechanism is recorded as a decision for Phase 1B.3 rather than
 * guessed at. See `DECISIONS.md`.
 */
@Injectable()
export class UserLifecycleService {
  constructor(private readonly credentials: CredentialService) {}

  async findByEmail(tx: Transaction, email: string): Promise<UserRecord | null> {
    const [row] = await tx
      .select({ id: schema.users.id, email: schema.users.email, status: schema.users.status })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = lower(${email})`);
    return row ?? null;
  }

  async findById(tx: Transaction, userId: string): Promise<UserRecord | null> {
    const [row] = await tx
      .select({ id: schema.users.id, email: schema.users.email, status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row ?? null;
  }

  /**
   * Creates an invited user: an identity with no credential, which cannot
   * authenticate until activated.
   */
  async invite(tx: Transaction, email: string, phone?: string | null): Promise<UserRecord> {
    const [row] = await tx
      .insert(schema.users)
      .values({ email, phone: phone ?? null, status: 'invited' })
      .returning({ id: schema.users.id, email: schema.users.email, status: schema.users.status });
    if (!row) throw new Error('user: invite returned no row');
    return row;
  }

  /**
   * Sets a user's password and moves them to `active`.
   *
   * The plaintext is hashed here and never stored, returned or logged. Callers
   * hold it only for the duration of this call.
   */
  async activate(tx: Transaction, userId: string, password: string): Promise<UserRecord> {
    const digest = await this.credentials.hash(password);
    const [row] = await tx
      .update(schema.users)
      .set({ passwordHash: digest, passwordUpdatedAt: new Date(), status: 'active' })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id, email: schema.users.email, status: schema.users.status });
    if (!row) throw new Error(`user: ${userId} not found for activation`);
    return row;
  }

  /**
   * Disables a user. Their sessions are revoked by the caller in the same
   * transaction — disabling an account that keeps live sessions is the bug this
   * separation exists to make visible rather than silent.
   */
  async disable(tx: Transaction, userId: string): Promise<UserRecord> {
    const [row] = await tx
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id, email: schema.users.email, status: schema.users.status });
    if (!row) throw new Error(`user: ${userId} not found to disable`);
    return row;
  }

  /**
   * Whether this user may present a credential at all. A disabled or invited
   * user cannot, regardless of whether the password supplied happens to match a
   * digest left over from before they were disabled.
   */
  canAuthenticate(user: UserRecord): boolean {
    return user.status === 'active';
  }

  /** The stored digest, read only inside a verification path. */
  async passwordDigest(tx: Transaction, userId: string): Promise<string | null> {
    const [row] = await tx
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row?.passwordHash ?? null;
  }
}
