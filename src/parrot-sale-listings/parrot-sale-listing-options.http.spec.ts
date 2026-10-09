import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { CustomerCapabilityGuard } from '../auth/guards/customer-capability.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ParrotSaleListingsController } from './parrot-sale-listings.controller';
import { ParrotSaleListingsService } from './parrot-sale-listings.service';

type OptionsResponse = {
  species: string[];
  subspeciesBySpecies: Record<string, string[]>;
  colors: string[];
};

describe('ParrotSaleListingsController options HTTP', () => {
  let app: INestApplication;
  let server: Server;
  const options: OptionsResponse = {
    species: ['african-grey'],
    subspeciesBySpecies: { 'african-grey': ['red-tail'] },
    colors: ['gray'],
  };
  const service = {
    getOptions: jest.fn().mockResolvedValue(options),
  };
  const authenticatedGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<{
        user?: { id: string; role: string };
      }>();
      request.user = { id: 'seller-id', role: 'customer' };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ParrotSaleListingsController],
      providers: [{ provide: ParrotSaleListingsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authenticatedGuard)
      .overrideGuard(CustomerCapabilityGuard)
      .useValue(authenticatedGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => app?.close());

  it('serves only the allowlisted real-data option structure', async () => {
    const response = await request(server)
      .get('/parrot-sale-listings/options')
      .expect(200);
    const body = response.body as OptionsResponse;
    expect(body).toEqual(options);
    expect(Object.keys(body).sort()).toEqual([
      'colors',
      'species',
      'subspeciesBySpecies',
    ]);
    expect(response.text).not.toContain('requestedPrice');
    expect(response.text).not.toContain('storageKey');
    expect(service.getOptions).toHaveBeenCalledTimes(1);
  });
});
