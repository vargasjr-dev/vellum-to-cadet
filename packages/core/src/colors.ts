/**
 * ANSI color helpers for the CLI's human output.
 * Respects NO_COLOR and disables itself on non-TTY stdout.
 */

const isTTY = process.stdout.isTTY;
/** `let` so the detached run-log child can force color on (see forceColor). */
let enabled = isTTY && !process.env["NO_COLOR"];
/** Errors go to stderr; color them only when THAT stream is a terminal. */
let errEnabled = process.stderr.isTTY && !process.env["NO_COLOR"];

function wrap(code: string, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * Force color on for this process. The detached run-log child writes to a
 * FILE, so the TTY probes see nothing — but its bytes are relayed to a
 * real terminal by the parent, where the color renders. NO_COLOR still wins.
 */
export function forceColor(): void {
  if (process.env["NO_COLOR"]) return;
  enabled = true;
  errEnabled = true;
}

export const colors = {
  green: (t: string) => wrap("32", t),
  red: (t: string) => wrap("31", t),
  yellow: (t: string) => wrap("33", t),
  cyan: (t: string) => wrap("36", t),
  dim: (t: string) => wrap("2", t),
  bold: (t: string) => wrap("1", t),
};

export function successIcon(): string {
  return colors.green("✔");
}

export function failIcon(): string {
  return colors.red("✖");
}

export function skipIcon(): string {
  return colors.yellow("–");
}

export function header(text: string): string {
  return colors.bold(text);
}

export function detail(text: string): string {
  return colors.dim(text);
}

export function command(text: string): string {
  return colors.cyan(text);
}

/** Red error text for stderr, colored only on a real terminal. */
export function errorText(text: string): string {
  return errEnabled ? `\u001b[31m${text}\u001b[0m` : text;
}

/** Yellow warning text for stderr, colored only on a real terminal. */
export function warnText(text: string): string {
  return errEnabled ? `\u001b[33m${text}\u001b[0m` : text;
}
