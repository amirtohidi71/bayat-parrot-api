/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Focused repository and web-push test doubles intentionally use Jest's dynamic mock values. */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as webPush from 'web-push';
import { ChatPushService } from './chat-push.service';
import { ChatPushOwnerType } from './entities/chat-push-subscription.entity';
import { SalesAgentScope } from './entities/sales-agent.entity';

describe('ChatPushService', () => {
  const vapid = webPush.generateVAPIDKeys();
  let rows: any[];
  let subscriptions: any;
  let agents: any;
  let client: any;
  let service: ChatPushService;

  beforeEach(() => {
    rows = [];
    subscriptions = {
      findOne: jest.fn(({ where }) =>
        Promise.resolve(
          rows.find((row) => row.endpoint === where.endpoint) ?? null,
        ),
      ),
      create: jest.fn((value) => ({ id: `sub-${rows.length + 1}`, ...value })),
      save: jest.fn((value) => {
        if (!rows.includes(value)) rows.push(value);
        return Promise.resolve(value);
      }),
      find: jest.fn(({ where }) =>
        Promise.resolve(
          rows.filter((row) => {
            if (where.ownerType && row.ownerType !== where.ownerType)
              return false;
            if (
              where.customerUserId &&
              row.customerUserId !== where.customerUserId
            )
              return false;
            if (where.salesAgentId && typeof where.salesAgentId === 'string') {
              return row.salesAgentId === where.salesAgentId;
            }
            if (where.salesAgentId?.value) {
              return where.salesAgentId.value.includes(row.salesAgentId);
            }
            return true;
          }),
        ),
      ),
      delete: jest.fn(({ id, endpoint }) => {
        rows = rows.filter((row) =>
          id ? row.id !== id : row.endpoint !== endpoint,
        );
        return Promise.resolve({ affected: 1 });
      }),
    };
    agents = {
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'agent-1', scope: SalesAgentScope.PARROT, active: true },
        ]),
    };
    client = { sendNotification: jest.fn().mockResolvedValue({}) };
    const config = {
      get: jest.fn(
        (name: string) =>
          ({
            CHAT_PUSH_ENABLED: 'true',
            VAPID_SUBJECT: 'mailto:test@example.com',
            VAPID_PUBLIC_KEY: vapid.publicKey,
            VAPID_PRIVATE_KEY: vapid.privateKey,
          })[name],
      ),
    } as unknown as ConfigService;
    service = new ChatPushService(subscriptions, agents, config, client);
  });

  it('stores only the authenticated owner subscription and can remove it', async () => {
    await service.subscribeCustomer('user-1', {
      endpoint: 'https://push.example/customer',
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    });
    expect(rows[0]).toEqual(
      expect.objectContaining({
        ownerType: ChatPushOwnerType.CUSTOMER,
        customerUserId: 'user-1',
        salesAgentId: null,
      }),
    );
    await service.unsubscribeCustomer('user-1', {
      endpoint: 'https://push.example/customer',
    });
    expect(rows).toHaveLength(0);
  });

  it('uses only canonical customer and sales deep links', async () => {
    rows.push({
      id: 'customer-sub',
      ownerType: ChatPushOwnerType.CUSTOMER,
      customerUserId: 'user-1',
      salesAgentId: null,
      endpoint: 'https://push.example/customer',
      p256dh: 'p',
      auth: 'a',
    });
    await service.notifyCustomer('user-1', 'conversation-1');
    expect(JSON.parse(client.sendNotification.mock.calls[0][1])).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-1',
        path: '/account/chat/conversation-1',
      }),
    );

    client.sendNotification.mockClear();
    rows.push({
      id: 'agent-sub',
      ownerType: ChatPushOwnerType.SALES_AGENT,
      customerUserId: null,
      salesAgentId: 'agent-1',
      endpoint: 'https://push.example/agent',
      p256dh: 'p',
      auth: 'a',
    });
    await service.notifyAssignedAgent('agent-1', 'conversation-2');
    expect(JSON.parse(client.sendNotification.mock.calls[0][1])).toEqual(
      expect.objectContaining({
        path: '/sales-panel/conversations/conversation-2',
      }),
    );
  });

  it('notifies only active agents resolved for the conversation area', async () => {
    rows.push(
      {
        id: 'parrot-agent-sub',
        ownerType: ChatPushOwnerType.SALES_AGENT,
        customerUserId: null,
        salesAgentId: 'agent-1',
        endpoint: 'https://push.example/parrot-agent',
        p256dh: 'p',
        auth: 'a',
      },
      {
        id: 'products-agent-sub',
        ownerType: ChatPushOwnerType.SALES_AGENT,
        customerUserId: null,
        salesAgentId: 'agent-5',
        endpoint: 'https://push.example/products-agent',
        p256dh: 'p',
        auth: 'a',
      },
    );

    await service.notifyAreaAgents(SalesAgentScope.PARROT, 'conversation-1');

    expect(agents.find).toHaveBeenCalledWith({
      where: { scope: SalesAgentScope.PARROT, active: true },
      select: { id: true },
    });
    expect(client.sendNotification).toHaveBeenCalledTimes(1);
    expect(client.sendNotification.mock.calls[0][0].endpoint).toBe(
      'https://push.example/parrot-agent',
    );
  });

  it('cleans an expired subscription without failing delivery', async () => {
    rows.push({
      id: 'expired',
      ownerType: ChatPushOwnerType.CUSTOMER,
      customerUserId: 'user-1',
      endpoint: 'https://push.example/expired',
      p256dh: 'p',
      auth: 'a',
    });
    client.sendNotification.mockRejectedValue({ statusCode: 410 });
    await expect(
      service.notifyCustomer('user-1', 'conversation-1'),
    ).resolves.toBeUndefined();
    expect(subscriptions.delete).toHaveBeenCalledWith({ id: 'expired' });
  });

  it('does not throw or log subscription secrets on provider failure', async () => {
    rows.push({
      id: 'failed',
      ownerType: ChatPushOwnerType.CUSTOMER,
      customerUserId: 'user-1',
      endpoint: 'https://push.example/private-endpoint',
      p256dh: 'private-p256dh',
      auth: 'private-auth',
    });
    client.sendNotification.mockRejectedValue(new Error('provider failure'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await expect(
      service.notifyCustomer('user-1', 'conversation-1'),
    ).resolves.toBeUndefined();
    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain('private-endpoint');
    expect(output).not.toContain('private-p256dh');
    expect(output).not.toContain('private-auth');
    warn.mockRestore();
  });
});
