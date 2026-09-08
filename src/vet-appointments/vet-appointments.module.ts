import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VetDoctor } from './entities/doctor.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetFreeConsultationClaim } from './entities/free-consultation-claim.entity';
import { VetAppointmentPayment } from './entities/appointment-payment.entity';
import { VetVideoRoom } from './entities/video-room.entity';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetNotificationOutbox } from './entities/notification-outbox.entity';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { AdminModule } from '../admin/admin.module';
import { AdminVetAvailabilityController } from './admin-availability.controller';
import { VetAvailabilityService } from './availability.service';
import { CustomerVetBookingController } from './customer-booking.controller';
import { VetBookingService } from './vet-booking.service';
import { VetPaidHoldService } from './vet-paid-hold.service';
import { AdminVetManualAssignmentController } from './admin-manual-assignment.controller';
import { VetManualAssignmentService } from './vet-manual-assignment.service';
import {
  CustomerVetVideoController,
  DoctorVetVideoController,
} from './vet-video.controller';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import { InternalVetVideoProvider } from './vet-video-provider';
import { VetVideoService } from './vet-video.service';

export const VET_ENTITIES = [
  VetDoctor,
  VetAvailabilityWindow,
  VetAppointmentSlot,
  VetAppointment,
  VetFreeConsultationClaim,
  VetAppointmentPayment,
  VetVideoRoom,
  VetAppointmentEvent,
  VetNotificationOutbox,
];

@Module({
  imports: [TypeOrmModule.forFeature(VET_ENTITIES), AdminModule],
  controllers: [
    AdminVetAvailabilityController,
    AdminVetManualAssignmentController,
    CustomerVetBookingController,
    CustomerVetVideoController,
    DoctorVetVideoController,
  ],
  providers: [
    VetBookingPolicy,
    VetAvailabilityService,
    VetBookingService,
    VetPaidHoldService,
    VetManualAssignmentService,
    VetDoctorAuthGuard,
    InternalVetVideoProvider,
    VetVideoService,
  ],
  exports: [
    TypeOrmModule,
    VetBookingPolicy,
    VetAvailabilityService,
    VetBookingService,
    VetPaidHoldService,
    VetManualAssignmentService,
    VetVideoService,
  ],
})
export class VetAppointmentsModule {}
