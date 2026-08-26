#!/usr/bin/env node
import { executeRead, readSpec, success, failure, READ_ACTIONS, READ_EXIT } from './lib/read-client.mjs';

const HELP = `OpenChamber read-only browser CLI

Usage: openchamber-browser <action> [options]

Actions: open, navigate, snapshot, extract, scroll, scroll-within, inspect, back, forward, resize
  open --url URL [--viewport mobile|tablet|desktop]
  navigate --url URL --expected-origin ORIGIN
  snapshot [--selector CSS]
  extract --spec FILE|-       (JSON spec; - reads stdin)
  scroll --direction up|down|top|bottom [--selector CSS]
  scroll-within --selector CSS --direction up|down|top|bottom [--rounds N] [--settle-ms N]
  inspect --selector CSS
  back | forward
  resize --viewport mobile|tablet|desktop|fill

Connection: --port PORT (default 3000), --server URL, OPENCHAMBER_TOKEN
Output: JSON success/error envelopes. Exit codes: 0 success, 2 usage, 3 unreachable,
4 server rejected, 5 timeout, 8 response too large.`;

const value = (args, name, required = false, allowDash = false) => {
  const index = args.indexOf(name);
  const found = index >= 0 ? args[index + 1] : undefined;
  if (required && (!found || (!allowDash && found.startsWith('-')))) throw Object.assign(new Error(`missing ${name}`), { exitCode: READ_EXIT.USAGE });
  return found;
};
const number = (args, name, fallback) => {
  const raw = value(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Object.assign(new Error(`${name} must be a non-negative integer`), { exitCode: READ_EXIT.USAGE });
  return parsed;
};

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const [command, ...args] = argv;
  const common = {
    server: value(args, '--server') || process.env.OPENCHAMBER_URL,
    token: value(args, '--token'),
    uiPassword: process.env.OPENCHAMBER_UI_PASSWORD,
  };
  if (common.server) {
    try {
      const parsed = new URL(common.server);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!['localhost', '127.0.0.1', '::1'].includes(hostname) && !hostname.startsWith('127.')) {
        throw new Error('foreign origin');
      }
    } catch {
      throw Object.assign(new Error('refusing non-loopback --server; read CLI credentials are never sent to foreign origins'), { exitCode: READ_EXIT.USAGE });
    }
  }
  const port = Number(value(args, '--port') || process.env.OPENCHAMBER_PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('invalid --port'), { exitCode: READ_EXIT.USAGE });
  let action; let input = {};
  switch (command) {
    case 'open': action = 'browser.open'; input = { url: value(args, '--url', true) }; if (value(args, '--viewport')) input.viewport = value(args, '--viewport'); break;
    case 'navigate': action = 'browser.navigate'; input = { url: value(args, '--url', true), expectedOrigin: value(args, '--expected-origin', true) }; break;
    case 'snapshot': action = 'browser.snapshot'; if (value(args, '--selector')) input.selector = value(args, '--selector'); break;
    case 'extract': action = 'browser.extract'; input = readSpec(value(args, '--spec', true, true)); break;
    case 'scroll': action = 'browser.scroll'; input = { selector: value(args, '--selector'), direction: value(args, '--direction') }; break;
    case 'scroll-within': action = 'browser.scrollWithin'; input = { selector: value(args, '--selector', true), direction: value(args, '--direction', true), rounds: number(args, '--rounds', undefined), settleMs: number(args, '--settle-ms', undefined) }; break;
    case 'inspect': action = 'browser.inspect'; input = { selector: value(args, '--selector', true) }; break;
    case 'back': action = 'browser.back'; break;
    case 'forward': action = 'browser.forward'; break;
    case 'resize': action = 'browser.resize'; input = { viewport: value(args, '--viewport', true) }; break;
    default: throw Object.assign(new Error(`unknown action '${command}'`), { exitCode: READ_EXIT.USAGE });
  }
  for (const key of ['rounds', 'settleMs']) if (input[key] === undefined) delete input[key];
  const result = await executeRead(port, action, input, common);
  console.log(JSON.stringify(success(action, result)));
}

main().catch((error) => { console.log(JSON.stringify(failure(error))); process.exitCode = error.exitCode || READ_EXIT.UNREACHABLE; });
