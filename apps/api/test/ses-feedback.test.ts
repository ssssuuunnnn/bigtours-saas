import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateToken, hashPassword, hashToken } from '@bigtours/shared/crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureApp, SES_WEBHOOK_PATH } from '../src/agency-path.ts';
import { AppModule } from '../src/app.module.ts';
import { DatabaseService } from '../src/database.service.ts';
import { sesMessageId } from '../src/mail.service.ts';
import { NotificationService } from '../src/notification.service.ts';
import { feedbackError, SesFeedbackService } from '../src/ses-feedback.service.ts';

const TOPIC = 'arn:aws:sns:ap-southeast-2:111122223333:bigtours-ses-feedback';
const CERT_URL = 'https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-test.pem';
const SUBSCRIBE_URL = 'https://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=y';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }) as string;

let app: INestApplication;
let admin: pg.Client;
let tierId: string;
let knownHash: string;
let fetched: string[];

const q1 = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

const FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

function signed(fields: Record<string, string>, { version = '2', key = keys.privateKey }: { version?: string; key?: typeof keys.privateKey } = {}) {
  const message: Record<string, string> = {
    MessageId: randomUUID(), Timestamp: '2026-11-09T14:00:00.000Z', TopicArn: TOPIC, Message: '{}', ...fields,
    SignatureVersion: version, SigningCertURL: fields.SigningCertURL ?? CERT_URL,
  };
  const canonical = FIELDS[message.Type!]!.filter((f) => message[f] !== undefined).map((f) => `${f}\n${message[f]}\n`).join('');
  message.Signature = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256').update(canonical, 'utf8').sign(key, 'base64');
  return message;
}

/** SNS 實際上用 text/plain 送出 JSON。 */
const post = (message: unknown) => request(app.getHttpServer()).post(SES_WEBHOOK_PATH).set('content-type', 'text/plain; charset=UTF-8').send(JSON.stringify(message));

const bounce = (messageId: string, bounceType = 'Permanent', bounceSubType = 'General') => signed({
  Type: 'Notification',
  Message: JSON.stringify({
    notificationType: 'Bounce', mail: { messageId },
    bounce: { bounceType, bounceSubType, bouncedRecipients: [{ emailAddress: 'x@example.com', diagnosticCode: 'smtp; 550 user unknown' }] },
  }),
});
const complaint = (messageId: string, complaintFeedbackType = 'abuse') => signed({
  Type: 'Notification',
  Message: JSON.stringify({ notificationType: 'Complaint', mail: { messageId }, complaint: { complaintFeedbackType, complainedRecipients: [{ emailAddress: 'x@example.com' }] } }),
});

async function fixture() {
  const code = `s-${randomUUID().slice(0, 8)}`;
  const agencyId = (await q1(`INSERT INTO agencies (code, name) VALUES ($1, 'T') RETURNING id`, [code])).id as string;
  const company = (await q1(`INSERT INTO companies (agency_id, name) VALUES ($1, '企業') RETURNING id`, [agencyId])).id as string;
  const eventId = (await q1(
    `INSERT INTO events (agency_id, company_id, slug, name, status, pricing_tier_id, registration_opens_at, registration_closes_at)
     VALUES ($1, $2, 'evt', '活動', 'published', $3, now() - interval '1 day', now() + interval '30 days') RETURNING id`,
    [agencyId, company, tierId],
  )).id as string;
  const userId = (await q1(`INSERT INTO agency_users (agency_id, email, password_hash, name, role) VALUES ($1, $2, $3, '承辦', 'admin') RETURNING id`,
    [agencyId, `${code}@example.com`, knownHash])).id;
  const token = generateToken();
  await admin.query(`INSERT INTO agency_user_sessions (agency_id, agency_user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [agencyId, userId, hashToken(process.env.TOKEN_HASH_KEY!, token)]);
  const emails = async () => (await request(app.getHttpServer()).get(`/api/v1/a/${code}/agency/events/${eventId}/emails`).set('cookie', `bt_agency_session=${token}`).expect(200)).body;
  return { agencyId, eventId, emails };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function sentMessage(f: Fixture, status = 'sent') {
  const providerId = `ses-${randomUUID()}`;
  await admin.query(
    `INSERT INTO email_messages (agency_id, event_id, recipient_email, template_key, idempotency_key, status, provider_message_id) VALUES ($1, $2, 'x@example.com', 'deadline_reminder', $3, $4, $5)`,
    [f.agencyId, f.eventId, randomUUID(), status, providerId],
  );
  return providerId;
}
const row = (providerId: string) => q1(`SELECT status, error FROM email_messages WHERE provider_message_id = $1`, [providerId]);

beforeAll(async () => {
  process.env.SES_SNS_TOPIC_ARN = TOPIC;
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  tierId = (await q1(`INSERT INTO pricing_tiers (min_travelers, max_travelers, price_amount) VALUES (1, 5000, 500)
                      ON CONFLICT (min_travelers, max_travelers) DO UPDATE SET price_amount = EXCLUDED.price_amount RETURNING id`)).id;
  knownHash = await hashPassword('abcd1234');
  app = configureApp(await NestFactory.create(AppModule, { logger: false }));
  await app.init();
  await app.listen(0);
});

beforeEach(() => {
  process.env.SES_SNS_TOPIC_ARN = TOPIC;
  fetched = [];
  app.get(SesFeedbackService).fetchText = async (url) => {
    fetched.push(url);
    return url.endsWith('.pem') ? PUBLIC_PEM : 'ok';
  };
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('SES 退信與客訴通知', () => {
  it('沒有設定 Topic 時端點不存在', async () => {
    delete process.env.SES_SNS_TOPIC_ARN;
    await post(bounce('x')).expect(404);
    expect(fetched).toEqual([]);
  });

  it('其他 Topic、偽造簽章、竄改內容都拒絕，且不處理內容', async () => {
    const f = await fixture();
    const id = await sentMessage(f);
    await post({ ...bounce(id), TopicArn: 'arn:aws:sns:ap-southeast-2:999999999999:evil' }).expect(403);
    expect(fetched).toEqual([]);
    await post(signed({ Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', mail: { messageId: id }, bounce: { bounceType: 'Permanent' } }) }, { key: otherKeys.privateKey })).expect(403);
    await post({ ...bounce(id), Message: JSON.stringify({ notificationType: 'Bounce', mail: { messageId: `${id}x` } }) }).expect(403);
    await post({ ...bounce(id), Signature: undefined }).expect(403);
    await request(app.getHttpServer()).post(SES_WEBHOOK_PATH).set('content-type', 'text/plain').send('not json').expect(403);
    expect((await row(id)).status).toBe('sent');
  });

  it('憑證網址不是 SNS 的 HTTPS 網址時，不會去下載', async () => {
    for (const SigningCertURL of [
      'http://sns.ap-southeast-2.amazonaws.com/a.pem',
      'https://evil.example.com/a.pem',
      'https://sns.ap-southeast-2.amazonaws.com.evil.example.com/a.pem',
      'https://sns.ap-southeast-2.amazonaws.com:8443/a.pem',
      'https://sns.ap-southeast-2.amazonaws.com/a.txt',
      'https://user@sns.ap-southeast-2.amazonaws.com/a.pem',
    ]) {
      await post(signed({ Type: 'Notification', SigningCertURL })).expect(403);
    }
    expect(fetched).toEqual([]);
  });

  it('簽章驗證通過才確認訂閱，確認網址也必須是 SNS 的', async () => {
    const confirm = { Type: 'SubscriptionConfirmation', Token: 'y' };
    await post(signed({ ...confirm, SubscribeURL: SUBSCRIBE_URL }, { key: otherKeys.privateKey })).expect(403);
    expect(fetched.filter((u) => u === SUBSCRIBE_URL)).toEqual([]);
    await post(signed({ ...confirm, SubscribeURL: 'https://evil.example.com/confirm' })).expect(403);
    expect(fetched.filter((u) => u.includes('evil'))).toEqual([]);
    await post(signed({ ...confirm, SubscribeURL: SUBSCRIBE_URL })).expect(204);
    expect(fetched.filter((u) => u === SUBSCRIBE_URL)).toHaveLength(1);
  });

  it('寄出時存下 SES 訊息 ID，永久退信後出現在後台失敗清單；重送不影響結果', async () => {
    const f = await fixture();
    const db = app.get(DatabaseService);
    const notifications = app.get(NotificationService);
    const event = await db.withTenant(f.agencyId, (tx) => notifications.mailEvent(tx, f.eventId));
    await notifications.deliver(f.agencyId, f.eventId, event, { id: null, name: '承辦', email: 'to@example.com' }, { key: 'account', token: 't' });
    const { provider_message_id: id } = await q1(`SELECT provider_message_id FROM email_messages WHERE event_id = $1`, [f.eventId]);
    expect(id).toBeTruthy();
    expect((await f.emails()).failures).toEqual([]);

    const notice = bounce(id);
    await post(notice).expect(204);
    expect(await row(id)).toMatchObject({ status: 'bounced', error: 'bounce:Permanent:General smtp; 550 user unknown' });
    const view = await f.emails();
    expect(view.stats).toMatchObject({ failed: 1 });
    expect(view.failures[0]).toMatchObject({ email: 'to@example.com', reason: 'mailbox' });

    await post(notice).expect(204);
    expect((await f.emails()).failures).toHaveLength(1);
  });

  it('客訴標示在失敗清單；回報非垃圾信不算', async () => {
    const f = await fixture();
    const id = await sentMessage(f);
    await post(complaint(id)).expect(204);
    expect(await row(id)).toMatchObject({ status: 'bounced', error: 'complaint:abuse' });
    expect((await f.emails()).failures[0].reason).toBe('complaint');
    const notSpam = await sentMessage(f);
    await post(complaint(notSpam, 'not-spam')).expect(204);
    expect((await row(notSpam)).status).toBe('sent');
  });

  it('暫時性退信：自動回覆不算失敗，信箱已滿等 SES 放棄重試的才算', async () => {
    const f = await fixture();
    const autoReply = await sentMessage(f);
    await post(bounce(autoReply, 'Transient', 'General')).expect(204);
    expect((await row(autoReply)).status).toBe('sent');
    const full = await sentMessage(f);
    await post(bounce(full, 'Transient', 'MailboxFull')).expect(204);
    expect((await row(full)).status).toBe('bounced');
    expect((await f.emails()).failures[0].reason).toBe('temporary');
  });

  it('寄出當下就失敗的信不會被通知改寫；沒有紀錄的信回 204，SNS 不會一直重送', async () => {
    const f = await fixture();
    const failed = await sentMessage(f, 'failed');
    await post(bounce(failed)).expect(204);
    expect(await row(failed)).toMatchObject({ status: 'failed', error: null });
    await post(bounce(`unknown-${randomUUID()}`)).expect(204);
  });

  it('也接受第 1 版簽章，未知版本拒絕', async () => {
    const f = await fixture();
    const id = await sentMessage(f);
    const message = JSON.stringify({ notificationType: 'Bounce', mail: { messageId: id }, bounce: { bounceType: 'Permanent', bounceSubType: 'General' } });
    await post(signed({ Type: 'Notification', Message: message }, { version: '3' })).expect(403);
    await post(signed({ Type: 'Notification', Message: message }, { version: '1' })).expect(204);
    expect((await row(id)).status).toBe('bounced');
  });

  it('解析 SMTP 回應與通知內容', () => {
    expect(sesMessageId('250 Ok 01010160d7de98d8-21e57d9a-JZho-416c-bbe1-8ebaAexample-000000')).toBe('01010160d7de98d8-21e57d9a-JZho-416c-bbe1-8ebaAexample-000000');
    expect(sesMessageId('250 2.0.0 Ok: queued as ABC')).toBeNull();
    expect(sesMessageId(undefined)).toBeNull();
    expect(feedbackError({ notificationType: 'Delivery' })).toBeNull();
    expect(feedbackError({ notificationType: 'Bounce', bounce: {} })).toBe('bounce:Undetermined:Undetermined');
  });
});
