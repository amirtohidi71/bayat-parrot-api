import { requireTaxonUuid } from '../breeder-listings/breeder-taxon.uuid';
import { EntityManager } from 'typeorm';
import { BirdSpecies } from '../breeder-listings/entities/bird-species.entity';
import { BirdSubspecies } from '../breeder-listings/entities/bird-subspecies.entity';
import {
  BreederSpeciesPermission,
  BreederPermissionState,
} from '../breeder-listings/entities/breeder-species-permission.entity';
import { BreederSubspeciesPermission } from '../breeder-listings/entities/breeder-subspecies-permission.entity';
import {
  BreederApplication,
  BreederApplicationStatus,
  BreederCallOutcome,
} from '../seller-onboarding/entities/breeder-application.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { parrotSaleListingError } from './parrot-sale-listing.errors';

type BreederListingSelection = {
  speciesId: string | null;
  subspeciesId: string | null;
  breederApplicationId?: string | null;
  breederSubspeciesPermissionId?: string | null;
};

// Caller must own lockSellerLifecycle for this seller. This serializes listing
// writes/publication with application and permission changes. Keep the same
// Application -> User -> parent -> child row ordering as the taxon API.
export async function assertBreederListingEligibility(
  manager: EntityManager,
  sellerUserId: string,
  selection: BreederListingSelection,
  original?: BreederListingSelection,
) {
  function denied(): never {
    throw parrotSaleListingError(
      403,
      'BREEDER_LISTING_NOT_ELIGIBLE',
      'An active breeder approval and explicit species/subspecies grants are required.',
    );
  }
  // Direct service callers receive the same validation as HTTP callers.
  selection = {
    ...selection,
    speciesId: requireTaxonUuid(selection.speciesId),
    subspeciesId: requireTaxonUuid(selection.subspeciesId),
  };
  if (original)
    original = {
      ...original,
      speciesId: requireTaxonUuid(original.speciesId),
      subspeciesId: requireTaxonUuid(original.subspeciesId),
    };
  const application = await manager.getRepository(BreederApplication).findOne({
    where: { userId: sellerUserId },
    order: { createdAt: 'DESC', id: 'DESC' },
    lock: { mode: 'pessimistic_write' },
  });
  const user = await manager.getRepository(User).findOne({
    where: { id: sellerUserId },
    lock: { mode: 'pessimistic_write' },
  });
  if (
    !application ||
    application.status !== BreederApplicationStatus.APPROVED ||
    application.revokedAt ||
    application.callOutcome !== BreederCallOutcome.SUCCESSFUL ||
    !application.contactedAt ||
    !user?.isActive ||
    !user.phoneVerifiedAt ||
    user.role !== UserRole.BREEDER ||
    (selection.breederApplicationId &&
      selection.breederApplicationId !== application.id) ||
    !selection.speciesId ||
    !selection.subspeciesId
  )
    denied();
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
  const permissionFor = (candidate: BreederListingSelection) => {
    const parent = parents.find((p) => p.speciesId === candidate.speciesId);
    const child = children.find(
      (p) =>
        p.speciesId === candidate.speciesId &&
        p.subspeciesId === candidate.subspeciesId,
    );
    if (
      !parent ||
      parent.state !== BreederPermissionState.APPROVED ||
      !child ||
      child.state !== BreederPermissionState.APPROVED ||
      child.speciesPermissionId !== parent.id ||
      (candidate.breederApplicationId &&
        candidate.breederApplicationId !== application.id) ||
      (candidate.breederSubspeciesPermissionId &&
        candidate.breederSubspeciesPermissionId !== child.id)
    )
      denied();
    return child;
  };
  // A taxon edit cannot escape a revoked original grant. Both the original
  // linkage and proposed target must still be authorized in this application.
  if (original) permissionFor(original);
  const child = permissionFor(selection);
  const species = await manager
    .getRepository(BirdSpecies)
    .findOneBy({ id: selection.speciesId });
  const subspecies = await manager
    .getRepository(BirdSubspecies)
    .findOneBy({ id: selection.subspeciesId, speciesId: selection.speciesId });
  if (!species || !subspecies) denied();
  return {
    breederApplicationId: application.id,
    breederSubspeciesPermissionId: child.id,
    speciesId: species.id,
    subspeciesId: subspecies.id,
    species: species.displayName,
    subspecies: subspecies.displayName,
  };
}
