import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

export type Tx = pg.PoolClient;

// date 欄位保持 YYYY-MM-DD 字串；轉成 Date 會受時區影響而差一天
pg.types.setTypeParser(1082, (value) => value);

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE ?? 20) });

  /** 所有租戶資料都必須在此交易內存取，RLS 依 app.agency_id 隔離。 */
  async withTenant<T>(agencyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.agency_id', $1, true)`, [agencyId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
