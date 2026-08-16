import { PartialType } from '@nestjs/swagger';
import { CreateVaccineRecordDto } from './create-vaccine-record.dto';

export class UpdateVaccineRecordDto extends PartialType(
  CreateVaccineRecordDto,
) {}
