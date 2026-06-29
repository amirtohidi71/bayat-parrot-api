import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(join(process.cwd(), 'public', 'uploads'), { prefix: '/uploads' });
  app.enableCors({
    origin: 'http://localhost:3000',
    credentials: true,
  });

  const validationLogger = new Logger('ValidationPipe');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        validationLogger.debug(`Request body validation failed: ${JSON.stringify(errors)}`);
        return new BadRequestException(errors);
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Bayat Parrot API')
    .setDescription('API documentation for the Bayat Parrot pet shop backend')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, swaggerDocument);

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
