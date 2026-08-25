import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { Product } from '../products/entities/product.entity';
import { AgentSalesChatController } from './agent-sales-chat.controller';
import { ChatPushService, defaultChatWebPushClient } from './chat-push.service';
import { CustomerSalesChatController } from './customer-sales-chat.controller';
import { ChatConversation } from './entities/chat-conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { ChatPushSubscription } from './entities/chat-push-subscription.entity';
import { ConversationAssignment } from './entities/conversation-assignment.entity';
import { SalesAgent } from './entities/sales-agent.entity';
import { SalesAgentAuthGuard } from './guards/sales-agent-auth.guard';
import { SalesChatSupervisorGuard } from './guards/sales-chat-supervisor.guard';
import { SalesChatThrottlerGuard } from './guards/sales-chat-throttler.guard';
import { SalesChatAuthService } from './sales-chat-auth.service';
import {
  CHAT_WEB_PUSH_CLIENT,
  SALES_CHAT_AGENT_JWT,
} from './sales-chat.constants';
import { SalesChatProductRoutingService } from './sales-chat-product-routing.service';
import { SalesChatService } from './sales-chat.service';
import { SupervisorSalesChatController } from './supervisor-sales-chat.controller';
import { createSalesChatJwtService } from './sales-chat-jwt.factory';

@Module({
  imports: [
    AdminModule,
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 15 * 60 * 1000, limit: 240 },
    ]),
    TypeOrmModule.forFeature([
      SalesAgent,
      ChatConversation,
      ChatMessage,
      ConversationAssignment,
      ChatPushSubscription,
      Product,
    ]),
  ],
  controllers: [
    CustomerSalesChatController,
    AgentSalesChatController,
    SupervisorSalesChatController,
  ],
  providers: [
    {
      provide: SALES_CHAT_AGENT_JWT,
      inject: [ConfigService],
      useFactory: createSalesChatJwtService,
    },
    {
      provide: CHAT_WEB_PUSH_CLIENT,
      useValue: defaultChatWebPushClient,
    },
    SalesChatAuthService,
    SalesChatService,
    SalesChatProductRoutingService,
    ChatPushService,
    SalesAgentAuthGuard,
    SalesChatSupervisorGuard,
    SalesChatThrottlerGuard,
  ],
})
export class SalesChatModule {}
