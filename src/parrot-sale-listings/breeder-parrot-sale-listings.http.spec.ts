import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { BreederParrotSaleListingsController } from './breeder-parrot-sale-listings.controller';
import { ParrotSaleListingsController } from './parrot-sale-listings.controller';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';

describe('dedicated breeder listing HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const input = {
    name: 'Bird',
    speciesId: '123e4567-e89b-42d3-a456-426614174000',
    subspeciesId: '223e4567-e89b-42d3-a456-426614174000',
    requestedPrice: 100,
  };
  const result = {
    id: 'listing',
    status: 'DRAFT',
    submissionKind: 'BREEDER',
    images: [],
  };
  const service = {
    createBreeder: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(result),
    create: jest
      .fn()
      .mockResolvedValue({ ...result, submissionKind: 'ORDINARY' }),
  };
  const auth: CanActivate = {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string>;
        user?: { id: string; role: string };
      }>();
      if (!req.headers.authorization) throw new UnauthorizedException();
      req.user = { id: 'server-owner', role: req.headers.authorization };
      return true;
    },
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        BreederParrotSaleListingsController,
        ParrotSaleListingsController,
      ],
      providers: [{ provide: ParrotSaleListingsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(auth)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer() as Server;
  });
  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());
  it('authenticates and uses server identity; strips spoofed kind, actor, linkage and state', async () => {
    const response = await request(server)
      .post('/breeder-parrot-sale-listings')
      .set('Authorization', 'breeder')
      .send({
        ...input,
        submissionKind: 'ORDINARY',
        sellerUserId: 'attacker',
        breederApplicationId: 'attacker',
        status: 'APPROVED',
        actorId: 'attacker',
      })
      .expect(201);
    expect(service.createBreeder).toHaveBeenCalledWith('server-owner', input);
    expect(service.create).not.toHaveBeenCalled();
    expect((response.body as { submissionKind: string }).submissionKind).toBe(
      'BREEDER',
    );
    expect(response.text).not.toMatch(/storageKey|actorId|attacker/);
  });
  it('normalizes uppercase v5 IDs for create and PATCH without accepting grant metadata', async () => {
    const speciesId = input.speciesId.replace('-42d3-', '-52d3-'),
      subspeciesId = input.subspeciesId.replace('-42d3-', '-52d3-');
    await request(server)
      .post('/breeder-parrot-sale-listings')
      .set('Authorization', 'breeder')
      .send({
        ...input,
        speciesId: ' ' + speciesId.toUpperCase() + ' ',
        subspeciesId: subspeciesId.toUpperCase(),
      })
      .expect(201);
    expect(service.createBreeder).toHaveBeenCalledWith('server-owner', {
      ...input,
      speciesId,
      subspeciesId,
    });
    await request(server)
      .patch('/parrot-sale-listings/323e4567-e89b-42d3-a456-426614174000')
      .set('Authorization', 'breeder')
      .send({
        speciesId: speciesId.toUpperCase(),
        subspeciesId: subspeciesId.toUpperCase(),
        breederSubspeciesPermissionId: 'spoof',
      })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(
      'server-owner',
      '323e4567-e89b-42d3-a456-426614174000',
      { speciesId, subspeciesId },
    );
  });
  it.each([null, [], {}, 42, 'invalid'])(
    'returns 400 for malformed PATCH taxon ID %j',
    async (speciesId: unknown) => {
      await request(server)
        .patch('/parrot-sale-listings/323e4567-e89b-42d3-a456-426614174000')
        .set('Authorization', 'breeder')
        .send({ speciesId, subspeciesId: input.subspeciesId })
        .expect(400);
      expect(service.update).not.toHaveBeenCalled();
    },
  );
  it('ordinary route strips spoofed breeder kind and retains its own create path', async () => {
    await request(server)
      .post('/parrot-sale-listings')
      .set('Authorization', 'breeder')
      .send({
        name: 'Bird',
        species: 'Existing',
        requestedPrice: 100,
        submissionKind: 'BREEDER',
        ...{ speciesId: input.speciesId },
      })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith('server-owner', {
      name: 'Bird',
      species: 'Existing',
      requestedPrice: 100,
    });
    expect(service.createBreeder).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, speciesId: undefined },
    { ...input, subspeciesId: null },
    { ...input, speciesId: 'label' },
    { ...input, requestedPrice: -1 },
  ])('rejects malformed breeder create', async (payload) => {
    await request(server)
      .post('/breeder-parrot-sale-listings')
      .set('Authorization', 'breeder')
      .send(payload)
      .expect(400);
    expect(service.createBreeder).not.toHaveBeenCalled();
  });
  it('preserves unauthenticated and ADMIN denial', async () => {
    await request(server)
      .post('/breeder-parrot-sale-listings')
      .send(input)
      .expect(401);
    await request(server)
      .post('/breeder-parrot-sale-listings')
      .set('Authorization', 'admin')
      .send(input)
      .expect(403);
    expect(service.createBreeder).not.toHaveBeenCalled();
    expect(
      Reflect.getMetadata('__guards__', BreederParrotSaleListingsController),
    ).toEqual([JwtAuthGuard, CustomerCapabilityGuard]);
  });
});
