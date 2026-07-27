import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { IppanelClient } from './ippanel.client';
import {
  SMS_HTTP_TRANSPORT,
  SMS_RUNTIME_CONFIG,
  createSmsRuntimeConfig,
} from './sms.types';

@Module({
  providers: [
    {
      provide: SMS_RUNTIME_CONFIG,
      inject: [ConfigService],
      useFactory: createSmsRuntimeConfig,
    },
    {
      provide: SMS_HTTP_TRANSPORT,
      useFactory: () => globalThis.fetch.bind(globalThis),
    },
    IppanelClient,
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
