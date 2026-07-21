import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminLoginDto } from './dto/admin-login.dto';
import { ProductsService } from '../products/products.service';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { GOD_ADMIN_PANEL_SCOPE, GOD_ADMIN_ROLE } from './guards/god-admin-auth.guard';

@Injectable()
export class GodAdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly productsService: ProductsService,
  ) {}

  login({ username, password }: AdminLoginDto) {
    const ownerUsername = this.configService.get<string>('GOD_ADMIN_USERNAME')?.trim();
    const ownerPassword = this.configService.get<string>('GOD_ADMIN_PASSWORD');

    if (
      !ownerUsername
      || !ownerPassword
      || ownerUsername.toLowerCase() !== username.toLowerCase()
      || ownerPassword !== password
    ) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return {
      accessToken: this.jwtService.sign(
        { scope: GOD_ADMIN_PANEL_SCOPE, role: GOD_ADMIN_ROLE, username: ownerUsername },
        { expiresIn: '4h' },
      ),
      username: ownerUsername,
      role: GOD_ADMIN_ROLE,
    };
  }

  getProducts(status?: ProductStatus): Promise<Product[]> {
    return this.productsService.findAllForAdmin(status);
  }

  getPendingProducts(): Promise<Product[]> {
    return this.productsService.findPending();
  }

  getProduct(id: string) {
    return this.productsService.findOneForAdmin(id);
  }

  updateProduct(id: string, updateProductDto: UpdateProductDto, ownerName?: string) {
    return this.productsService.update(id, {
      ...updateProductDto,
      lastEditedByName: ownerName ?? null,
    });
  }

  publishProduct(id: string): Promise<Product> {
    return this.productsService.publishPendingById(id);
  }
}
