import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class MarkChatReadDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sequence?: number;
}
