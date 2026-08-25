import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getTrustedProxyClientIp } from '../../common/security/trusted-proxy-client-ip';

@Injectable()
export class SalesChatThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: Record<string, any>): Promise<string> {
    return Promise.resolve(getTrustedProxyClientIp(request));
  }
}
