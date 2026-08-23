import {
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
  BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
} from '../bird-passport-metadata';
import { BirdPassportGender } from '../entities/bird-passport.entity';

export class CreateBirdPassportDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'ownerFullName must contain a non-whitespace character',
  })
  @MaxLength(BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH)
  ownerFullName: string;

  @IsString()
  @IsNotEmpty()
  ownerMobile: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'birdName must contain a non-whitespace character',
  })
  @MaxLength(BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH)
  birdName: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'birthDate must use YYYY-MM-DD format',
  })
  birthDate: string;

  @IsEnum(BirdPassportGender)
  gender: BirdPassportGender;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'species must contain a non-whitespace character' })
  species: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'subspecies must contain a non-whitespace character',
  })
  subspecies: string;
}
