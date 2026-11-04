import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './configure-app.ts';

const app = await NestFactory.create(AppModule, { bodyParser: false });
configureApp(app);
app.enableShutdownHooks();
const port = Number(process.env.API_PORT ?? 4000);
await app.listen(port);
console.log(`API 已啟動：http://localhost:${port}`);
