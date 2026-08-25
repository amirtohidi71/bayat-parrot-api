import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';
import { ChatMessagesQueryDto } from './dto/chat-messages-query.dto';
import { MarkChatReadDto } from './dto/mark-chat-read.dto';
import { OpenChatConversationDto } from './dto/open-chat-conversation.dto';
import { SalesChatSupervisorQueryDto } from './dto/sales-chat-supervisor-query.dto';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import {
  ChatChannel,
  ChatConversation,
  ChatConversationStatus,
} from './entities/chat-conversation.entity';
import {
  ChatMessage,
  ChatMessageSenderType,
  ChatMessageType,
} from './entities/chat-message.entity';
import {
  ConversationAssignment,
  ConversationAssignmentActorType,
} from './entities/conversation-assignment.entity';
import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';
import { ChatPushService } from './chat-push.service';
import { CHAT_TEXT_MAX_LENGTH } from './sales-chat.constants';
import {
  ResolvedChatContext,
  SalesChatProductRoutingService,
} from './sales-chat-product-routing.service';

const OPEN_STATUSES = [
  ChatConversationStatus.OPEN_UNASSIGNED,
  ChatConversationStatus.OPEN_ASSIGNED,
];
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

@Injectable()
export class SalesChatService {
  private readonly logger = new Logger(SalesChatService.name);

  constructor(
    @InjectRepository(ChatConversation)
    private readonly conversations: Repository<ChatConversation>,
    @InjectRepository(ChatMessage)
    private readonly messages: Repository<ChatMessage>,
    @InjectRepository(SalesAgent)
    private readonly agents: Repository<SalesAgent>,
    private readonly dataSource: DataSource,
    private readonly routing: SalesChatProductRoutingService,
    private readonly push: ChatPushService,
  ) {}

  async openCustomerConversation(
    customerUserId: string,
    dto: OpenChatConversationDto,
  ) {
    const context = await this.routing.resolve(dto);
    const conversation = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sales-chat-open:${customerUserId}:${context.area}`,
      ]);
      const repository = manager.getRepository(ChatConversation);
      let current = await repository.findOne({
        where: {
          customerUserId,
          area: context.area,
          status: In(OPEN_STATUSES),
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (!current) {
        current = await repository.save(
          repository.create({
            customerUserId,
            area: context.area,
            status: ChatConversationStatus.OPEN_UNASSIGNED,
            assignedAgentId: null,
            channel: ChatChannel.WEB,
            sourceType: context.sourceType,
            sourceProductId: context.sourceProductId,
            sourcePath: context.sourcePath,
            lastSequence: 0,
            customerLastReadSequence: 0,
            agentLastReadSequence: 0,
            lastMessageAt: new Date(),
            closedAt: null,
          }),
        );
        if (this.hasContext(context)) {
          await this.appendContext(manager, current, context);
        }
        return repository.findOneOrFail({
          where: { id: current.id },
          relations: { assignedAgent: true },
        });
      }

      if (this.contextChanged(current, context)) {
        current.sourceType = context.sourceType;
        current.sourceProductId = context.sourceProductId;
        current.sourcePath = context.sourcePath;
        await this.appendContext(manager, current, context);
      }
      return repository.findOneOrFail({
        where: { id: current.id },
        relations: { assignedAgent: true },
      });
    });
    return this.customerConversationResponse(conversation);
  }

  async listCustomerConversations(customerUserId: string) {
    const conversations = await this.conversations.find({
      where: { customerUserId },
      relations: { assignedAgent: true },
      order: { lastMessageAt: 'DESC', id: 'DESC' },
    });
    return {
      items: await Promise.all(
        conversations.map(async (conversation) => ({
          ...this.customerConversationResponse(conversation),
          unreadCount: await this.customerUnreadForConversation(conversation),
        })),
      ),
    };
  }

  async getCustomerMessages(
    customerUserId: string,
    conversationId: string,
    query: ChatMessagesQueryDto,
  ) {
    await this.requireCustomerConversation(customerUserId, conversationId);
    return this.messagePage(conversationId, query);
  }

  async sendCustomerMessage(
    customerUserId: string,
    conversationId: string,
    dto: SendChatMessageDto,
  ) {
    const text = this.validText(dto.text);
    const result = await this.dataSource.transaction(async (manager) => {
      const conversation = await this.lockConversation(manager, conversationId);
      if (conversation.customerUserId !== customerUserId) {
        throw new NotFoundException('Conversation not found');
      }
      if (conversation.status === ChatConversationStatus.CLOSED) {
        throw new ConflictException('Conversation is closed');
      }
      const existing = await manager.getRepository(ChatMessage).findOne({
        where: {
          conversationId,
          senderType: ChatMessageSenderType.CUSTOMER,
          clientMessageId: dto.clientMessageId,
        },
      });
      if (existing) return { message: existing, conversation, duplicate: true };
      const message = await this.appendText(
        manager,
        conversation,
        ChatMessageSenderType.CUSTOMER,
        text,
        dto.clientMessageId,
        customerUserId,
        null,
      );
      return { message, conversation, duplicate: false };
    });

    if (!result.duplicate) {
      await this.notifyCustomerMessage(result.conversation).catch(() => {
        this.logger.warn(
          'Chat push dispatch failed after customer message commit',
        );
      });
    }
    return {
      item: this.messageResponse(result.message),
      duplicate: result.duplicate,
    };
  }

  async markCustomerRead(
    customerUserId: string,
    conversationId: string,
    dto: MarkChatReadDto,
  ) {
    const conversation = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockConversation(manager, conversationId);
      if (locked.customerUserId !== customerUserId) {
        throw new NotFoundException('Conversation not found');
      }
      const target = Math.min(
        dto.sequence ?? locked.lastSequence,
        locked.lastSequence,
      );
      locked.customerLastReadSequence = Math.max(
        locked.customerLastReadSequence,
        target,
      );
      return manager.getRepository(ChatConversation).save(locked);
    });
    return {
      readThroughSequence: conversation.customerLastReadSequence,
      unreadCount: await this.customerUnreadForConversation(conversation),
    };
  }

  async getCustomerUnreadCount(customerUserId: string) {
    const result = await this.messages
      .createQueryBuilder('message')
      .innerJoin(
        ChatConversation,
        'conversation',
        'conversation.id = message.conversationId',
      )
      .where('conversation.customerUserId = :customerUserId', {
        customerUserId,
      })
      .andWhere('message.senderType = :senderType', {
        senderType: ChatMessageSenderType.AGENT,
      })
      .andWhere('message.sequence > conversation.customerLastReadSequence')
      .getCount();
    return { unreadCount: result };
  }

  async listAgentQueue(agentId: string, scope: SalesAgentScope) {
    await this.requireActiveAgent(agentId, scope);
    const items = await this.conversations.find({
      where: {
        area: scope,
        status: ChatConversationStatus.OPEN_UNASSIGNED,
        assignedAgentId: IsNull(),
      },
      order: { lastMessageAt: 'ASC', id: 'ASC' },
      take: 100,
    });
    return {
      items: items.map((conversation) =>
        this.queueConversationResponse(conversation),
      ),
    };
  }

  async listAgentConversations(agentId: string, scope: SalesAgentScope) {
    await this.requireActiveAgent(agentId, scope);
    const items = await this.conversations.find({
      where: {
        assignedAgentId: agentId,
        status: In([
          ChatConversationStatus.OPEN_ASSIGNED,
          ChatConversationStatus.CLOSED,
        ]),
      },
      relations: { customer: true },
      order: { lastMessageAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    return {
      items: await Promise.all(
        items.map(async (conversation) => ({
          ...this.agentConversationResponse(conversation),
          unreadCount: await this.agentUnreadForConversation(conversation),
        })),
      ),
    };
  }

  async claimConversation(
    agentId: string,
    scope: SalesAgentScope,
    conversationId: string,
  ) {
    await this.requireActiveAgent(agentId, scope);
    const claimed = await this.dataSource.transaction(async (manager) => {
      const update = await manager
        .createQueryBuilder()
        .update(ChatConversation)
        .set({
          assignedAgentId: agentId,
          status: ChatConversationStatus.OPEN_ASSIGNED,
          agentLastReadSequence: 0,
        })
        .where('id = :conversationId', { conversationId })
        .andWhere('area = :scope', { scope })
        .andWhere('status = :status', {
          status: ChatConversationStatus.OPEN_UNASSIGNED,
        })
        .andWhere('"assignedAgentId" IS NULL')
        .returning(['id'])
        .execute();

      if (!update.affected) {
        const actual = await manager.getRepository(ChatConversation).findOne({
          where: { id: conversationId },
          select: { id: true, area: true, status: true, assignedAgentId: true },
        });
        if (!actual) throw new NotFoundException('Conversation not found');
        if (actual.area !== scope) {
          throw new ForbiddenException(
            'Conversation belongs to another sales area',
          );
        }
        throw new ConflictException(
          'Conversation is no longer available to claim',
        );
      }

      await manager.getRepository(ConversationAssignment).save(
        manager.getRepository(ConversationAssignment).create({
          conversationId,
          fromAgentId: null,
          toAgentId: agentId,
          actorType: ConversationAssignmentActorType.AGENT_CLAIM,
          actorAgentId: agentId,
          actorAdminUsername: null,
        }),
      );
      return manager.getRepository(ChatConversation).findOneOrFail({
        where: { id: conversationId },
        relations: { customer: true, assignedAgent: true },
      });
    });
    return this.agentConversationResponse(claimed);
  }

  async getAgentMessages(
    agentId: string,
    scope: SalesAgentScope,
    conversationId: string,
    query: ChatMessagesQueryDto,
  ) {
    await this.requireAssignedConversation(agentId, scope, conversationId);
    return this.messagePage(conversationId, query);
  }

  async sendAgentMessage(
    agentId: string,
    scope: SalesAgentScope,
    conversationId: string,
    dto: SendChatMessageDto,
  ) {
    const text = this.validText(dto.text);
    const result = await this.dataSource.transaction(async (manager) => {
      const conversation = await this.lockConversation(manager, conversationId);
      this.assertAssigned(conversation, agentId, scope);
      if (conversation.status === ChatConversationStatus.CLOSED) {
        throw new ConflictException('Conversation is closed');
      }
      const existing = await manager.getRepository(ChatMessage).findOne({
        where: {
          conversationId,
          senderType: ChatMessageSenderType.AGENT,
          clientMessageId: dto.clientMessageId,
        },
      });
      if (existing) return { message: existing, conversation, duplicate: true };
      const message = await this.appendText(
        manager,
        conversation,
        ChatMessageSenderType.AGENT,
        text,
        dto.clientMessageId,
        null,
        agentId,
      );
      return { message, conversation, duplicate: false };
    });
    if (!result.duplicate) {
      await this.push
        .notifyCustomer(result.conversation.customerUserId, conversationId)
        .catch(() => {
          this.logger.warn(
            'Chat push dispatch failed after agent message commit',
          );
        });
    }
    return {
      item: this.messageResponse(result.message),
      duplicate: result.duplicate,
    };
  }

  async markAgentRead(
    agentId: string,
    scope: SalesAgentScope,
    conversationId: string,
    dto: MarkChatReadDto,
  ) {
    const conversation = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockConversation(manager, conversationId);
      this.assertAssigned(locked, agentId, scope);
      const target = Math.min(
        dto.sequence ?? locked.lastSequence,
        locked.lastSequence,
      );
      locked.agentLastReadSequence = Math.max(
        locked.agentLastReadSequence,
        target,
      );
      return manager.getRepository(ChatConversation).save(locked);
    });
    return {
      readThroughSequence: conversation.agentLastReadSequence,
      unreadCount: await this.agentUnreadForConversation(conversation),
    };
  }

  async getAgentUnreadCount(agentId: string, scope: SalesAgentScope) {
    await this.requireActiveAgent(agentId, scope);
    const unreadCount = await this.messages
      .createQueryBuilder('message')
      .innerJoin(
        ChatConversation,
        'conversation',
        'conversation.id = message.conversationId',
      )
      .where('conversation.assignedAgentId = :agentId', { agentId })
      .andWhere('conversation.area = :scope', { scope })
      .andWhere('conversation.status = :status', {
        status: ChatConversationStatus.OPEN_ASSIGNED,
      })
      .andWhere('message.senderType = :senderType', {
        senderType: ChatMessageSenderType.CUSTOMER,
      })
      .andWhere('message.sequence > conversation.agentLastReadSequence')
      .getCount();
    return { unreadCount };
  }

  async closeAgentConversation(
    agentId: string,
    scope: SalesAgentScope,
    conversationId: string,
  ) {
    const conversation = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockConversation(manager, conversationId);
      this.assertAssigned(locked, agentId, scope);
      if (locked.status !== ChatConversationStatus.CLOSED) {
        locked.status = ChatConversationStatus.CLOSED;
        locked.closedAt = new Date();
        await manager.getRepository(ChatConversation).save(locked);
      }
      return manager.getRepository(ChatConversation).findOneOrFail({
        where: { id: conversationId },
        relations: { customer: true, assignedAgent: true },
      });
    });
    return this.agentConversationResponse(conversation);
  }

  async listSupervisorConversations(query: SalesChatSupervisorQueryDto) {
    const builder = this.conversations
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.customer', 'customer')
      .leftJoinAndSelect('conversation.assignedAgent', 'assignedAgent');
    if (query.area)
      builder.andWhere('conversation.area = :area', { area: query.area });
    if (query.status) {
      builder.andWhere('conversation.status = :status', {
        status: query.status,
      });
    }
    if (query.agentId) {
      builder.andWhere('conversation.assignedAgentId = :agentId', {
        agentId: query.agentId,
      });
    }
    builder
      .orderBy('conversation.lastMessageAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    const [items, total] = await builder.getManyAndCount();
    return {
      items: items.map((conversation) =>
        this.supervisorConversationResponse(conversation),
      ),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getSupervisorMessages(
    conversationId: string,
    query: ChatMessagesQueryDto,
  ) {
    await this.requireConversation(conversationId);
    return this.messagePage(conversationId, query);
  }

  async reassignConversation(
    conversationId: string,
    targetAgentId: string,
    supervisorUsername: string,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const conversation = await this.lockConversation(manager, conversationId);
      if (conversation.status === ChatConversationStatus.CLOSED) {
        throw new ConflictException(
          'Closed conversation must be reopened first',
        );
      }
      const target = await manager.getRepository(SalesAgent).findOne({
        where: { id: targetAgentId, active: true },
      });
      if (!target) throw new NotFoundException('Sales agent not found');
      if (target.scope !== conversation.area) {
        throw new BadRequestException(
          'Sales agent belongs to another sales area',
        );
      }
      const fromAgentId = conversation.assignedAgentId;
      conversation.assignedAgentId = target.id;
      conversation.status = ChatConversationStatus.OPEN_ASSIGNED;
      conversation.agentLastReadSequence = 0;
      await manager.getRepository(ChatConversation).save(conversation);
      await manager.getRepository(ConversationAssignment).save(
        manager.getRepository(ConversationAssignment).create({
          conversationId,
          fromAgentId,
          toAgentId: target.id,
          actorType: ConversationAssignmentActorType.SUPERVISOR_REASSIGN,
          actorAgentId: null,
          actorAdminUsername: supervisorUsername,
        }),
      );
      return manager.getRepository(ChatConversation).findOneOrFail({
        where: { id: conversationId },
        relations: { customer: true, assignedAgent: true },
      });
    });
    return this.supervisorConversationResponse(result);
  }

  async closeSupervisorConversation(conversationId: string) {
    const conversation = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockConversation(manager, conversationId);
      if (locked.status !== ChatConversationStatus.CLOSED) {
        locked.status = ChatConversationStatus.CLOSED;
        locked.closedAt = new Date();
        await manager.getRepository(ChatConversation).save(locked);
      }
      return manager.getRepository(ChatConversation).findOneOrFail({
        where: { id: conversationId },
        relations: { customer: true, assignedAgent: true },
      });
    });
    return this.supervisorConversationResponse(conversation);
  }

  async reopenSupervisorConversation(conversationId: string) {
    const conversation = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockConversation(manager, conversationId);
      if (locked.status !== ChatConversationStatus.CLOSED) {
        throw new ConflictException('Conversation is already open');
      }
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `sales-chat-open:${locked.customerUserId}:${locked.area}`,
      ]);
      const other = await manager.getRepository(ChatConversation).findOne({
        where: {
          customerUserId: locked.customerUserId,
          area: locked.area,
          status: In(OPEN_STATUSES),
        },
        select: { id: true },
      });
      if (other) {
        throw new ConflictException(
          'Another conversation is already open for this area',
        );
      }
      if (locked.assignedAgentId) {
        const assignedAgent = await manager.getRepository(SalesAgent).findOne({
          where: { id: locked.assignedAgentId, active: true },
          select: { id: true },
        });
        if (!assignedAgent) locked.assignedAgentId = null;
      }
      locked.status = locked.assignedAgentId
        ? ChatConversationStatus.OPEN_ASSIGNED
        : ChatConversationStatus.OPEN_UNASSIGNED;
      locked.closedAt = null;
      await manager.getRepository(ChatConversation).save(locked);
      return manager.getRepository(ChatConversation).findOneOrFail({
        where: { id: conversationId },
        relations: { customer: true, assignedAgent: true },
      });
    });
    return this.supervisorConversationResponse(conversation);
  }

  async listActiveAgents() {
    const items = await this.agents.find({
      where: { active: true },
      order: { scope: 'ASC', username: 'ASC' },
    });
    return {
      items: items.map(({ id, username, displayName, scope, active }) => ({
        id,
        username,
        displayName,
        scope,
        active,
      })),
    };
  }

  private async appendContext(
    manager: EntityManager,
    conversation: ChatConversation,
    context: ResolvedChatContext,
  ): Promise<ChatMessage> {
    conversation.lastSequence += 1;
    conversation.lastMessageAt = new Date();
    conversation.lastMessagePreview = 'Context updated';
    conversation.sourceType = context.sourceType;
    conversation.sourceProductId = context.sourceProductId;
    conversation.sourcePath = context.sourcePath;
    await manager.getRepository(ChatConversation).save(conversation);
    return manager.getRepository(ChatMessage).save(
      manager.getRepository(ChatMessage).create({
        conversationId: conversation.id,
        senderType: ChatMessageSenderType.SYSTEM,
        senderUserId: null,
        senderAgentId: null,
        type: ChatMessageType.CONTEXT,
        text: null,
        sequence: conversation.lastSequence,
        clientMessageId: null,
        contextProductId: context.sourceProductId,
        contextSourcePath: context.sourcePath,
      }),
    );
  }

  private async appendText(
    manager: EntityManager,
    conversation: ChatConversation,
    senderType: ChatMessageSenderType.CUSTOMER | ChatMessageSenderType.AGENT,
    text: string,
    clientMessageId: string,
    senderUserId: string | null,
    senderAgentId: string | null,
  ): Promise<ChatMessage> {
    conversation.lastSequence += 1;
    conversation.lastMessageAt = new Date();
    conversation.lastMessagePreview = text.slice(0, 200);
    await manager.getRepository(ChatConversation).save(conversation);
    return manager.getRepository(ChatMessage).save(
      manager.getRepository(ChatMessage).create({
        conversationId: conversation.id,
        senderType,
        senderUserId,
        senderAgentId,
        type: ChatMessageType.TEXT,
        text,
        sequence: conversation.lastSequence,
        clientMessageId,
        contextProductId: null,
        contextSourcePath: null,
      }),
    );
  }

  private async messagePage(
    conversationId: string,
    query: ChatMessagesQueryDto,
  ) {
    const rows = await this.messages.find({
      where: {
        conversationId,
        sequence: MoreThan(query.afterSequence),
      },
      order: { sequence: 'ASC', id: 'ASC' },
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: page.map((message) => this.messageResponse(message)),
      nextCursor: page.at(-1)?.sequence ?? query.afterSequence,
      hasMore,
    };
  }

  private async lockConversation(
    manager: EntityManager,
    id: string,
  ): Promise<ChatConversation> {
    const conversation = await manager.getRepository(ChatConversation).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private async requireConversation(id: string) {
    const conversation = await this.conversations.findOne({ where: { id } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private async requireCustomerConversation(userId: string, id: string) {
    const conversation = await this.conversations.findOne({
      where: { id, customerUserId: userId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private async requireAssignedConversation(
    agentId: string,
    scope: SalesAgentScope,
    id: string,
  ) {
    await this.requireActiveAgent(agentId, scope);
    const conversation = await this.conversations.findOne({ where: { id } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertAssigned(conversation, agentId, scope);
    return conversation;
  }

  private async requireActiveAgent(agentId: string, scope: SalesAgentScope) {
    const agent = await this.agents.findOne({
      where: { id: agentId, scope, active: true },
      select: { id: true },
    });
    if (!agent)
      throw new ForbiddenException('Sales agent access is unavailable');
  }

  private assertAssigned(
    conversation: ChatConversation,
    agentId: string,
    scope: SalesAgentScope,
  ): void {
    if (
      conversation.area !== scope ||
      conversation.assignedAgentId !== agentId
    ) {
      throw new ForbiddenException(
        'Conversation is not assigned to this sales agent',
      );
    }
  }

  private validText(value: string): string {
    const text = value.trim();
    if (!text || text.length > CHAT_TEXT_MAX_LENGTH) {
      throw new BadRequestException(
        `Message text must contain 1 to ${CHAT_TEXT_MAX_LENGTH} characters`,
      );
    }
    if (HTML_TAG_PATTERN.test(text)) {
      throw new BadRequestException('HTML is not allowed in chat messages');
    }
    return text;
  }

  private hasContext(context: ResolvedChatContext): boolean {
    return Boolean(
      context.sourceType || context.sourceProductId || context.sourcePath,
    );
  }

  private contextChanged(
    conversation: ChatConversation,
    context: ResolvedChatContext,
  ): boolean {
    if (!this.hasContext(context)) return false;
    return (
      conversation.sourceType !== context.sourceType ||
      conversation.sourceProductId !== context.sourceProductId ||
      conversation.sourcePath !== context.sourcePath
    );
  }

  private async notifyCustomerMessage(conversation: ChatConversation) {
    if (
      conversation.status === ChatConversationStatus.OPEN_ASSIGNED &&
      conversation.assignedAgentId
    ) {
      const assignedAgent = await this.agents.findOne({
        where: {
          id: conversation.assignedAgentId,
          active: true,
          scope: conversation.area,
        },
        select: { id: true },
      });
      if (!assignedAgent) {
        this.logger.warn(
          'Chat push skipped count=1 reason=assigned-agent-unavailable',
        );
        return;
      }
      await this.push.notifyAssignedAgent(
        conversation.assignedAgentId,
        conversation.id,
      );
      return;
    }
    await this.push.notifyAreaAgents(conversation.area, conversation.id);
  }

  private customerConversationResponse(conversation: ChatConversation) {
    return {
      id: conversation.id,
      area: conversation.area,
      status: conversation.status,
      channel: conversation.channel,
      assignedAgent: conversation.assignedAgent
        ? {
            id: conversation.assignedAgent.id,
            displayName: conversation.assignedAgent.displayName,
          }
        : null,
      sourceType: conversation.sourceType,
      sourceProductId: conversation.sourceProductId,
      sourcePath: conversation.sourcePath,
      lastMessageAt: conversation.lastMessageAt,
      lastSequence: conversation.lastSequence,
      customerLastReadSequence: conversation.customerLastReadSequence,
      createdAt: conversation.createdAt,
      closedAt: conversation.closedAt,
    };
  }

  private queueConversationResponse(conversation: ChatConversation) {
    return {
      id: conversation.id,
      area: conversation.area,
      status: conversation.status,
      sourceType: conversation.sourceType,
      sourceProductId: conversation.sourceProductId,
      lastMessageAt: conversation.lastMessageAt,
      createdAt: conversation.createdAt,
    };
  }

  private agentConversationResponse(conversation: ChatConversation) {
    return {
      id: conversation.id,
      area: conversation.area,
      status: conversation.status,
      customer: conversation.customer
        ? {
            id: conversation.customer.id,
            firstName: conversation.customer.firstName,
            lastName: conversation.customer.lastName,
            phone: conversation.customer.phone,
          }
        : undefined,
      sourceType: conversation.sourceType,
      sourceProductId: conversation.sourceProductId,
      sourcePath: conversation.sourcePath,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      lastSequence: conversation.lastSequence,
      agentLastReadSequence: conversation.agentLastReadSequence,
      closedAt: conversation.closedAt,
    };
  }

  private supervisorConversationResponse(conversation: ChatConversation) {
    return {
      ...this.agentConversationResponse(conversation),
      assignedAgent: conversation.assignedAgent
        ? {
            id: conversation.assignedAgent.id,
            username: conversation.assignedAgent.username,
            displayName: conversation.assignedAgent.displayName,
            scope: conversation.assignedAgent.scope,
          }
        : null,
    };
  }

  private messageResponse(message: ChatMessage) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderType: message.senderType,
      type: message.type,
      text: message.text,
      sequence: message.sequence,
      context:
        message.type === ChatMessageType.CONTEXT
          ? {
              productId: message.contextProductId,
              sourcePath: message.contextSourcePath,
            }
          : null,
      createdAt: message.createdAt,
    };
  }

  private customerUnreadForConversation(conversation: ChatConversation) {
    return this.messages.count({
      where: {
        conversationId: conversation.id,
        senderType: ChatMessageSenderType.AGENT,
        sequence: MoreThan(conversation.customerLastReadSequence),
      },
    });
  }

  private agentUnreadForConversation(conversation: ChatConversation) {
    return this.messages.count({
      where: {
        conversationId: conversation.id,
        senderType: ChatMessageSenderType.CUSTOMER,
        sequence: MoreThan(conversation.agentLastReadSequence),
      },
    });
  }
}
