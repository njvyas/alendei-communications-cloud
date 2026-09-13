import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import { ERROR_CODES } from '@acc/contracts';
import { uuidv7 } from 'uuidv7';

import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../common/errors/app.exception';
import { SECRETS_PORT, type SecretsPort } from '../secrets/secrets.port';

/** The complete access-token payload. ADR-003 D-3: identity and session only. */
export interface AccessTokenClaims {
  /** Subject — the user id. */
  readonly sub: string;
  /** Session id. The token is evidence of *this* session, not of a user in general. */
  readonly sid: string;
  readonly actor_type: 'user';
  /** Unique token id, so one token can be distinguished from its successors. */
  readonly jti: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

/** Exactly one algorithm is accepted. Pinned to close `alg` substitution. */
const ALGORITHM = 'HS256' as const;

/**
 * Access-token signing and verification (`RBAC.md` §5a, ADR-003 D-3).
 *
 * The payload carries **no** tenancy, roles or permissions. That is not
 * minimalism for its own sake: it is what makes a forged tenant claim
 * structurally unable to influence authorization, because no code path reads one
 * (`TESTING.md` §6c). Everything about *what the holder may do* is re-derived
 * per request from current database state, so a revoked grant stops applying
 * immediately rather than at token expiry.
 *
 * The token is therefore authentication evidence, never an authorization
 * snapshot.
 */
@Injectable()
export class AccessTokenService implements OnModuleInit {
  private secret!: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly jwt: NestJwtService,
    @Inject(SECRETS_PORT) private readonly secrets: SecretsPort,
  ) {}

  /**
   * Resolved once at startup through `SecretsPort`, so the signing key comes
   * from the configured backend rather than being read as raw configuration
   * (`SECURITY.md` §3). A failure here stops the process rather than falling
   * back to a weak key.
   */
  async onModuleInit(): Promise<void> {
    this.secret = await this.secrets.resolve(this.config.secrets.jwtSecretRef);
  }

  /** For tests and CLI paths that construct the service directly. */
  setSecretForTesting(secret: string): void {
    this.secret = secret;
  }

  issue(params: { userId: string; sessionId: string }): { token: string; expiresIn: number } {
    const ttl = this.config.auth.accessTokenTtlSeconds;
    const now = Math.floor(Date.now() / 1000);

    const claims: AccessTokenClaims = {
      sub: params.userId,
      sid: params.sessionId,
      actor_type: 'user',
      jti: uuidv7(),
      iss: this.config.auth.issuer,
      aud: this.config.auth.audience,
      iat: now,
      exp: now + ttl,
    };

    // `iss`/`aud`/`iat`/`exp` are set explicitly on the payload rather than
    // through sign options, so the issued claim set is exactly what the type
    // above declares. `noTimestamp` is deliberately NOT used: it deletes an
    // explicit `iat` as well as suppressing the generated one, which would ship
    // tokens with no issued-at at all.
    const token = this.jwt.sign(claims, { secret: this.secret, algorithm: ALGORITHM });
    return { token, expiresIn: ttl };
  }

  /**
   * Verifies a presented token.
   *
   * Every failure — expired, wrong issuer, wrong audience, wrong algorithm,
   * tampered signature, structurally malformed — produces the same
   * `AUTH_TOKEN_INVALID` shape to the caller, except expiry, which is
   * distinguishable because a client legitimately needs to know to refresh.
   * Nothing else about *why* a token failed is disclosed.
   */
  verify(token: string): AccessTokenClaims {
    let claims: AccessTokenClaims;
    try {
      claims = this.jwt.verify<AccessTokenClaims>(token, {
        secret: this.secret,
        // Pinning the algorithm list is what refuses a token re-signed as `none`
        // or swapped to an algorithm the key was not chosen for.
        algorithms: [ALGORITHM],
        issuer: this.config.auth.issuer,
        audience: this.config.auth.audience,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TokenExpiredError') {
        throw new AppException({
          status: HttpStatus.UNAUTHORIZED,
          code: ERROR_CODES.AUTH_TOKEN_EXPIRED,
          message: 'Access token has expired',
        });
      }
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_TOKEN_INVALID,
        message: 'Access token is not valid',
        // The reason is kept for the operator, never returned to the caller.
        logContext: { reason: name ?? 'verify_failed' },
      });
    }

    // Belt and braces over the library's own checks: a payload missing the
    // claims we depend on must not be treated as a usable identity.
    if (!claims.sub || !claims.sid || claims.actor_type !== 'user') {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_TOKEN_INVALID,
        message: 'Access token is not valid',
        logContext: { reason: 'missing_required_claims' },
      });
    }
    return claims;
  }
}
