import { BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ChatChannel,
  ChatConversationStatus,
} from './entities/chat-conversation.entity';
import {
  ChatMessageSenderType,
  ChatMessageType,
} from './entities/chat-message.entity';
import { SalesAgentScope } from './entities/sales-agent.entity';
import { SalesChatService } from './sales-chat.service';

describe('SalesChatService security boundaries', () => {
  const conversations = { find: jest.fn() };
  const messages = {};
  const agents = { findOne: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const routing = {};
  const push = {
    notifyAreaAgents: jest.fn(),
    notifyAssignedAgent: jest.fn(),
    notifyCustomer: jest.fn(),
  };
  const service = new SalesChatService(
    conversations as never,
    messages as never,
    agents as never,
    dataSource as unknown as DataSource,
    routing as never,
    push as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    agents.findOne.mockResolvedValue({ id: 'agent-1' });
    push.notifyAreaAgents.mockResolvedValue(undefined);
    push.notifyAssignedAgent.mockResolvedValue(undefined);
    push.notifyCustomer.mockResolvedValue(undefined);
  });

  it.each(['', '   ', '<script>alert(1)</script>', 'x'.repeat(4001)])(
    'rejects invalid or HTML text before a transaction: %s',
    async (text) => {
      await expect(
        service.sendCustomerMessage('user-1', 'conversation-1', {
          clientMessageId: '90000001-0000-4000-8000-000000000001',
          text,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('does not roll back an already committed message when push fails', async () => {
    const message = {
      id: 'message-1',
      conversationId: 'conversation-1',
      senderType: ChatMessageSenderType.CUSTOMER,
      type: ChatMessageType.TEXT,
      text: 'سلام 🦜',
      sequence: 1,
      contextProductId: null,
      contextSourcePath: null,
      createdAt: new Date('2026-08-19T00:00:00Z'),
    };
    dataSource.transaction.mockResolvedValue({
      message,
      conversation: {
        id: 'conversation-1',
        status: ChatConversationStatus.OPEN_UNASSIGNED,
        area: SalesAgentScope.PARROT,
        assignedAgentId: null,
      },
      duplicate: false,
    });
    push.notifyAreaAgents.mockRejectedValue(new Error('provider unavailable'));

    const result = await service.sendCustomerMessage(
      'user-1',
      'conversation-1',
      {
        clientMessageId: '90000001-0000-4000-8000-000000000001',
        text: 'سلام 🦜',
      },
    );
    expect(result).toEqual({
      item: {
        id: 'message-1',
        conversationId: 'conversation-1',
        senderType: ChatMessageSenderType.CUSTOMER,
        type: ChatMessageType.TEXT,
        text: 'سلام 🦜',
        sequence: 1,
        context: null,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      duplicate: false,
    });
  });

  it('does not dispatch another push notification for an idempotent retry', async () => {
    dataSource.transaction.mockResolvedValue({
      message: {
        id: 'message-1',
        conversationId: 'conversation-1',
        senderType: ChatMessageSenderType.CUSTOMER,
        type: ChatMessageType.TEXT,
        text: 'retry',
        sequence: 1,
        contextProductId: null,
        contextSourcePath: null,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      conversation: {
        id: 'conversation-1',
        status: ChatConversationStatus.OPEN_UNASSIGNED,
        area: SalesAgentScope.PARROT,
        assignedAgentId: null,
      },
      duplicate: true,
    });

    await service.sendCustomerMessage('user-1', 'conversation-1', {
      clientMessageId: '90000001-0000-4000-8000-000000000001',
      text: 'retry',
    });

    expect(push.notifyAreaAgents).not.toHaveBeenCalled();
    expect(push.notifyAssignedAgent).not.toHaveBeenCalled();
  });

  it('routes a customer message only to the assigned agent', async () => {
    dataSource.transaction.mockResolvedValue({
      message: {
        id: 'message-2',
        conversationId: 'conversation-1',
        senderType: ChatMessageSenderType.CUSTOMER,
        type: ChatMessageType.TEXT,
        text: 'assigned',
        sequence: 2,
        contextProductId: null,
        contextSourcePath: null,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      conversation: {
        id: 'conversation-1',
        customerUserId: 'user-1',
        status: ChatConversationStatus.OPEN_ASSIGNED,
        area: SalesAgentScope.PARROT,
        assignedAgentId: 'agent-1',
      },
      duplicate: false,
    });

    await service.sendCustomerMessage('user-1', 'conversation-1', {
      clientMessageId: '90000002-0000-4000-8000-000000000002',
      text: 'assigned',
    });

    expect(push.notifyAssignedAgent).toHaveBeenCalledWith(
      'agent-1',
      'conversation-1',
    );
    expect(push.notifyAreaAgents).not.toHaveBeenCalled();
  });

  it('skips push for an inactive assigned agent without affecting the committed message', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    agents.findOne.mockResolvedValue(null);
    dataSource.transaction.mockResolvedValue({
      message: {
        id: 'message-inactive',
        conversationId: 'conversation-1',
        senderType: ChatMessageSenderType.CUSTOMER,
        type: ChatMessageType.TEXT,
        text: 'committed message',
        sequence: 2,
        contextProductId: null,
        contextSourcePath: null,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      conversation: {
        id: 'conversation-1',
        customerUserId: 'user-1',
        status: ChatConversationStatus.OPEN_ASSIGNED,
        area: SalesAgentScope.PARROT,
        assignedAgentId: 'inactive-agent-id',
      },
      duplicate: false,
    });

    await expect(
      service.sendCustomerMessage('user-1', 'conversation-1', {
        clientMessageId: '90000004-0000-4000-8000-000000000004',
        text: 'committed message',
      }),
    ).resolves.toMatchObject({ duplicate: false });

    expect(agents.findOne).toHaveBeenCalledWith({
      where: {
        id: 'inactive-agent-id',
        active: true,
        scope: SalesAgentScope.PARROT,
      },
      select: { id: true },
    });
    expect(push.notifyAssignedAgent).not.toHaveBeenCalled();
    expect(push.notifyAreaAgents).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      'Chat push skipped count=1 reason=assigned-agent-unavailable',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'inactive-agent-id',
    );
    warning.mockRestore();
  });

  it('routes an agent message to the owning customer', async () => {
    dataSource.transaction.mockResolvedValue({
      message: {
        id: 'message-3',
        conversationId: 'conversation-1',
        senderType: ChatMessageSenderType.AGENT,
        type: ChatMessageType.TEXT,
        text: 'customer reply',
        sequence: 3,
        contextProductId: null,
        contextSourcePath: null,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      conversation: {
        id: 'conversation-1',
        customerUserId: 'user-1',
        status: ChatConversationStatus.OPEN_ASSIGNED,
        area: SalesAgentScope.PARROT,
        assignedAgentId: 'agent-1',
      },
      duplicate: false,
    });

    await service.sendAgentMessage(
      'agent-1',
      SalesAgentScope.PARROT,
      'conversation-1',
      {
        clientMessageId: '90000003-0000-4000-8000-000000000003',
        text: 'customer reply',
      },
    );

    expect(push.notifyCustomer).toHaveBeenCalledWith(
      'user-1',
      'conversation-1',
    );
  });

  it('keeps the unassigned queue summary free of customer and message text', async () => {
    agents.findOne.mockResolvedValue({ id: 'agent-1' });
    conversations.find.mockResolvedValue([
      {
        id: 'conversation-1',
        area: SalesAgentScope.PARROT,
        status: ChatConversationStatus.OPEN_UNASSIGNED,
        channel: ChatChannel.WEB,
        customerUserId: 'private-user-id',
        sourceType: null,
        sourceProductId: null,
        sourcePath: null,
        lastMessageAt: new Date('2026-08-19T00:00:00Z'),
        lastMessagePreview: 'private message body',
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
    ]);
    const response = await service.listAgentQueue(
      'agent-1',
      SalesAgentScope.PARROT,
    );
    expect(JSON.stringify(response)).not.toContain('private-user-id');
    expect(JSON.stringify(response)).not.toContain('private message body');
  });
});
