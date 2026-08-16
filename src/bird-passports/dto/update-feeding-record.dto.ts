import { PartialType } from '@nestjs/swagger';
import { CreateFeedingRecordDto } from './create-feeding-record.dto';

export class UpdateFeedingRecordDto extends PartialType(
  CreateFeedingRecordDto,
) {}
