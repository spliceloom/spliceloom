#!/usr/bin/env node
import { createInterface } from "node:readline";
import { main } from "./cli.js";

/** Hidden prompt on a TTY; otherwise the first line of stdin (e.g. `echo $TOKEN | splice login`). */
function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => (data += chunk));
      process.stdin.on("end", () => resolve(data.split(/\r?\n/)[0] ?? ""));
      process.stdin.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const writer = rl as unknown as { _writeToOutput: (s: string) => void };
    let prompted = false;
    writer._writeToOutput = (s: string) => {
      // Print the prompt once, then echo nothing while the secret is typed.
      if (!prompted) {
        prompted = true;
        process.stderr.write(s);
      }
    };
    rl.question(prompt, (answer) => {
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  color: Boolean(process.stdout.isTTY),
  readSecret,
  stdin: process.stdin,
});
process.exitCode = code;
