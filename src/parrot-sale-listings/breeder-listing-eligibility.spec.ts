import { EntityManager } from 'typeorm';
import { assertBreederListingEligibility } from './breeder-listing-eligibility';
import { BirdSpecies } from '../breeder-listings/entities/bird-species.entity';
import { BirdSubspecies } from '../breeder-listings/entities/bird-subspecies.entity';
import { BreederSpeciesPermission } from '../breeder-listings/entities/breeder-species-permission.entity';
import { BreederSubspeciesPermission } from '../breeder-listings/entities/breeder-subspecies-permission.entity';
import { BreederApplication } from '../seller-onboarding/entities/breeder-application.entity';
import { User } from '../users/entities/user.entity';

const SPECIES_ID = '123e4567-e89b-52d3-a456-426614174000';
const SUBSPECIES_ID = '223e4567-e89b-52d3-a456-426614174000';

function context() {
  const application = {
    id: 'application',
    userId: 'seller',
    status: 'APPROVED',
    revokedAt: null,
    callOutcome: 'SUCCESSFUL',
    contactedAt: new Date(),
  };
  const user = { role: 'breeder', isActive: true, phoneVerifiedAt: new Date() };
  const parent = { id: 'parent', speciesId: SPECIES_ID, state: 'APPROVED' };
  const child = {
    id: 'child',
    speciesId: SPECIES_ID,
    subspeciesId: SUBSPECIES_ID,
    state: 'APPROVED',
    speciesPermissionId: 'parent',
  };
  const rows = new Map<unknown, unknown>([
    [BreederApplication, application],
    [User, user],
    [BreederSpeciesPermission, parent],
    [BreederSubspeciesPermission, child],
    [BirdSpecies, { id: SPECIES_ID, displayName: 'Canonical species' }],
    [BirdSubspecies, { id: SUBSPECIES_ID, displayName: 'Canonical child' }],
  ]);
  const calls: unknown[] = [];
  const manager = {
    getRepository: jest.fn((entity: unknown) => {
      calls.push(entity);
      return {
        findOne: jest.fn().mockResolvedValue(rows.get(entity)),
        find: jest
          .fn()
          .mockResolvedValue(rows.get(entity) ? [rows.get(entity)] : []),
        findOneBy: jest.fn().mockResolvedValue(rows.get(entity)),
      };
    }),
  } as unknown as EntityManager;
  const selection = { speciesId: SPECIES_ID, subspeciesId: SUBSPECIES_ID };
  return { application, user, parent, child, rows, calls, manager, selection };
}

describe('breeder listing current permission policy', () => {
  it('resolves canonical snapshots through application/user/parent/child locking order', async () => {
    const v = context();
    await expect(
      assertBreederListingEligibility(v.manager, 'seller', v.selection),
    ).resolves.toEqual({
      ...v.selection,
      breederApplicationId: 'application',
      breederSubspeciesPermissionId: 'child',
      species: 'Canonical species',
      subspecies: 'Canonical child',
    });
    expect(v.calls.slice(0, 4)).toEqual([
      BreederApplication,
      User,
      BreederSpeciesPermission,
      BreederSubspeciesPermission,
    ]);
  });
  it('normalizes uppercase supported UUIDs for service calls and original taxon checks', async () => {
    const v = context();
    const input = {
      speciesId: ' ' + SPECIES_ID.toUpperCase() + ' ',
      subspeciesId: SUBSPECIES_ID.toUpperCase(),
    };
    await expect(
      assertBreederListingEligibility(v.manager, 'seller', input, input),
    ).resolves.toMatchObject(v.selection);
  });
  it.each([null, '', 'not-a-uuid', 42, [], {}])(
    'rejects malformed IDs before repository queries: %j',
    async (speciesId: unknown) => {
      const v = context();
      await expect(
        assertBreederListingEligibility(v.manager, 'seller', {
          ...v.selection,
          speciesId,
        } as never),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'BREEDER_TAXON_INVALID_SELECTION' },
      });
      expect(v.calls).toEqual([]);
    },
  );
  it('uppercase input never revives a revoked grant', async () => {
    const v = context();
    v.child.state = 'REVOKED';
    await expect(
      assertBreederListingEligibility(v.manager, 'seller', {
        speciesId: SPECIES_ID.toUpperCase(),
        subspeciesId: SUBSPECIES_ID.toUpperCase(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'BREEDER_LISTING_NOT_ELIGIBLE' },
    });
  });
  it.each([
    'parent-only',
    'revoked-child',
    'revoked-parent',
    'stale-role',
    'inactive',
    'revoked-application',
    'old-application',
    'wrong-parent',
    'old-permission',
    'missing-child',
  ] as const)('denies %s', async (scenario) => {
    const v = context();
    const selection: typeof v.selection & {
      breederApplicationId?: string;
      breederSubspeciesPermissionId?: string;
    } = { ...v.selection };
    if (scenario === 'parent-only') v.child.state = 'REQUESTED';
    if (scenario === 'revoked-child') v.child.state = 'REVOKED';
    if (scenario === 'revoked-parent') v.parent.state = 'REVOKED';
    if (scenario === 'stale-role') v.user.role = 'customer';
    if (scenario === 'inactive') v.user.isActive = false;
    if (scenario === 'revoked-application')
      Object.assign(v.application, { revokedAt: new Date() });
    if (scenario === 'old-application')
      selection.breederApplicationId = 'historical';
    if (scenario === 'old-permission')
      selection.breederSubspeciesPermissionId = 'historical';
    if (scenario === 'wrong-parent') v.child.speciesPermissionId = 'other';
    if (scenario === 'missing-child')
      v.rows.set(BreederSubspeciesPermission, null);
    await expect(
      assertBreederListingEligibility(v.manager, 'seller', selection),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'BREEDER_LISTING_NOT_ELIGIBLE' },
    });
  });
});
