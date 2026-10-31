import { loadSettings, probeDatabases } from './databases.ts';

async function main(): Promise<void> {
  const settings = loadSettings();
  const results = await probeDatabases(settings);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    for (const item of results) {
      console.log((item.ok ? '[OK] ' : '[ОШИБКА] ') + item.name + ' (' + item.latencyMs + ' мс)' + (item.error ? ': ' + item.error : ''));
    }
  }
  if (results.some(item => !item.ok)) process.exitCode = 1;
}

main().catch(error => {
  // Do not reveal secrets in raw connection string messages.
  console.error('[ОШИБКА] ' + (error instanceof Error ? error.name + ': ' + error.message.replace(/[a-f0-9]{64}/gi, '[скрыто]') : 'Неизвестная ошибка'));
  process.exitCode = 1;
});
