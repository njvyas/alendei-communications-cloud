import { Module } from '@nestjs/common';

import { CredentialService } from './credential.service';
import { SessionService } from './session.service';
import { UserLifecycleService } from './user-lifecycle.service';
import { WsTicketController } from './ws-ticket.controller';
import { WsTicketService } from './ws-ticket.service';

/**
 * Identity and access module (`ARCHITECTURE.md` §4: `iam`).
 *
 * Phase 1B.2 shipped the persistence and credential foundation — hashing,
 * session lifecycle, refresh rotation and user state transitions — with the
 * request pipeline that uses them (`AuthGuard`, login/refresh/logout, API-key
 * authentication) arriving in Phase 1B.3 without this module presuming its
 * shape.
 *
 * It gained one HTTP surface in the Phase 1B.7 preparation: `POST /ws/ticket`,
 * which `API.md` §2 assigns to `iam` and which mints credential material of
 * exactly the kind this module already owns. It is issuance only — the socket
 * gateway and ticket consumption remain deferred (`DECISIONS.md` D15).
 */
@Module({
  controllers: [WsTicketController],
  providers: [CredentialService, SessionService, UserLifecycleService, WsTicketService],
  exports: [CredentialService, SessionService, UserLifecycleService, WsTicketService],
})
export class IamModule {}
