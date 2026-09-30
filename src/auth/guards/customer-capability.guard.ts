import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { isCustomerRole } from '../../users/entities/user.entity';

type AuthenticatedRequest = { user?: AuthenticatedUser };

@Injectable()
export class CustomerCapabilityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user || !isCustomerRole(user.role)) {
      throw new ForbiddenException('Customer access required');
    }
    return true;
  }
}
