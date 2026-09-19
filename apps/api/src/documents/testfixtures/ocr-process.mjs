import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (input.log) appendFileSync(input.log, JSON.stringify({ event: 'start', at: Date.now(), id: input.id }) + '\n');
if (input.childMarker) {
  spawn(process.execPath, ['-e', 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1], "escaped"), 1800)', input.childMarker], { stdio: 'ignore', windowsHide: true });
  writeFileSync(input.startedMarker, 'started');
}
if (input.stdoutOverflow) process.stdout.write('x'.repeat(9 * 1024 * 1024));
if (input.stderrOverflow) process.stderr.write('x'.repeat(70 * 1024));
await new Promise(resolve => setTimeout(resolve, input.delay ?? 0));
if (input.log) appendFileSync(input.log, JSON.stringify({ event: 'end', at: Date.now(), id: input.id }) + '\n');
process.stdout.write(input.raw ?? JSON.stringify(input.result));
process.exitCode = input.exitCode ?? 0;
