import { execSync } from 'node:child_process';

/** A fresh database for every run, so results never depend on the last one. */
export default async function globalSetup() {
  execSync('bash tests/support/reset-db.sh', { stdio: 'inherit' });
  await fetch('http://127.0.0.1:54321/__control/outage?on=0');
  await fetch('http://127.0.0.1:54321/__control/reload');
}
