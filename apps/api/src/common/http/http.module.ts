import { Global, Module } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { SECRETS_PORT, type SecretsPort } from '../../secrets/secrets.port';
import { CursorCodec } from './cursor';
import { ListQuery } from './list-query';

/**
 * The shared HTTP conventions (`API.md` §§7-9, Phase 1B.5.8).
 *
 * Global because pagination is a cross-cutting convention, not a feature of one
 * module: every list endpoint present and future resolves its query through the
 * same `ListQuery`, which is what stops the conventions drifting per resource.
 */
@Global()
@Module({
  providers: [
    {
      provide: CursorCodec,
      inject: [AppConfigService, SECRETS_PORT],
      // Derived from the existing signing secret rather than a new one: another
      // secret is another thing to provision, rotate and get wrong, and the
      // codec domain-separates its key internally. Resolved through
      // `SecretsPort` exactly as the JWT key is, so neither is ever read from
      // the environment directly.
      useFactory: async (config: AppConfigService, secrets: SecretsPort) =>
        new CursorCodec(await secrets.resolve(config.secrets.jwtSecretRef)),
    },
    {
      provide: ListQuery,
      inject: [CursorCodec],
      useFactory: (cursors: CursorCodec) => new ListQuery(cursors),
    },
  ],
  exports: [CursorCodec, ListQuery],
})
export class HttpConventionsModule {}
