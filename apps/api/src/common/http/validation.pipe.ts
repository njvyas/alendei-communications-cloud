import { ValidationPipe, type ValidationError } from '@nestjs/common';

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

interface FieldIssue {
  readonly field: string;
  readonly constraints: readonly string[];
}

function flatten(errors: readonly ValidationError[], parent = ''): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      issues.push({ field, constraints: Object.values(error.constraints) });
    }
    if (error.children && error.children.length > 0) {
      issues.push(...flatten(error.children, field));
    }
  }
  return issues;
}
