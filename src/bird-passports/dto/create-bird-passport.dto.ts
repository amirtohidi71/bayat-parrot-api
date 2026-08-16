import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateBirdPassportDto {
  @IsString()
  @IsNotEmpty()
  ownerMobile: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'birthDate must use YYYY-MM-DD format',
  })
  birthDate: string;

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
