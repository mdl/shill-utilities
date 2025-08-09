import readline from 'readline';

export function prompt(question: string, opts?: { mask?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const masked = !!(opts && opts.mask);

    if (masked) {
      // Override output to mask typed characters
      (rl as any).stdoutMuted = true;
      const write = (rl as any)._writeToOutput?.bind(rl);
      (rl as any)._writeToOutput = (stringToWrite: string) => {
        // Preserve newlines; mask other characters
        if ((rl as any).stdoutMuted) {
          if (stringToWrite.endsWith('\n') || stringToWrite.endsWith('\r')) {
            (rl as any).output.write(stringToWrite);
          } else {
            (rl as any).output.write('*');
          }
        } else if (write) {
          write(stringToWrite);
        } else {
          (rl as any).output.write(stringToWrite);
        }
      };
    }

    rl.question(question, (answer) => {
      if (masked) {
        (rl as any).stdoutMuted = false;
        (rl as any).output.write('\n');
      }
      rl.close();
      resolve(answer.trim());
    });
  });
}
