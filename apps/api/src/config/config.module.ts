import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';

import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

/**
 * Loads and validates configuration once, at startup. `validate` throws on any
 * problem, which aborts the bootstrap — a misconfigured process never reaches
 * the point of serving traffic.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // The repository root `.env` is the single source for local development;
      // deployed environments inject real environment variables instead.
      envFilePath: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
