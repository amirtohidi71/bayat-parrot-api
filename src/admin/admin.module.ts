import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import { OrdersModule } from '../orders/orders.module';
import { ProductsModule } from '../products/products.module';
import { User } from '../users/entities/user.entity';
import { GodAdminController } from './god-admin.controller';
import { GodAdminService } from './god-admin.service';
import { GodAdminAuthGuard } from './guards/god-admin-auth.guard';

@Module({
  imports: [
    OrdersModule,
    ProductsModule,
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [AdminService, AdminAuthGuard, GodAdminService, GodAdminAuthGuard],
  controllers: [AdminController, GodAdminController],
})
export class AdminModule {}
