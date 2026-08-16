import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const PUBLIC_BIRD_PASSPORT_REQUEST_FLOOR_MS = 200;
export const PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS = 30;
export const PUBLIC_BIRD_PASSPORT_TIMING_PRIMITIVES = Symbol(
  'PUBLIC_BIRD_PASSPORT_TIMING_PRIMITIVES',
);

export type PublicBirdPassportTimingPrimitives = {
  now: () => number;
  randomInteger: (minimum: number, maximum: number) => number;
  delay: (milliseconds: number) => Promise<void>;
};

export const publicBirdPassportTimingPrimitives: PublicBirdPassportTimingPrimitives =
  {
    now: () => performance.now(),
    randomInteger: randomInt,
    delay: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };

@Injectable()
export class PublicBirdPassportRequestTimingService {
  constructor(
    @Inject(PUBLIC_BIRD_PASSPORT_TIMING_PRIMITIVES)
    private readonly primitives: PublicBirdPassportTimingPrimitives,
  ) {}

  start(): number {
    return this.primitives.now();
  }

  async waitForFloor(startedAt: number): Promise<void> {
    const jitter = this.primitives.randomInteger(
      0,
      PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS + 1,
    );
    const target = PUBLIC_BIRD_PASSPORT_REQUEST_FLOOR_MS + jitter;
    const remaining = Math.max(0, target - (this.primitives.now() - startedAt));
    if (remaining > 0) await this.primitives.delay(remaining);
  }
}
