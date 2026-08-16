import { Injectable } from '@nestjs/common';

@Injectable()
export class PublicBirdPassportBackgroundScheduler {
  schedule(task: () => Promise<void>, onUnexpectedFailure: () => void): void {
    setImmediate(() => {
      task().catch(onUnexpectedFailure);
    });
  }
}
