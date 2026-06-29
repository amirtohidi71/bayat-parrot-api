import { IsNotEmpty, IsString } from 'class-validator';

export class CompleteRegistrationDto {
  @IsNotEmpty()
  @IsString()
  firstName: string;

  @IsNotEmpty()
  @IsString()
  lastName: string;
}
