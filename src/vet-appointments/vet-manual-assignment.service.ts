import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { normalizeBirdPassportCode } from '../bird-passports/bird-passport-code';
import { normalizeBirdPassportMobile } from '../bird-passports/mobile-normalizer';
import {
  BirdPassport,
  BirdPassportStatus,
} from '../bird-passports/entities/bird-passport.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { AdminManualVetAssignmentDto } from './dto/admin-manual-assignment.dto';
import { AdminManualVetAssignmentResponseDto } from './dto/admin-manual-assignment-response.dto';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetDoctor } from './entities/doctor.entity';
import {
  VetActorType,
  VetAppointmentStatus,
  VetAvailabilityStatus,
  VetPricingKind,
  VetSlotStatus,
} from './vet-appointment.enums';
import { encryptVetField } from './security/vet-field-encryption';
import { VET_ADMIN_MANUAL_RULE } from './vet-manual-assignment.constants';

interface ManualAssignmentInput extends AdminManualVetAssignmentDto {
  passportCode?: string;
}

@Injectable()
export class VetManualAssignmentService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
  ) {}

  async create(raw: AdminManualVetAssignmentDto, adminUsername: string) {
    const input = this.input(raw);
    const admin = this.admin(adminUsername);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.source.transaction(
          'READ COMMITTED',
          async (manager) => this.createInTransaction(manager, input, admin),
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = this.postgresCode(error);
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;
        if (
          [
            '23505',
            '23P01',
            '23514',
            '23503',
            '40P01',
            '40001',
            '55P03',
            '57014',
          ].includes(code ?? '')
        )
          throw new ConflictException(
            'Manual assignment conflicts with current scheduling state',
          );
        if (['22007', '22008', '22P02', '22003'].includes(code ?? ''))
          throw new BadRequestException('Invalid manual assignment input');
        throw new InternalServerErrorException('Manual assignment failed');
      }
    }
  }

  private async createInTransaction(
    manager: EntityManager,
    input: ManualAssignmentInput,
    admin: string,
  ) {
    await manager.query("SET LOCAL lock_timeout = '5s'");
    await manager.query("SET LOCAL statement_timeout = '15s'");

    // Slot is the first row lock, matching cancellation and retirement order.
    const slot = await manager.getRepository(VetAppointmentSlot).findOne({
      where: { id: input.slotId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!slot) throw new NotFoundException('Vet appointment slot not found');
    const [{ now }] = await manager.query<Array<{ now: Date }>>(
      'SELECT transaction_timestamp() AS now',
    );
    if (
      slot.status !== VetSlotStatus.AVAILABLE ||
      slot.startsAt.getTime() <= now.getTime()
    )
      throw new ConflictException('Vet appointment slot is unavailable');
    const occupied = await manager.query<unknown[]>(
      `SELECT 1 FROM public.vet_appointments
       WHERE "slotId"=$1 AND status IN ('PAYMENT_PENDING','CONFIRMED','COMPLETED','NO_SHOW') LIMIT 1`,
      [slot.id],
    );
    if (occupied.length)
      throw new ConflictException('Vet appointment slot is unavailable');

    const customer = await manager.getRepository(User).findOne({
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        nationalId: true,
        profileCompleted: true,
        role: true,
      },
      where: { id: input.customerUserId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.role !== UserRole.CUSTOMER)
      throw new ConflictException('Selected user is not a customer');
    const ownerFullName = this.customerProfile(customer);

    const passport = input.passportCode
      ? await manager.getRepository(BirdPassport).findOne({
          select: {
            id: true,
            code: true,
            ownerMobile: true,
            ownerFullName: true,
            birdName: true,
            species: true,
            status: true,
          },
          where: { code: input.passportCode },
          lock: { mode: 'pessimistic_read' },
        })
      : null;
    if (input.passportCode && !passport)
      throw new NotFoundException('Bird passport not found');
    if (passport) {
      if (
        normalizeBirdPassportMobile(passport.ownerMobile) !==
        normalizeBirdPassportMobile(customer.phone)
      )
        throw new ForbiddenException(
          'Bird passport does not belong to selected customer',
        );
      this.bookablePassport(passport);
    }

    const doctor = await manager.getRepository(VetDoctor).findOne({
      select: { id: true, displayName: true, active: true, currency: true },
      where: { id: slot.doctorId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!doctor) throw new NotFoundException('Vet doctor not found');
    if (!doctor.active) throw new ConflictException('Vet doctor is inactive');
    const window = await manager.getRepository(VetAvailabilityWindow).findOne({
      select: { id: true, doctorId: true, status: true },
      where: { id: slot.availabilityWindowId },
    });
    if (
      !window ||
      window.status !== VetAvailabilityStatus.ACTIVE ||
      window.doctorId !== slot.doctorId ||
      doctor.id !== slot.doctorId
    )
      throw new ConflictException('Vet appointment slot is unavailable');

    const appointmentId = randomUUID();
    const appointment = manager.getRepository(VetAppointment).create({
      id: appointmentId,
      publicReference: `V${randomBytes(8).toString('hex').toUpperCase()}`,
      bookingRequestId: randomUUID(),
      customerUserId: customer.id,
      slotId: slot.id,
      doctorId: doctor.id,
      birdPassportId: passport?.id ?? null,
      status: VetAppointmentStatus.CONFIRMED,
      pricingKind: VetPricingKind.FREE,
      feeAmountMinor: '0',
      currency: doctor.currency,
      pricingRuleVersion: VET_ADMIN_MANUAL_RULE,
      holdExpiresAt: null,
      ownerFullNameSnapshot: ownerFullName,
      ownerMobileSnapshot: normalizeBirdPassportMobile(customer.phone),
      doctorNameSnapshot: doctor.displayName.trim(),
      passportCodeSnapshot: passport?.code ?? null,
      birdNameSnapshot: passport?.birdName?.trim() ?? null,
      birdSpeciesSnapshot: passport?.species?.trim() ?? null,
      passportOwnerFullNameSnapshot: passport?.ownerFullName?.trim() ?? null,
      nationalIdCiphertext: encryptVetField(
        customer.nationalId,
        this.encryptionKey(),
        `${appointmentId}:nationalId`,
      ),
      nationalIdLast4: customer.nationalId.slice(-4),
      confirmedAt: now,
      completedAt: null,
      cancelledAt: null,
      cancelledByType: null,
      cancelledById: null,
      cancellationReason: null,
    });
    await manager.getRepository(VetAppointment).insert(appointment);
    await manager.getRepository(VetAppointmentEvent).insert({
      appointmentId,
      eventType: 'ADMIN_ASSIGNED',
      eventKey: 'admin-manual-assignment',
      actorType: VetActorType.ADMIN,
      actorId: admin,
      previousStatus: null,
      newStatus: VetAppointmentStatus.CONFIRMED,
      metadata: { source: 'ADMIN_MANUAL' },
    });
    return AdminManualVetAssignmentResponseDto.from(appointment, slot);
  }

  private input(input: AdminManualVetAssignmentDto): ManualAssignmentInput {
    if (!isUUID(input?.customerUserId) || !isUUID(input?.slotId))
      throw new BadRequestException('Invalid manual assignment identifier');
    return {
      customerUserId: input.customerUserId.toLowerCase(),
      slotId: input.slotId.toLowerCase(),
      ...(input.passportCode
        ? { passportCode: normalizeBirdPassportCode(input.passportCode) }
        : {}),
    };
  }

  private admin(value: string): string {
    const admin = typeof value === 'string' ? value.trim() : '';
    if (!admin || admin.length > 50)
      throw new BadRequestException('Invalid admin identity');
    return admin;
  }

  private customerProfile(user: User): string {
    const firstName = user.firstName?.trim() ?? '';
    const lastName = user.lastName?.trim() ?? '';
    const fullName = `${firstName} ${lastName}`;
    if (
      !user.profileCompleted ||
      !firstName ||
      !lastName ||
      fullName.length > 150 ||
      !/^09[0-9]{9}$/.test(user.phone) ||
      !/^[0-9]{10}$/.test(user.nationalId ?? '')
    )
      throw new BadRequestException('Customer profile is incomplete');
    return fullName;
  }

  private bookablePassport(passport: BirdPassport): void {
    if (
      passport.status !== BirdPassportStatus.ACTIVE ||
      !passport.ownerFullName?.trim() ||
      !passport.birdName?.trim() ||
      !passport.species?.trim() ||
      passport.ownerFullName.trim().length > 150 ||
      passport.birdName.trim().length > 100 ||
      passport.species.trim().length > 150
    )
      throw new ConflictException('Bird passport is not bookable');
  }

  private encryptionKey(): Buffer {
    const encoded = (
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY') ??
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY_BASE64') ??
      ''
    ).trim();
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(encoded)) key = Buffer.from(encoded, 'hex');
    else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded))
      key = Buffer.from(encoded, 'base64');
    else key = Buffer.alloc(0);
    if (key.length !== 32)
      throw new InternalServerErrorException(
        'Vet assignment encryption is not configured',
      );
    return key;
  }

  private postgresCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
