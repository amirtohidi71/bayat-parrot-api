import { PartialType } from '@nestjs/swagger';
import { CreateVeterinaryVisitDto } from './create-veterinary-visit.dto';

export class UpdateVeterinaryVisitDto extends PartialType(
  CreateVeterinaryVisitDto,
) {}
