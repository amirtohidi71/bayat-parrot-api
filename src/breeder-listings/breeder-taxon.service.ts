import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { ParrotSaleListing } from '../parrot-sale-listings/entities/parrot-sale-listing.entity';
import { ListingSubmissionKind } from '../parrot-sale-listings/entities/listing-submission-kind';
import {
  BreederApplication,
  BreederApplicationStatus,
  BreederCallOutcome,
} from '../seller-onboarding/entities/breeder-application.entity';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { lockSellerLifecycle } from '../seller-onboarding/seller-lifecycle';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';
import { BirdSpecies } from './entities/bird-species.entity';
import { BirdSubspecies } from './entities/bird-subspecies.entity';
import {
  BreederSpeciesPermission,
  BreederPermissionState as State,
} from './entities/breeder-species-permission.entity';
import { BreederSubspeciesPermission } from './entities/breeder-subspecies-permission.entity';
import {
  BreederPermissionAction as Action,
  BreederPermissionEvent,
} from './entities/breeder-permission-event.entity';
import {
  BreederPermissionDecision as Decision,
  BreederPermissionKind as Kind,
  DecideBreederPermissionDto,
  RequestBreederTaxaDto,
} from './breeder-taxon.dto';
import {
  BreederTaxonErrorCode as Code,
  taxonError,
} from './breeder-taxon.errors';

export function nextPermissionState(state: State, decision: Decision): State {
  if (decision === Decision.APPROVE && state === State.REQUESTED)
    return State.APPROVED;
  if (decision === Decision.REJECT && state === State.REQUESTED)
    return State.REJECTED;
  if (decision === Decision.REVOKE && state === State.APPROVED)
    return State.REVOKED;
  if (
    decision === Decision.REGRANT &&
    [State.REJECTED, State.REVOKED].includes(state)
  )
    return State.APPROVED;
  return taxonError(409, Code.INVALID_TRANSITION);
}

@Injectable()
export class BreederTaxonService {
  constructor(
    private readonly source: DataSource,
    private readonly eligibility: SellerEligibilityPolicy,
  ) {}

  async taxonomy() {
    return this.source.transaction(async (manager) => {
      const species = await manager
        .getRepository(BirdSpecies)
        .find({ order: { key: 'ASC', id: 'ASC' } });
      const children = await manager
        .getRepository(BirdSubspecies)
        .find({ order: { key: 'ASC', id: 'ASC' } });
      return species.map((parent) => ({
        id: parent.id,
        key: parent.key,
        displayName: parent.displayName,
        subspecies: children
          .filter((child) => child.speciesId === parent.id)
          .map((child) => ({
            id: child.id,
            key: child.key,
            displayName: child.displayName,
          })),
      }));
    });
  }

  async validateSelections(
    manager: EntityManager,
    input: RequestBreederTaxaDto,
  ) {
    // HTTP DTO validation is the first boundary. Also fail safely for malformed
    // internal calls before sorting, flattening, or touching a repository.
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !isUUID(input.requestId) ||
      !Array.isArray(input.selections) ||
      input.selections.length < 1 ||
      input.selections.length > 20 ||
      input.selections.some(
        (selection) =>
          !selection ||
          typeof selection !== 'object' ||
          Array.isArray(selection) ||
          !isUUID(selection.speciesId) ||
          !Array.isArray(selection.subspeciesIds) ||
          selection.subspeciesIds.length < 1 ||
          selection.subspeciesIds.length > 100 ||
          selection.subspeciesIds.some((id) => !isUUID(id)),
      )
    )
      taxonError(400, Code.INVALID_SELECTION);
    const selections = [...input.selections].sort((a, b) =>
      a.speciesId.localeCompare(b.speciesId),
    );
    if (
      !selections.length ||
      new Set(selections.map((s) => s.speciesId)).size !== selections.length
    )
      taxonError(400, Code.INVALID_SELECTION);
    const species = await manager
      .getRepository(BirdSpecies)
      .find({ where: { id: In(selections.map((s) => s.speciesId)) } });
    const childIds = selections.flatMap((s) => s.subspeciesIds);
    if (!childIds.length || new Set(childIds).size !== childIds.length)
      taxonError(400, Code.INVALID_SELECTION);
    const children = await manager
      .getRepository(BirdSubspecies)
      .find({ where: { id: In(childIds) } });
    for (const selection of selections) {
      if (
        !species.some((s) => s.id === selection.speciesId) ||
        !selection.subspeciesIds.length ||
        selection.subspeciesIds.some(
          (id) =>
            !children.some(
              (child) =>
                child.id === id && child.speciesId === selection.speciesId,
            ),
        )
      )
        taxonError(400, Code.INVALID_SELECTION);
    }
    return { selections, species };
  }

  // Caller owns the lifecycle lock and application transaction (also used by
  // initial application creation). Never changes the application's history.
  async requestInTransaction(
    manager: EntityManager,
    application: BreederApplication,
    actor: string,
    input: RequestBreederTaxaDto,
  ) {
    const { selections } = await this.validateSelections(manager, input);
    const hash = this.hash({
      operation: 'REQUEST',
      applicationId: application.id,
      actor,
      selections: selections.map((s) => ({
        speciesId: s.speciesId,
        subspeciesIds: [...s.subspeciesIds].sort(),
      })),
    });
    if (await this.replay(manager, application.id, input.requestId, hash))
      return;
    const parents = await manager.getRepository(BreederSpeciesPermission).find({
      where: { applicationId: application.id },
      order: { speciesId: 'ASC', id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const children = await manager
      .getRepository(BreederSubspeciesPermission)
      .find({
        where: { applicationId: application.id },
        order: { speciesId: 'ASC', subspeciesId: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
    for (const selection of selections) {
      let parent = parents.find((p) => p.speciesId === selection.speciesId);
      if (parent && ![State.APPROVED, State.REQUESTED].includes(parent.state))
        taxonError(409, Code.REGRANT_REQUIRED);
      if (
        children.some((c) => selection.subspeciesIds.includes(c.subspeciesId))
      )
        taxonError(409, Code.REQUEST_CONFLICT);
      if (!parent) {
        parent = await manager.getRepository(BreederSpeciesPermission).save(
          manager.getRepository(BreederSpeciesPermission).create({
            applicationId: application.id,
            speciesId: selection.speciesId,
            state: State.REQUESTED,
            revision: 1,
          }),
        );
        await this.event(
          manager,
          parent,
          false,
          Action.REQUEST,
          null,
          'CUSTOMER',
          actor,
          null,
          input.requestId,
          hash,
        );
      }
      for (const subspeciesId of [...selection.subspeciesIds].sort()) {
        const child = await manager
          .getRepository(BreederSubspeciesPermission)
          .save(
            manager.getRepository(BreederSubspeciesPermission).create({
              applicationId: application.id,
              speciesId: selection.speciesId,
              subspeciesId,
              speciesPermissionId: parent.id,
              state: State.REQUESTED,
              revision: 1,
            }),
          );
        await this.event(
          manager,
          child,
          true,
          Action.REQUEST,
          null,
          'CUSTOMER',
          actor,
          null,
          input.requestId,
          hash,
        );
      }
    }
  }

  request(applicationId: string, userId: string, input: RequestBreederTaxaDto) {
    return this.transaction(async (manager) => {
      const { application, user } = await this.lockApplication(
        manager,
        applicationId,
        userId,
      );
      await this.assertCurrent(manager, application);
      await this.assertEligible(manager, application, user, false);
      await this.requestInTransaction(manager, application, user.id, input);
      return this.response(manager, application, false);
    });
  }

  read(applicationId: string, userId?: string) {
    return this.source.transaction(async (manager) => {
      const { application } = await this.lockApplication(
        manager,
        applicationId,
        userId,
      );
      return this.response(manager, application, userId === undefined);
    });
  }

  decide(
    applicationId: string,
    permissionId: string,
    kind: Kind,
    decision: Decision,
    actor: string,
    input: DecideBreederPermissionDto,
  ) {
    return this.transaction(async (manager) => {
      const { application, user } = await this.lockApplication(
        manager,
        applicationId,
      );
      const normalizedActor = actor?.trim();
      if (!normalizedActor || normalizedActor.length > 100)
        taxonError(403, Code.NOT_ELIGIBLE);
      const hash = this.hash({
        operation: decision,
        applicationId,
        permissionId,
        kind,
        actor: normalizedActor,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      if (await this.replay(manager, applicationId, input.requestId, hash))
        return this.response(manager, application, true);
      await this.assertCurrent(manager, application);
      const granting =
        decision === Decision.APPROVE || decision === Decision.REGRANT;
      if (granting) await this.assertEligible(manager, application, user, true);
      if (application.status === BreederApplicationStatus.REJECTED)
        taxonError(409, Code.INVALID_TRANSITION);
      const parents = await manager
        .getRepository(BreederSpeciesPermission)
        .find({
          where: { applicationId },
          order: { speciesId: 'ASC', id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
      const children = await manager
        .getRepository(BreederSubspeciesPermission)
        .find({
          where: { applicationId },
          order: { speciesId: 'ASC', subspeciesId: 'ASC', id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
      const child = kind === Kind.SUBSPECIES;
      const permission = child
        ? children.find((p) => p.id === permissionId)
        : parents.find((p) => p.id === permissionId);
      if (!permission) taxonError(404, Code.NOT_FOUND);
      if (permission.revision !== input.expectedRevision)
        taxonError(409, Code.REVISION_CONFLICT);
      const next = nextPermissionState(permission.state, decision);
      if (
        child &&
        next === State.APPROVED &&
        !parents.some(
          (p) =>
            p.id ===
              (permission as BreederSubspeciesPermission).speciesPermissionId &&
            p.state === State.APPROVED,
        )
      )
        taxonError(409, Code.INVALID_TRANSITION);
      const affectedChildren = child
        ? [permission as BreederSubspeciesPermission]
        : children.filter(
            (p) =>
              p.speciesPermissionId === permission.id &&
              p.state === State.APPROVED,
          );
      if (decision === Decision.REVOKE) {
        // Product unpublication/fulfillment is a later phase. Never silently
        // revoke permission while its published BREEDER Product remains live.
        const ids = (
          child
            ? affectedChildren
            : children.filter((p) => p.speciesPermissionId === permission.id)
        ).map((p) => p.id);
        if (
          ids.length &&
          (await manager
            .getRepository(ParrotSaleListing)
            .createQueryBuilder('listing')
            .innerJoin(Product, 'product', 'product.id = listing."productId"')
            .where('listing."submissionKind" = :kind', {
              kind: ListingSubmissionKind.BREEDER,
            })
            .andWhere('listing."breederSubspeciesPermissionId" IN (:...ids)', {
              ids,
            })
            .andWhere('product.status = :status', {
              status: ProductStatus.PUBLISHED,
            })
            .getExists())
        )
          taxonError(409, Code.UNPUBLISH_REQUIRED);
        if (!child) {
          for (const affected of affectedChildren) {
            const from = affected.state;
            affected.state = State.REVOKED;
            affected.revision++;
            await manager
              .getRepository(BreederSubspeciesPermission)
              .save(affected);
            await this.event(
              manager,
              affected,
              true,
              Action.REVOKE,
              from,
              'ADMIN',
              normalizedActor,
              input.reason,
              input.requestId,
              hash,
            );
          }
        }
      }
      const from = permission.state;
      permission.state = next;
      permission.revision++;
      if (child)
        await manager
          .getRepository(BreederSubspeciesPermission)
          .save(permission as BreederSubspeciesPermission);
      else
        await manager.getRepository(BreederSpeciesPermission).save(permission);
      await this.event(
        manager,
        permission,
        child,
        decision.toUpperCase() as Action,
        from,
        'ADMIN',
        normalizedActor,
        input.reason,
        input.requestId,
        hash,
      );
      return this.response(manager, application, true);
    });
  }

  private async lockApplication(
    manager: EntityManager,
    id: string,
    owner?: string,
  ) {
    const repository = manager.getRepository(BreederApplication);
    const initial = await repository.findOne({
      where: { id, ...(owner ? { userId: owner } : {}) },
    });
    if (!initial) taxonError(404, Code.NOT_FOUND);
    await lockSellerLifecycle(manager, initial.userId);
    // Same ordering as application approval/revocation; parents before children.
    const application = await repository.findOne({
      where: { id, userId: initial.userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!application || (owner && application.userId !== owner))
      taxonError(404, Code.NOT_FOUND);
    const user = await manager.getRepository(User).findOne({
      where: { id: application.userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user) taxonError(404, Code.NOT_FOUND);
    return { application, user };
  }

  private async assertCurrent(
    manager: EntityManager,
    application: BreederApplication,
  ) {
    const current = await manager.getRepository(BreederApplication).findOne({
      where: { userId: application.userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    if (current?.id !== application.id) taxonError(409, Code.NOT_CURRENT);
  }

  private async assertEligible(
    manager: EntityManager,
    application: BreederApplication,
    user: User,
    granting: boolean,
  ) {
    if (
      application.revokedAt ||
      ![
        BreederApplicationStatus.PENDING_CALL,
        BreederApplicationStatus.FOLLOW_UP,
        BreederApplicationStatus.APPROVED,
      ].includes(application.status) ||
      !user.isActive ||
      !isCustomerRole(user.role) ||
      !user.phoneVerifiedAt ||
      (application.status === BreederApplicationStatus.APPROVED
        ? user.role !== UserRole.BREEDER
        : user.role !== UserRole.CUSTOMER) ||
      (granting &&
        (application.status !== BreederApplicationStatus.APPROVED ||
          application.callOutcome !== BreederCallOutcome.SUCCESSFUL ||
          !application.contactedAt))
    )
      taxonError(403, Code.NOT_ELIGIBLE);
    await this.eligibility.assertEligibleSellerInTransaction(user.id, manager);
  }

  private hash(value: object) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private async replay(
    manager: EntityManager,
    applicationId: string,
    requestId: string,
    hash: string,
  ) {
    const events = await manager
      .getRepository(BreederPermissionEvent)
      .find({ where: { applicationId, requestId } });
    if (events.some((event) => event.requestHash !== hash))
      taxonError(409, Code.IDEMPOTENCY_CONFLICT);
    return events.length > 0;
  }

  private async event(
    manager: EntityManager,
    permission: BreederSpeciesPermission | BreederSubspeciesPermission,
    child: boolean,
    action: Action,
    fromState: State | null,
    actorType: 'CUSTOMER' | 'ADMIN',
    actorId: string,
    reason: string | null,
    requestId: string,
    requestHash: string,
  ) {
    await manager.getRepository(BreederPermissionEvent).insert({
      applicationId: permission.applicationId,
      speciesPermissionId: child ? null : permission.id,
      subspeciesPermissionId: child ? permission.id : null,
      revision: permission.revision,
      action,
      fromState,
      toState: permission.state,
      actorType,
      actorId,
      reason,
      requestId,
      requestHash,
      affectedListingCount: 0,
      affectedProductCount: 0,
    });
  }

  private async response(
    manager: EntityManager,
    application: BreederApplication,
    admin: boolean,
  ) {
    const parents = await manager.getRepository(BreederSpeciesPermission).find({
      where: { applicationId: application.id },
      order: { speciesId: 'ASC', id: 'ASC' },
    });
    const children = await manager
      .getRepository(BreederSubspeciesPermission)
      .find({
        where: { applicationId: application.id },
        order: { subspeciesId: 'ASC', id: 'ASC' },
      });
    const events = admin
      ? await manager.getRepository(BreederPermissionEvent).find({
          where: { applicationId: application.id },
          order: { occurredAt: 'ASC', id: 'ASC' },
        })
      : [];
    const current = await manager.getRepository(BreederApplication).findOne({
      where: { userId: application.userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const user = await manager
      .getRepository(User)
      .findOne({ where: { id: application.userId } });
    const sellerEligible = (
      await this.eligibility.canSubmitParrotSaleListingInTransaction(
        application.userId,
        manager,
      )
    ).eligible;
    const canRequestTaxa =
      current?.id === application.id &&
      !application.revokedAt &&
      sellerEligible &&
      Boolean(user?.isActive && user.phoneVerifiedAt) &&
      (application.status === BreederApplicationStatus.APPROVED
        ? user?.role === UserRole.BREEDER
        : [
            BreederApplicationStatus.PENDING_CALL,
            BreederApplicationStatus.FOLLOW_UP,
          ].includes(application.status) && user?.role === UserRole.CUSTOMER);
    const canUsePermissions =
      canRequestTaxa &&
      application.status === BreederApplicationStatus.APPROVED &&
      application.callOutcome === BreederCallOutcome.SUCCESSFUL &&
      Boolean(application.contactedAt);
    const summary = (
      p: BreederSpeciesPermission | BreederSubspeciesPermission,
    ) => ({
      id: p.id,
      speciesId: p.speciesId,
      state: p.state,
      revision: p.revision,
    });
    return {
      applicationId: application.id,
      applicationStatus: application.status,
      revoked: Boolean(application.revokedAt),
      isCurrent: current?.id === application.id,
      canRequestTaxa,
      speciesPermissions: parents.map((p) => ({
        ...summary(p),
        effectiveApproved: canUsePermissions && p.state === State.APPROVED,
        subspeciesPermissions: children
          .filter((c) => c.speciesPermissionId === p.id)
          .map((c) => ({
            ...summary(c),
            subspeciesId: c.subspeciesId,
            effectiveApproved:
              canUsePermissions &&
              p.state === State.APPROVED &&
              c.state === State.APPROVED,
          })),
      })),
      ...(admin
        ? {
            events: events.map((event) => ({
              id: event.id,
              speciesPermissionId: event.speciesPermissionId,
              subspeciesPermissionId: event.subspeciesPermissionId,
              revision: event.revision,
              action: event.action,
              fromState: event.fromState,
              toState: event.toState,
              actorType: event.actorType,
              actorId: event.actorId,
              reason: event.reason,
              occurredAt: event.occurredAt,
            })),
          }
        : {}),
    };
  }

  private async transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.source.transaction(work);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        ['23505', '23514', '23503', '40001', '40P01'].includes(
          (error.driverError as { code?: string }).code ?? '',
        )
      )
        taxonError(409, Code.INVALID_TRANSITION);
      throw error;
    }
  }
}
