import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
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
import { ProductReviewStatus } from '../products/entities/product-review.entity';
import { UpdateProductReviewStatusDto } from '../products/dto/update-product-review-status.dto';
import { AdminAuthGuard, AdminTokenPayload } from './guards/admin-auth.guard';
import { productImageUploadOptions } from './config/product-image-upload.config';

type AdminRequest = Request & { admin?: AdminTokenPayload };

@Controller('admin-panel')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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

  @Get('reviews')
  @UseGuards(AdminAuthGuard)
  getReviews(@Query('status') status?: ProductReviewStatus) {
    return this.adminService.getReviews(status);
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
