import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';

export const VET_DOCTOR_SCOPE = 'vet-doctor';

export type VetDoctorTokenPayload = {
  scope: typeof VET_DOCTOR_SCOPE;
  sub: string;
};

@Injectable()
export class VetDoctorAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      vetDoctor?: VetDoctorTokenPayload;
    }>();
    const header: string | undefined = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing vet doctor token');
    try {
      const payload = this.jwt.verify<VetDoctorTokenPayload>(token);
      if (payload?.scope !== VET_DOCTOR_SCOPE || !isUUID(payload.sub))
        throw new Error('Invalid doctor token');
      request.vetDoctor = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired vet doctor token');
    }
  }
}
