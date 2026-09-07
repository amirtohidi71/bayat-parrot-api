import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../entities/user.entity';
import { UsersService } from '../users.service';

/** JwtAuthGuard must run first. Recheck the persisted role, not only JWT claims. */
@Injectable()
export class UserDirectoryAdminGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('User directory admin access required');
    }
    const current = await this.users.findOne(user.id);
    if (current.role !== UserRole.ADMIN) {
      throw new ForbiddenException('User directory admin access required');
    }
    return true;
  }
}
