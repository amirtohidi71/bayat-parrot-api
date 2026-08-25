import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';
import { SalesChatAuthService } from './sales-chat-auth.service';

describe('SalesChatAuthService', () => {
  const agent = {
    id: '30000001-0000-4000-8000-000000000001',
    username: 'ad1',
    displayName: 'Ad1',
    scope: SalesAgentScope.PARROT,
    active: true,
  } as SalesAgent;
  const repository = {
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(agent),
    })),
  };
  const config = {
    get: jest.fn((name: string) =>
      name === 'SALES_AGENT_PASSWORD_AD1' ? 'agent-password' : undefined,
    ),
  };
  const jwt = { sign: jest.fn(() => 'sales-token') };
  const service = new SalesChatAuthService(
    repository as never,
    config as unknown as ConfigService,
    jwt as unknown as JwtService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('uses a case-insensitive username and returns the stable DB identity', async () => {
    await expect(
      service.login({ username: 'Ad1', password: 'agent-password' }),
    ).resolves.toEqual({
      accessToken: 'sales-token',
      agent: {
        id: agent.id,
        username: 'ad1',
        displayName: 'Ad1',
        scope: SalesAgentScope.PARROT,
      },
    });
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: agent.id,
        agentId: agent.id,
        scope: 'sales-chat-agent',
        agentScope: SalesAgentScope.PARROT,
      }),
    );
  });

  it('returns one generic failure for a wrong password', async () => {
    await expect(
      service.login({
        username: 'Ad1',
        password: 'wrong',
      }),
    ).rejects.toEqual(
      new UnauthorizedException('Invalid username or password'),
    );
  });
});
