import { createVerify } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from './database.service.ts';

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;
const ALGORITHMS: Record<string, string> = { '1': 'RSA-SHA1', '2': 'RSA-SHA256' };
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};
const MAX_CACHED_CERTS = 8;

type SnsMessage = Record<string, unknown>;

/** 只接受 SNS 自己網域上的 HTTPS 網址，避免被騙去下載別的憑證或呼叫內部服務。 */
function isSnsUrl(value: unknown, path?: RegExp): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && SNS_HOST.test(url.hostname) && (!path || path.test(url.pathname));
  } catch {
    return false;
  }
}

function canonicalString(message: SnsMessage): string | null {
  const fields = SIGNED_FIELDS[String(message.Type)];
  if (!fields) return null;
  let out = '';
  for (const field of fields) {
    const value = message[field];
    if (value === undefined && field === 'Subject') continue;
    if (typeof value !== 'string') return null;
    out += `${field}\n${value}\n`;
  }
  return out;
}

/**
 * 需要在後台處理的通知回傳要記錄的原因，不需要處理的回傳 null。
 * 自動回覆（例如休假通知）也算 Transient General，信其實已送達，不當作失敗。
 */
export function feedbackError(notification: any): string | null {
  if (notification?.notificationType === 'Bounce') {
    const type = String(notification.bounce?.bounceType ?? 'Undetermined');
    const subType = String(notification.bounce?.bounceSubType ?? 'Undetermined');
    if (type === 'Transient' && subType === 'General') return null;
    const diagnostic = notification.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
    return `bounce:${type}:${subType}${typeof diagnostic === 'string' ? ` ${diagnostic}` : ''}`.slice(0, 500);
  }
  if (notification?.notificationType === 'Complaint') {
    const type = notification.complaint?.complaintFeedbackType;
    if (type === 'not-spam') return null;
    return `complaint:${typeof type === 'string' ? type : 'unknown'}`;
  }
  return null;
}

/**
 * 接收 SES 經由 SNS 送來的退信與客訴通知。
 * 端點是公開的，所以先確認 Topic 是我們的、簽章正確，才處理內容或連到其他網址。
 * SNS 可能重送同一則通知，更新只影響還在「已寄出」狀態的信。
 */
@Injectable()
export class SesFeedbackService {
  private readonly logger = new Logger(SesFeedbackService.name);
  private readonly certs = new Map<string, string>();
  /** 測試用：取代實際的 HTTP 請求。 */
  fetchText: (url: string) => Promise<string> = async (url) => {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`SNS 回應 ${res.status}`);
    return res.text();
  };

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async handle(body: unknown) {
    const topic = process.env.SES_SNS_TOPIC_ARN;
    if (!topic) throw new NotFoundException();
    const message = this.parse(body);
    if (message.TopicArn !== topic) throw new ForbiddenException();
    await this.verify(message);

    if (message.Type === 'SubscriptionConfirmation') {
      if (!isSnsUrl(message.SubscribeURL)) throw new ForbiddenException();
      await this.fetchText(message.SubscribeURL);
      this.logger.log('已確認 SNS 訂閱');
    } else if (message.Type === 'Notification') {
      await this.record(message);
    }
  }

  private parse(body: unknown): SnsMessage {
    try {
      const parsed = JSON.parse(typeof body === 'string' ? body : '');
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 不是 JSON，視同無效
    }
    throw new ForbiddenException();
  }

  private async verify(message: SnsMessage) {
    const algorithm = ALGORITHMS[String(message.SignatureVersion)];
    const canonical = canonicalString(message);
    if (!algorithm || !canonical || typeof message.Signature !== 'string' || !isSnsUrl(message.SigningCertURL, /\.pem$/)) throw new ForbiddenException();
    const cert = await this.cert(message.SigningCertURL);
    let valid = false;
    try {
      valid = createVerify(algorithm).update(canonical, 'utf8').verify(cert, message.Signature, 'base64');
    } catch {
      // 憑證或簽章格式錯誤，視同驗證失敗
    }
    if (!valid) throw new ForbiddenException();
  }

  private async cert(url: string) {
    const cached = this.certs.get(url);
    if (cached) return cached;
    const pem = await this.fetchText(url);
    if (this.certs.size >= MAX_CACHED_CERTS) this.certs.clear();
    this.certs.set(url, pem);
    return pem;
  }

  private async record(message: SnsMessage) {
    let notification: any;
    try {
      notification = JSON.parse(String(message.Message));
    } catch {
      this.logger.warn(`無法解析 SNS 通知 ${String(message.MessageId)}`);
      return;
    }
    const providerId = notification?.mail?.messageId;
    const error = feedbackError(notification);
    if (typeof providerId !== 'string' || !error) return;

    const { rows } = await this.db.pool.query(`SELECT email_message_agency($1) AS agency_id`, [providerId]);
    const agencyId = rows[0]?.agency_id as string | null;
    // 沒有寄送紀錄的信（例如旅行社人員的設定密碼信）只記 log；SES 的 suppression list 仍會擋下之後的寄送。
    if (!agencyId) {
      this.logger.warn(`收到沒有寄送紀錄的信件回饋：${error.split(' ')[0]}，SES 訊息 ${providerId}`);
      return;
    }
    await this.db.withTenant(agencyId, (tx) => tx.query(
      `UPDATE email_messages SET status = 'bounced', error = $2 WHERE provider_message_id = $1 AND status IN ('sent', 'delivered')`,
      [providerId, error],
    ));
  }
}
