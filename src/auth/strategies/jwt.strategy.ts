import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '../../users/entities/user.entity';

export interface JwtPayload {
  sub: string;
  phone: string;
  role: string;
  scope?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  validate(payload: JwtPayload) {
    if (
      payload.scope ||
      !payload.sub ||
      !/^09\d{9}$/.test(payload.phone) ||
      !Object.values(UserRole).includes(payload.role as UserRole)
    ) {
      throw new UnauthorizedException('Invalid user token');
    }
    return { id: payload.sub, phone: payload.phone, role: payload.role };
  }
}
