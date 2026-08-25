import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminTokenPayload } from '../../admin/guards/admin-auth.guard';
import { CANONICAL_SALES_CHAT_SUPERVISORS } from '../sales-chat.constants';

type SupervisorRequest = { admin?: AdminTokenPayload };

@Injectable()
export class SalesChatSupervisorGuard implements CanActivate {
  private readonly allowed: Set<string>;

  constructor(config: ConfigService) {
    const configured = config
      .get<string>('SALES_CHAT_SUPERVISORS')
      ?.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const requested = configured?.length
      ? configured
      : [...CANONICAL_SALES_CHAT_SUPERVISORS];
    this.allowed = new Set(
      requested.filter((username) =>
        CANONICAL_SALES_CHAT_SUPERVISORS.has(username),
      ),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SupervisorRequest>();
    const username = request.admin?.username?.trim().toLowerCase();
    if (!username || !this.allowed.has(username)) {
      throw new ForbiddenException('Sales chat supervisor access required');
    }
    return true;
  }
}
