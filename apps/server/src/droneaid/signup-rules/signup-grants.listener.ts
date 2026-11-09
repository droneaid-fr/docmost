import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { SignupRulesService } from './signup-rules.service';

/** Emitted by core after a new account is committed (today: invitation acceptance). */
export interface UserCreatedEvent {
  userId: string;
  email: string;
  workspaceId: string;
  source?: string;
}

/**
 * Space grants for accounts that core creates. Our own Google signup calls
 * `SignupRulesService.applyGrants` directly once its transaction commits.
 */
@Injectable()
export class SignupGrantsListener {
  private readonly logger = new Logger(SignupGrantsListener.name);

  constructor(private readonly signupRules: SignupRulesService) {}

  @OnEvent(EventName.USER_CREATED)
  async onUserCreated(event: UserCreatedEvent): Promise<void> {
    try {
      if (!event?.userId || !event.email || !event.workspaceId) return;
      await this.signupRules.applyGrants(
        { id: event.userId, email: event.email },
        event.workspaceId,
      );
    } catch (err) {
      // applyGrants never throws; this guards the signup against future changes.
      this.logger.error(`Signup grants failed for ${event?.userId}`, err);
    }
  }
}
