import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SalesAgentLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;
}
