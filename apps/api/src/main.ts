import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
const port = Number(process.env.API_PORT ?? 4000);
await app.listen(port);
console.log(`API 已啟動：http://localhost:${port}`);
