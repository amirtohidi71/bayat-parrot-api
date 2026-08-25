import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

const MINIMUM_PRODUCTION_SECRET_BYTES = 32;

export function createSalesChatJwtService(config: ConfigService): JwtService {
  const production =
    config.get<string>('NODE_ENV')?.trim().toLowerCase() === 'production';
  const salesSecret = config.get<string>('SALES_CHAT_JWT_SECRET')?.trim();
  const generalSecret = config.get<string>('JWT_SECRET')?.trim();

  if (production) {
    if (
      !salesSecret ||
      Buffer.byteLength(salesSecret, 'utf8') <
        MINIMUM_PRODUCTION_SECRET_BYTES ||
      salesSecret === generalSecret
    ) {
      throw new Error('SALES_CHAT_JWT_SECRET configuration is invalid');
    }
  }

  const secret = salesSecret || (!production ? generalSecret : undefined);
  if (!secret) {
    throw new Error('SALES_CHAT_JWT_SECRET configuration is invalid');
  }
  return new JwtService({ secret, signOptions: { expiresIn: '8h' } });
}
