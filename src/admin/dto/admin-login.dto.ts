import { IsNotEmpty, IsString } from 'class-validator';

export class AdminLoginDto {
  @IsNotEmpty()
  @IsString()
  username: string;

  @IsNotEmpty()
  @IsString()
  password: string;
}
