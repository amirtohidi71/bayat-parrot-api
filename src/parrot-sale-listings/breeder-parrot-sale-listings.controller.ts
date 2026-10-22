import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { CreateBreederParrotSaleListingDto } from './dto/parrot-sale-listing.dto';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';
import { parrotSaleListingSellerResponse } from './parrot-sale-listing.responses';

@Controller('breeder-parrot-sale-listings')
@UseGuards(JwtAuthGuard, CustomerCapabilityGuard)
export class BreederParrotSaleListingsController {
  constructor(private readonly listings: ParrotSaleListingsService) {}
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateBreederParrotSaleListingDto,
  ) {
    return parrotSaleListingSellerResponse(
      await this.listings.createBreeder(user.id, input),
    );
  }
}
