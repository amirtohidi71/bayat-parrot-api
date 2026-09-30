import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import {
  SubmitBreederApplicationDto,
  SubmitSellerVerificationDto,
} from './dto/seller-onboarding.dto';
import { SellerOnboardingService } from './seller-onboarding.service';
import {
  breederUserResponse,
  sellerUserResponse,
} from './seller-onboarding.responses';

@Controller('seller-onboarding')
@UseGuards(JwtAuthGuard, CustomerCapabilityGuard)
export class SellerOnboardingController {
  constructor(private readonly onboarding: SellerOnboardingService) {}

  @Post('verification')
  async submitVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SubmitSellerVerificationDto,
  ) {
    return sellerUserResponse(
      await this.onboarding.submitSeller(user.id, input),
    );
  }

  @Get('verification')
  async ownVerification(@CurrentUser() user: AuthenticatedUser) {
    const value = await this.onboarding.ownSeller(user.id);
    return value ? sellerUserResponse(value) : null;
  }

  @Post('breeder-application')
  async submitBreeder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SubmitBreederApplicationDto,
  ) {
    return breederUserResponse(
      await this.onboarding.submitBreeder(user.id, input),
    );
  }

  @Get('breeder-application')
  async ownBreeder(@CurrentUser() user: AuthenticatedUser) {
    const value = await this.onboarding.ownBreeder(user.id);
    return value ? breederUserResponse(value) : null;
  }
}
