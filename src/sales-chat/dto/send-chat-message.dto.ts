import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CHAT_TEXT_MAX_LENGTH } from '../sales-chat.constants';

export class SendChatMessageDto {
  @IsUUID('4')
  clientMessageId: string;

  @Transform(({ value }: TransformFnParams): unknown => {
    const candidate: unknown = value;
    return typeof candidate === 'string' ? candidate.trim() : candidate;
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_TEXT_MAX_LENGTH)
  text: string;
}
