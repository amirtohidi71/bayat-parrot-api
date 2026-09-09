import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { VetDoctorTokenService } from './vet-doctor-token.service';

describe('VetDoctorTokenService configuration', () => {
  const create = (values: Record<string, unknown>) => {
    const config = {
      get: <T>(key: string) => values[key] as T | undefined,
    } as ConfigService;
    return new VetDoctorTokenService(new JwtService(), config);
  };

  it.each(['development', 'test'])(
    'allows an ephemeral secret only in %s',
    (environment) => {
      const tokens = create({ NODE_ENV: environment });
      const doctorId = randomUUID();
      expect(tokens.verify(tokens.issue(doctorId))).toMatchObject({
        sub: doctorId,
        scope: 'vet-doctor',
      });
    },
  );

  it.each(['production', 'staging', 'preview', 'arbitrary-runtime'])(
    'fails closed without a secret in %s',
    (environment) => {
      expect(() => create({ NODE_ENV: environment })).toThrow(
        'Vet doctor JWT configuration is invalid',
      );
    },
  );

  it('fails closed when the environment is undefined', () => {
    expect(() => create({})).toThrow('Vet doctor JWT configuration is invalid');
  });

  it('accepts an explicit valid secret in a non-development environment', () => {
    const tokens = create({
      NODE_ENV: 'staging',
      VET_DOCTOR_JWT_SECRET: 'staging-vet-doctor-secret-with-at-least-32-bytes',
    });
    const doctorId = randomUUID();
    expect(tokens.verify(tokens.issue(doctorId))).toMatchObject({
      sub: doctorId,
      scope: 'vet-doctor',
    });
  });

  it.each([
    ['too-short', undefined],
    [
      'same-secret-used-by-both-auth-domains-123456',
      'same-secret-used-by-both-auth-domains-123456',
    ],
  ])('rejects an invalid configured secret', (doctorSecret, generalSecret) => {
    expect(() =>
      create({
        NODE_ENV: 'staging',
        VET_DOCTOR_JWT_SECRET: doctorSecret,
        JWT_SECRET: generalSecret,
      }),
    ).toThrow('Vet doctor JWT configuration is invalid');
  });
});
