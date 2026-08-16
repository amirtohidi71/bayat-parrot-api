import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateVaccineRecordDto {
  @IsString()
  @IsNotEmpty()
  vaccineName: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'vaccinationDate must use YYYY-MM-DD format',
  })
  vaccinationDate: string;
}
