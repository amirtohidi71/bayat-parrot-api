import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BreederPermissionDecision as Decision,
  DecideBreederPermissionDto,
  RequestBreederTaxaDto,
} from './breeder-taxon.dto';
import { BreederPermissionState as State } from './entities/breeder-species-permission.entity';
import {
  BreederTaxonService,
  nextPermissionState,
} from './breeder-taxon.service';
import { DataSource } from 'typeorm';
import { SellerEligibilityPolicy } from '../seller-onboarding/seller-eligibility.policy';
import { SubmitBreederApplicationDto } from '../seller-onboarding/dto/seller-onboarding.dto';

describe('Breeder taxon validation and transition policy', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    validationError: { target: false, value: false },
  });
  const selection = () => ({
    speciesId: randomUUID(),
    subspeciesIds: [randomUUID()],
  });
  const validate = (body: unknown, metatype = RequestBreederTaxaDto) =>
    pipe.transform(body, { type: 'body', metatype });

  it('accepts structured immutable IDs through the real Nest ValidationPipe', async () => {
    const body = { requestId: randomUUID(), selections: [selection()] };
    expect(await validate(body)).toEqual(body);
  });
  it('accepts structured application without legacy labels; rejects missing/null requests and legacy missing species', async () => {
    const base = {
      breederName: 'Fixture',
      city: 'City',
      experienceYears: 1,
      approximateBirdCount: 1,
      preferredContactTime: 'Morning',
    };
    const transform = (body: unknown) =>
      pipe.transform(body, {
        type: 'body',
        metatype: SubmitBreederApplicationDto,
      });
    await expect(
      transform({
        ...base,
        taxonRequest: { requestId: randomUUID(), selections: [selection()] },
      }),
    ).resolves.toBeInstanceOf(SubmitBreederApplicationDto);
    await expect(
      transform({ ...base, species: ['Legacy label'] }),
    ).resolves.toBeInstanceOf(SubmitBreederApplicationDto);
    for (const body of [
      base,
      { ...base, taxonRequest: null },
      { ...base, taxonRequest: {} },
    ])
      await expect(transform(body)).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    null,
    42,
    'free text',
    {},
    { speciesId: randomUUID(), subspeciesIds: [] },
  ])('rejects malformed selection %p', async (item) => {
    await expect(
      validate({ requestId: randomUUID(), selections: [item] }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects duplicate species and duplicate children', async () => {
    const item = selection();
    for (const body of [
      { requestId: randomUUID(), selections: [item, item] },
      {
        requestId: randomUUID(),
        selections: [
          {
            ...item,
            subspeciesIds: [item.subspeciesIds[0], item.subspeciesIds[0]],
          },
        ],
      },
    ])
      await expect(validate(body)).rejects.toMatchObject({ status: 400 });
  });
  it('strips unknown actor/approval fields recursively using production whitelist behavior', async () => {
    const item = selection(),
      clean = { requestId: randomUUID(), selections: [item] };
    expect(
      await validate({
        ...clean,
        actorId: 'forged',
        state: 'APPROVED',
        selections: [{ ...item, state: 'APPROVED', revision: 500 }],
      }),
    ).toEqual(clean);
  });
  it.each([
    [],
    [[]],
    [[[]]],
    null,
    true,
    42,
    'text',
    {},
    { requestId: randomUUID(), selections: [] },
  ])('rejects malformed initial taxonRequest %p', async (taxonRequest) => {
    await expect(
      pipe.transform(
        {
          breederName: 'Fixture',
          city: 'City',
          experienceYears: 1,
          approximateBirdCount: 1,
          preferredContactTime: 'Morning',
          taxonRequest,
        },
        { type: 'body', metatype: SubmitBreederApplicationDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([[], [[]], [[], []], [[{}]], null, true, 42, 'text', {}])(
    'rejects malformed selections container/items %p',
    async (selections) => {
      await expect(
        validate({ requestId: randomUUID(), selections }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
  it.each([
    [],
    [[]],
    [[randomUUID()]],
    [null],
    [{}],
    [42],
    [true],
    null,
    {},
    42,
    true,
    'text',
  ])('rejects malformed subspeciesIds %p', async (subspeciesIds) => {
    await expect(
      validate({
        requestId: randomUUID(),
        selections: [{ speciesId: randomUUID(), subspeciesIds }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    null,
    [],
    [[]],
    {},
    { selections: [[], []] },
    { requestId: randomUUID(), selections: [[], []] },
    { requestId: randomUUID(), selections: [selection(), null] },
  ])(
    'defensively returns 400 before repository access for malformed internal input %p',
    async (input) => {
      const source = new DataSource({ type: 'postgres' });
      const getRepository = jest.spyOn(source.manager, 'getRepository');
      const service = new BreederTaxonService(
        source,
        {} as SellerEligibilityPolicy,
      );
      await expect(
        service.validateSelections(
          source.manager,
          input as unknown as RequestBreederTaxaDto,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'BREEDER_TAXON_INVALID_SELECTION' },
      });
      expect(getRepository).not.toHaveBeenCalled();
    },
  );
  it.each(['1', true, null, 1.5, 0])(
    'rejects invalid expectedRevision %p',
    async (expectedRevision) => {
      await expect(
        pipe.transform(
          { requestId: randomUUID(), expectedRevision, reason: 'Decision' },
          { type: 'body', metatype: DecideBreederPermissionDto },
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
  it.each([[], [[]], [{}], null, true, 42, 'text', {}])(
    'rejects malformed admin mutation body %p',
    async (body) => {
      await expect(
        pipe.transform(body, {
          type: 'body',
          metatype: DecideBreederPermissionDto,
        }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
  it('requires a trimmed nonempty reason and a request UUID', async () => {
    for (const body of [
      { requestId: randomUUID(), expectedRevision: 1, reason: '  ' },
      { expectedRevision: 1, reason: 'Decision' },
    ])
      await expect(
        pipe.transform(body, {
          type: 'body',
          metatype: DecideBreederPermissionDto,
        }),
      ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    [State.REQUESTED, Decision.APPROVE, State.APPROVED],
    [State.REQUESTED, Decision.REJECT, State.REJECTED],
    [State.APPROVED, Decision.REVOKE, State.REVOKED],
    [State.REVOKED, Decision.REGRANT, State.APPROVED],
    [State.REJECTED, Decision.REGRANT, State.APPROVED],
  ])('permits explicit %s -> %s', (state, decision, next) =>
    expect(nextPermissionState(state, decision)).toBe(next),
  );
  it.each([
    [State.APPROVED, Decision.APPROVE],
    [State.APPROVED, Decision.REJECT],
    [State.REQUESTED, Decision.REGRANT],
    [State.REVOKED, Decision.APPROVE],
    [State.REJECTED, Decision.REVOKE],
  ])('rejects stale/invalid %s -> %s', (state, decision) => {
    expect(() => nextPermissionState(state, decision)).toThrow();
  });
});
