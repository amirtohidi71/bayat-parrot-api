import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminService } from './admin.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { UpdateOrderStatusDto } from '../orders/dto/update-order-status.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { ProductStatus } from '../products/entities/product.entity';
import { UpdateProductReviewStatusDto } from '../products/dto/update-product-review-status.dto';
import { AdminAuthGuard, AdminTokenPayload } from './guards/admin-auth.guard';
import { productImageUploadOptions } from './config/product-image-upload.config';
import { ProductReviewVideosService } from '../products/product-review-videos.service';
import { ReorderProductReviewVideosDto } from '../products/dto/reorder-product-review-videos.dto';
import type { ProductReviewVideoUploadFiles } from '../products/media/product-review-video-storage.service';
import { ProductReviewVideoUploadInterceptor } from '../products/media/product-review-video-upload.interceptor';

type AdminRequest = Request & { admin?: AdminTokenPayload };

@Controller('admin-panel')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly productReviewVideos: ProductReviewVideosService,
  ) {}

  @Post('login')
  login(@Body() adminLoginDto: AdminLoginDto) {
    return this.adminService.login(adminLoginDto);
  }

  @Get('orders')
  @UseGuards(AdminAuthGuard)
  getOrders() {
    return this.adminService.getOrders();
  }

  @Get('dashboard')
  @UseGuards(AdminAuthGuard)
  getDashboardSummary() {
    return this.adminService.getDashboardSummary();
  }

  @Patch('orders/:id/status')
  @UseGuards(AdminAuthGuard)
  updateOrderStatus(@Param('id') id: string, @Body() updateOrderStatusDto: UpdateOrderStatusDto) {
    return this.adminService.updateOrderStatus(id, updateOrderStatusDto);
  }

  @Get('sales')
  @UseGuards(AdminAuthGuard)
  getSalesReport() {
    return this.adminService.getSalesReport();
  }

  @Post('products')
  @UseGuards(AdminAuthGuard)
  createProduct(@Body() createProductDto: CreateProductDto, @Req() request: AdminRequest) {
    return this.adminService.createProduct(createProductDto, request.admin?.username);
  }

  @Get('products')
  @UseGuards(AdminAuthGuard)
  getProducts(@Query('status') status?: ProductStatus) {
    return this.adminService.getProducts(status);
  }

  @Get('products/pending')
  @UseGuards(AdminAuthGuard)
  getPendingProducts() {
    return this.adminService.getPendingProducts();
  }

  @Get('products/lookup/:identifier')
  @UseGuards(AdminAuthGuard)
  lookupProduct(@Param('identifier') identifier: string) {
    return this.adminService.lookupProduct(identifier);
  }

  @Get('products/:id')
  @UseGuards(AdminAuthGuard)
  getProduct(@Param('id') id: string) {
    return this.adminService.getProduct(id);
  }

  @Patch('products/:id')
  @UseGuards(AdminAuthGuard)
  updateProduct(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto, @Req() request: AdminRequest) {
    return this.adminService.updateProduct(id, updateProductDto, request.admin?.username);
  }

  @Delete('products/:id')
  @UseGuards(AdminAuthGuard)
  removeProduct(@Param('id') id: string) {
    return this.adminService.removeProduct(id);
  }

  @Post('products/:id/images')
  @UseGuards(AdminAuthGuard)
  @UseInterceptors(FileInterceptor('image', productImageUploadOptions))
  uploadProductImage(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.adminService.uploadProductImage(id, file);
  }

  @Get('products/:productId/review-videos')
  @UseGuards(AdminAuthGuard)
  getProductReviewVideos(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ) {
    return this.productReviewVideos.findForAdmin(productId);
  }

  @Post('products/:productId/review-videos')
  @UseGuards(AdminAuthGuard)
  @UseInterceptors(ProductReviewVideoUploadInterceptor)
  createProductReviewVideo(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @UploadedFiles() files: ProductReviewVideoUploadFiles = {},
  ) {
    return this.productReviewVideos.create(productId, files);
  }

  @Patch('products/:productId/review-videos/:videoId')
  @UseGuards(AdminAuthGuard)
  @UseInterceptors(ProductReviewVideoUploadInterceptor)
  replaceProductReviewVideo(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('videoId', new ParseUUIDPipe({ version: '4' })) videoId: string,
    @UploadedFiles() files: ProductReviewVideoUploadFiles = {},
  ) {
    return this.productReviewVideos.replace(productId, videoId, files);
  }

  @Delete('products/:productId/review-videos/:videoId')
  @UseGuards(AdminAuthGuard)
  removeProductReviewVideo(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('videoId', new ParseUUIDPipe({ version: '4' })) videoId: string,
  ) {
    return this.productReviewVideos.remove(productId, videoId);
  }

  @Put('products/:productId/review-videos/order')
  @UseGuards(AdminAuthGuard)
  reorderProductReviewVideos(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: ReorderProductReviewVideosDto,
  ) {
    return this.productReviewVideos.reorder(productId, dto.orderedIds);
  }

  @Get('reviews')
  @UseGuards(AdminAuthGuard)
  getReviews(@Query('status') status?: string) {
    return this.adminService.getReviews(status);
  }

  @Delete('reviews/:id')
  @UseGuards(AdminAuthGuard)
  removeReview(@Param('id') id: string) {
    return this.adminService.removeReview(id);
  }

  @Patch('reviews/:id/status')
  @UseGuards(AdminAuthGuard)
  updateReviewStatus(
    @Param('id') id: string,
    @Body() updateReviewStatusDto: UpdateProductReviewStatusDto,
    @Req() request: AdminRequest,
  ) {
    return this.adminService.updateReviewStatus(id, updateReviewStatusDto, request.admin?.username);
  }
}
