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

// Day 1: persistence and policy only. No booking, payment, video or SMS execution.
@Module({
  imports: [TypeOrmModule.forFeature(VET_ENTITIES)],
  providers: [VetBookingPolicy],
  exports: [TypeOrmModule, VetBookingPolicy],
})
export class VetAppointmentsModule {}
