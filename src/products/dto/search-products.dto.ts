import { IsNotEmpty, IsString } from 'class-validator';
import { FindProductsDto } from './find-products.dto';

export class SearchProductsDto extends FindProductsDto {
  @IsNotEmpty()
  @IsString()
  q: string;
}
