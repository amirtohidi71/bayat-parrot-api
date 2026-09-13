import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VetAvailabilityService } from './availability.service';
import { ListBookableVetSlotsDto } from './dto/customer-availability.dto';

@Controller('vet/availability')
@UseGuards(JwtAuthGuard)
export class CustomerVetAvailabilityController {
  constructor(private readonly availability: VetAvailabilityService) {}

  @Get('slots')
  slots(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListBookableVetSlotsDto,
  ) {
    if (user.role !== 'customer')
      throw new ForbiddenException('Customer access required');
    return this.availability.bookableSlots(query);
  }
}
