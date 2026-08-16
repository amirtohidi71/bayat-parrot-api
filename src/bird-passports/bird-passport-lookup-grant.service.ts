import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';

export const BIRD_PASSPORT_LOOKUP_COOKIE = 'bird_passport_view';
export const BIRD_PASSPORT_LOOKUP_SCOPE = 'bird-passport-view';
export const BIRD_PASSPORT_LOOKUP_AUDIENCE = 'bird-passport-public';
export const BIRD_PASSPORT_LOOKUP_ISSUER = 'bayat-parrot-api';
export const BIRD_PASSPORT_LOOKUP_GRANT_SECONDS = 10 * 60;

export type BirdPassportLookupGrant = {
  scope: typeof BIRD_PASSPORT_LOOKUP_SCOPE;
  passportId: string;
  jti: string;
  iat: number;
  exp: number;
};

@Injectable()
export class BirdPassportLookupGrantService {
  private readonly secret: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    const environment =
      configService.get<string>('NODE_ENV')?.trim().toLowerCase() ??
      'development';
    const configuredSecret = configService
      .get<string>('BIRD_PASSPORT_LOOKUP_JWT_SECRET')
      ?.trim();
    const generalSecret = configService.get<string>('JWT_SECRET')?.trim();

    if (configuredSecret && configuredSecret === generalSecret) {
      throw new Error('Bird passport lookup JWT configuration is invalid');
    }
    if (configuredSecret && configuredSecret.length < 32) {
      throw new Error('Bird passport lookup JWT configuration is invalid');
    }
    if (!configuredSecret && environment === 'production') {
      throw new Error('Bird passport lookup JWT configuration is invalid');
    }
    this.secret = configuredSecret ?? randomBytes(32).toString('base64url');
  }

  issue(passportId: string): string {
    return this.jwtService.sign(
      {
        scope: BIRD_PASSPORT_LOOKUP_SCOPE,
        passportId,
      },
      {
        secret: this.secret,
        expiresIn: BIRD_PASSPORT_LOOKUP_GRANT_SECONDS,
        audience: BIRD_PASSPORT_LOOKUP_AUDIENCE,
        issuer: BIRD_PASSPORT_LOOKUP_ISSUER,
        jwtid: randomUUID(),
        algorithm: 'HS256',
      },
    );
  }

  verify(token: string): BirdPassportLookupGrant {
    const payload = this.jwtService.verify<BirdPassportLookupGrant>(token, {
      secret: this.secret,
      audience: BIRD_PASSPORT_LOOKUP_AUDIENCE,
      issuer: BIRD_PASSPORT_LOOKUP_ISSUER,
      algorithms: ['HS256'],
    });
    return payload;
  }
}
