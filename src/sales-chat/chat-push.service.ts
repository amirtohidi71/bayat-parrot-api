import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { PushSubscription, RequestOptions, SendResult } from 'web-push';
import * as webPush from 'web-push';
import {
  SubscribeChatPushDto,
  UnsubscribeChatPushDto,
} from './dto/chat-push-subscription.dto';
import {
  ChatPushOwnerType,
  ChatPushSubscription,
} from './entities/chat-push-subscription.entity';
import { SalesAgent, SalesAgentScope } from './entities/sales-agent.entity';
import { CHAT_WEB_PUSH_CLIENT } from './sales-chat.constants';

export interface ChatWebPushClient {
  sendNotification(
    subscription: PushSubscription,
    payload: string,
    options: RequestOptions,
  ): Promise<SendResult>;
}

type PushPayload = {
  type: 'SALES_CHAT_MESSAGE';
  title: string;
  body: string;
  conversationId: string;
  path: string;
};

@Injectable()
export class ChatPushService {
  private readonly logger = new Logger(ChatPushService.name);
  private readonly enabled: boolean;
  private readonly vapid: RequestOptions['vapidDetails'];

  constructor(
    @InjectRepository(ChatPushSubscription)
    private readonly subscriptions: Repository<ChatPushSubscription>,
    @InjectRepository(SalesAgent)
    private readonly agents: Repository<SalesAgent>,
    private readonly config: ConfigService,
    @Inject(CHAT_WEB_PUSH_CLIENT)
    private readonly client: ChatWebPushClient,
  ) {
    this.enabled =
      this.config.get<string>('CHAT_PUSH_ENABLED')?.trim().toLowerCase() ===
      'true';
    if (!this.enabled) return;

    const subject = this.config.get<string>('VAPID_SUBJECT')?.trim();
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    if (!subject || !publicKey || !privateKey) {
      throw new Error(
        'Web Push is enabled but VAPID configuration is incomplete',
      );
    }
    try {
      webPush.getVapidHeaders(
        'https://push.example',
        subject,
        publicKey,
        privateKey,
        'aes128gcm',
      );
    } catch {
      throw new Error('Web Push is enabled but VAPID configuration is invalid');
    }
    this.vapid = { subject, publicKey, privateKey };
  }

  getPublicConfig() {
    return {
      enabled: this.enabled,
      vapidPublicKey: this.enabled ? this.vapid?.publicKey : null,
    };
  }

  subscribeCustomer(userId: string, dto: SubscribeChatPushDto) {
    return this.subscribe(ChatPushOwnerType.CUSTOMER, userId, dto);
  }

  subscribeAgent(agentId: string, dto: SubscribeChatPushDto) {
    return this.subscribe(ChatPushOwnerType.SALES_AGENT, agentId, dto);
  }

  unsubscribeCustomer(userId: string, dto: UnsubscribeChatPushDto) {
    return this.unsubscribe(ChatPushOwnerType.CUSTOMER, userId, dto.endpoint);
  }

  unsubscribeAgent(agentId: string, dto: UnsubscribeChatPushDto) {
    return this.unsubscribe(
      ChatPushOwnerType.SALES_AGENT,
      agentId,
      dto.endpoint,
    );
  }

  async notifyCustomer(
    customerUserId: string,
    conversationId: string,
  ): Promise<void> {
    const subscriptions = await this.subscriptions.find({
      where: { ownerType: ChatPushOwnerType.CUSTOMER, customerUserId },
    });
    await this.deliver(subscriptions, {
      type: 'SALES_CHAT_MESSAGE',
      title: 'پیام جدید از مشاور فروش',
      body: 'یک پیام جدید در گفت‌وگوی فروش دارید.',
      conversationId,
      path: `/account/chat/${conversationId}`,
    });
  }

  async notifyAssignedAgent(
    agentId: string,
    conversationId: string,
  ): Promise<void> {
    const subscriptions = await this.subscriptions.find({
      where: {
        ownerType: ChatPushOwnerType.SALES_AGENT,
        salesAgentId: agentId,
      },
    });
    await this.deliver(subscriptions, this.salesPayload(conversationId));
  }

  async notifyAreaAgents(
    area: SalesAgentScope,
    conversationId: string,
  ): Promise<void> {
    const agents = await this.agents.find({
      where: { scope: area, active: true },
      select: { id: true },
    });
    if (!agents.length) return;
    const subscriptions = await this.subscriptions.find({
      where: {
        ownerType: ChatPushOwnerType.SALES_AGENT,
        salesAgentId: In(agents.map((agent) => agent.id)),
      },
    });
    await this.deliver(subscriptions, this.salesPayload(conversationId));
  }

  private salesPayload(conversationId: string): PushPayload {
    return {
      type: 'SALES_CHAT_MESSAGE',
      title: 'پیام جدید مشتری',
      body: 'یک پیام جدید در صف گفت‌وگوی فروش دارید.',
      conversationId,
      path: `/sales-panel/conversations/${conversationId}`,
    };
  }

  private async subscribe(
    ownerType: ChatPushOwnerType,
    ownerId: string,
    dto: SubscribeChatPushDto,
  ) {
    this.requireEnabled();
    const existing = await this.subscriptions.findOne({
      where: { endpoint: dto.endpoint },
    });
    const owned =
      existing &&
      existing.ownerType === ownerType &&
      (ownerType === ChatPushOwnerType.CUSTOMER
        ? existing.customerUserId === ownerId
        : existing.salesAgentId === ownerId);
    if (existing && !owned) {
      throw new ConflictException('Push subscription is already registered');
    }
    const subscription =
      existing ??
      this.subscriptions.create({
        ownerType,
        customerUserId:
          ownerType === ChatPushOwnerType.CUSTOMER ? ownerId : null,
        salesAgentId:
          ownerType === ChatPushOwnerType.SALES_AGENT ? ownerId : null,
        endpoint: dto.endpoint,
      });
    subscription.p256dh = dto.keys.p256dh;
    subscription.auth = dto.keys.auth;
    await this.subscriptions.save(subscription);
    return { success: true as const };
  }

  private async unsubscribe(
    ownerType: ChatPushOwnerType,
    ownerId: string,
    endpoint: string,
  ) {
    const where =
      ownerType === ChatPushOwnerType.CUSTOMER
        ? { ownerType, customerUserId: ownerId, endpoint }
        : { ownerType, salesAgentId: ownerId, endpoint };
    await this.subscriptions.delete(where);
    return { success: true as const };
  }

  private async deliver(
    subscriptions: ChatPushSubscription[],
    payload: PushPayload,
  ): Promise<void> {
    if (!this.enabled || !subscriptions.length || !this.vapid) return;
    const results = await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        try {
          await this.client.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth,
              },
            },
            JSON.stringify(payload),
            {
              vapidDetails: this.vapid,
              TTL: 300,
              urgency: 'high',
              timeout: 10_000,
            },
          );
        } catch (error) {
          const statusCode = (error as { statusCode?: unknown })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await this.subscriptions.delete({ id: subscription.id });
            return;
          }
          throw error;
        }
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      this.logger.warn(
        `Chat push delivery failed count=${failures.length} total=${results.length}`,
      );
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Chat push is not configured');
    }
  }
}

export const defaultChatWebPushClient: ChatWebPushClient = {
  sendNotification: (subscription, payload, options) =>
    webPush.sendNotification(subscription, payload, options),
};
