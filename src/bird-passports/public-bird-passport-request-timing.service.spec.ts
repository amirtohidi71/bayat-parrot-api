import {
  PUBLIC_BIRD_PASSPORT_REQUEST_FLOOR_MS,
  PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS,
  PublicBirdPassportRequestTimingService,
} from './public-bird-passport-request-timing.service';

describe('PublicBirdPassportRequestTimingService', () => {
  it('pads to the floor plus bounded jitter without a real sleep', async () => {
    const delay = jest.fn().mockResolvedValue(undefined);
    const primitives = {
      now: jest.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_050),
      randomInteger: jest.fn(() => PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS),
      delay,
    };
    const service = new PublicBirdPassportRequestTimingService(primitives);
    const startedAt = service.start();
    await service.waitForFloor(startedAt);
    expect(primitives.randomInteger).toHaveBeenCalledWith(
      0,
      PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS + 1,
    );
    expect(delay).toHaveBeenCalledWith(
      PUBLIC_BIRD_PASSPORT_REQUEST_FLOOR_MS +
        PUBLIC_BIRD_PASSPORT_REQUEST_JITTER_MAX_MS -
        50,
    );
  });

  it('does not add delay after the bounded target has already elapsed', async () => {
    const primitives = {
      now: jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(500),
      randomInteger: jest.fn(() => 0),
      delay: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PublicBirdPassportRequestTimingService(primitives);
    await service.waitForFloor(service.start());
    expect(primitives.delay).not.toHaveBeenCalled();
  });
});
