import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductStockReservation } from './entities/product-stock-reservation.entity';
import { StockReservationsService } from './stock-reservations.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProductStockReservation])],
  providers: [StockReservationsService],
  exports: [StockReservationsService],
})
export class StockReservationsModule {}
