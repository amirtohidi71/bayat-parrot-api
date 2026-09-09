import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import {
  VET_DOCTOR_DEFAULT_TOKEN_TTL_SECONDS,
  VET_DOCTOR_JWT_AUDIENCE,
  VET_DOCTOR_JWT_ISSUER,
  VET_DOCTOR_MAX_TOKEN_TTL_SECONDS,
  VET_DOCTOR_MIN_TOKEN_TTL_SECONDS,
  VET_DOCTOR_SCOPE,
} from './vet-doctor-auth.constants';

type VetDoctorTokenPayload = {
  scope: typeof VET_DOCTOR_SCOPE;
  sub: string;
};

const MINIMUM_SECRET_BYTES = 32;

@Injectable()
export class VetDoctorTokenService {
  readonly expiresIn: number;
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();
    const allowsEphemeralSecret =
      environment === 'development' || environment === 'test';
    const configuredSecret = config
      .get<string>('VET_DOCTOR_JWT_SECRET')
      ?.trim();
    const generalSecret = config.get<string>('JWT_SECRET')?.trim();

    if (
      configuredSecret &&
      (configuredSecret === generalSecret ||
        Buffer.byteLength(configuredSecret, 'utf8') < MINIMUM_SECRET_BYTES ||
        configuredSecret.startsWith('replace-with-'))
    ) {
      throw new Error('Vet doctor JWT configuration is invalid');
    }
    if (!configuredSecret && !allowsEphemeralSecret) {
      throw new Error('Vet doctor JWT configuration is invalid');
    }
    this.secret =
      configuredSecret ??
      randomBytes(MINIMUM_SECRET_BYTES).toString('base64url');
    this.expiresIn = this.readTtl(
      config.get<string>('VET_DOCTOR_JWT_TTL_SECONDS'),
    );
  }

  issue(doctorId: string): string {
    try {
      return this.jwt.sign(
        { sub: doctorId, scope: VET_DOCTOR_SCOPE },
        {
          secret: this.secret,
          algorithm: 'HS256',
          expiresIn: this.expiresIn,
          issuer: VET_DOCTOR_JWT_ISSUER,
          audience: VET_DOCTOR_JWT_AUDIENCE,
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Doctor authentication unavailable',
      );
    }
  }

  verify(token: string): VetDoctorTokenPayload {
    return this.jwt.verify<VetDoctorTokenPayload>(token, {
      secret: this.secret,
      algorithms: ['HS256'],
      issuer: VET_DOCTOR_JWT_ISSUER,
      audience: VET_DOCTOR_JWT_AUDIENCE,
    });
  }

  private readTtl(value: string | undefined): number {
    if (value === undefined || value.trim() === '') {
      return VET_DOCTOR_DEFAULT_TOKEN_TTL_SECONDS;
    }
    const ttl = Number(value);
    if (
      !Number.isInteger(ttl) ||
      ttl < VET_DOCTOR_MIN_TOKEN_TTL_SECONDS ||
      ttl > VET_DOCTOR_MAX_TOKEN_TTL_SECONDS
    ) {
      throw new Error('Vet doctor JWT configuration is invalid');
    }
    return ttl;
  }
}
