import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export const GOD_ADMIN_PANEL_SCOPE = 'god-admin-panel';
export const GOD_ADMIN_ROLE = 'owner';

export type GodAdminTokenPayload = {
  scope: typeof GOD_ADMIN_PANEL_SCOPE;
  role: typeof GOD_ADMIN_ROLE;
  username: string;
};

@Injectable()
export class GodAdminAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing god admin token');
    }

    let payload: GodAdminTokenPayload;
    try {
      payload = this.jwtService.verify<GodAdminTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired god admin token');
    }

    if (payload?.scope !== GOD_ADMIN_PANEL_SCOPE || payload?.role !== GOD_ADMIN_ROLE) {
      throw new ForbiddenException('Owner access required');
    }

    request.godAdmin = payload;
    return true;
  }
}
