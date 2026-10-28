import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { ProductMigrations } from '../options';
import { dataSourceOptions, describeTarget, migrateAll } from './data-source';
import { ENTITIES } from './entities';

/** Pending migrations (the gateway's, then the product's) are applied here (DB_MIGRATIONS_RUN), before TypeORM connects. */
@Module({})
export class DatabaseModule {
  static forRoot(extraEntities: Function[], migrations?: ProductMigrations): DynamicModule {
    const entities = [...ENTITIES, ...extraEntities];
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: async (config: ConfigService<AppConfig, true>) => {
            const db = config.get('database', { infer: true });
            if (db.migrationsRun) {
              const log = new Logger('Migrations');
              for (const { set, result } of await migrateAll(db, migrations, { log: (m) => log.log(m) })) {
                log.log(`${describeTarget(db)} ${set.ledgerTable}: ${result.applied.length ? `applied ${result.applied.join(', ')}` : 'up to date'}`);
              }
            }
            return dataSourceOptions(db, entities);
          },
        }),
        TypeOrmModule.forFeature(entities),
      ],
      exports: [TypeOrmModule],
    };
  }
}
