import { PartialType } from '@nestjs/swagger';
import { CreateBirdPassportDto } from './create-bird-passport.dto';

export class UpdateBirdPassportDto extends PartialType(CreateBirdPassportDto) {}
