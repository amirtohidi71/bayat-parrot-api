import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { resolveConfiguredAdminUsername } from '../admin-auth.config';

export const ADMIN_PANEL_SCOPE = 'admin-panel';

export type AdminTokenPayload = {
  scope: typeof ADMIN_PANEL_SCOPE;
  username: string;
};

type AdminRequest = {
  headers: { authorization?: string };
  admin?: AdminTokenPayload;
};

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing admin token');
    }

    try {
      const payload = this.jwtService.verify<AdminTokenPayload>(token);
      const username = resolveConfiguredAdminUsername(
        this.configService,
        payload?.username,
      );
      if (payload?.scope !== ADMIN_PANEL_SCOPE || !username) {
        throw new UnauthorizedException('Invalid admin token');
      }
      request.admin = { ...payload, username };
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    return true;
  }
}
