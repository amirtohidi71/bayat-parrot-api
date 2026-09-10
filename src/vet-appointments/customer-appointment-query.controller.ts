import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ListVetAppointmentsDto } from './dto/appointment-query.dto';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

@Controller('vet/appointments')
@UseGuards(JwtAuthGuard)
export class CustomerVetAppointmentQueryController {
  constructor(private readonly appointments: VetAppointmentQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListVetAppointmentsDto,
  ) {
    this.assertCustomer(user);
    return this.appointments.listCustomer(user.id, query);
  }

  @Get(':appointmentId')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ) {
    this.assertCustomer(user);
    return this.appointments.detailCustomer(user.id, appointmentId);
  }

  private assertCustomer(user: AuthenticatedUser) {
    if (user.role !== 'customer')
      throw new ForbiddenException('Customer access required');
  }
}
