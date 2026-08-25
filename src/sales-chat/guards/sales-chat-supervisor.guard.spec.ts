import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SalesChatSupervisorGuard } from './sales-chat-supervisor.guard';

function context(username: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ admin: { username } }),
    }),
  } as ExecutionContext;
}

describe('SalesChatSupervisorGuard', () => {
  const guard = new SalesChatSupervisorGuard({
    get: jest.fn(() => 'pahlevan,bayat,shoaei,ahmadi'),
  } as unknown as ConfigService);

  it.each(['pahlevan', 'bayat', 'shoaei'])(
    'allows canonical supervisor %s',
    (username) => {
      expect(guard.canActivate(context(username))).toBe(true);
    },
  );

  it.each(['ahmadi', 'shayan', 'owner'])(
    'denies non-supervisor %s even if configuration tries to add it',
    (username) => {
      expect(() => guard.canActivate(context(username))).toThrow(
        ForbiddenException,
      );
    },
  );
});
