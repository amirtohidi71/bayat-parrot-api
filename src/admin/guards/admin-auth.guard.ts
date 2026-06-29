import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export const ADMIN_PANEL_SCOPE = 'admin-panel';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing admin token');
    }

    try {
      const payload = this.jwtService.verify(token);
      if (payload?.scope !== ADMIN_PANEL_SCOPE) {
        throw new UnauthorizedException('Invalid admin token');
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    return true;
  }
}
