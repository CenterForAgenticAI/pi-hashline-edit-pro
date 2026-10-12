const envRestores: Array<() => void> = [];

export function pushEnvRestore(restore: () => void): void {
  envRestores.push(restore);
}

export function drainEnvRestores(): void {
  while (envRestores.length > 0) envRestores.pop()!();
}
