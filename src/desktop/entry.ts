// Parser mode must run before the normal app touches settings, account storage or its instance lock.
const parser = process.argv.indexOf('--archive-parser');
if (parser >= 0) {
  const { app } = await import('electron');
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking');
  app.whenReady().then(async () => {
    const { runParserClient } = await import('../core/parser-client.js');
    await runParserClient(process.argv[parser + 1] ?? '');
  }).then(() => app.exit(0), () => app.exit(1));
} else await import('./main.js');
