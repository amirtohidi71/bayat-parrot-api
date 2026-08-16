import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BIRD_PASSPORT_LOOKUP_AUDIENCE,
  BIRD_PASSPORT_LOOKUP_COOKIE,
  BIRD_PASSPORT_LOOKUP_ISSUER,
  BIRD_PASSPORT_LOOKUP_SCOPE,
  BirdPassportLookupGrantService,
} from './bird-passport-lookup-grant.service';
import {
  BirdPassportLookupGuard,
  readStrictCookie,
} from './bird-passport-lookup.guard';

const LOOKUP_SECRET = 'lookup-secret-used-only-in-tests-1234567890';
const GENERAL_SECRET = 'general-secret-used-only-in-tests-123456789';
const PASSPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function config(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((name: string) => values[name]),
  } as unknown as ConfigService;
}

function context(cookie?: string, authorization?: string) {
  const request = {
    headers: { cookie, authorization },
  };
  return {
    request,
    executionContext: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

describe('BirdPassportLookupGrantService', () => {
  it('issues a narrowly scoped grant without identity, phone or OTP claims', () => {
    const jwt = new JwtService();
    const service = new BirdPassportLookupGrantService(
      jwt,
      config({
        NODE_ENV: 'test',
        BIRD_PASSPORT_LOOKUP_JWT_SECRET: LOOKUP_SECRET,
        JWT_SECRET: GENERAL_SECRET,
      }),
    );
    const token = service.issue(PASSPORT_ID);
    const decoded: unknown = jwt.decode(token);
    if (!decoded || typeof decoded !== 'object') {
      throw new Error('Expected a decoded lookup grant payload');
    }
    if (!('jti' in decoded)) throw new Error('Expected lookup grant jti');
    expect(decoded).toMatchObject({
      scope: BIRD_PASSPORT_LOOKUP_SCOPE,
      passportId: PASSPORT_ID,
      aud: BIRD_PASSPORT_LOOKUP_AUDIENCE,
      iss: BIRD_PASSPORT_LOOKUP_ISSUER,
    });
    expect(decoded.jti).toMatch(/^[0-9a-f-]{36}$/i);
    for (const forbidden of [
      'ownerMobile',
      'userId',
      'adminId',
      'role',
      'otp',
      'codeHash',
    ]) {
      expect(decoded).not.toHaveProperty(forbidden);
    }
    expect(service.verify(token).passportId).toBe(PASSPORT_ID);
  });

  it.each([
    ['missing in production', undefined, GENERAL_SECRET],
    ['short', 'too-short', GENERAL_SECRET],
    ['same as general JWT', GENERAL_SECRET, GENERAL_SECRET],
  ])('fails closed for %s secret configuration', (_label, lookup, general) => {
    expect(
      () =>
        new BirdPassportLookupGrantService(
          new JwtService(),
          config({
            NODE_ENV: 'production',
            BIRD_PASSPORT_LOOKUP_JWT_SECRET: lookup,
            JWT_SECRET: general,
          }),
        ),
    ).toThrow('configuration is invalid');
  });
});

describe('BirdPassportLookupGuard', () => {
  const jwt = new JwtService();
  const grants = new BirdPassportLookupGrantService(
    jwt,
    config({
      NODE_ENV: 'test',
      BIRD_PASSPORT_LOOKUP_JWT_SECRET: LOOKUP_SECRET,
      JWT_SECRET: GENERAL_SECRET,
    }),
  );
  const guard = new BirdPassportLookupGuard(grants);

  function cookie(token: string) {
    return `${BIRD_PASSPORT_LOOKUP_COOKIE}=${token}`;
  }

  function crafted(
    payload: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) {
    return jwt.sign(payload, {
      secret: LOOKUP_SECRET,
      expiresIn: 600,
      audience: BIRD_PASSPORT_LOOKUP_AUDIENCE,
      issuer: BIRD_PASSPORT_LOOKUP_ISSUER,
      jwtid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ...options,
    });
  }

  function unsignedNoneToken() {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      scope: BIRD_PASSPORT_LOOKUP_SCOPE,
      passportId: PASSPORT_ID,
      jti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      aud: BIRD_PASSPORT_LOOKUP_AUDIENCE,
      iss: BIRD_PASSPORT_LOOKUP_ISSUER,
      iat: now,
      exp: now + 600,
    })}.`;
  }

  it('accepts the correct cookie and attaches only the limited grant context', () => {
    const value = context(cookie(grants.issue(PASSPORT_ID)));
    expect(guard.canActivate(value.executionContext)).toBe(true);
    expect(value.request).toMatchObject({
      birdPassportGrant: {
        scope: BIRD_PASSPORT_LOOKUP_SCOPE,
        passportId: PASSPORT_ID,
      },
    });
  });

  it.each([
    [
      'general secret',
      jwt.sign(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        { secret: GENERAL_SECRET },
      ),
    ],
    ['wrong scope', crafted({ scope: 'admin-panel', passportId: PASSPORT_ID })],
    [
      'wrong audience',
      crafted(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        { audience: 'other-audience' },
      ),
    ],
    [
      'wrong issuer',
      crafted(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        { issuer: 'other-issuer' },
      ),
    ],
    [
      'expired',
      jwt.sign(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        {
          secret: LOOKUP_SECRET,
          expiresIn: -1,
          audience: BIRD_PASSPORT_LOOKUP_AUDIENCE,
          issuer: BIRD_PASSPORT_LOOKUP_ISSUER,
          jwtid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
    ],
    [
      'invalid passport id',
      crafted({ scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: 'not-a-uuid' }),
    ],
    [
      'missing expiration',
      jwt.sign(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        {
          secret: LOOKUP_SECRET,
          audience: BIRD_PASSPORT_LOOKUP_AUDIENCE,
          issuer: BIRD_PASSPORT_LOOKUP_ISSUER,
          jwtid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
    ],
    [
      'HS384 algorithm',
      crafted(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        { algorithm: 'HS384' },
      ),
    ],
    [
      'HS512 algorithm',
      crafted(
        { scope: BIRD_PASSPORT_LOOKUP_SCOPE, passportId: PASSPORT_ID },
        { algorithm: 'HS512' },
      ),
    ],
    ['alg=none', unsignedNoneToken()],
    ['malformed token', 'not-a-jwt'],
  ])('rejects a lookup cookie with %s', (_label, token) => {
    expect(() =>
      guard.canActivate(context(cookie(token)).executionContext),
    ).toThrow(UnauthorizedException);
  });

  it('does not accept user/admin bearer authorization in place of the cookie', () => {
    const bearer = jwt.sign(
      { sub: 'user-1', role: 'customer' },
      { secret: GENERAL_SECRET },
    );
    expect(() =>
      guard.canActivate(
        context(undefined, `Bearer ${bearer}`).executionContext,
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    [`${BIRD_PASSPORT_LOOKUP_COOKIE}`],
    [`${BIRD_PASSPORT_LOOKUP_COOKIE}=`],
    [`${BIRD_PASSPORT_LOOKUP_COOKIE}=one; ${BIRD_PASSPORT_LOOKUP_COOKIE}=two`],
    [`bad cookie; ${BIRD_PASSPORT_LOOKUP_COOKIE}=value`],
  ])('fails closed for malformed cookie header %s', (header) => {
    expect(() => guard.canActivate(context(header).executionContext)).toThrow(
      UnauthorizedException,
    );
  });
});

describe('readStrictCookie', () => {
  it('reads one feature-specific cookie without a parser dependency', () => {
    expect(
      readStrictCookie(
        'theme=dark; bird_passport_view=a.b.c',
        BIRD_PASSPORT_LOOKUP_COOKIE,
      ),
    ).toBe('a.b.c');
  });
});
