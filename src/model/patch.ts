export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkShape(value: unknown, template: unknown, path: string): void {
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length !== template.length) throw new Error(`${path} must have ${template.length} effects (FX2, FX3).`);
    template.forEach((item, index) => checkShape(value[index], item, `${path}[${index}]`));
  } else if (isRecord(template)) {
    if (!isRecord(value)) throw new Error(`Patch is missing ${path}.`);
    for (const [key, item] of Object.entries(template)) checkShape(value[key], item, `${path}.${key}`);
  } else if (typeof value !== typeof template || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${path} must be ${typeof template === 'number' ? 'a finite number' : typeof template}.`);
  }
}

export function checkChoice(value: unknown, choices: readonly unknown[], path: string): void {
  if (!choices.includes(value)) throw new Error(`Invalid ${path}.`);
}
