import { resolve } from 'node:path';

import { assertDisposableTestDatabase } from './database-target-guard';
import { loadTestEnv } from './harness';

loadTestEnv();
// Before any suite connects: only a with-db-clone.mjs copy or the CI container.
assertDisposableTestDatabase([
  resolve(__dirname, '../../../../.env'),
  resolve(__dirname, '../../.env'),
]);
