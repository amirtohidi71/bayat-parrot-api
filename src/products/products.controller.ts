import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductReviewDto } from './dto/create-product-review.dto';
import { FindProductsDto } from './dto/find-products.dto';
import { SearchProductsDto } from './dto/search-products.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { ProductReviewVideosService } from './product-review-videos.service';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productReviewVideos: ProductReviewVideosService,
  ) {}

  @Get('search')
  search(@Query() searchDto: SearchProductsDto) {
    return this.productsService.searchPublished(searchDto);
  }

  @Get()
  findAll(@Query() filterDto: FindProductsDto) {
    return this.productsService.findAllPublished(filterDto);
  }

  @Post(':productId/reviews')
  @UseGuards(JwtAuthGuard)
  submitReview(
    @Param('productId') productId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() createReviewDto: CreateProductReviewDto,
  ) {
    return this.productsService.submitReview(productId, user.id, createReviewDto);
  }

  @Get(':productId/reviews')
  findApprovedReviews(@Param('productId') productId: string) {
    return this.productsService.findApprovedReviews(productId);
  }

  @Get(':productId/review-videos')
  findReviewVideos(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ) {
    return this.productReviewVideos.findPublic(productId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOnePublished(id);
  }
}
