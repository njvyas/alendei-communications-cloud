import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { pinoHttpOptions } from './pino-http-options';

/**
 * Structured JSON logging (`OBSERVABILITY.md` §2): pino-http with the options built in
 * `pino-http-options.ts` (fixed base schema, correlation keys, credential and PII redaction,
 * and the Phase 5.0 webhook-ingress key redaction).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ pinoHttp: pinoHttpOptions(config) }),
    }),
  ],
})
export class LoggingModule {}
