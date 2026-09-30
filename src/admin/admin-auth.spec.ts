import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminService } from './admin.service';
import { assertAdminAuthConfiguration } from './admin-auth.config';
import { AdminAuthGuard } from './guards/admin-auth.guard';

describe('Admin authentication registry', () => {
  const usernames = ['pahlevan', 'bayat', 'shoaei', 'shayan', 'ahmadi'];
  const passwords = Object.fromEntries(
    usernames.map((username, index) => [
      username,
      `fixture-credential-${index}`,
    ]),
  );
  const values: Record<string, string> = {
    ADMIN_USERS: usernames.join(','),
    GOD_ADMIN_USERNAME: 'owner-fixture',
    GOD_ADMIN_PASSWORD: 'owner-secret-fixture',
  };
  usernames.forEach((username) => {
    values[`ADMIN_PASSWORD_${username.toUpperCase()}`] = passwords[username];
  });

  const configService = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const jwtService = new JwtService({
    secret: 'admin-auth-test-signing-secret',
  });
  const adminService = new AdminService(
    configService,
    jwtService,
    {} as never,
    {} as never,
    {} as never,
  );
  const guard = new AdminAuthGuard(jwtService, configService);

  it.each(usernames)(
    'issues and accepts an admin-panel token for %s',
    (username) => {
      const login = adminService.login({
        username,
        password: passwords[username],
      });
      const { context, request } = contextFor(login.accessToken);

      expect(guard.canActivate(context)).toBe(true);
      expect(request.admin).toMatchObject({ scope: 'admin-panel', username });
    },
  );

  it.each([
    [
      'god admin',
      { scope: 'god-admin-panel', role: 'owner', username: 'owner-fixture' },
    ],
    ['customer', { sub: 'customer-id', role: 'customer' }],
    ['breeder', { sub: 'breeder-id', role: 'breeder' }],
    ['missing username', { scope: 'admin-panel' }],
    ['blank username', { scope: 'admin-panel', username: '   ' }],
    ['unregistered username', { scope: 'admin-panel', username: 'outsider' }],
  ])('rejects %s credentials', (_kind, payload) => {
    const token = jwtService.sign(payload);
    expect(() => guard.canActivate(contextFor(token).context)).toThrow(
      UnauthorizedException,
    );
  });

  it('fails safely when owner and ordinary admin registries overlap', () => {
    const unsafeConfig = {
      get: jest.fn((key: string) => {
        if (key === 'ADMIN_USERS') return 'pahlevan, bayat';
        if (key === 'GOD_ADMIN_USERNAME') return ' BAYAT ';
        if (key === 'GOD_ADMIN_PASSWORD') return 'must-not-appear';
        return undefined;
      }),
    } as unknown as ConfigService;

    let error: Error | undefined;
    try {
      assertAdminAuthConfiguration(unsafeConfig);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toBe('Invalid admin authentication configuration');
    expect(error?.message).not.toContain('must-not-appear');
    expect(error?.message).not.toContain('bayat');
  });
});

function contextFor(token: string): {
  context: ExecutionContext;
  request: { headers: { authorization: string }; admin?: unknown };
} {
  const request: { headers: { authorization: string }; admin?: unknown } = {
    headers: { authorization: `Bearer ${token}` },
  };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext,
  };
}
