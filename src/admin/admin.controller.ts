import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminService } from './admin.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { UpdateOrderStatusDto } from '../orders/dto/update-order-status.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import { productImageUploadOptions } from './config/product-image-upload.config';

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
  createProduct(@Body() createProductDto: CreateProductDto) {
    return this.adminService.createProduct(createProductDto);
  }

  @Get('products')
  @UseGuards(AdminAuthGuard)
  getProducts() {
    return this.adminService.getProducts();
  }

  @Get('products/pending')
  @UseGuards(AdminAuthGuard)
  getPendingProducts() {
    return this.adminService.getPendingProducts();
  }

  @Patch('products/:id')
  @UseGuards(AdminAuthGuard)
  updateProduct(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto) {
    return this.adminService.updateProduct(id, updateProductDto);
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
}
