import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getBirdPassportClientIp } from './public-bird-passport-client-ip';

@Injectable()
export class PublicBirdPassportThrottlerGuard extends ThrottlerGuard {
  canActivate(context: ExecutionContext): Promise<boolean> {
    context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>()
      .setHeader('Cache-Control', 'no-store');
    return super.canActivate(context);
  }

  protected getTracker(request: Record<string, any>): Promise<string> {
    return Promise.resolve(getBirdPassportClientIp(request));
  }
}
