import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BIRD_PASSPORT_LOOKUP_COOKIE,
  BIRD_PASSPORT_LOOKUP_SCOPE,
  BirdPassportLookupGrant,
  BirdPassportLookupGrantService,
} from './bird-passport-lookup-grant.service';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type BirdPassportGrantRequest = {
  headers: { cookie?: string | string[] };
  birdPassportGrant?: Pick<
    BirdPassportLookupGrant,
    'scope' | 'passportId' | 'jti'
  >;
};

export function readStrictCookie(
  header: string | string[] | undefined,
  cookieName: string,
): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !COOKIE_NAME_PATTERN.test(cookieName)) {
    throw new Error('Malformed cookie header');
  }

  let result: string | undefined;
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    if (separator <= 0) throw new Error('Malformed cookie header');
    const name = part.slice(0, separator).trim();
    if (!COOKIE_NAME_PATTERN.test(name)) {
      throw new Error('Malformed cookie header');
    }
    if (name !== cookieName) continue;
    if (result !== undefined) throw new Error('Duplicate lookup cookie');
    const encodedValue = part.slice(separator + 1);
    if (!encodedValue || /[\s;,]/.test(encodedValue)) {
      throw new Error('Malformed lookup cookie');
    }
    result = decodeURIComponent(encodedValue);
  }
  return result;
}

@Injectable()
export class BirdPassportLookupGuard implements CanActivate {
  constructor(private readonly grants: BirdPassportLookupGrantService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<BirdPassportGrantRequest>();
    try {
      const token = readStrictCookie(
        request.headers.cookie,
        BIRD_PASSPORT_LOOKUP_COOKIE,
      );
      if (!token) throw new Error('Missing lookup cookie');
      const grant = this.grants.verify(token);
      if (
        grant.scope !== BIRD_PASSPORT_LOOKUP_SCOPE ||
        typeof grant.passportId !== 'string' ||
        !UUID_V4_PATTERN.test(grant.passportId) ||
        typeof grant.jti !== 'string' ||
        !UUID_V4_PATTERN.test(grant.jti) ||
        !Number.isInteger(grant.iat) ||
        !Number.isInteger(grant.exp) ||
        grant.exp * 1000 <= Date.now()
      ) {
        throw new Error('Invalid lookup grant');
      }
      request.birdPassportGrant = {
        scope: grant.scope,
        passportId: grant.passportId,
        jti: grant.jti,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Bird passport access is unauthorized');
    }
  }
}
