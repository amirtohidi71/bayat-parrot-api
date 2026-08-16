import { PublicBirdPassportBackgroundScheduler } from './public-bird-passport-background-scheduler';

describe('PublicBirdPassportBackgroundScheduler', () => {
  it('attaches a terminal catch to asynchronous task rejection', async () => {
    const scheduler = new PublicBirdPassportBackgroundScheduler();
    await new Promise<void>((resolve) => {
      scheduler.schedule(
        () => Promise.reject(new Error('background failure')),
        resolve,
      );
    });
  });
});
