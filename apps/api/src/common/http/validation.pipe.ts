import { ValidationPipe, type ValidationError } from '@nestjs/common';
import type { ValidationIssue } from '@acc/contracts';

import { ValidationFailedException } from '../errors/app.exception';

/**
 * Global input validation (`SECURITY.md` §6: input validation via DTO schemas at
 * every API boundary).
 *
 * `whitelist` + `forbidNonWhitelisted` mean an unexpected property is rejected
 * rather than silently carried through — which is what stops a caller smuggling
 * a field such as `org_id` into a DTO and having it reach a persistence layer.
 */
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors: ValidationError[]) =>
      new ValidationFailedException({ issues: flatten(errors) }),
  });
}

/**
 * Turns `class-validator`'s nested errors into the flat, field-addressed issues
 * the error contract publishes (`API.md` §7a, Phase 1B.5.8).
 *
 * One issue per failed *rule*, not per field: a value can fail its type and its
 * length at once, and collapsing those into one entry forces a form to re-derive
 * which rule it was from prose. `rule` is the machine-readable half and is what
 * a client branches on; `message` is for people.
 */
function flatten(errors: readonly ValidationError[], parent = ''): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
      issues.push({ field, rule: ruleCodeFor(constraint), message: String(message) });
    }
    if (error.children && error.children.length > 0) {
      issues.push(...flatten(error.children, field));
    }
  }
  return issues;
}

/**
 * `class-validator`'s constraint name as a stable screaming-snake code:
 * `isUuid` → `IS_UUID`, `maxLength` → `MAX_LENGTH`.
 *
 * Derived rather than mapped by hand, so a new validator decorator produces a
 * sensible code without anyone remembering to extend a table — and a table that
 * falls behind yields `undefined`, which is worse than a mechanical answer.
 */
function ruleCodeFor(constraint: string): string {
  return constraint
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}
