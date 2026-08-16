import { IsNotEmpty, IsString } from 'class-validator';

export class CreateFeedingRecordDto {
  @IsString()
  @IsNotEmpty()
  ageRange: string;

  @IsString()
  @IsNotEmpty()
  description: string;
}
