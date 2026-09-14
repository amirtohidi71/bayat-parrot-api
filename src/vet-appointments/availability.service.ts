import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { isUUID } from 'class-validator';
import { VetDoctor } from './entities/doctor.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAvailabilityStatus, VetSlotStatus } from './vet-appointment.enums';
import {
  AvailabilityGeometryDto,
  CreateAvailabilityDto,
  ListAvailabilityDto,
} from './dto/availability-request.dto';
import {
  AvailabilityResponseDto,
  AvailabilitySlotResponseDto,
  ManualAvailabilitySlotResponseDto,
} from './dto/availability-response.dto';
import type { ManualAvailabilitySlotResponse } from './dto/availability-response.dto';
import {
  BookableVetSlotResponseDto,
  ListBookableVetSlotsDto,
} from './dto/customer-availability.dto';
import type { BookableVetSlotRow } from './dto/customer-availability.dto';
import {
  generateAvailabilitySlots,
  parseInstant,
  SlotGeometry,
} from './availability-slot-generation';
import { CreateManualAvailabilitySlotsDto } from './dto/manual-availability-slot.dto';
import { parseManualAvailabilitySlots } from './manual-availability-slot';

const occupant = `SELECT 1 FROM public.vet_appointments a WHERE a."slotId" = s.id
  AND a.status IN ('PAYMENT_PENDING','CONFIRMED','COMPLETED','NO_SHOW')`;
const MAX_BOOKABLE_SLOT_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

@Injectable()
export class VetAvailabilityService {
  constructor(private readonly source: DataSource) {}

  async create(input: CreateAvailabilityDto, admin: string) {
    this.uuid(input.doctorId);
    this.admin(admin);
    const slots = generateAvailabilitySlots(input);
    return this.write(input.doctorId, async (manager) => {
      await this.activeDoctor(manager, input.doctorId);
      return this.insert(manager, input.doctorId, input, admin, slots);
    });
  }

  async createManualSlots(
    input: CreateManualAvailabilitySlotsDto,
    admin: string,
  ) {
    this.uuid(input.doctorId);
    this.admin(admin);
    const slots = parseManualAvailabilitySlots(input.slots);
    return this.write(
      input.doctorId,
      async (manager) => {
        await this.activeDoctor(manager, input.doctorId);
        const [{ now }] = await manager.query<Array<{ now: Date }>>(
          'SELECT transaction_timestamp() AS now',
        );
        if (slots.some((slot) => slot.startsAt.getTime() <= now.getTime()))
          throw new BadRequestException(
            'Manual availability slots must be future',
          );

        const created: ManualAvailabilitySlotResponse[] = [];
        for (const slot of slots) {
          const slotDurationMinutes =
            (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
          const result = await this.insert(
            manager,
            input.doctorId,
            {
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              slotDurationMinutes,
              timeZone: 'Asia/Tehran',
            },
            admin,
            [slot],
          );
          created.push(
            ManualAvailabilitySlotResponseDto.from(
              result.window,
              result.slots[0],
            ),
          );
        }
        return created;
      },
      'Manual availability slots conflict with current scheduling state',
    );
  }

  async list(query: ListAvailabilityDto) {
    if (query.doctorId) this.uuid(query.doctorId);
    if (query.from) parseInstant(query.from);
    if (query.to) parseInstant(query.to);
    if (
      query.from &&
      query.to &&
      Date.parse(query.from) >= Date.parse(query.to)
    )
      throw new BadRequestException('Filter start must precede end');
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      (query.status !== undefined &&
        !Object.values(VetAvailabilityStatus).includes(query.status))
    )
      throw new BadRequestException('Invalid availability filter');
    const builder = this.source
      .getRepository(VetAvailabilityWindow)
      .createQueryBuilder('w');
    if (query.doctorId)
      builder.andWhere('w.doctorId = :doctorId', { doctorId: query.doctorId });
    if (query.status)
      builder.andWhere('w.status = :status', { status: query.status });
    if (query.from) builder.andWhere('w.endsAt > :from', { from: query.from });
    if (query.to) builder.andWhere('w.startsAt < :to', { to: query.to });
    const [windows, total] = await builder
      .orderBy('w.startsAt', 'ASC')
      .addOrderBy('w.id', 'ASC')
      .take(limit)
      .skip(offset)
      .getManyAndCount();
    return {
      items: windows.map(AvailabilityResponseDto.from),
      total,
      limit,
      offset,
    };
  }

  async read(id: string) {
    return AvailabilityResponseDto.from(
      await this.window(this.source.manager, id),
    );
  }

  async slots(id: string) {
    await this.window(this.source.manager, id);
    const slots = await this.source.getRepository(VetAppointmentSlot).find({
      where: { availabilityWindowId: id },
      order: { startsAt: 'ASC', id: 'ASC' },
    });
    return slots.map(AvailabilitySlotResponseDto.from);
  }

  async bookableSlots(query: ListBookableVetSlotsDto) {
    const from = parseInstant(query.from);
    const to = parseInstant(query.to);
    const range = to - from;
    if (range <= 0)
      throw new BadRequestException('Filter start must precede end');
    if (range > MAX_BOOKABLE_SLOT_RANGE_MS)
      throw new BadRequestException('Availability range cannot exceed 31 days');

    const slots = await this.source
      .getRepository(VetAppointmentSlot)
      .createQueryBuilder('s')
      .innerJoin(
        VetAvailabilityWindow,
        'w',
        'w.id = s.availabilityWindowId AND w.doctorId = s.doctorId',
      )
      .innerJoin(VetDoctor, 'd', 'd.id = s.doctorId')
      .select('s.id', 'slotId')
      .addSelect('s.doctorId', 'doctorId')
      .addSelect('d.displayName', 'doctorDisplayName')
      .addSelect('s.startsAt', 'startsAt')
      .addSelect('s.endsAt', 'endsAt')
      .where('s.status = :slotStatus', {
        slotStatus: VetSlotStatus.AVAILABLE,
      })
      .andWhere('w.status = :windowStatus', {
        windowStatus: VetAvailabilityStatus.ACTIVE,
      })
      .andWhere('d.active = TRUE')
      .andWhere('s.startsAt >= :from', { from: new Date(from) })
      .andWhere('s.startsAt < :to', { to: new Date(to) })
      .andWhere('s.startsAt > transaction_timestamp()')
      .andWhere(`NOT EXISTS (${occupant})`)
      .orderBy('s.startsAt', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .getRawMany<BookableVetSlotRow>();

    return slots.map(BookableVetSlotResponseDto.from);
  }

  async cancel(id: string) {
    return this.transition(id, VetAvailabilityStatus.CANCELLED);
  }

  async retire(id: string) {
    return this.transition(id, VetAvailabilityStatus.RETIRED);
  }

  async replace(id: string, input: AvailabilityGeometryDto, admin: string) {
    this.admin(admin);
    generateAvailabilitySlots(input);
    const original = await this.window(this.source.manager, id);
    return this.write(original.doctorId, async (manager) => {
      await this.activeDoctor(manager, original.doctorId);
      await this.lockWindow(manager, id);
      await this.closeWindow(manager, id, VetAvailabilityStatus.RETIRED);
      const retained = await manager
        .getRepository(VetAppointmentSlot)
        .createQueryBuilder('s')
        .where('s.availabilityWindowId = :id', { id })
        .andWhere('s.status <> :cancelled', {
          cancelled: VetSlotStatus.CANCELLED,
        })
        .orderBy('s.startsAt', 'ASC')
        .getMany();
      const slots = generateAvailabilitySlots(input, retained);
      const replacement = await this.insert(
        manager,
        original.doctorId,
        input,
        admin,
        slots,
      );
      return {
        previousWindow: AvailabilityResponseDto.from(
          await this.window(manager, id),
        ),
        ...replacement,
        retainedSlots: retained.map(AvailabilitySlotResponseDto.from),
      };
    });
  }

  private async transition(id: string, status: VetAvailabilityStatus) {
    const original = await this.window(this.source.manager, id);
    return this.write(original.doctorId, async (manager) => {
      await this.lockWindow(manager, id);
      await this.closeWindow(manager, id, status);
      return AvailabilityResponseDto.from(await this.window(manager, id));
    });
  }

  private async lockWindow(manager: EntityManager, id: string) {
    // Match database slot/booking lock order. Read occupancy in a NEW command
    // after all slot waits, then lock and re-read the parent before changing it.
    await manager.query(
      'SELECT id FROM public.vet_appointment_slots WHERE "availabilityWindowId"=$1 ORDER BY id FOR UPDATE',
      [id],
    );
    const window = await manager.getRepository(VetAvailabilityWindow).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!window) throw new NotFoundException('Availability window not found');
    if (window.status !== VetAvailabilityStatus.ACTIVE)
      throw new ConflictException('Availability window is terminal');
  }

  private async closeWindow(
    manager: EntityManager,
    id: string,
    status: VetAvailabilityStatus,
  ) {
    // CANCEL attempts all slots (occupied rows fail at the DB guard and roll back).
    // RETIRE keeps occupied rows and ended historical geometry. DB time is authoritative.
    const retirement =
      status === VetAvailabilityStatus.RETIRED
        ? `AND s."endsAt" > transaction_timestamp() AND NOT EXISTS (${occupant})`
        : '';
    await manager.query(
      `UPDATE public.vet_appointment_slots s SET status='CANCELLED', "updatedAt"=now()
      WHERE s."availabilityWindowId"=$1 AND s.status <> 'CANCELLED' ${retirement}`,
      [id],
    );
    await manager.getRepository(VetAvailabilityWindow).update(id, { status });
  }

  private async insert(
    manager: EntityManager,
    doctorId: string,
    input: AvailabilityGeometryDto,
    admin: string,
    slots: SlotGeometry[],
  ) {
    const window = await manager.getRepository(VetAvailabilityWindow).save({
      doctorId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      slotDurationMinutes: input.slotDurationMinutes,
      timeZone: input.timeZone ?? 'Asia/Tehran',
      status: VetAvailabilityStatus.ACTIVE,
      createdByAdmin: admin,
    });
    if (slots.length)
      await manager.getRepository(VetAppointmentSlot).insert(
        slots.map((s) => ({
          ...s,
          doctorId,
          availabilityWindowId: window.id,
          status: VetSlotStatus.AVAILABLE,
        })),
      );
    const generated = await manager.getRepository(VetAppointmentSlot).find({
      where: { availabilityWindowId: window.id },
      order: { startsAt: 'ASC' },
    });
    if (generated.length !== slots.length)
      throw new InternalServerErrorException(
        'Availability slot generation failed',
      );
    return {
      window: AvailabilityResponseDto.from(window),
      slots: generated.map(AvailabilitySlotResponseDto.from),
    };
  }

  private async activeDoctor(manager: EntityManager, id: string) {
    const doctor = await manager.getRepository(VetDoctor).findOne({
      select: { id: true, active: true },
      where: { id },
      lock: { mode: 'pessimistic_read' },
    });
    if (!doctor) throw new NotFoundException('Vet doctor not found');
    if (!doctor.active) throw new ConflictException('Vet doctor is inactive');
  }

  private async window(manager: EntityManager, id: string) {
    this.uuid(id);
    const window = await manager
      .getRepository(VetAvailabilityWindow)
      .findOneBy({ id });
    if (!window) throw new NotFoundException('Availability window not found');
    return window;
  }

  private uuid(id: string) {
    if (typeof id !== 'string' || !isUUID(id))
      throw new BadRequestException('Invalid identifier');
  }

  private admin(admin: string) {
    if (typeof admin !== 'string' || !admin.trim() || admin.length > 50)
      throw new BadRequestException('Invalid admin identity');
  }

  private async write<T>(
    doctorId: string,
    action: (manager: EntityManager) => Promise<T>,
    conflictMessage = 'Availability conflicts with current scheduling state',
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.source.transaction(
          'READ COMMITTED',
          async (manager) => {
            await manager.query("SET LOCAL lock_timeout = '5s'");
            await manager.query("SET LOCAL statement_timeout = '15s'");
            await manager.query(
              "SELECT pg_advisory_xact_lock(hashtextextended('vet:availability:doctor:' || $1::text, 0))",
              [doctorId.toLowerCase()],
            );
            return action(manager);
          },
        );
      } catch (error) {
        const code =
          error instanceof QueryFailedError
            ? (error.driverError as { code?: string }).code
            : undefined;
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;
        if (error instanceof HttpException) throw error;
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
          throw new ConflictException(conflictMessage);
        if (['22007', '22008', '22P02', '22003'].includes(code ?? ''))
          throw new BadRequestException('Invalid availability input');
        throw new InternalServerErrorException('Availability operation failed');
      }
    }
  }
}
