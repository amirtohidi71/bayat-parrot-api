import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CreateVeterinaryVisitDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'visitDate must use YYYY-MM-DD format',
  })
  visitDate: string;

  @IsString()
  @IsNotEmpty()
  clinicalNotes: string;

  @IsString()
  @IsNotEmpty()
  veterinaryActions: string;
}
