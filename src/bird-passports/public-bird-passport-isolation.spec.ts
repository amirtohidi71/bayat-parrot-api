import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('public Bird Passport auth isolation', () => {
  it('has no login, user creation, user JWT or admin authentication dependency', () => {
    const source = readFileSync(
      join(__dirname, 'public-bird-passports.service.ts'),
      'utf8',
    );
    for (const forbidden of [
      'AuthService',
      'UsersService',
      'createWithPhone',
      'AdminAuthGuard',
      'GodAdminAuthGuard',
      'accessToken',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('PublicBirdPassportSmsDispatchService');
    const dispatcher = readFileSync(
      join(__dirname, 'public-bird-passport-sms-dispatch.service.ts'),
      'utf8',
    );
    expect(dispatcher).toContain('SmsService');
    for (const forbidden of ['AuthService', 'UsersService', 'JwtService']) {
      expect(dispatcher).not.toContain(forbidden);
    }
  });

  it('does not read an Authorization header in the lookup grant guard', () => {
    const source = readFileSync(
      join(__dirname, 'bird-passport-lookup.guard.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/authorization|bearer/i);
    expect(source).toContain('BIRD_PASSPORT_LOOKUP_COOKIE');
  });
});
