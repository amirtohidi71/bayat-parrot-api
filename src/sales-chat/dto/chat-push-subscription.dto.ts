import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ChatPushSubscriptionKeysDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  p256dh: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  auth: string;
}

export class SubscribeChatPushDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  endpoint: string;

  @ValidateNested()
  @Type(() => ChatPushSubscriptionKeysDto)
  keys: ChatPushSubscriptionKeysDto;
}

export class UnsubscribeChatPushDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  endpoint: string;
}
