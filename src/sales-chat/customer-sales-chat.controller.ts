import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatPushService } from './chat-push.service';
import { ChatMessagesQueryDto } from './dto/chat-messages-query.dto';
import {
  SubscribeChatPushDto,
  UnsubscribeChatPushDto,
} from './dto/chat-push-subscription.dto';
import { MarkChatReadDto } from './dto/mark-chat-read.dto';
import { OpenChatConversationDto } from './dto/open-chat-conversation.dto';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SalesChatThrottlerGuard } from './guards/sales-chat-throttler.guard';
import { SalesChatService } from './sales-chat.service';

const uuidV4Pipe = new ParseUUIDPipe({ version: '4' });

@Controller('sales-chat/customer')
@UseGuards(JwtAuthGuard, SalesChatThrottlerGuard)
@Throttle({ default: { limit: 240, ttl: 15 * 60 * 1000 } })
export class CustomerSalesChatController {
  constructor(
    private readonly chat: SalesChatService,
    private readonly push: ChatPushService,
  ) {}

  @Post('conversations')
  @Throttle({ default: { limit: 20, ttl: 15 * 60 * 1000 } })
  openConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenChatConversationDto,
  ) {
    return this.chat.openCustomerConversation(user.id, dto);
  }

  @Get('conversations')
  listConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.listCustomerConversations(user.id);
  }

  @Get('conversations/unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.getCustomerUnreadCount(user.id);
  }

  @Get('conversations/:conversationId/messages')
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Query() query: ChatMessagesQueryDto,
  ) {
    return this.chat.getCustomerMessages(user.id, conversationId, query);
  }

  @Post('conversations/:conversationId/messages')
  @Throttle({ default: { limit: 60, ttl: 60 * 1000 } })
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    return this.chat.sendCustomerMessage(user.id, conversationId, dto);
  }

  @Post('conversations/:conversationId/read')
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', uuidV4Pipe) conversationId: string,
    @Body() dto: MarkChatReadDto,
  ) {
    return this.chat.markCustomerRead(user.id, conversationId, dto);
  }

  @Get('push-config')
  pushConfig() {
    return this.push.getPublicConfig();
  }

  @Post('push-subscriptions')
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribeChatPushDto,
  ) {
    return this.push.subscribeCustomer(user.id, dto);
  }

  @Delete('push-subscriptions')
  unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnsubscribeChatPushDto,
  ) {
    return this.push.unsubscribeCustomer(user.id, dto);
  }
}
