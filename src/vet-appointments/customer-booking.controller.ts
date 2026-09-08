import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BookVetAppointmentDto } from './dto/booking-request.dto';
import { VetBookingService } from './vet-booking.service';

@Controller('vet/appointments')
@UseGuards(JwtAuthGuard)
export class CustomerVetBookingController {
  constructor(private readonly booking: VetBookingService) {}

  @Post()
  book(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: BookVetAppointmentDto,
  ) {
    if (user.role !== 'customer')
      throw new ForbiddenException('Customer access required');
    return this.booking.book(user.id, input);
  }
}
