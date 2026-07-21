import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AdminLoginDto } from './dto/admin-login.dto';
import { GodAdminService } from './god-admin.service';
import { GodAdminAuthGuard, GodAdminTokenPayload } from './guards/god-admin-auth.guard';
import { ProductStatus } from '../products/entities/product.entity';
import { UpdateProductDto } from '../products/dto/update-product.dto';

type GodAdminRequest = Request & { godAdmin?: GodAdminTokenPayload };

@Controller('god-admin-panel')
export class GodAdminController {
  constructor(private readonly godAdminService: GodAdminService) {}

  @Post('login')
  login(@Body() adminLoginDto: AdminLoginDto) {
    return this.godAdminService.login(adminLoginDto);
  }

  @Get('products')
  @UseGuards(GodAdminAuthGuard)
  getProducts(@Query('status') status?: ProductStatus) {
    return this.godAdminService.getProducts(status);
  }

  @Get('products/pending')
  @UseGuards(GodAdminAuthGuard)
  getPendingProducts() {
    return this.godAdminService.getPendingProducts();
  }

  @Get('products/:id')
  @UseGuards(GodAdminAuthGuard)
  getProduct(@Param('id') id: string) {
    return this.godAdminService.getProduct(id);
  }

  @Patch('products/:id')
  @UseGuards(GodAdminAuthGuard)
  updateProduct(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
    @Req() request: GodAdminRequest,
  ) {
    return this.godAdminService.updateProduct(id, updateProductDto, request.godAdmin?.username);
  }

  @Patch('products/:id/publish')
  @UseGuards(GodAdminAuthGuard)
  publishProduct(@Param('id') id: string) {
    return this.godAdminService.publishProduct(id);
  }
}
