import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSalesChatJwtService } from './sales-chat-jwt.factory';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

describe('createSalesChatJwtService production isolation', () => {
  const generalSecret = 'general-jwt-secret-that-is-at-least-32-bytes';

  it('rejects a missing production Sales secret', () => {
    expect(() =>
      createSalesChatJwtService(
        config({ NODE_ENV: 'production', JWT_SECRET: generalSecret }),
      ),
    ).toThrow('SALES_CHAT_JWT_SECRET configuration is invalid');
  });

  it('rejects a short production Sales secret after trimming', () => {
    expect(() =>
      createSalesChatJwtService(
        config({
          NODE_ENV: 'production',
          JWT_SECRET: generalSecret,
          SALES_CHAT_JWT_SECRET: '  too-short  ',
        }),
      ),
    ).toThrow('SALES_CHAT_JWT_SECRET configuration is invalid');
  });

  it('rejects reuse of the general JWT secret', () => {
    expect(() =>
      createSalesChatJwtService(
        config({
          NODE_ENV: 'production',
          JWT_SECRET: generalSecret,
          SALES_CHAT_JWT_SECRET: `  ${generalSecret}  `,
        }),
      ),
    ).toThrow('SALES_CHAT_JWT_SECRET configuration is invalid');
  });

  it('accepts a strong independent production Sales secret', () => {
    expect(
      createSalesChatJwtService(
        config({
          NODE_ENV: 'production',
          JWT_SECRET: generalSecret,
          SALES_CHAT_JWT_SECRET:
            'independent-sales-secret-that-is-at-least-32-bytes',
        }),
      ),
    ).toBeInstanceOf(JwtService);
  });
});
