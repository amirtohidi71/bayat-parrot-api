import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminListVetAppointmentsDto,
  ListVetAppointmentsDto,
  VET_APPOINTMENT_MAX_PAGE,
  VetAppointmentPeriod,
} from './dto/appointment-query.dto';
import {
  VetAppointmentDashboardListResponseDto,
  VetAppointmentDashboardResponseDto,
  VetAppointmentDashboardRow,
  VetVideoProjection,
} from './dto/appointment-dashboard-response.dto';
import { VetAppointmentStatus, VetVideoStatus } from './vet-appointment.enums';

type QueryAudience = 'customer' | 'doctor' | 'admin';

interface NormalizedQuery {
  page: number;
  pageSize: number;
  period?: VetAppointmentPeriod;
  status?: VetAppointmentStatus;
  from?: Date;
  to?: Date;
  doctorId?: string;
  customerUserId?: string;
}

interface QueryParts {
  whereSql: string;
  parameters: unknown[];
}

@Injectable()
export class VetAppointmentQueryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  listCustomer(customerUserId: string, input: ListVetAppointmentsDto) {
    return this.list('customer', customerUserId, input);
  }

  detailCustomer(customerUserId: string, appointmentId: string) {
    return this.detail('customer', customerUserId, appointmentId);
  }

  listDoctor(doctorId: string, input: ListVetAppointmentsDto) {
    return this.list('doctor', doctorId, input);
  }

  detailDoctor(doctorId: string, appointmentId: string) {
    return this.detail('doctor', doctorId, appointmentId);
  }

  listAdmin(input: AdminListVetAppointmentsDto) {
    return this.list('admin', null, input);
  }

  detailAdmin(appointmentId: string) {
    return this.detail('admin', null, appointmentId);
  }

  private async list(
    audience: QueryAudience,
    principalId: string | null,
    input: AdminListVetAppointmentsDto,
  ) {
    const query = this.normalize(input, audience === 'admin');
    this.validatePrincipal(audience, principalId);

    return this.execute(async (manager) => {
      if (audience === 'doctor')
        await this.assertActiveDoctor(manager, principalId as string);
      const [{ now }] = await manager.query<Array<{ now: Date }>>(
        'SELECT transaction_timestamp() AS now',
      );
      const parts = this.buildWhere(audience, principalId, query);
      const [{ total }] = await manager.query<Array<{ total: string }>>(
        `SELECT COUNT(*)::text AS total
           FROM vet_appointments a
           LEFT JOIN vet_appointment_slots s ON s.id = a."slotId"
           JOIN vet_doctors d ON d.id = a."doctorId"
          WHERE ${parts.whereSql}`,
        parts.parameters,
      );
      const offset = (query.page - 1) * query.pageSize;
      const parameters = [...parts.parameters, query.pageSize, offset];
      const limitParameter = `$${parts.parameters.length + 1}`;
      const offsetParameter = `$${parts.parameters.length + 2}`;
      const rows = await manager.query<VetAppointmentDashboardRow[]>(
        `${this.selectSql()}
          WHERE ${parts.whereSql}
          ${this.orderSql(query.period)}
          LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        parameters,
      );
      const items = rows.map((row) =>
        VetAppointmentDashboardResponseDto.from(
          { ...row, dbNow: now },
          audience,
          this.videoProjection(row, now),
        ),
      );
      return VetAppointmentDashboardListResponseDto.from(
        items,
        query.page,
        query.pageSize,
        Number(total),
      );
    });
  }

  private async detail(
    audience: QueryAudience,
    principalId: string | null,
    appointmentId: string,
  ) {
    this.validatePrincipal(audience, principalId);
    if (!isUUID(appointmentId))
      throw new BadRequestException('Invalid appointment id');

    return this.execute(async (manager) => {
      if (audience === 'doctor')
        await this.assertActiveDoctor(manager, principalId as string);
      const [{ now }] = await manager.query<Array<{ now: Date }>>(
        'SELECT transaction_timestamp() AS now',
      );
      const parts = this.buildWhere(audience, principalId, {
        page: 1,
        pageSize: 1,
      });
      parts.parameters.push(appointmentId);
      const rows = await manager.query<VetAppointmentDashboardRow[]>(
        `${this.selectSql()}
          WHERE ${parts.whereSql} AND a.id = $${parts.parameters.length}
          LIMIT 1`,
        parts.parameters,
      );
      const row = rows[0];
      if (!row) throw new NotFoundException('Vet appointment not found');
      return VetAppointmentDashboardResponseDto.from(
        { ...row, dbNow: now },
        audience,
        this.videoProjection(row, now),
      );
    });
  }

  private async execute<T>(work: (manager: EntityManager) => Promise<T>) {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          await manager.query('SET TRANSACTION READ ONLY');
          await manager.query("SET LOCAL statement_timeout = '10s'");
          return work(manager);
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('Unable to read vet appointments');
    }
  }

  private normalize(
    input: AdminListVetAppointmentsDto,
    allowAdminFilters: boolean,
  ): NormalizedQuery {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > VET_APPOINTMENT_MAX_PAGE
    )
      throw new BadRequestException('Invalid page');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
      throw new BadRequestException('Invalid page size');
    if (
      input.period !== undefined &&
      !Object.values(VetAppointmentPeriod).includes(input.period)
    )
      throw new BadRequestException('Invalid appointment period');
    if (
      input.status !== undefined &&
      !Object.values(VetAppointmentStatus).includes(input.status)
    )
      throw new BadRequestException('Invalid appointment status');

    const from = this.optionalDate(input.from, 'from');
    const to = this.optionalDate(input.to, 'to');
    if (from && to && from >= to)
      throw new BadRequestException('from must be before to');
    if (
      allowAdminFilters &&
      input.doctorId !== undefined &&
      !isUUID(input.doctorId)
    )
      throw new BadRequestException('Invalid doctor id');
    if (
      allowAdminFilters &&
      input.customerUserId !== undefined &&
      !isUUID(input.customerUserId)
    )
      throw new BadRequestException('Invalid customer id');

    return {
      page,
      pageSize,
      period: input.period,
      status: input.status,
      from,
      to,
      doctorId: allowAdminFilters ? input.doctorId : undefined,
      customerUserId: allowAdminFilters ? input.customerUserId : undefined,
    };
  }

  private optionalDate(value: string | undefined, field: string) {
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()))
      throw new BadRequestException(`Invalid ${field} date`);
    return parsed;
  }

  private validatePrincipal(
    audience: QueryAudience,
    principalId: string | null,
  ) {
    if (audience !== 'admin' && (!principalId || !isUUID(principalId)))
      throw new ForbiddenException('Vet appointment access denied');
  }

  private async assertActiveDoctor(manager: EntityManager, doctorId: string) {
    const rows = await manager.query<Array<{ active: boolean }>>(
      'SELECT active FROM vet_doctors WHERE id = $1',
      [doctorId],
    );
    if (!rows[0]?.active)
      throw new ForbiddenException('Vet doctor access unavailable');
  }

  private buildWhere(
    audience: QueryAudience,
    principalId: string | null,
    query: NormalizedQuery,
  ): QueryParts {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      parameters.push(value);
      clauses.push(sql.replace('?', `$${parameters.length}`));
    };

    if (audience === 'customer') add('a."customerUserId" = ?', principalId);
    if (audience === 'doctor') add('a."doctorId" = ?', principalId);
    if (query.status) add('a.status = ?', query.status);
    if (query.from) add('s."startsAt" >= ?', query.from);
    if (query.to) add('s."startsAt" < ?', query.to);
    if (query.doctorId) add('a."doctorId" = ?', query.doctorId);
    if (query.customerUserId)
      add('a."customerUserId" = ?', query.customerUserId);
    if (query.period === VetAppointmentPeriod.UPCOMING)
      clauses.push('s."endsAt" >= transaction_timestamp()');
    if (query.period === VetAppointmentPeriod.PAST)
      clauses.push('s."endsAt" < transaction_timestamp()');

    return {
      whereSql: clauses.length ? clauses.join(' AND ') : 'TRUE',
      parameters,
    };
  }

  private selectSql() {
    return `SELECT
      a.id AS "appointmentId",
      a."publicReference" AS "publicReference",
      a.status AS status,
      a."pricingKind" AS "pricingKind",
      CASE
        WHEN a."pricingRuleVersion" = 'vet-admin-manual-v1'
         AND EXISTS (
           SELECT 1 FROM vet_appointment_events e
            WHERE e."appointmentId" = a.id
              AND e."eventType" = 'ADMIN_ASSIGNED'
         ) THEN 'ADMIN_MANUAL'
        WHEN a."pricingKind" = 'FREE' THEN 'CUSTOMER_FIRST_FREE'
        ELSE 'CUSTOMER_PAID'
      END AS source,
      a."customerUserId" AS "customerUserId",
      a."ownerFullNameSnapshot" AS "customerName",
      a."doctorId" AS "doctorId",
      a."doctorNameSnapshot" AS "doctorName",
      a."slotId" AS "slotId",
      s."startsAt" AS "startsAt",
      s."endsAt" AS "endsAt",
      a."passportCodeSnapshot" AS "passportCode",
      a."birdNameSnapshot" AS "birdName",
      a."birdSpeciesSnapshot" AS "birdSpecies",
      a."confirmedAt" AS "confirmedAt",
      a."createdAt" AS "createdAt",
      d.active AS "doctorActive",
      vr.status AS "roomStatus",
      vr."providerEndDate" AS "providerEndDate"
    FROM vet_appointments a
    LEFT JOIN vet_appointment_slots s ON s.id = a."slotId"
    JOIN vet_doctors d ON d.id = a."doctorId"
    LEFT JOIN vet_video_rooms vr ON vr."appointmentId" = a.id`;
  }

  private orderSql(period?: VetAppointmentPeriod) {
    if (period === VetAppointmentPeriod.UPCOMING)
      return 'ORDER BY s."startsAt" ASC, a.id ASC';
    return 'ORDER BY COALESCE(s."startsAt", a."createdAt") DESC, a.id DESC';
  }

  private videoProjection(
    row: VetAppointmentDashboardRow,
    databaseNow: Date,
  ): VetVideoProjection {
    const eligible =
      row.status === VetAppointmentStatus.CONFIRMED &&
      Boolean(row.confirmedAt) &&
      Boolean(row.slotId && row.startsAt && row.endsAt) &&
      row.doctorActive;
    if (!eligible)
      return {
        eligible: false,
        joinAllowedNow: false,
        state: 'NOT_ELIGIBLE',
        roomStatus: row.roomStatus,
        opensAt: null,
        closesAt: null,
      };

    const opensAt = new Date(
      new Date(row.startsAt as Date | string).getTime() -
        this.minutes('VET_VIDEO_JOIN_BEFORE_MINUTES', 15) * 60_000,
    );
    const closesAt = new Date(
      new Date(row.endsAt as Date | string).getTime() +
        this.minutes('VET_VIDEO_GRACE_AFTER_MINUTES', 15) * 60_000,
    );
    const now = new Date(databaseNow);
    let state: VetVideoProjection['state'];
    if (now < opensAt) state = 'TOO_EARLY';
    else if (
      now > closesAt ||
      row.roomStatus === VetVideoStatus.EXPIRED ||
      row.roomStatus === VetVideoStatus.DELETED ||
      (row.roomStatus === VetVideoStatus.READY &&
        (!row.providerEndDate || new Date(row.providerEndDate) <= now))
    )
      state = 'CLOSED';
    else if (row.roomStatus === VetVideoStatus.CREATING) state = 'UNAVAILABLE';
    else state = 'OPEN';

    return {
      eligible: true,
      joinAllowedNow: state === 'OPEN',
      state,
      roomStatus: row.roomStatus,
      opensAt: opensAt.toISOString(),
      closesAt: closesAt.toISOString(),
    };
  }

  private minutes(key: string, fallback: number) {
    const raw = this.config.get<string>(key)?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1440)
      throw new Error(`${key} is out of range`);
    return value;
  }
}
